//! Desktop's local socket (Unix only for now): the CLI's way in, and the
//! single-instance check. It lives in a directory only this user can open
//! (see `config::create_private_dir`), so unlike the `127.0.0.1` port, no
//! other local user and no web page can reach it at all. Browsers never use
//! it.
//!
//! Every frame is a 4-byte little-endian length and that many bytes of JSON:
//! one control request, one response (`control.rs`).

use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::control::{self, ControlRequest, ControlResponse};
use crate::hub::Hub;
use crate::session::{HANDSHAKE_TIMEOUT, MAX_MESSAGE_SIZE};

/// Binds the socket, first making sure it isn't a live one. A socket file
/// that still answers means another Desktop is running; one that doesn't is
/// left over from a crash and replaced.
pub fn bind(path: &Path) -> io::Result<UnixListener> {
    if UnixStream::connect(path).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            "another Parousia Desktop is already running",
        ));
    }
    match fs::remove_file(path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
        _ => {}
    }
    let listener = UnixListener::bind(path)?;
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(listener)
}

pub fn serve(listener: UnixListener, hub: Arc<Hub>) {
    for stream in listener.incoming().flatten() {
        let hub = Arc::clone(&hub);
        thread::spawn(move || handle(stream, &hub));
    }
}

fn handle(mut stream: UnixStream, hub: &Hub) {
    if stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).is_err() {
        return;
    }
    let Ok(Some(frame)) = read_frame(&mut stream) else {
        return;
    };
    let Ok(request) = serde_json::from_str::<ControlRequest>(&frame) else {
        return;
    };
    let response = control::handle(request, hub);
    let json = serde_json::to_string(&response).expect("ControlResponse always serializes");
    let _ = write_frame(&mut stream, &json);
}

pub fn request(socket_path: &Path, request: &ControlRequest) -> io::Result<ControlResponse> {
    let mut stream = UnixStream::connect(socket_path).map_err(|err| {
        io::Error::new(
            err.kind(),
            format!(
                "Parousia Desktop isn't running (no socket at {})",
                socket_path.display()
            ),
        )
    })?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let json = serde_json::to_string(request).map_err(io::Error::other)?;
    write_frame(&mut stream, &json)?;
    let reply = read_frame(&mut stream)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Desktop closed the connection",
        )
    })?;
    serde_json::from_str(&reply).map_err(io::Error::other)
}

/// `Ok(None)` on a clean end of stream between frames.
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<String>> {
    let mut len = [0u8; 4];
    match reader.read_exact(&mut len) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err),
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_MESSAGE_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    String::from_utf8(body)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame is not UTF-8"))
}

pub fn write_frame(writer: &mut impl Write, text: &str) -> io::Result<()> {
    if text.len() > MAX_MESSAGE_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let len = u32::try_from(text.len()).expect("bounded by MAX_MESSAGE_SIZE");
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(text.as_bytes())?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::tests::temp_dir;
    use crate::hub::tests::{OTHER, test_hub};

    fn serve_hub(hub: Arc<Hub>) -> std::path::PathBuf {
        let path = temp_dir("ipc").join("desktop.sock");
        let listener = bind(&path).unwrap();
        thread::spawn(move || serve(listener, hub));
        path
    }

    #[test]
    fn frames_round_trip_and_oversized_ones_are_refused() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, r#"{"a":1}"#).unwrap();
        assert_eq!(&buffer[..4], &7u32.to_le_bytes());
        assert_eq!(
            read_frame(&mut buffer.as_slice()).unwrap().as_deref(),
            Some(r#"{"a":1}"#)
        );
        assert_eq!(read_frame(&mut [].as_slice()).unwrap(), None);

        let mut huge = ((MAX_MESSAGE_SIZE + 1) as u32).to_le_bytes().to_vec();
        huge.extend(std::iter::repeat_n(b'x', 8));
        assert_eq!(
            read_frame(&mut huge.as_slice()).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(write_frame(&mut Vec::new(), &"x".repeat(MAX_MESSAGE_SIZE + 1)).is_err());
    }

    #[test]
    fn the_socket_is_owner_only_and_a_second_desktop_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let path = serve_hub(Arc::new(test_hub()));
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(bind(&path).unwrap_err().kind(), io::ErrorKind::AddrInUse);
    }

    #[test]
    fn a_stale_socket_file_is_replaced() {
        let path = temp_dir("ipc-stale").join("desktop.sock");
        drop(UnixListener::bind(&path).unwrap());
        assert!(path.exists());
        assert!(bind(&path).is_ok());
    }

    #[test]
    fn control_requests_work_over_the_socket() {
        let hub = Arc::new(test_hub());
        let path = serve_hub(Arc::clone(&hub));
        let response = request(
            &path,
            &ControlRequest::Allow {
                origin: OTHER.to_string(),
            },
        )
        .unwrap();
        assert!(
            matches!(response, ControlResponse::Status { status } if status.settings.allowed_origins.contains(&OTHER.to_string()))
        );
    }

    /// Only control requests get an answer; the session protocol never runs
    /// on this socket.
    #[test]
    fn anything_but_a_control_request_is_dropped() {
        let path = serve_hub(Arc::new(test_hub()));
        for first in [
            "{}",
            "not json",
            r#"{"control":"format-disk"}"#,
            r#"{"type":"hello","protocolVersion":6,"name":"Chromium"}"#,
        ] {
            let mut stream = UnixStream::connect(&path).unwrap();
            write_frame(&mut stream, first).unwrap();
            assert_eq!(read_frame(&mut stream).unwrap(), None, "{first}");
        }
    }
}
