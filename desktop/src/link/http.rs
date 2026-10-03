//! HTTP on the shared port: each connection's request head is read and
//! parsed once, then either answered here (the one real route, `GET /health`,
//! or an error) or, for a WebSocket upgrade, handed to `ws.rs` with what the
//! handshake needs. Everything else happens over the WebSocket.
//!
//! The upgrade is RFC 6455's, checked here rather than by tungstenite's
//! handshake, which would parse the request a second time into the `http`
//! crate's types (and bring that crate and three more along). tungstenite
//! still runs the WebSocket itself.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// Larger than any request head this server expects (an upgrade handshake or
/// `GET /health`); a longer one is refused.
const HEAD_BUFFER_SIZE: usize = 8192;
const MAX_HEADERS: usize = 32;

/// What a connection asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    /// A well-formed WebSocket upgrade.
    Upgrade(Upgrade),
    /// Anything else, answered and closed.
    Http(Answer),
}

#[derive(Debug, PartialEq, Eq)]
pub struct Upgrade {
    pub path: String,
    /// The browser-set `Origin`; empty when there's none, or more than one.
    pub origin: String,
    /// `Sec-WebSocket-Accept`, for the `101` response.
    pub accept: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Health,
    NotFound,
    BadRequest,
}

/// Reads the request head, all of it within `timeout` (not per read, so a
/// trickle of bytes can't hold the connection's thread longer).
pub fn read_request(stream: &mut TcpStream, timeout: Duration) -> io::Result<Request> {
    let deadline = Instant::now() + timeout;
    let mut buf = [0u8; HEAD_BUFFER_SIZE];
    let mut len = 0;
    let head_end = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        stream.set_read_timeout(Some(remaining))?;
        // A read that waited out the timeout says `WouldBlock` on Unix.
        let read = stream
            .read(&mut buf[len..])
            .map_err(|err| match err.kind() {
                io::ErrorKind::WouldBlock => io::ErrorKind::TimedOut.into(),
                _ => err,
            })?;
        if read == 0 {
            return Ok(Request::Http(Answer::BadRequest));
        }
        let from = len.saturating_sub(3);
        len += read;
        if let Some(at) = buf[from..len].windows(4).position(|w| w == b"\r\n\r\n") {
            break from + at + 4;
        }
        if len == buf.len() {
            return Ok(Request::Http(Answer::BadRequest));
        }
    };
    Ok(parse(&buf[..head_end], len > head_end))
}

/// `trailing`: whether the client sent more after the head before any answer.
fn parse(head: &[u8], trailing: bool) -> Request {
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut request = httparse::Request::new(&mut headers);
    if !matches!(request.parse(head), Ok(httparse::Status::Complete(_))) {
        return Request::Http(Answer::BadRequest);
    }
    let headers = &request.headers[..];
    let upgrade = headers.iter().any(|header| {
        header.name.eq_ignore_ascii_case("Upgrade")
            && header.value.eq_ignore_ascii_case(b"websocket")
    });
    if upgrade {
        return websocket(&request, trailing)
            .map_or(Request::Http(Answer::BadRequest), Request::Upgrade);
    }
    // Refused rather than supported: a tiny responder that half-understands
    // chunked bodies is the classic request-smuggling bug.
    if headers
        .iter()
        .any(|header| header.name.eq_ignore_ascii_case("Transfer-Encoding"))
    {
        return Request::Http(Answer::BadRequest);
    }
    match (request.method, request.path) {
        (Some("GET"), Some("/health")) => Request::Http(Answer::Health),
        _ => Request::Http(Answer::NotFound),
    }
}

/// The value of the one header called `name`; `None` when there are none or several.
fn only<'h>(headers: &[httparse::Header<'h>], name: &str) -> Option<&'h str> {
    let mut matching = headers
        .iter()
        .filter(|header| header.name.eq_ignore_ascii_case(name));
    let value = matching.next()?.value;
    if matching.next().is_some() {
        return None;
    }
    std::str::from_utf8(value).ok()
}

/// RFC 6455 section 4.2.1: a `GET` over HTTP/1.1 asking to upgrade, at
/// version 13, with a key that's 16 bytes in base64. A client that sends
/// anything before the answer isn't one.
fn websocket(request: &httparse::Request<'_, '_>, trailing: bool) -> Option<Upgrade> {
    let headers = &request.headers[..];
    let asks_to_upgrade = only(headers, "Connection").is_some_and(|value| {
        value
            .split([',', ' ', '\t'])
            .any(|token| token.eq_ignore_ascii_case("Upgrade"))
    });
    let key = only(headers, "Sec-WebSocket-Key").filter(|key| is_valid_key(key))?;
    let valid = !trailing
        && request.method == Some("GET")
        && request.version == Some(1)
        && asks_to_upgrade
        && only(headers, "Sec-WebSocket-Version") == Some("13");
    valid.then(|| Upgrade {
        path: request.path.unwrap_or("").to_string(),
        origin: only(headers, "Origin").unwrap_or("").to_string(),
        accept: accept_key(key),
    })
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 16 bytes, as canonical base64: 22 characters, the last carrying only 2
/// bits, then `==`.
fn is_valid_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    bytes.len() == 24
        && bytes[..21].iter().all(|b| BASE64.contains(b))
        && b"AQgw".contains(&bytes[21])
        && &bytes[22..] == b"=="
}

/// `Sec-WebSocket-Accept`: the key and RFC 6455's GUID, hashed with SHA-1, in
/// base64. SHA-1 here is a fixed way of showing the server read the key, not
/// a secret or a signature.
fn accept_key(key: &str) -> String {
    let digest = sha1(&[key.as_bytes(), b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"].concat());
    let mut text = String::with_capacity(28);
    for chunk in digest.chunks(3) {
        let bits = chunk.iter().enumerate().fold(0u32, |bits, (i, &byte)| {
            bits | (u32::from(byte) << (16 - 8 * i))
        });
        for i in 0..4 {
            if i <= chunk.len() {
                text.push(char::from(BASE64[((bits >> (18 - 6 * i)) & 63) as usize]));
            } else {
                text.push('=');
            }
        }
    }
    text
}

/// FIPS 180-4 SHA-1.
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut state: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend((data.len() as u64 * 8).to_be_bytes());
    for block in message.as_chunks::<64>().0 {
        let mut w = [0u32; 80];
        for (word, bytes) in w.iter_mut().zip(block.as_chunks::<4>().0) {
            *word = u32::from_be_bytes(*bytes);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = state;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..20 => ((b & c) | (!b & d), 0x5A82_7999),
                20..40 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..60 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let next = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            (e, d, c, b, a) = (d, c, b.rotate_left(30), a, next);
        }
        for (value, add) in state.iter_mut().zip([a, b, c, d, e]) {
            *value = value.wrapping_add(add);
        }
    }
    let mut digest = [0u8; 20];
    for (bytes, value) in digest.as_chunks_mut::<4>().0.iter_mut().zip(state) {
        *bytes = value.to_be_bytes();
    }
    digest
}

/// Answers with `Connection: close`: only the WebSocket path is worth keeping
/// a connection open for.
pub fn answer(stream: &mut TcpStream, answer: Answer) -> io::Result<()> {
    let (status, body) = match answer {
        Answer::Health => ("200 OK", "ok"),
        Answer::NotFound => ("404 Not Found", "Not Found"),
        Answer::BadRequest => ("400 Bad Request", "Bad Request"),
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    stream.write_all(response.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    const UPGRADE: &str = "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:57179\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: chrome-extension://abcdefghijklmnopabcdefghijklmnop\r\n\r\n";

    /// Sends `parts` with a pause between them, as a client whose request
    /// arrives in pieces would, and returns what the server made of it and
    /// what the client got back.
    fn exchange(parts: &[&str]) -> (io::Result<Request>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let parts: Vec<String> = parts.iter().map(|part| part.to_string()).collect();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            for part in parts {
                stream.write_all(part.as_bytes()).unwrap();
                thread::sleep(Duration::from_millis(20));
            }
            stream.shutdown(std::net::Shutdown::Write).ok();
            let mut response = String::new();
            stream.read_to_string(&mut response).ok();
            response
        });
        let (mut stream, _) = listener.accept().unwrap();
        let request = read_request(&mut stream, Duration::from_secs(5));
        if let Ok(Request::Http(reply)) = &request {
            answer(&mut stream, *reply).unwrap();
        }
        drop(stream);
        (request, client.join().unwrap())
    }

    #[test]
    fn health_route_returns_200() {
        let (request, response) = exchange(&["GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n"]);
        assert_eq!(request.unwrap(), Request::Http(Answer::Health));
        assert!(response.starts_with("HTTP/1.1 200 OK"));
    }

    #[test]
    fn unknown_route_returns_404() {
        let (_, response) = exchange(&["GET /nope HTTP/1.1\r\nHost: localhost\r\n\r\n"]);
        assert!(response.starts_with("HTTP/1.1 404 Not Found"));
    }

    #[test]
    fn transfer_encoding_is_rejected() {
        let (_, response) = exchange(&[
            "GET /health HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n",
        ]);
        assert!(response.starts_with("HTTP/1.1 400 Bad Request"));
    }

    #[test]
    fn an_upgrade_carries_its_path_origin_and_accept_key() {
        let (request, _) = exchange(&[UPGRADE]);
        assert_eq!(
            request.unwrap(),
            Request::Upgrade(Upgrade {
                path: "/ws".into(),
                origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop".into(),
                // RFC 6455's own example, section 1.3.
                accept: "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".into(),
            })
        );
    }

    /// One `peek` used to decide the route, so an upgrade split across
    /// segments was answered as plain HTTP.
    #[test]
    fn a_request_head_that_arrives_in_pieces_is_read_whole() {
        let (request, _) = exchange(&[&UPGRADE[..20], &UPGRADE[20..21], &UPGRADE[21..]]);
        assert!(matches!(request, Ok(Request::Upgrade(_))));
    }

    #[test]
    fn a_stalled_head_times_out_as_a_whole() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let _client = thread::spawn(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            for _ in 0..20 {
                if stream.write_all(b"X").is_err() {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
        });
        let (mut stream, _) = listener.accept().unwrap();
        let started = Instant::now();
        let result = read_request(&mut stream, Duration::from_millis(300));
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_millis(900));
    }

    #[test]
    fn malformed_upgrades_are_bad_requests() {
        let base = UPGRADE.replace("Origin", "X-Origin");
        for bad in [
            base.replace("GET", "POST"),
            base.replace("HTTP/1.1", "HTTP/1.0"),
            base.replace("keep-alive, Upgrade", "keep-alive"),
            base.replace("Version: 13", "Version: 8"),
            base.replace("dGhlIHNhbXBsZSBub25jZQ==", "dGhlIHNhbXBsZSBub25jZQ"),
            base.replace("dGhlIHNhbXBsZSBub25jZQ==", "dGhlIHNhbXBsZSBub25jZR=="),
            base.replace("dGhlIHNhbXBsZSBub25jZQ==", "dGhlIHNhbXBsZSBub25j*Q=="),
            base.replace(
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n",
            ),
        ] {
            assert_eq!(
                parse(bad.as_bytes(), false),
                Request::Http(Answer::BadRequest),
                "{bad}"
            );
        }
        // Bytes sent before any answer: not a client following the handshake.
        assert_eq!(
            parse(base.as_bytes(), true),
            Request::Http(Answer::BadRequest)
        );
    }

    #[test]
    fn two_origins_count_as_none() {
        let doubled = UPGRADE.replace(
            "Origin:",
            "Origin: chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba\r\nOrigin:",
        );
        let Request::Upgrade(upgrade) = parse(doubled.as_bytes(), false) else {
            panic!("still an upgrade");
        };
        assert_eq!(upgrade.origin, "");
    }

    #[test]
    fn sha1_matches_the_standard_vectors() {
        let hex =
            |digest: [u8; 20]| -> String { digest.iter().map(|b| format!("{b:02x}")).collect() };
        assert_eq!(hex(sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            hex(sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hex(sha1(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        assert_eq!(
            hex(sha1(&vec![b'a'; 1_000_000])),
            "34aa973cd4c4daa4f61eeb2bdbad27316534016f"
        );
    }
}
