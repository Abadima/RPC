//! Everything that differs by operating system, behind one set of names the
//! rest of Desktop uses: who owns a loopback connection, the tray, Desktop's
//! local control socket, where Discord listens, file permissions, and the
//! Windows console. Each build compiles only its own operating system's
//! directory (`linux`, `windows`, `macos`) plus `unix` on Linux and macOS.
//!
//! "Platform" here means the operating system. The presence platforms
//! (Discord and the rest) are `adapters`.

#[cfg(not(any(unix, windows)))]
compile_error!("Parousia Desktop builds for Linux, macOS (and other Unix), and Windows only");

#[cfg(target_os = "linux")]
mod linux;
#[cfg(all(unix, not(target_os = "linux")))]
mod macos;
#[cfg(any(target_os = "linux", windows))]
mod tray_menu;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::{VERIFIES_PEERS, listener_owner, loopback_owner, run_tray};
#[cfg(all(unix, not(target_os = "linux")))]
pub use macos::{VERIFIES_PEERS, listener_owner, loopback_owner, run_tray};
#[cfg(unix)]
pub use unix::{alert, attach_parent_console, control, discord, fs};
#[cfg(all(windows, test))]
pub use windows::pipe;
#[cfg(windows)]
pub use windows::{
    VERIFIES_PEERS, alert, attach_parent_console, control, discord, fs, listener_owner,
    loopback_owner, run_tray,
};

/// Which OS user is on the other end of a loopback connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    not(any(target_os = "linux", windows)),
    allow(
        dead_code,
        reason = "only Linux and Windows can tell who owns a loopback connection so far"
    )
)]
pub enum Owner {
    ThisUser,
    OtherUser,
    Unknown,
}

/// How the tray ended, where there is one.
#[cfg_attr(
    not(any(target_os = "linux", windows)),
    allow(dead_code, reason = "no tray on this operating system yet")
)]
pub enum TrayExit {
    Quit,
    Unavailable(String),
}
