//! macOS, and any other Unix: no tray yet, and the loopback peer's owner
//! isn't looked up yet (macOS needs `libproc`; see `project/roadmap.md`), so
//! connections are unverified: they may publish presence but not change
//! settings. The console, CLI, and the extension's Settings cover the rest.

use std::net::SocketAddr;
use std::sync::Arc;

use crate::app::hub::Hub;

use super::{Owner, TrayExit};

pub const VERIFIES_PEERS: bool = false;

pub fn loopback_owner(peer: SocketAddr, local: SocketAddr) -> Owner {
    let _ = (peer, local);
    Owner::Unknown
}

pub fn listener_owner(port: u16) -> Owner {
    let _ = port;
    Owner::Unknown
}

pub fn run_tray(hub: Arc<Hub>) -> Option<TrayExit> {
    let _ = hub;
    None
}
