//! Plain HTTP on the shared port: telling a WebSocket upgrade apart from a
//! plain request, and the one real route (`GET /health`). Everything else
//! happens over the WebSocket (`ws.rs`).

use std::io::{self, Read, Write};
use std::net::TcpStream;

/// Larger than any request head this server expects (an upgrade handshake or
/// `GET /health`), so one `peek` captures the whole head.
const HEAD_BUFFER_SIZE: usize = 8192;
const MAX_HEADERS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteDecision {
    WebSocketUpgrade,
    Http,
}

/// Peeks without consuming, so both paths share one port with no
/// stream-replay wrapper. Anything ambiguous (an incomplete peek, a parse
/// failure) goes to `Http`, which answers with a proper 4xx; a browser's
/// small handshake isn't split across segments on loopback.
pub fn peek_route(stream: &TcpStream) -> io::Result<RouteDecision> {
    let mut buf = [0u8; HEAD_BUFFER_SIZE];
    let n = stream.peek(&mut buf)?;

    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut request = httparse::Request::new(&mut headers);
    let is_websocket_upgrade = match request.parse(&buf[..n]) {
        Ok(httparse::Status::Complete(_)) => request.headers.iter().any(|header| {
            header.name.eq_ignore_ascii_case("Upgrade")
                && std::str::from_utf8(header.value)
                    .map(|value| value.eq_ignore_ascii_case("websocket"))
                    .unwrap_or(false)
        }),
        _ => false,
    };

    Ok(if is_websocket_upgrade {
        RouteDecision::WebSocketUpgrade
    } else {
        RouteDecision::Http
    })
}

/// Answers one request with `Connection: close`: only the WebSocket path is
/// worth keeping a connection open for.
pub fn handle_http(mut stream: TcpStream) -> io::Result<()> {
    let mut buf = [0u8; HEAD_BUFFER_SIZE];
    let n = read_request_head(&mut stream, &mut buf)?;

    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut request = httparse::Request::new(&mut headers);
    let parsed = matches!(request.parse(&buf[..n]), Ok(httparse::Status::Complete(_)));

    if !parsed {
        return write_response(&mut stream, 400, "Bad Request");
    }

    // Refused rather than supported: a tiny responder that half-understands
    // chunked bodies is the classic request-smuggling bug.
    let has_transfer_encoding = request
        .headers
        .iter()
        .any(|header| header.name.eq_ignore_ascii_case("Transfer-Encoding"));
    if has_transfer_encoding {
        return write_response(&mut stream, 400, "Bad Request");
    }

    let is_get = request.method == Some("GET");
    let path = request.path.unwrap_or("/");

    match (is_get, path) {
        (true, "/health") => write_response(&mut stream, 200, "ok"),
        _ => write_response(&mut stream, 404, "Not Found"),
    }
}

fn read_request_head(
    stream: &mut TcpStream,
    buf: &mut [u8; HEAD_BUFFER_SIZE],
) -> io::Result<usize> {
    let mut total = 0;
    loop {
        let n = stream.read(&mut buf[total..])?;
        if n == 0
            || buf[..total + n]
                .windows(4)
                .any(|window| window == b"\r\n\r\n")
        {
            total += n;
            break;
        }
        total += n;
        if total == buf.len() {
            break;
        }
    }
    Ok(total)
}

fn write_response(stream: &mut TcpStream, status: u16, body: &str) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    stream.write_all(response.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn spawn_client(port: u16, request: &'static str) -> thread::JoinHandle<String> {
        thread::spawn(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream.write_all(request.as_bytes()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).ok();
            response
        })
    }

    #[test]
    fn health_route_returns_200() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = spawn_client(port, "GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n");

        let (stream, _) = listener.accept().unwrap();
        assert_eq!(peek_route(&stream).unwrap(), RouteDecision::Http);
        handle_http(stream).unwrap();

        assert!(client.join().unwrap().starts_with("HTTP/1.1 200 OK"));
    }

    #[test]
    fn unknown_route_returns_404() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = spawn_client(port, "GET /nope HTTP/1.1\r\nHost: localhost\r\n\r\n");

        let (stream, _) = listener.accept().unwrap();
        handle_http(stream).unwrap();

        assert!(client.join().unwrap().starts_with("HTTP/1.1 404 Not Found"));
    }

    #[test]
    fn transfer_encoding_is_rejected() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = spawn_client(
            port,
            "GET /health HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n",
        );

        let (stream, _) = listener.accept().unwrap();
        handle_http(stream).unwrap();

        assert!(
            client
                .join()
                .unwrap()
                .starts_with("HTTP/1.1 400 Bad Request")
        );
    }

    #[test]
    fn websocket_upgrade_request_is_routed_away_from_http() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let _client = spawn_client(
            port,
            "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        );

        let (stream, _) = listener.accept().unwrap();
        assert_eq!(
            peek_route(&stream).unwrap(),
            RouteDecision::WebSocketUpgrade
        );
    }
}
