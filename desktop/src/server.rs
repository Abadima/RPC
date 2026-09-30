//! The `127.0.0.1` port: plain HTTP (`GET /health`) and the WebSocket. Bound
//! to loopback only, never `0.0.0.0`. Before anything is read from a
//! connection, it must come from this OS user (where that can be checked, see
//! `peer.rs`), fit under the connection cap, and not arrive faster than the
//! accept rate limit.

use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::http;
use crate::hub::Hub;
use crate::peer::{self, Owner};
use crate::rate::TokenBucket;
use crate::ws;

/// IANA dynamic/private range; avoids common local-dev-server ports and
/// Discord's own local-RPC range (6463-6472).
pub const DEFAULT_PORT: u16 = 57179;
pub const ADDRESS: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(Ipv4Addr::LOCALHOST), DEFAULT_PORT);
/// Each open connection is a thread; real use is a handful of browsers.
const MAX_CONNECTIONS: usize = 64;
/// New connections per second, after a burst: enough for browsers
/// reconnecting together, and a page or process hammering the port is
/// dropped before any parsing.
const ACCEPT_BURST: u32 = 32;
const ACCEPTS_PER_SECOND: u32 = 16;
/// Covers reading the HTTP request head: a stalled connection is dropped
/// instead of holding a thread.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Server {
    hub: Arc<Hub>,
    open: Arc<AtomicUsize>,
    accepts: Mutex<TokenBucket>,
}

impl Server {
    pub fn new(hub: Arc<Hub>) -> Self {
        Self {
            hub,
            open: Arc::new(AtomicUsize::new(0)),
            accepts: Mutex::new(TokenBucket::new(ACCEPT_BURST, ACCEPTS_PER_SECOND)),
        }
    }

    pub fn bind() -> std::io::Result<TcpListener> {
        TcpListener::bind(ADDRESS)
    }

    /// Serves an already-bound listener forever. Tests bind `127.0.0.1:0`.
    pub fn serve(&self, listener: TcpListener) {
        for stream in listener.incoming().flatten() {
            self.dispatch(stream);
        }
    }

    fn dispatch(&self, stream: TcpStream) {
        let admitted = self
            .accepts
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take(Instant::now());
        if !admitted {
            return;
        }
        let (Ok(peer_addr), Ok(local_addr)) = (stream.peer_addr(), stream.local_addr()) else {
            return;
        };
        let same_user = match peer::loopback_owner(peer_addr, local_addr) {
            Owner::ThisUser => true,
            Owner::Unknown => false,
            Owner::OtherUser => return,
        };
        if self.open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            self.open.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        let guard = OpenGuard(Arc::clone(&self.open));
        let hub = Arc::clone(&self.hub);

        thread::spawn(move || {
            let _guard = guard;
            if stream.set_read_timeout(Some(REQUEST_TIMEOUT)).is_err() {
                return;
            }
            match http::peek_route(&stream) {
                Ok(http::RouteDecision::WebSocketUpgrade) => {
                    ws::handle_connection(stream, &hub, same_user);
                }
                Ok(http::RouteDecision::Http) => {
                    let _ = http::handle_http(stream);
                }
                Err(_) => {}
            }
        });
    }
}

struct OpenGuard(Arc<AtomicUsize>);

impl Drop for OpenGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::tests::{CHROMIUM, test_hub};
    use std::io::{Read, Write};
    use tungstenite::Message;
    use tungstenite::client::ClientRequestBuilder;
    use tungstenite::http::Uri;

    fn spawn_test_server() -> (u16, Arc<Hub>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hub = Arc::new(test_hub());
        let server = Server::new(Arc::clone(&hub));
        thread::spawn(move || server.serve(listener));
        (port, hub)
    }

    fn connect(port: u16) -> tungstenite::WebSocket<TcpStream> {
        let uri: Uri = format!("ws://127.0.0.1:{port}/ws").parse().unwrap();
        let request = ClientRequestBuilder::new(uri).with_header("Origin", CHROMIUM);
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        tungstenite::client(request, stream).unwrap().0
    }

    #[test]
    fn the_fixed_address_is_loopback_only() {
        assert!(ADDRESS.ip().is_loopback());
        assert_eq!(ADDRESS.to_string(), "127.0.0.1:57179");
    }

    #[test]
    fn health_and_websocket_share_one_port() {
        let (port, hub) = spawn_test_server();
        let mut http_stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        http_stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        http_stream.read_to_string(&mut response).ok();
        assert!(response.starts_with("HTTP/1.1 200 OK"));

        let mut socket = connect(port);
        socket
            .send(Message::Text(
                r#"{"type":"hello","protocolVersion":6,"name":"t"}"#.into(),
            ))
            .unwrap();
        assert!(matches!(socket.read().unwrap(), Message::Text(text) if text.contains("welcome")));
        // Linux confirms the connection is this user's; elsewhere it's unknown.
        let status = hub.status();
        assert_eq!(status.clients.len(), 1);
    }

    #[test]
    fn a_stalled_request_is_dropped_after_the_timeout() {
        let (port, _hub) = spawn_test_server();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(b"GET /health HTTP/1.1\r\n").unwrap();
        stream
            .set_read_timeout(Some(REQUEST_TIMEOUT + Duration::from_secs(3)))
            .unwrap();
        let started = Instant::now();
        let _ = stream.read(&mut [0u8; 64]);
        assert!(started.elapsed() < REQUEST_TIMEOUT + Duration::from_secs(3));
    }

    #[test]
    fn a_connection_flood_is_cut_off() {
        let (port, _hub) = spawn_test_server();
        // Far past the burst: the excess is closed without a response.
        let streams: Vec<TcpStream> = (0..80)
            .map(|_| TcpStream::connect(("127.0.0.1", port)).unwrap())
            .collect();
        let mut dropped = 0;
        for mut stream in streams {
            stream
                .set_read_timeout(Some(Duration::from_millis(300)))
                .unwrap();
            let _ = stream.write_all(b"GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            if response.is_empty() {
                dropped += 1;
            }
        }
        assert!(
            dropped >= 80 - ACCEPT_BURST as usize - 4,
            "dropped {dropped}"
        );
    }
}
