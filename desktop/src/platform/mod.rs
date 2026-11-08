//! Everything that differs by operating system, behind one set of names. Each
//! build compiles its own OS's directory, plus `unix` on Linux and macOS.
//! "Platform" here is the OS; presence platforms are `adapters`.

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

#[cfg_attr(
    not(any(target_os = "linux", windows)),
    allow(dead_code, reason = "no tray on this operating system yet")
)]
pub enum TrayExit {
    Quit,
    Unavailable(String),
}
