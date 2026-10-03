//! What Linux and macOS share: Desktop's control socket, Discord's socket,
//! who owns a socket's other end, and owner-only file permissions.

pub mod control;
pub mod discord;
pub mod user;

/// Only Windows' GUI-subsystem release build has no console of its own.
pub fn attach_parent_console() {}

/// Where there's a terminal, the message was already printed to it.
pub fn alert(message: &str) {
    let _ = message;
}

pub mod fs {
    use std::fs::{self, OpenOptions};
    use std::io;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    /// `0700`, tightening a directory that already exists with looser
    /// permissions.
    pub fn restrict_dir(path: &Path) -> io::Result<()> {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
    }

    /// New files readable and writable by this user only (`0600`).
    pub fn owner_only(options: &mut OpenOptions) {
        options.mode(0o600);
    }
}
