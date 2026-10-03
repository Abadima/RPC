//! Desktop's control pipe (Windows): the CLI's way in, and the
//! single-instance check, like the socket on Linux and macOS. A named pipe
//! lives in one machine-wide namespace, so what keeps it private is its
//! access list (this user only, never over the network) and a second check on
//! the process behind every connection, on both ends: Desktop serves only this
//! user's processes, and the CLI trusts only this user's Desktop. Browsers
//! never use it.
//!
//! The framing is the Unix socket's (`app/control.rs`): one control request,
//! one response.

use std::io::{self, Read};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crate::app::config::AppPaths;
use crate::app::control::{self, ControlRequest, ControlResponse, read_frame, write_frame};
use crate::app::hub::Hub;
use crate::link::session::HANDSHAKE_TIMEOUT;

use super::pipe::{self, OwnerOnly, Pipe};
use super::user::{is_this_user, this_user};

/// Each open connection is a thread; the CLI makes one at a time.
const MAX_CONNECTIONS: usize = 8;

/// `\\.\pipe\parousia-desktop-<this user's SID>`: one per user, so a
/// second account on the machine has its own.
fn pipe_name() -> io::Result<String> {
    let sid = this_user()
        .and_then(|sid| sid.to_text())
        .ok_or_else(|| io::Error::other("can't tell which Windows user this is"))?;
    Ok(format!(r"\\.\pipe\parousia-desktop-{sid}"))
}

/// The control pipe, created: holding its name is what makes this the one Desktop.
pub struct Server {
    first: Pipe,
    owner: OwnerOnly,
    name: String,
    /// How long a connection has to send its request, and to take the reply.
    timeout: Duration,
}

/// `AddrInUse` when another Desktop is running (or something else holds the
/// name, which the CLI then says).
pub fn claim(paths: &AppPaths) -> io::Result<Server> {
    let _ = paths;
    claim_named(pipe_name()?, HANDSHAKE_TIMEOUT)
}

fn claim_named(name: String, timeout: Duration) -> io::Result<Server> {
    let owner = OwnerOnly::new()?;
    match pipe::create_server(&name, true, &owner) {
        Ok(first) => Ok(Server {
            first,
            owner,
            name,
            timeout,
        }),
        // A first instance is refused, as "access denied", where the name has one already.
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            "another Parousia Desktop is already running",
        )),
        Err(err) => Err(err),
    }
}

pub fn start(server: Server, hub: Arc<Hub>) {
    thread::spawn(move || serve(server, &hub));
}

/// Sends one request to the running Desktop.
pub fn send(request: &ControlRequest) -> io::Result<ControlResponse> {
    self::request(&pipe_name()?, request)
}

/// The pipe goes away with the process: nothing to clean up.
pub fn release() {}

fn serve(server: Server, hub: &Arc<Hub>) {
    let open = Arc::new(AtomicUsize::new(0));
    let mut listening = Some(server.first);
    loop {
        let pipe = match listening.take() {
            Some(pipe) => pipe,
            None => match pipe::create_server(&server.name, false, &server.owner) {
                Ok(pipe) => pipe,
                Err(_) => {
                    thread::sleep(Duration::from_millis(250));
                    continue;
                }
            },
        };
        if pipe.accept(None).is_err() {
            thread::sleep(Duration::from_millis(250));
            continue;
        }
        // The next instance exists before this one is served, so the name is never without one.
        listening = pipe::create_server(&server.name, false, &server.owner).ok();
        if open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            open.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let (hub, open, timeout) = (Arc::clone(hub), Arc::clone(&open), server.timeout);
        thread::spawn(move || {
            handle(&pipe, &hub, timeout);
            open.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

fn handle(pipe: &Pipe, hub: &Hub, timeout: Duration) {
    // The access list already keeps other users out; this looks at the
    // process itself, as the Linux check does for a loopback connection.
    if !pipe.client_process_id().is_some_and(is_this_user) {
        return;
    }
    let deadline = Instant::now() + timeout;
    let mut io = pipe.io_until(deadline);
    let Ok(Some(frame)) = read_frame(&mut io) else {
        return;
    };
    let Ok(request) = serde_json::from_str::<ControlRequest>(&frame) else {
        return;
    };
    let response = control::handle(request, hub);
    let json = serde_json::to_string(&response).expect("ControlResponse always serializes");
    if write_frame(&mut pipe.io_until(deadline), &json).is_err() {
        return;
    }
    // Closing the pipe now could drop the reply before it's read: wait for
    // the client to be done with it (it closes its end), within the deadline.
    let _ = pipe.io_until(deadline).read(&mut [0u8; 1]);
}

fn request(name: &str, request: &ControlRequest) -> io::Result<ControlResponse> {
    let pipe = pipe::open_client(name).map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            io::Error::new(err.kind(), "Parousia Desktop isn't running")
        } else {
            err
        }
    })?;
    if !pipe.server_process_id().is_some_and(is_this_user) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Desktop's pipe is held by a process of another Windows user, so nothing was sent to it",
        ));
    }
    let mut io = pipe.io_until(Instant::now() + Duration::from_secs(5));
    let json = serde_json::to_string(request).map_err(io::Error::other)?;
    write_frame(&mut io, &json)?;
    let reply = read_frame(&mut io)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Desktop closed the connection",
        )
    })?;
    serde_json::from_str(&reply).map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::hub::tests::{OTHER, test_hub};
    use crate::platform::windows::pipe::unique_name;
    use std::io::Write;

    const SHORT: Duration = Duration::from_millis(300);

    fn serve_hub(hub: Arc<Hub>, timeout: Duration) -> String {
        let name = unique_name("control");
        let server = claim_named(name.clone(), timeout).unwrap();
        start(server, hub);
        name
    }

    #[test]
    fn control_requests_work_over_the_pipe() {
        let hub = Arc::new(test_hub());
        let name = serve_hub(Arc::clone(&hub), HANDSHAKE_TIMEOUT);
        // Several in a row: the pipe has an instance ready after each.
        for _ in 0..3 {
            let response = request(
                &name,
                &ControlRequest::Allow {
                    origin: OTHER.to_string(),
                },
            )
            .unwrap();
            assert!(
                matches!(response, ControlResponse::Status { status } if status.settings.allowed_origins.contains(&OTHER.to_string()))
            );
        }
    }

    #[test]
    fn a_second_desktop_is_refused_and_the_first_still_answers() {
        let name = serve_hub(Arc::new(test_hub()), HANDSHAKE_TIMEOUT);
        let err = claim_named(name.clone(), HANDSHAKE_TIMEOUT).err().unwrap();
        assert_eq!(err.kind(), io::ErrorKind::AddrInUse);
        assert!(request(&name, &ControlRequest::Status).is_ok());
    }

    #[test]
    fn nothing_listening_says_desktop_isnt_running() {
        let err = request(&unique_name("absent"), &ControlRequest::Status)
            .err()
            .unwrap();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(err.to_string().contains("isn't running"));
    }

    /// Only control requests get an answer; the session protocol never runs on this pipe.
    #[test]
    fn anything_but_a_control_request_is_dropped() {
        let name = serve_hub(Arc::new(test_hub()), HANDSHAKE_TIMEOUT);
        for first in [
            "{}",
            "not json",
            r#"{"control":"format-disk"}"#,
            r#"{"type":"hello","protocolVersion":1,"version":"1.0.0","name":"Chromium"}"#,
        ] {
            let pipe = pipe::open_client(&name).unwrap();
            let mut io = pipe.io(Some(Duration::from_secs(5)));
            write_frame(&mut io, first).unwrap();
            assert_eq!(read_frame(&mut io).unwrap(), None, "{first}");
        }
    }

    #[test]
    fn silent_and_slow_clients_are_dropped_and_dont_block_the_next() {
        let name = serve_hub(Arc::new(test_hub()), SHORT);
        // More silent connections than the cap, then a dribbler: none holds a thread for long.
        let silent: Vec<Pipe> = (0..MAX_CONNECTIONS + 4)
            .filter_map(|_| pipe::open_client(&name).ok())
            .collect();
        let dribbler = pipe::open_client(&name).unwrap();
        dribbler.io(None).write_all(&[200, 0]).unwrap();
        let started = Instant::now();
        let mut byte = [0u8; 1];
        let ended = dribbler.io(Some(Duration::from_secs(5))).read(&mut byte);
        assert!(matches!(ended, Ok(0) | Err(_)));
        assert!(started.elapsed() < Duration::from_secs(3));
        drop(silent);
        assert!(request(&name, &ControlRequest::Status).is_ok());
    }

    #[test]
    fn a_stalled_reply_doesnt_hold_the_server() {
        // A client that sends a request and never reads the reply: the server lets go at the deadline.
        let name = serve_hub(Arc::new(test_hub()), SHORT);
        let pipe = pipe::open_client(&name).unwrap();
        let json = serde_json::to_string(&ControlRequest::Status).unwrap();
        write_frame(&mut pipe.io(Some(Duration::from_secs(5))), &json).unwrap();
        thread::sleep(SHORT * 2);
        assert!(request(&name, &ControlRequest::Status).is_ok());
    }

    #[test]
    fn the_pipe_name_is_this_users() {
        let name = pipe_name().unwrap();
        assert!(
            name.starts_with(r"\\.\pipe\parousia-desktop-S-1-5-"),
            "{name}"
        );
    }
}
