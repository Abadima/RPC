//! What the Windows build needs that a console program doesn't: the release
//! exe is a GUI-subsystem program (no console window when launched from the
//! Start menu or at login), so a terminal has to be reattached for commands
//! run from one, and a startup failure needs somewhere to be seen.

use std::iter::once;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{
    ATTACH_PARENT_PROCESS, AttachConsole, GetConsoleWindow, GetStdHandle, STD_ERROR_HANDLE,
    STD_OUTPUT_HANDLE, SetStdHandle,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

/// NUL-terminated UTF-16, as the `...W` functions want.
pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(once(0)).collect()
}

/// Lets `--help`, `status`, and friends print into the terminal they were
/// typed in. Redirected output is left alone.
pub fn attach_parent_console() {
    // SAFETY: plain Win32 calls with valid arguments; every handle is checked.
    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return;
        }
        for which in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let handle = GetStdHandle(which);
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                continue;
            }
            let console = CreateFileW(
                wide("CONOUT$").as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            );
            if console != INVALID_HANDLE_VALUE {
                SetStdHandle(which, console);
            }
        }
    }
}

/// A message box when there's no console to print to, so a failed start
/// (say, the port is taken) isn't a silent exit.
pub fn alert(message: &str) {
    // SAFETY: both strings are NUL-terminated and outlive the call.
    unsafe {
        if GetConsoleWindow().is_null() {
            MessageBoxW(
                null_mut(),
                wide(message).as_ptr(),
                wide("Parousia Desktop").as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}
