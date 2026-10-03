//! Named pipes, opened for overlapped I/O. A synchronous pipe handle can't be
//! read on one thread while another writes to it (the write waits for the
//! read), which is why Discord quitting could only be noticed at the next
//! update. With overlapped I/O a reader thread can wait on Discord's pipe
//! forever while the adapter writes, and a stalled peer costs a timeout, not a
//! stuck thread: every call can be given a deadline, and `cancel` ends a wait
//! from another thread.
//!
//! Both ends use it: Desktop's control pipe (`control.rs`) and the Discord
//! app's (`discord.rs`).

use std::ffi::c_void;
use std::io::{self, Read, Write};
use std::mem::zeroed;
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY,
    ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, GetLastError,
    HANDLE, INVALID_HANDLE_VALUE, LocalFree, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_ANONYMOUS, SECURITY_SQOS_PRESENT, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
    PIPE_WAIT, WaitNamedPipeW,
};
use windows_sys::Win32::System::Threading::{CreateEventW, INFINITE, WaitForSingleObject};

use super::sys::wide;
use super::user::{Handle, this_user};

/// How long to wait for a busy pipe (another client is being served) before
/// giving up on it.
const BUSY_WAIT: Duration = Duration::from_secs(2);

pub struct Pipe {
    handle: Handle,
}

/// An event for one overlapped call to signal.
struct Event(Handle);

impl Event {
    fn new() -> io::Result<Self> {
        // SAFETY: a plain unnamed manual-reset event; checked below.
        let event = unsafe { CreateEventW(null(), 1, 0, null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(Handle(event)))
    }
}

fn os_error(code: u32) -> io::Error {
    io::Error::from_raw_os_error(code as i32)
}

/// The peer went away, or this end was cancelled: what reading calls end of stream.
fn is_closed(code: u32) -> bool {
    matches!(
        code,
        ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA | ERROR_OPERATION_ABORTED
    )
}

fn millis(timeout: Option<Duration>) -> u32 {
    timeout.map_or(INFINITE, |timeout| {
        u32::try_from(timeout.as_millis())
            .unwrap_or(INFINITE - 1)
            .min(INFINITE - 1)
    })
}

impl Pipe {
    fn new(handle: HANDLE) -> Self {
        Self {
            handle: Handle(handle),
        }
    }

    fn raw(&self) -> HANDLE {
        self.handle.0
    }

    /// Runs one overlapped call to completion, or until `timeout`, when it's
    /// cancelled and waited for (its buffers are on the caller's stack).
    /// Returns the bytes transferred. `done` lists errors that mean the call
    /// finished at once without queueing anything.
    fn overlapped(
        &self,
        timeout: Option<Duration>,
        done: &[u32],
        start: impl FnOnce(*mut OVERLAPPED) -> i32,
    ) -> io::Result<u32> {
        let event = Event::new()?;
        // SAFETY: an all-zero OVERLAPPED is how one starts.
        let mut overlapped: OVERLAPPED = unsafe { zeroed() };
        overlapped.hEvent = event.0.0;
        if start(&mut overlapped) == 0 {
            // SAFETY: reads the calling thread's last error, straight after the call.
            let code = unsafe { GetLastError() };
            if done.contains(&code) {
                return Ok(0);
            }
            if code != ERROR_IO_PENDING {
                return Err(os_error(code));
            }
            // SAFETY: the event outlives the wait; `overlapped` is alive until
            // the call completes, which both branches below make sure of.
            let waited = unsafe { WaitForSingleObject(event.0.0, millis(timeout)) };
            if waited != WAIT_OBJECT_0 {
                let mut transferred = 0;
                // SAFETY: cancels this call only, then waits for it to end.
                unsafe {
                    CancelIoEx(self.raw(), &overlapped);
                    GetOverlappedResult(self.raw(), &overlapped, &mut transferred, 1);
                }
                // It may have finished just before the cancel.
                return if transferred > 0 {
                    Ok(transferred)
                } else if waited == WAIT_TIMEOUT {
                    Err(io::ErrorKind::TimedOut.into())
                } else {
                    Err(io::Error::last_os_error())
                };
            }
        }
        let mut transferred = 0;
        // SAFETY: the call has completed, so this only collects its result.
        if unsafe { GetOverlappedResult(self.raw(), &overlapped, &mut transferred, 1) } == 0 {
            // SAFETY: as above.
            return Err(os_error(unsafe { GetLastError() }));
        }
        Ok(transferred)
    }

    /// Ends every wait on this pipe, from any thread: a reader gets an error
    /// as if the peer had gone.
    pub fn cancel(&self) {
        // SAFETY: cancelling all of this handle's pending I/O is always allowed.
        unsafe { CancelIoEx(self.raw(), null()) };
    }

    /// Reads and writes with `timeout` on each call (`None`: wait for good).
    pub fn io(&self, timeout: Option<Duration>) -> Io<'_> {
        Io {
            pipe: self,
            limit: Limit::Each(timeout),
        }
    }

    /// Reads and writes that all have to finish by `deadline`, however the
    /// peer spreads them out.
    pub fn io_until(&self, deadline: Instant) -> Io<'_> {
        Io {
            pipe: self,
            limit: Limit::Until(deadline),
        }
    }

    /// The process on the other end, when this is a client's pipe.
    pub fn server_process_id(&self) -> Option<u32> {
        let mut pid = 0;
        // SAFETY: `pid` is valid for the write.
        (unsafe { GetNamedPipeServerProcessId(self.raw(), &mut pid) } != 0).then_some(pid)
    }

    /// The process on the other end, when this is a server's pipe and a client is connected.
    pub fn client_process_id(&self) -> Option<u32> {
        let mut pid = 0;
        // SAFETY: `pid` is valid for the write.
        (unsafe { GetNamedPipeClientProcessId(self.raw(), &mut pid) } != 0).then_some(pid)
    }

    /// Waits for a client to connect to this server instance.
    pub fn accept(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.overlapped(timeout, &[ERROR_PIPE_CONNECTED], |overlapped| {
            // SAFETY: `overlapped` is alive until the call completes.
            unsafe { ConnectNamedPipe(self.raw(), overlapped) }
        })
        .map(|_| ())
    }
}

enum Limit {
    Each(Option<Duration>),
    Until(Instant),
}

/// A pipe with the deadline its reads and writes share.
pub struct Io<'a> {
    pipe: &'a Pipe,
    limit: Limit,
}

impl Io<'_> {
    fn timeout(&self) -> Option<Duration> {
        match self.limit {
            Limit::Each(timeout) => timeout,
            Limit::Until(deadline) => Some(deadline.saturating_duration_since(Instant::now())),
        }
    }
}

impl Read for Io<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let length = u32::try_from(buf.len()).unwrap_or(u32::MAX);
        let result = self.pipe.overlapped(self.timeout(), &[], |overlapped| {
            // SAFETY: `buf` is alive until the call completes.
            unsafe {
                ReadFile(
                    self.pipe.raw(),
                    buf.as_mut_ptr().cast(),
                    length,
                    null_mut(),
                    overlapped,
                )
            }
        });
        match result {
            Ok(read) => Ok(read as usize),
            Err(err)
                if err
                    .raw_os_error()
                    .is_some_and(|code| is_closed(code as u32)) =>
            {
                Ok(0)
            }
            Err(err) => Err(err),
        }
    }
}

impl Write for Io<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let length = u32::try_from(buf.len()).unwrap_or(u32::MAX);
        self.pipe
            .overlapped(self.timeout(), &[], |overlapped| {
                // SAFETY: `buf` is alive until the call completes.
                unsafe {
                    WriteFile(
                        self.pipe.raw(),
                        buf.as_ptr().cast(),
                        length,
                        null_mut(),
                        overlapped,
                    )
                }
            })
            .map(|written| written as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A security descriptor that lets this user, and nobody else, open a pipe.
/// (The default one gives every other account read access.)
pub struct OwnerOnly {
    descriptor: *mut c_void,
}

// SAFETY: the descriptor is only read, by pipe creation, while this is alive.
unsafe impl Send for OwnerOnly {}
// SAFETY: as above.
unsafe impl Sync for OwnerOnly {}

impl OwnerOnly {
    pub fn new() -> io::Result<Self> {
        let sid = this_user()
            .and_then(|sid| sid.to_text())
            .ok_or_else(|| io::Error::other("can't tell which Windows user this is"))?;
        // Protected (`P`: nothing inherited), one entry: this user, all access.
        let sddl = wide(&format!("D:P(A;;GA;;;{sid})"));
        let mut descriptor: *mut c_void = null_mut();
        // SAFETY: the string is NUL-terminated; on success Windows allocates
        // the descriptor, freed on drop.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { descriptor })
    }

    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor,
            bInheritHandle: 0,
        }
    }
}

impl Drop for OwnerOnly {
    fn drop(&mut self) {
        // SAFETY: allocated by the call in `new`, freed once.
        unsafe { LocalFree(self.descriptor) };
    }
}

/// One instance of the pipe called `name` (`\\.\pipe\...`), for a client to
/// connect to. `first` makes it fail, with "access denied", when the name is
/// already taken: that is how a second Desktop is told from the first. Only
/// this user may connect, and never over the network.
pub fn create_server(name: &str, first: bool, owner: &OwnerOnly) -> io::Result<Pipe> {
    let attributes = owner.attributes();
    let open_mode = PIPE_ACCESS_DUPLEX
        | FILE_FLAG_OVERLAPPED
        | if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    // SAFETY: the name is NUL-terminated and the attributes outlive the call.
    let handle = unsafe {
        CreateNamedPipeW(
            wide(name).as_ptr(),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            4096,
            4096,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(Pipe::new(handle))
}

/// Connects to the pipe called `name`, waiting briefly if it's busy. The
/// server can't act as this user (`SECURITY_ANONYMOUS`), whoever it is: the
/// caller decides whether to trust it (`server_process_id`).
pub fn open_client(name: &str) -> io::Result<Pipe> {
    let path = wide(name);
    let mut waited = Duration::ZERO;
    loop {
        // SAFETY: the name is NUL-terminated; the handle is checked.
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            return Ok(Pipe::new(handle));
        }
        // SAFETY: straight after the call.
        let code = unsafe { GetLastError() };
        if code != ERROR_PIPE_BUSY || waited >= BUSY_WAIT {
            return Err(os_error(code));
        }
        // Every instance is serving someone: wait for one to free up.
        let slice = Duration::from_millis(250);
        // SAFETY: the name is NUL-terminated.
        unsafe { WaitNamedPipeW(path.as_ptr(), millis(Some(slice))) };
        waited += slice;
    }
}

/// A pipe name no other test or process shares.
#[cfg(test)]
pub fn unique_name(what: &str) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    format!(
        r"\\.\pipe\parousia-test-{what}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    use std::time::Instant;

    #[test]
    fn bytes_travel_both_ways_and_each_end_knows_the_others_process() {
        let name = unique_name("pipe");
        let owner = OwnerOnly::new().unwrap();
        let server = create_server(&name, true, &owner).unwrap();
        let accepting = thread::spawn(move || {
            server.accept(Some(Duration::from_secs(5))).unwrap();
            let mut byte = [0u8; 5];
            server
                .io(Some(Duration::from_secs(5)))
                .read_exact(&mut byte)
                .unwrap();
            assert_eq!(&byte, b"hello");
            server
                .io(Some(Duration::from_secs(5)))
                .write_all(b"world")
                .unwrap();
            server.client_process_id()
        });
        let client = open_client(&name).unwrap();
        assert_eq!(client.server_process_id(), Some(std::process::id()));
        client
            .io(Some(Duration::from_secs(5)))
            .write_all(b"hello")
            .unwrap();
        let mut reply = [0u8; 5];
        client
            .io(Some(Duration::from_secs(5)))
            .read_exact(&mut reply)
            .unwrap();
        assert_eq!(&reply, b"world");
        assert_eq!(accepting.join().unwrap(), Some(std::process::id()));
    }

    #[test]
    fn a_name_in_use_is_refused_to_a_first_instance() {
        let name = unique_name("first");
        let owner = OwnerOnly::new().unwrap();
        let _held = create_server(&name, true, &owner).unwrap();
        let err = create_server(&name, true, &owner).err().unwrap();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        // Later instances of the same pipe are how one server serves many clients.
        assert!(create_server(&name, false, &owner).is_ok());
    }

    #[test]
    fn a_silent_peer_costs_a_timeout_not_a_thread() {
        let name = unique_name("silent");
        let owner = OwnerOnly::new().unwrap();
        let server = create_server(&name, true, &owner).unwrap();
        let client = open_client(&name).unwrap();
        server.accept(Some(Duration::from_secs(1))).unwrap();
        let started = Instant::now();
        let err = server
            .io(Some(Duration::from_millis(100)))
            .read(&mut [0u8; 1])
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
        // The pipe still works afterwards.
        client
            .io(Some(Duration::from_secs(1)))
            .write_all(b"x")
            .unwrap();
        let mut byte = [0u8; 1];
        server
            .io(Some(Duration::from_secs(1)))
            .read_exact(&mut byte)
            .unwrap();
        assert_eq!(&byte, b"x");
    }

    #[test]
    fn a_reader_waiting_for_good_notices_the_peer_leaving_at_once() {
        let name = unique_name("leave");
        let owner = OwnerOnly::new().unwrap();
        let server = create_server(&name, true, &owner).unwrap();
        let client = open_client(&name).unwrap();
        server.accept(Some(Duration::from_secs(1))).unwrap();
        let reading = thread::spawn(move || {
            let started = Instant::now();
            let read = client.io(None).read(&mut [0u8; 1]);
            (read.unwrap(), started.elapsed())
        });
        thread::sleep(Duration::from_millis(100));
        drop(server);
        let (read, waited) = reading.join().unwrap();
        assert_eq!(read, 0, "end of stream");
        assert!(waited < Duration::from_secs(2), "{waited:?}");
    }

    #[test]
    fn cancel_ends_a_wait_from_another_thread() {
        let name = unique_name("cancel");
        let owner = OwnerOnly::new().unwrap();
        let server = create_server(&name, true, &owner).unwrap();
        let client = Arc::new(open_client(&name).unwrap());
        server.accept(Some(Duration::from_secs(1))).unwrap();
        let reader = Arc::clone(&client);
        let reading = thread::spawn(move || reader.io(None).read(&mut [0u8; 1]));
        thread::sleep(Duration::from_millis(100));
        client.cancel();
        assert_eq!(reading.join().unwrap().unwrap(), 0);
        drop(server);
    }

    #[test]
    fn only_this_user_is_in_the_pipes_access_list() {
        use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT};
        use windows_sys::Win32::Security::{
            ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
            DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation, PSECURITY_DESCRIPTOR,
        };

        let name = unique_name("acl");
        let owner = OwnerOnly::new().unwrap();
        let server = create_server(&name, true, &owner).unwrap();
        let mut acl: *mut ACL = null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: reads the pipe's own access list into memory Windows allocates, freed below.
        unsafe {
            let status = GetSecurityInfo(
                server.raw(),
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut acl,
                null_mut(),
                &mut descriptor,
            );
            assert_eq!(status, 0);
            let mut size: ACL_SIZE_INFORMATION = zeroed();
            assert_ne!(
                GetAclInformation(
                    acl,
                    (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
                    size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                ),
                0
            );
            assert_eq!(size.AceCount, 1, "one entry, so no one else can open it");
            let mut ace: *mut c_void = null_mut();
            assert_ne!(GetAce(acl, 0, &mut ace), 0);
            assert!(!ace.is_null(), "GetAce returned success but no ACE pointer");
            let ace = &*(ace as *const ACCESS_ALLOWED_ACE);
            let sid = (&ace.SidStart as *const u32).cast_mut().cast::<c_void>();
            assert_ne!(EqualSid(sid, this_user().unwrap().as_ptr()), 0);
            LocalFree(descriptor);
        }
    }
}
