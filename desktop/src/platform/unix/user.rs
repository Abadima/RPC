//! Which OS user this process runs as, and which one is on the other end of a
//! Unix socket, both as the kernel has them. A socket's peer is the user the
//! process that made its listening end ran as, so a path that was swapped for
//! someone else's socket between a check of the file and the connect is still
//! caught. (std's `UnixStream::peer_cred` isn't stable yet, and the C library
//! these come from is the one std already links.)

use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;

unsafe extern "C" {
    /// Takes nothing and can't fail.
    safe fn geteuid() -> u32;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn getsockopt(
        fd: i32,
        level: i32,
        name: i32,
        value: *mut std::ffi::c_void,
        len: *mut u32,
    ) -> i32;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    fn getpeereid(fd: i32, uid: *mut u32, gid: *mut u32) -> i32;
}

/// The effective uid: whose files and sockets this process may use.
pub fn current_uid() -> u32 {
    geteuid()
}

/// The uid of the process listening at the other end of `stream`.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    // `SOL_SOCKET` and `SO_PEERCRED`: most architectures share one numbering,
    // and these three have their own.
    #[cfg(any(
        target_arch = "mips",
        target_arch = "mips64",
        target_arch = "mips32r6",
        target_arch = "mips64r6"
    ))]
    const LEVEL_AND_NAME: (i32, i32) = (0xffff, 18);
    #[cfg(any(target_arch = "sparc", target_arch = "sparc64"))]
    const LEVEL_AND_NAME: (i32, i32) = (0xffff, 0x40);
    #[cfg(any(target_arch = "powerpc", target_arch = "powerpc64"))]
    const LEVEL_AND_NAME: (i32, i32) = (1, 21);
    #[cfg(not(any(
        target_arch = "mips",
        target_arch = "mips64",
        target_arch = "mips32r6",
        target_arch = "mips64r6",
        target_arch = "sparc",
        target_arch = "sparc64",
        target_arch = "powerpc",
        target_arch = "powerpc64"
    )))]
    const LEVEL_AND_NAME: (i32, i32) = (1, 17);

    /// `struct ucred`, laid out the same on every Linux architecture.
    #[repr(C)]
    struct Ucred {
        pid: i32,
        uid: u32,
        gid: u32,
    }
    let mut cred = Ucred {
        pid: 0,
        uid: u32::MAX,
        gid: u32::MAX,
    };
    let mut len = size_of::<Ucred>() as u32;
    let (level, name) = LEVEL_AND_NAME;
    // SAFETY: the descriptor is open for the call, and `cred` and `len` are
    // valid for writes of the size `len` says.
    let result = unsafe {
        getsockopt(
            stream.as_raw_fd(),
            level,
            name,
            (&raw mut cred).cast(),
            &mut len,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if len as usize != size_of::<Ucred>() {
        return Err(io::Error::other("the kernel gave no peer credentials"));
    }
    Ok(cred.uid)
}

/// The uid of the process listening at the other end of `stream`.
#[cfg(not(any(target_os = "linux", target_os = "android")))]
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let (mut uid, mut gid) = (u32::MAX, u32::MAX);
    // SAFETY: the descriptor is open for the call, and both outputs are valid for writes.
    if unsafe { getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

/// Whether the other end of `stream` is `uid`'s; an error counts as no.
pub fn peer_is(stream: &UnixStream, uid: u32) -> bool {
    peer_uid(stream).is_ok_and(|peer| peer == uid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::net::UnixListener;

    #[test]
    fn this_user_is_whoever_owns_what_this_process_creates() {
        let dir = crate::app::config::tests::temp_dir("uid");
        assert_eq!(std::fs::metadata(&dir).unwrap().uid(), current_uid());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_peer_is_known_from_the_socket_not_its_path() {
        let (a, b) = UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&a).unwrap(), current_uid());
        assert!(peer_is(&b, current_uid()));
        assert!(!peer_is(&b, current_uid().wrapping_add(1)));

        let dir = crate::app::config::tests::temp_dir("peer-uid");
        let path = dir.join("socket");
        let _listener = UnixListener::bind(&path).unwrap();
        let client = UnixStream::connect(&path).unwrap();
        // Gone from the file system, still answered for by the kernel.
        std::fs::remove_file(&path).unwrap();
        assert_eq!(peer_uid(&client).unwrap(), current_uid());
        std::fs::remove_dir_all(dir).ok();
    }
}
