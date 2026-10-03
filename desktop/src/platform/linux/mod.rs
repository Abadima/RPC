//! Linux: the loopback peer's owner from `/proc/net/tcp`, and the
//! StatusNotifierItem tray and notifications over the session bus.

mod peer;
mod tray;

use std::sync::Arc;

use crate::app::hub::Hub;

use super::TrayExit;

pub use peer::{listener_owner, loopback_owner};

/// Linux can tell which OS user a loopback connection comes from, so a
/// WebSocket connection there may change settings once verified.
pub const VERIFIES_PEERS: bool = true;

/// Runs the tray on this thread until Quit, or returns why it couldn't.
pub fn run_tray(hub: Arc<Hub>) -> Option<TrayExit> {
    Some(tray::run(hub))
}
