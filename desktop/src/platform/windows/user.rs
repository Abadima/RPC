//! Which Windows user a process runs as. Everything Desktop checks about
//! "another OS user" on Windows comes down to this: the user SID in a
//! process's token, compared with this process's own. (A user's own elevated
//! processes carry the same SID.)

use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{
    EqualSid, GetLengthSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Closes the handle when dropped.
pub struct Handle(pub HANDLE);

// SAFETY: a kernel handle is a plain number that any thread may use; what's
// done with it concurrently is the owner's to order.
unsafe impl Send for Handle {}
// SAFETY: as above.
unsafe impl Sync for Handle {}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle is owned and closed once.
        unsafe { CloseHandle(self.0) };
    }
}

/// A user's SID, as the bytes Windows hands out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sid(Vec<u8>);

impl Sid {
    /// For the calls that take a `PSID`; valid while `self` is.
    pub fn as_ptr(&self) -> *mut c_void {
        self.0.as_ptr().cast_mut().cast()
    }

    /// `S-1-5-21-...`, the form security descriptors and pipe names use.
    pub fn to_text(&self) -> Option<String> {
        let mut text: *mut u16 = null_mut();
        // SAFETY: the SID is valid for the call; on success `text` is a
        // NUL-terminated string Windows allocated, freed below.
        unsafe {
            if ConvertSidToStringSidW(self.as_ptr(), &mut text) == 0 || text.is_null() {
                return None;
            }
            let len = (0..).take_while(|&i| *text.add(i) != 0).count();
            let result = String::from_utf16(std::slice::from_raw_parts(text, len)).ok();
            LocalFree(text.cast());
            result
        }
    }

    fn equals(&self, other: &Sid) -> bool {
        // SAFETY: both point at valid SIDs for the call.
        unsafe { EqualSid(self.as_ptr(), other.as_ptr()) != 0 }
    }
}

/// The user in a token opened for `TOKEN_QUERY`.
fn token_user(token: HANDLE) -> Option<Sid> {
    let mut size = 0u32;
    // SAFETY: the first call only asks how much room the answer needs.
    unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut size) };
    if size == 0 {
        return None;
    }
    // Aligned for the TOKEN_USER the buffer starts with.
    let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
    // SAFETY: the buffer is at least `size` bytes; on success it holds a
    // TOKEN_USER whose SID points inside it, which is copied out before it's dropped.
    unsafe {
        if GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        ) == 0
        {
            return None;
        }
        let user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
        let sid = user.User.Sid;
        let len = GetLengthSid(sid) as usize;
        Some(Sid(
            std::slice::from_raw_parts(sid.cast::<u8>(), len).to_vec()
        ))
    }
}

/// The user this process runs as. Read once: it can't change.
pub fn this_user() -> Option<&'static Sid> {
    static SID: OnceLock<Option<Sid>> = OnceLock::new();
    SID.get_or_init(|| {
        let mut token: HANDLE = null_mut();
        // SAFETY: the pseudo-handle for this process needs no closing; the
        // token it opens is owned by the guard.
        unsafe {
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return None;
            }
        }
        let token = Handle(token);
        token_user(token.0)
    })
    .as_ref()
}

/// The user process `pid` runs as, or `None` when it can't be read: the
/// process is gone, or it belongs to someone this user has no access to.
pub fn process_user(pid: u32) -> Option<Sid> {
    // SAFETY: plain Win32 calls; every handle is checked and owned by a guard.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let process = Handle(process);
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(process.0, TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let token = Handle(token);
        token_user(token.0)
    }
}

/// Whether process `pid` runs as this user. Not being able to tell is a
/// "no": a process this user can't even inspect isn't one of its own.
pub fn is_this_user(pid: u32) -> bool {
    match (this_user(), process_user(pid)) {
        (Some(me), Some(them)) => me.equals(&them),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_runs_as_this_user() {
        let me = this_user().expect("a token user");
        assert!(me.to_text().unwrap().starts_with("S-1-5-"));
        assert_eq!(process_user(std::process::id()).as_ref(), Some(me));
        assert!(is_this_user(std::process::id()));
    }

    #[test]
    fn a_process_that_isnt_there_is_not_this_user() {
        // Process ids are multiples of 4; 2 is never one.
        assert_eq!(process_user(2), None);
        assert!(!is_this_user(2));
    }

    /// The System process (always pid 4) is another account's, and a standard
    /// user can't open its token: not being able to tell is "not this user".
    #[test]
    fn the_system_process_is_not_this_user() {
        assert!(!is_this_user(4));
    }

    /// Windows' own processes run as SYSTEM and the service accounts. Any
    /// whose token this user can read must compare as another user.
    #[test]
    fn processes_of_other_accounts_are_other_users() {
        let me = this_user().unwrap();
        let mut others = 0;
        for pid in (4..65_536u32).step_by(4) {
            if let Some(user) = process_user(pid)
                && &user != me
            {
                others += 1;
                assert!(!is_this_user(pid), "pid {pid} runs as {:?}", user.to_text());
            }
        }
        eprintln!("{others} readable processes belong to other accounts");
    }
}
