//! Where the Discord app listens on Windows: `\\.\pipe\discord-ipc-0` to `9`. Any
//! account can create such a pipe, so Desktop connects only to one whose server
//! process runs as this user, and as an anonymous client that can't be
//! impersonated.

use std::io::{self, Write};
use std::sync::Arc;
use std::time::Duration;

use crate::adapters::discord::ipc::{Deliver, Incoming, READ_BUFFER, encode, read_frame};

use super::pipe::{self, Pipe};
use super::user::is_this_user;

/// A write to Discord that takes longer than this means it has stopped listening.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct Endpoints {
    prefix: String,
}

impl Endpoints {
    /// `PAROUSIA_DISCORD_IPC_PIPE` replaces `\\.\pipe\discord-ipc-` as what the
    /// number is added to: so end-to-end checks can point Desktop at a fake
    /// Discord (or none) and never at the real one.
    pub fn discover() -> Self {
        let prefix = std::env::var("PAROUSIA_DISCORD_IPC_PIPE")
            .ok()
            .filter(|value| value.starts_with(r"\\.\pipe\") && value.len() < 200)
            .unwrap_or_else(|| r"\\.\pipe\discord-ipc-".to_string());
        Self { prefix }
    }

    #[cfg(test)]
    pub fn at(prefix: String) -> Self {
        Self { prefix }
    }
}

/// An open connection to Discord. Writes happen on the adapter's thread.
pub struct Link {
    pipe: Arc<Pipe>,
}

impl Link {
    /// Sends one frame. A handshake or command always gets exactly one
    /// reply, which reaches `deliver` (see `open`).
    pub fn send(&mut self, op: u32, body: &[u8]) -> io::Result<()> {
        self.pipe
            .io(Some(WRITE_TIMEOUT))
            .write_all(&encode(op, body)?)
    }
}

impl Drop for Link {
    /// Also ends the reader thread, which then reports `Closed` for a
    /// connection the adapter has already forgotten.
    fn drop(&mut self) {
        self.pipe.cancel();
    }
}

/// Connects to the first Discord that answers. A reader thread hands every
/// frame to `deliver`, then `Closed` once Discord goes away, so a restart is
/// noticed at once.
pub fn open(endpoints: &Endpoints, deliver: Deliver) -> io::Result<Link> {
    for index in 0..10 {
        let Ok(pipe) = pipe::open_client(&format!("{}{index}", endpoints.prefix)) else {
            continue;
        };
        // Only this user's Discord: nothing is sent to anything else.
        if !pipe.server_process_id().is_some_and(is_this_user) {
            continue;
        }
        let pipe = Arc::new(pipe);
        let reader = Arc::clone(&pipe);
        std::thread::Builder::new()
            .name("discord-ipc".into())
            .spawn(move || {
                let mut io = io::BufReader::with_capacity(READ_BUFFER, reader.io(None));
                while let Ok((op, body)) = read_frame(&mut io) {
                    deliver(Incoming::Frame(op, body));
                }
                deliver(Incoming::Closed);
            })?;
        return Ok(Link { pipe });
    }
    Err(io::ErrorKind::NotFound.into())
}
