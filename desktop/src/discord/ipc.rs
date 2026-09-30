//! The Discord app's local RPC transport: a Unix socket (Linux, macOS) or a
//! named pipe (Windows) called `discord-ipc-0` to `discord-ipc-9`, carrying
//! frames of an 8-byte header (opcode, then body length, both little-endian
//! `u32`) and a JSON body. That's the whole format, so there's no crate for it.

use std::io::{self, Read, Write};
#[cfg(unix)]
use std::path::PathBuf;

pub const OP_HANDSHAKE: u32 = 0;
pub const OP_FRAME: u32 = 1;
pub const OP_CLOSE: u32 = 2;
pub const OP_PING: u32 = 3;
pub const OP_PONG: u32 = 4;

/// Discord's replies are a few KiB at most (`READY` carries the user); a
/// bigger frame isn't worth reading.
pub const MAX_FRAME: usize = 64 * 1024;

pub fn encode(op: u32, body: &[u8]) -> io::Result<Vec<u8>> {
    let len = u32::try_from(body.len())
        .ok()
        .filter(|&len| len as usize <= MAX_FRAME)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "frame too large"))?;
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&op.to_le_bytes());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(body);
    Ok(frame)
}

pub fn read_frame(reader: &mut impl Read) -> io::Result<(u32, Vec<u8>)> {
    let mut header = [0u8; 8];
    reader.read_exact(&mut header)?;
    let [a, b, c, d, e, f, g, h] = header;
    let op = u32::from_le_bytes([a, b, c, d]);
    let len = u32::from_le_bytes([e, f, g, h]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok((op, body))
}

/// What arrives from Discord, delivered to the adapter's queue.
#[derive(Debug)]
pub enum Incoming {
    Frame(u32, Vec<u8>),
    Closed,
}

pub type Deliver = Box<dyn Fn(Incoming) + Send>;

/// Where to look for Discord.
#[derive(Debug, Clone)]
pub struct Endpoints {
    #[cfg(unix)]
    dirs: Vec<PathBuf>,
    /// Only sockets this OS user owns are used: `/tmp`, a fallback, is
    /// shared, and another user's socket there could pose as Discord.
    #[cfg(unix)]
    uid: Option<u32>,
}

/// Where Discord and its sandboxed packages put the socket, under each base
/// directory: its own, then Flatpak's and Snap's per-app directories.
#[cfg(unix)]
const APP_DIRS: [&str; 5] = [
    "",
    "app/com.discordapp.Discord",
    "app/com.discordapp.DiscordCanary",
    "snap.discord",
    "snap.discord-canary",
];

impl Endpoints {
    /// `uid` is this user's, where it's known (Unix).
    pub fn discover(uid: Option<u32>) -> Self {
        #[cfg(unix)]
        {
            Self {
                dirs: candidate_dirs(|name| std::env::var_os(name)),
                uid,
            }
        }
        #[cfg(not(unix))]
        {
            let _ = uid;
            Self {}
        }
    }

    #[cfg(all(test, unix))]
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
#[cfg(unix)]
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
    #[cfg(unix)]
    stream: std::os::unix::net::UnixStream,
    #[cfg(windows)]
    pipe: std::fs::File,
    #[cfg(windows)]
    deliver: Deliver,
}

impl Link {
    /// Sends one frame. A handshake or command always gets exactly one
    /// reply, which reaches `deliver` (see `open`).
    pub fn send(&mut self, op: u32, body: &[u8]) -> io::Result<()> {
        let frame = encode(op, body)?;
        #[cfg(unix)]
        {
            self.stream.write_all(&frame)
        }
        #[cfg(windows)]
        {
            self.pipe.write_all(&frame)?;
            if op == OP_PONG {
                return Ok(());
            }
            // See `open`: the reply is read here, answering pings on the way.
            loop {
                match read_frame(&mut self.pipe) {
                    Ok((OP_PING, ping)) => self.pipe.write_all(&encode(OP_PONG, &ping)?)?,
                    Ok((op, reply)) => {
                        (self.deliver)(Incoming::Frame(op, reply));
                        return Ok(());
                    }
                    Err(err) => {
                        (self.deliver)(Incoming::Closed);
                        return Err(err);
                    }
                }
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = frame;
            Err(io::ErrorKind::Unsupported.into())
        }
    }
}

#[cfg(unix)]
impl Drop for Link {
    /// Also ends the reader thread, which then reports `Closed` for a
    /// connection the adapter has already forgotten.
    fn drop(&mut self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

/// Connects to the first Discord that answers.
///
/// On Unix a reader thread hands every frame to `deliver`, then `Closed`
/// once Discord goes away, so a restart is noticed at once. A synchronous
/// Windows pipe can't be read on one thread while another writes to it (the
/// write waits for the read), so there replies are read right after each
/// request instead, and Discord quitting is noticed at the next update.
pub fn open(endpoints: &Endpoints, deliver: Deliver) -> io::Result<Link> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        use std::os::unix::net::UnixStream;

        for dir in endpoints.dirs.iter().filter(|dir| dir.is_dir()) {
            for index in 0..10 {
                let path = dir.join(format!("discord-ipc-{index}"));
                let ours = std::fs::metadata(&path).is_ok_and(|meta| {
                    meta.file_type().is_socket()
                        && endpoints.uid.is_none_or(|uid| meta.uid() == uid)
                });
                if !ours {
                    continue;
                }
                let Ok(stream) = UnixStream::connect(&path) else {
                    continue;
                };
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
    #[cfg(windows)]
    {
        let _ = endpoints;
        for index in 0..10 {
            let path = format!(r"\\.\pipe\discord-ipc-{index}");
            if let Ok(pipe) = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
            {
                return Ok(Link { pipe, deliver });
            }
        }
        Err(io::ErrorKind::NotFound.into())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (endpoints, deliver);
        Err(io::ErrorKind::Unsupported.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_oversized_ones_are_refused() {
        let frame = encode(OP_FRAME, br#"{"a":1}"#).unwrap();
        assert_eq!(&frame[..8], &[1, 0, 0, 0, 7, 0, 0, 0]);
        let (op, body) = read_frame(&mut frame.as_slice()).unwrap();
        assert_eq!((op, body.as_slice()), (OP_FRAME, br#"{"a":1}"#.as_slice()));

        let mut huge = OP_FRAME.to_le_bytes().to_vec();
        huge.extend_from_slice(&((MAX_FRAME + 1) as u32).to_le_bytes());
        assert_eq!(
            read_frame(&mut huge.as_slice()).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(encode(OP_FRAME, &vec![b'x'; MAX_FRAME + 1]).is_err());
        // A truncated frame is an error, not a short read.
        assert!(read_frame(&mut &frame[..10]).is_err());
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn only_this_users_sockets_are_used() {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::net::UnixListener;

        let dir = crate::config::tests::temp_dir("discord-owner");
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
}
