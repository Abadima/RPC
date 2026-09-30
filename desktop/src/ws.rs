//! The WebSocket every browser client connects over. The browser-set
//! `Origin` decides everything before the upgrade completes (see
//! `Hub::ws_gate`): an allowed Parousia extension origin reaches the session,
//! an unknown extension origin gets one `origin_not_allowed` message and
//! nothing else, and web pages and anything malformed get a plain 403.

use std::cell::RefCell;
use std::io::{self, Read};
use std::net::{Shutdown, TcpStream};
use std::time::{Duration, Instant};

use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::{Response as HttpResponse, StatusCode};
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tungstenite::{Message, WebSocket};

use crate::hub::{Closer, Gate, Hub};
use crate::protocol::{self, RejectReason, ServerMessage};
use crate::session::{self, Channel, MAX_MESSAGE_SIZE};

const REJECT_CLOSE_CODE: u16 = 4001;

/// Runs one accepted TCP connection's whole WebSocket lifetime. Never panics
/// on protocol or I/O errors: any failure ends the connection.
pub fn handle_connection(stream: TcpStream, hub: &Hub, same_user: bool) {
    let gate_cell: RefCell<Option<Gate>> = RefCell::new(None);
    // `ErrorResponse`'s size is dictated by tungstenite's `Callback` trait
    // signature, not something this closure controls.
    #[allow(clippy::result_large_err)]
    let callback = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let origin = request
            .headers()
            .get("Origin")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let gate = if request.uri().path() == "/ws" {
            hub.ws_gate(origin, same_user)
        } else {
            Gate::Forbidden
        };
        if gate == Gate::Forbidden {
            return Err(HttpResponse::builder()
                .status(StatusCode::FORBIDDEN)
                .body(None)
                .expect("a static response always builds"));
        }
        *gate_cell.borrow_mut() = Some(gate);
        Ok(response)
    };

    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_MESSAGE_SIZE);
    config.max_frame_size = Some(MAX_MESSAGE_SIZE);

    let Ok(socket) = tungstenite::accept_hdr_with_config(stream, callback, Some(config)) else {
        return;
    };
    let mut channel = WsChannel { socket };
    match gate_cell.into_inner() {
        Some(Gate::Admit(peer)) => session::run(&mut channel, &peer, hub),
        Some(Gate::NotAllowed) => {
            let reject = ServerMessage::Reject {
                reason: RejectReason::OriginNotAllowed,
            };
            let _ = channel.send(&protocol::encode(&reject));
            channel.close();
        }
        Some(Gate::Forbidden) | None => {}
    }
}

struct WsChannel {
    socket: WebSocket<TcpStream>,
}

impl Channel for WsChannel {
    fn recv(&mut self) -> io::Result<Option<String>> {
        loop {
            match self.socket.read() {
                Ok(Message::Text(text)) => return Ok(Some(text.as_str().to_string())),
                Ok(Message::Close(_)) => return Ok(None),
                Ok(
                    Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_),
                ) => {}
                Err(tungstenite::Error::Io(err))
                    if matches!(
                        err.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return Err(io::Error::from(io::ErrorKind::TimedOut));
                }
                Err(_) => return Ok(None),
            }
        }
    }

    fn send(&mut self, text: &str) -> io::Result<()> {
        self.socket
            .send(Message::Text(text.into()))
            .map_err(io::Error::other)
    }

    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
        self.socket.get_ref().set_read_timeout(timeout)
    }

    fn closer(&self) -> io::Result<Closer> {
        let stream = self.socket.get_ref().try_clone()?;
        Ok(Box::new(move || {
            let _ = stream.shutdown(Shutdown::Both);
        }))
    }

    fn close(&mut self) {
        let _ = self.socket.close(Some(CloseFrame {
            code: CloseCode::Library(REJECT_CLOSE_CODE),
            reason: "rejected".into(),
        }));
        let _ = self.socket.flush();
        linger(self.socket.get_mut());
    }
}

/// Closing a socket with unread input makes the kernel reset the
/// connection, and a reset can take the `reject` just sent down with it
/// (clients then see a bare connection error). So stop sending, then discard
/// whatever the client still sends until it closes too, within a bound.
fn linger(stream: &mut TcpStream) {
    const LINGER: Duration = Duration::from_secs(1);
    const LINGER_BYTES: usize = 256 * 1024;
    let _ = stream.shutdown(Shutdown::Write);
    let deadline = Instant::now() + LINGER;
    let mut sink = [0; 4096];
    let mut left = LINGER_BYTES;
    while left > 0 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || stream.set_read_timeout(Some(remaining)).is_err() {
            return;
        }
        match stream.read(&mut sink) {
            Ok(0) | Err(_) => return,
            Ok(read) => left = left.saturating_sub(read),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::Setting;
    use crate::hub::tests::{CHROMIUM, OTHER, test_hub};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::thread;
    use tungstenite::client::ClientRequestBuilder;
    use tungstenite::http::Uri;

    fn spawn_server(hub: Arc<Hub>) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            handle_connection(stream, &hub, true);
        });
        (port, handle)
    }

    fn connect(
        port: u16,
        path: &str,
        origin: Option<&str>,
    ) -> tungstenite::Result<WebSocket<TcpStream>> {
        let uri: Uri = format!("ws://127.0.0.1:{port}{path}").parse().unwrap();
        let mut request = ClientRequestBuilder::new(uri);
        if let Some(origin) = origin {
            request = request.with_header("Origin", origin);
        }
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        tungstenite::client(request, stream)
            .map(|(socket, _)| socket)
            .map_err(|err| match err {
                tungstenite::HandshakeError::Failure(err) => err,
                tungstenite::HandshakeError::Interrupted(_) => unreachable!("blocking stream"),
            })
    }

    fn read_json(socket: &mut WebSocket<TcpStream>) -> serde_json::Value {
        loop {
            match socket.read().unwrap() {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Close(_) => panic!("closed"),
                _ => {}
            }
        }
    }

    fn assert_forbidden(result: tungstenite::Result<WebSocket<TcpStream>>) {
        let Err(tungstenite::Error::Http(response)) = result else {
            panic!("expected an HTTP failure");
        };
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(
            response.body().as_ref().is_none_or(Vec::is_empty),
            "says nothing about Desktop"
        );
    }

    #[test]
    fn web_pages_malformed_origins_and_wrong_paths_get_a_plain_403() {
        for (path, origin) in [
            ("/ws", Some("https://evil.example")),
            ("/ws", Some("null")),
            ("/ws", Some("file://")),
            ("/ws", None),
            ("/elsewhere", Some(CHROMIUM)),
        ] {
            let (port, _handle) = spawn_server(Arc::new(test_hub()));
            assert_forbidden(connect(port, path, origin));
        }
    }

    #[test]
    fn an_unknown_extension_is_told_it_is_not_allowed_and_nothing_more() {
        let (port, handle) = spawn_server(Arc::new(test_hub()));
        let mut socket = connect(port, "/ws", Some(OTHER)).unwrap();
        assert_eq!(read_json(&mut socket)["reason"], "origin_not_allowed");
        handle.join().unwrap();
        let _ = socket.send(Message::Text(r#"{"type":"ping"}"#.into()));
        assert!(!matches!(socket.read(), Ok(Message::Text(_))));
    }

    /// Reads everything left on the raw stream: the bytes, and whether it
    /// ended cleanly (EOF) rather than with a reset.
    fn drain(socket: &mut WebSocket<TcpStream>) -> (Vec<u8>, io::Result<()>) {
        let mut bytes = Vec::new();
        let result = socket.get_mut().read_to_end(&mut bytes).map(drop);
        (bytes, result)
    }

    /// Closing with unread input makes the kernel reset the connection,
    /// which can destroy the `reject` before the client reads it.
    #[test]
    fn a_reject_ends_cleanly_even_with_input_left_unread() {
        let (port, handle) = spawn_server(Arc::new(test_hub()));
        let mut socket = connect(port, "/ws", Some(CHROMIUM)).unwrap();
        socket
            .write(Message::Text(
                r#"{"type":"hello","protocolVersion":6,"name":"Flood"}"#.into(),
            ))
            .unwrap();
        // More than tungstenite's 128 KiB read buffer takes in at once, so
        // some is still queued in the kernel when Desktop gives up on it.
        for _ in 0..8000 {
            socket
                .write(Message::Text(r#"{"type":"ping"}"#.into()))
                .unwrap();
        }
        socket.flush().unwrap();
        let (bytes, ended) = drain(&mut socket);
        drop(socket);
        handle.join().unwrap();
        assert!(ended.is_ok(), "ended with {ended:?}");
        assert!(String::from_utf8_lossy(&bytes).contains("rate_limited"));
    }

    #[test]
    fn an_allowed_extension_says_hello_and_is_welcomed() {
        let hub = Arc::new(test_hub());
        let (port, handle) = spawn_server(Arc::clone(&hub));
        let mut socket = connect(port, "/ws", Some(CHROMIUM)).unwrap();
        socket
            .send(Message::Text(
                r#"{"type":"hello","protocolVersion":6,"name":"Chromium on Linux"}"#.into(),
            ))
            .unwrap();
        assert_eq!(read_json(&mut socket)["type"], "welcome");
        assert_eq!(hub.status().clients[0].identity, CHROMIUM);
        drop(socket);
        handle.join().unwrap();
        assert!(hub.status().clients.is_empty());
    }

    #[test]
    fn userscripts_connect_only_once_allowed() {
        let hub = Arc::new(test_hub());
        let (port, _handle) = spawn_server(Arc::clone(&hub));
        assert_forbidden(connect(port, "/ws", Some("https://example.com")));
        hub.set(Setting::AllowUserscripts, true).unwrap();
        let (port, _handle) = spawn_server(Arc::clone(&hub));
        assert!(connect(port, "/ws", Some("https://example.com")).is_ok());
    }

    #[test]
    fn oversized_frames_end_the_connection() {
        let hub = Arc::new(test_hub());
        let (port, handle) = spawn_server(Arc::clone(&hub));
        let mut socket = connect(port, "/ws", Some(CHROMIUM)).unwrap();
        let _ = socket.send(Message::Text("x".repeat(MAX_MESSAGE_SIZE + 1).into()));
        handle.join().unwrap();
        assert!(hub.status().clients.is_empty());
    }
}
