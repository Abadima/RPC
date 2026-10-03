//! Desktop's local socket (Linux and macOS): the CLI's way in, and the
//! single-instance check. It lives in a directory only this user can open
//! (see `config::create_private_dir`), so unlike the `127.0.0.1` port, no
//! other local user and no web page can reach it at all. Browsers never use
//! it.
//!
//! Every frame is a 4-byte little-endian length and that many bytes of JSON:
//! one control request, one response (`control.rs`).

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

use crate::app::config::AppPaths;
use crate::app::control::{self, ControlRequest, ControlResponse, read_frame, write_frame};
use crate::app::hub::Hub;
use crate::link::session::HANDSHAKE_TIMEOUT;

/// Each open connection is a thread; the CLI makes one at a time.
const MAX_CONNECTIONS: usize = 8;

/// `$XDG_RUNTIME_DIR/parousia/desktop.sock` on Linux.
pub fn socket_path(paths: &AppPaths) -> PathBuf {
    paths.runtime_dir.join("desktop.sock")
}

/// The control socket, bound, and the lock that makes this the one Desktop.
pub struct Server {
    listener: UnixListener,
    /// Held for as long as the process runs: the kernel lets go of it however
    /// the process ends.
    _lock: File,
}

/// `AddrInUse` when another Desktop is running.
pub fn claim(paths: &AppPaths) -> io::Result<Server> {
    claim_in(&paths.runtime_dir)
}

pub fn start(server: Server, hub: Arc<Hub>) {
    thread::spawn(move || {
        // The whole `Server` moves here (a closure would take only the field
        // it names), so the lock lasts as long as the serving does: always.
        let Server { listener, _lock } = server;
        serve(listener, hub);
    });
}

/// Sends one request to the running Desktop.
pub fn send(request: &ControlRequest) -> io::Result<ControlResponse> {
    let paths = AppPaths::locate()?;
    self::request(&socket_path(&paths), request)
}

/// Removes the socket so the next start doesn't have to probe it.
pub fn release() {
    if let Ok(paths) = AppPaths::locate() {
        let _ = fs::remove_file(socket_path(&paths));
    }
}

fn already_running() -> io::Error {
    io::Error::new(
        io::ErrorKind::AddrInUse,
        "another Parousia Desktop is already running",
    )
}

/// Locks `desktop.lock` in `dir`, then binds `desktop.sock` there. The lock
/// is the single-instance check: of two Desktops starting at once, only one
/// gets it, where checking the socket alone let both find nothing, and the
/// second replace the first's socket. Under the lock, a socket file nobody
/// answers on was left by a crash and is replaced; one that answers belongs
/// to a Desktop from before the lock existed.
fn claim_in(dir: &Path) -> io::Result<Server> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(false);
    super::fs::owner_only(&mut options);
    let lock = options.open(dir.join("desktop.lock"))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Err(already_running()),
        Err(TryLockError::Error(err)) => return Err(err),
    }
    let path = dir.join("desktop.sock");
    if UnixStream::connect(&path).is_ok() {
        return Err(already_running());
    }
    match fs::remove_file(&path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
        _ => {}
    }
    let listener = UnixListener::bind(&path)?;
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(Server {
        listener,
        _lock: lock,
    })
}

pub fn serve(listener: UnixListener, hub: Arc<Hub>) {
    let open = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming().flatten() {
        if open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            open.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let (hub, open) = (Arc::clone(&hub), Arc::clone(&open));
        thread::spawn(move || {
            handle(stream, &hub);
            open.fetch_sub(1, Ordering::SeqCst);
        });
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::config::tests::temp_dir;
    use crate::app::hub::tests::{OTHER, test_hub};

    fn serve_hub(hub: Arc<Hub>) -> std::path::PathBuf {
        let dir = temp_dir("ipc");
        let server = claim_in(&dir).unwrap();
        thread::spawn(move || {
            let _lock = server._lock;
            serve(server.listener, hub);
        });
        dir.join("desktop.sock")
    }

    #[test]
    fn the_socket_is_owner_only_and_a_second_desktop_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let path = serve_hub(Arc::new(test_hub()));
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir = path.parent().unwrap();
        assert_eq!(
            claim_in(dir).err().map(|e| e.kind()),
            Some(io::ErrorKind::AddrInUse)
        );
    }

    #[test]
    fn a_stale_socket_file_is_replaced() {
        let dir = temp_dir("ipc-stale");
        let path = dir.join("desktop.sock");
        drop(UnixListener::bind(&path).unwrap());
        assert!(path.exists());
        assert!(claim_in(&dir).is_ok());
    }

    /// Before the lock, both could find no socket, and the second removed the
    /// first's and bound its own: two Desktops, and the CLI reaching the one
    /// that was about to exit.
    #[test]
    fn of_desktops_starting_together_exactly_one_gets_the_socket() {
        for _ in 0..20 {
            let dir = temp_dir("ipc-race");
            let barrier = Arc::new(std::sync::Barrier::new(8));
            let claims: Vec<_> = (0..8)
                .map(|_| {
                    let (dir, barrier) = (dir.clone(), Arc::clone(&barrier));
                    thread::spawn(move || {
                        barrier.wait();
                        claim_in(&dir)
                    })
                })
                .collect();
            let results: Vec<_> = claims.into_iter().map(|c| c.join().unwrap()).collect();
            let won = results.iter().filter(|r| r.is_ok()).count();
            assert_eq!(won, 1);
            assert!(results.iter().all(|r| match r {
                Ok(_) => true,
                Err(err) => err.kind() == io::ErrorKind::AddrInUse,
            }));
            drop(results);
            fs::remove_dir_all(dir).ok();
        }
    }

    /// The lock, not just the socket answering, keeps a second Desktop out
    /// while the first runs: with the socket file gone, it's all there is.
    #[test]
    fn a_running_desktop_keeps_its_lock() {
        let dir = temp_dir("ipc-held");
        start(claim_in(&dir).unwrap(), Arc::new(test_hub()));
        fs::remove_file(dir.join("desktop.sock")).unwrap();
        assert_eq!(
            claim_in(&dir).err().map(|e| e.kind()),
            Some(io::ErrorKind::AddrInUse)
        );
    }

    #[test]
    fn the_lock_goes_with_the_desktop_that_held_it() {
        let dir = temp_dir("ipc-relock");
        let first = claim_in(&dir).unwrap();
        assert!(claim_in(&dir).is_err());
        drop(first);
        assert!(claim_in(&dir).is_ok());
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
            r#"{"type":"hello","protocolVersion":1,"version":"1.0.0","name":"Chromium"}"#,
        ] {
            let mut stream = UnixStream::connect(&path).unwrap();
            write_frame(&mut stream, first).unwrap();
            assert_eq!(read_frame(&mut stream).unwrap(), None, "{first}");
        }
    }
}
