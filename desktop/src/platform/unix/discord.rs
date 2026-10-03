//! Where the Discord app listens on Linux and macOS: a Unix socket called
//! `discord-ipc-0` to `discord-ipc-9` in its runtime or temporary directory,
//! or in the Flatpak or Snap package's own. Framing is the adapter's
//! (`adapters/discord/ipc.rs`).
//!
//! Some of those directories are shared (`/tmp`) or can be made by anyone
//! (`/tmp/snap.discord`), so another user could put a socket there and pose
//! as Discord. Only a socket this user owns is tried, and once connected, the
//! kernel must confirm the process listening on it runs as this user too: a
//! symbolic link in a directory someone else controls can be pointed at this
//! user's socket for the first check and at their own for the connect.

use std::io::{self, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use crate::adapters::discord::ipc::{Deliver, Incoming, encode, read_frame};

use super::user;

/// Where to look for Discord.
#[derive(Debug, Clone)]
pub struct Endpoints {
    dirs: Vec<PathBuf>,
    /// This OS user: only its sockets, served by its processes, are used.
    uid: Option<u32>,
}

/// Where Discord and its sandboxed packages put the socket, under each base
/// directory: its own, then Flatpak's and Snap's per-app directories.
const APP_DIRS: [&str; 5] = [
    "",
    "app/com.discordapp.Discord",
    "app/com.discordapp.DiscordCanary",
    "snap.discord",
    "snap.discord-canary",
];

impl Endpoints {
    pub fn discover() -> Self {
        Self {
            dirs: candidate_dirs(|name| std::env::var_os(name)),
            uid: Some(user::current_uid()),
        }
    }

    #[cfg(test)]
    pub fn at(dir: PathBuf) -> Self {
        Self {
            dirs: vec![dir],
            uid: None,
        }
    }
}

/// Discord uses the first of `$XDG_RUNTIME_DIR`, `$TMPDIR`, `$TMP`, `$TEMP`,
/// `/tmp` that's set; all of them are tried, in that order, in case Discord
/// was started with a different environment.
///
/// `PAROUSIA_DISCORD_IPC_DIR` replaces the search with one directory: for an
/// unusual install, and so end-to-end checks can point Desktop at a fake
/// Discord (or none) and never at the real one.
fn candidate_dirs(env: impl Fn(&str) -> Option<std::ffi::OsString>) -> Vec<PathBuf> {
    if let Some(dir) = env("PAROUSIA_DISCORD_IPC_DIR").filter(|value| !value.is_empty()) {
        return vec![PathBuf::from(dir)];
    }
    let mut bases: Vec<PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .into_iter()
        .filter_map(|name| env(name).filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .collect();
    bases.push(PathBuf::from("/tmp"));
    let mut dirs: Vec<PathBuf> = Vec::new();
    for base in bases {
        for app in APP_DIRS {
            let dir = base.join(app);
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    dirs
}

/// An open connection to Discord. Writes happen on the adapter's thread.
pub struct Link {
    stream: UnixStream,
}

impl Link {
    /// Sends one frame. A handshake or command always gets exactly one
    /// reply, which reaches `deliver` (see `open`).
    pub fn send(&mut self, op: u32, body: &[u8]) -> io::Result<()> {
        self.stream.write_all(&encode(op, body)?)
    }
}

impl Drop for Link {
    /// Also ends the reader thread, which then reports `Closed` for a
    /// connection the adapter has already forgotten.
    fn drop(&mut self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

/// Connects to the first Discord that answers. A reader thread hands every
/// frame to `deliver`, then `Closed` once Discord goes away, so a restart is
/// noticed at once.
pub fn open(endpoints: &Endpoints, deliver: Deliver) -> io::Result<Link> {
    for dir in endpoints.dirs.iter().filter(|dir| dir.is_dir()) {
        for index in 0..10 {
            let path = dir.join(format!("discord-ipc-{index}"));
            let ours = std::fs::metadata(&path).is_ok_and(|meta| {
                meta.file_type().is_socket() && endpoints.uid.is_none_or(|uid| meta.uid() == uid)
            });
            if !ours {
                continue;
            }
            let Ok(stream) = UnixStream::connect(&path) else {
                continue;
            };
            if endpoints
                .uid
                .is_some_and(|uid| !user::peer_is(&stream, uid))
            {
                continue;
            }
            let mut reader = stream.try_clone()?;
            std::thread::Builder::new()
                .name("discord-ipc".into())
                .spawn(move || {
                    while let Ok((op, body)) = read_frame(&mut reader) {
                        deliver(Incoming::Frame(op, body));
                    }
                    deliver(Incoming::Closed);
                })?;
            return Ok(Link { stream });
        }
    }
    Err(io::ErrorKind::NotFound.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_in_every_base_directory_and_in_flatpak_and_snap_ones() {
        let dirs = candidate_dirs(|name| match name {
            "XDG_RUNTIME_DIR" => Some("/run/user/1000".into()),
            "TMPDIR" => Some("".into()),
            "TMP" => Some("/tmp".into()),
            _ => None,
        });
        let dirs: Vec<String> = dirs.iter().map(|d| d.display().to_string()).collect();
        assert_eq!(
            &dirs[..5],
            [
                "/run/user/1000/",
                "/run/user/1000/app/com.discordapp.Discord",
                "/run/user/1000/app/com.discordapp.DiscordCanary",
                "/run/user/1000/snap.discord",
                "/run/user/1000/snap.discord-canary",
            ]
        );
        // `/tmp` is listed once, however many variables point at it.
        assert_eq!(dirs.len(), 10);
        assert!(dirs.contains(&"/tmp/snap.discord".to_string()));

        let pinned = candidate_dirs(|name| match name {
            "PAROUSIA_DISCORD_IPC_DIR" => Some("/tmp/fake-discord".into()),
            _ => Some("/run/user/1000".into()),
        });
        assert_eq!(pinned, [PathBuf::from("/tmp/fake-discord")]);
    }

    #[test]
    fn only_this_users_sockets_are_used() {
        use std::os::unix::net::UnixListener;

        let dir = crate::app::config::tests::temp_dir("discord-owner");
        let _listener = UnixListener::bind(dir.join("discord-ipc-0")).unwrap();
        std::fs::write(dir.join("discord-ipc-1"), b"not a socket").unwrap();
        let me = std::fs::metadata(&dir).unwrap().uid();

        let deliver = || -> Deliver { Box::new(|_| {}) };
        let mut endpoints = Endpoints::at(dir.clone());
        endpoints.uid = Some(me);
        assert!(open(&endpoints, deliver()).is_ok());
        endpoints.uid = Some(me.wrapping_add(1));
        assert_eq!(
            open(&endpoints, deliver()).err().map(|e| e.kind()),
            Some(io::ErrorKind::NotFound)
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// Another user's socket behind a link swapped back and forth with this
    /// user's own: the file passes the owner check whenever it points at
    /// this user's socket, so only asking the kernel who's listening keeps
    /// the swapped-in one out. The system bus, served by its own account,
    /// stands in for another user's socket; without one, there's nothing to
    /// check against.
    #[test]
    fn a_socket_swapped_in_after_the_owner_check_is_refused() {
        use std::os::unix::net::UnixListener;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let other = PathBuf::from("/run/dbus/system_bus_socket");
        let me = user::current_uid();
        let Ok(probe) = UnixStream::connect(&other) else {
            return;
        };
        if user::peer_uid(&probe).map_or(true, |uid| uid == me) {
            return;
        }
        drop(probe);

        let dir = crate::app::config::tests::temp_dir("discord-swap");
        let mine = dir.join("mine");
        let listener = UnixListener::bind(&mine).unwrap();
        std::thread::spawn(move || listener.incoming().for_each(drop));
        let link = dir.join("discord-ipc-0");
        std::os::unix::fs::symlink(&mine, &link).unwrap();

        let stop = Arc::new(AtomicBool::new(false));
        let swapper = {
            let (stop, dir, link, mine) = (Arc::clone(&stop), dir.clone(), link.clone(), mine);
            std::thread::spawn(move || {
                let next = dir.join("next");
                for target in [&other, &mine].into_iter().cycle() {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let _ = std::fs::remove_file(&next);
                    std::os::unix::fs::symlink(target, &next).unwrap();
                    std::fs::rename(&next, &link).unwrap();
                }
            })
        };

        let mut endpoints = Endpoints::at(dir.clone());
        endpoints.uid = Some(me);
        let (mut opened, mut refused) = (0, 0);
        for _ in 0..500 {
            match open(&endpoints, Box::new(|_| {})) {
                Ok(link) => {
                    assert_eq!(user::peer_uid(&link.stream).unwrap(), me);
                    opened += 1;
                }
                Err(_) => refused += 1,
            }
        }
        stop.store(true, Ordering::Relaxed);
        swapper.join().unwrap();
        std::fs::remove_dir_all(dir).ok();
        assert!(
            opened > 0 && refused > 0,
            "{opened} opened, {refused} refused"
        );
    }
}
