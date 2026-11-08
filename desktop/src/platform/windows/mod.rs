//! Windows. "Another OS user" is decided by the user SID in a process's token
//! (`user.rs`): for loopback connections, the control pipe, and Discord's pipe.

pub mod control;
pub mod discord;
mod peer;
pub mod pipe;
#[cfg(test)]
mod port;
mod startup;
mod sys;
mod tray;
mod user;

use std::sync::Arc;

use crate::app::hub::Hub;

use super::TrayExit;

pub use peer::loopback_owner;
pub use sys::{alert, attach_parent_console};

pub const VERIFIES_PEERS: bool = true;

/// Who holds the port isn't looked up here yet.
pub fn listener_owner(port: u16) -> super::Owner {
    let _ = port;
    super::Owner::Unknown
}

pub fn run_tray(hub: Arc<Hub>) -> Option<TrayExit> {
    Some(tray::run(hub))
}

pub mod fs {
    use std::fs::OpenOptions;
    use std::io;
    use std::path::Path;

    /// `%APPDATA%` is already private to this user.
    pub fn restrict_dir(path: &Path) -> io::Result<()> {
        let _ = path;
        Ok(())
    }

    pub fn owner_only(options: &mut OpenOptions) {
        let _ = options;
    }
}
