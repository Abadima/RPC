//! Start at login (Windows): a value under this user's `Run` key, the same
//! list Task Manager's Startup tab shows and can switch off. It's per user and
//! needs no administrator rights, and Windows runs it with no arguments, which
//! is a plain launch with the tray. Nothing else is installed or scheduled, and
//! nothing runs in the background to keep it: the entry is read when the tray
//! menu opens and changed when someone clicks it.

use std::io;
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ, RegCloseKey, RegCreateKeyExW,
    RegDeleteValueW, RegQueryValueExW, RegSetValueExW,
};

use super::sys::wide;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE: &str = "Parousia Desktop";
/// More than any real path or this entry would be; a value longer is someone else's.
const MAX_CHARS: usize = 1024;

/// An open registry key, closed when dropped.
struct Key(HKEY);

impl Key {
    /// The key under this user's hive, created if it isn't there.
    fn open(subkey: &str) -> io::Result<Self> {
        let mut key: HKEY = null_mut();
        // SAFETY: the name is NUL-terminated and `key` is valid for the write.
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                wide(subkey).as_ptr(),
                0,
                null(),
                0,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                null(),
                &mut key,
                null_mut(),
            )
        };
        check(status)?;
        Ok(Self(key))
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: the key was opened by `open` and is closed once.
        unsafe { RegCloseKey(self.0) };
    }
}

fn check(status: u32) -> io::Result<()> {
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status as i32))
    }
}

/// How Windows is told to start `exe`: quoted, so a path with spaces stays one.
fn command(exe: &Path) -> io::Result<String> {
    let path = exe
        .to_str()
        .ok_or_else(|| io::Error::other("Desktop's path isn't valid text"))?;
    if path.contains('"') || path.chars().count() > MAX_CHARS - 2 {
        return Err(io::Error::other(
            "Desktop's path can't be used as a login entry",
        ));
    }
    Ok(format!("\"{path}\""))
}

fn read(subkey: &str) -> io::Result<Option<String>> {
    let key = Key::open(subkey)?;
    let name = wide(VALUE);
    let mut buffer = [0u16; MAX_CHARS];
    let mut kind = 0;
    let mut size = size_of_val(&buffer) as u32;
    // SAFETY: the buffer is `size` bytes; the name is NUL-terminated.
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            null(),
            &mut kind,
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    check(status)?;
    if kind != REG_SZ {
        return Ok(None);
    }
    let chars = (size as usize / 2).min(MAX_CHARS);
    let text = &buffer[..chars];
    let end = text.iter().position(|&unit| unit == 0).unwrap_or(chars);
    Ok(Some(String::from_utf16_lossy(&text[..end])))
}

fn write(subkey: &str, exe: &Path, enabled: bool) -> io::Result<()> {
    let key = Key::open(subkey)?;
    let name = wide(VALUE);
    if !enabled {
        // SAFETY: the name is NUL-terminated.
        let status = unsafe { RegDeleteValueW(key.0, name.as_ptr()) };
        return if status == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            check(status)
        };
    }
    let data = wide(&command(exe)?);
    // SAFETY: `data` is NUL-terminated UTF-16 and its byte length is passed.
    let status = unsafe {
        RegSetValueExW(
            key.0,
            name.as_ptr(),
            0,
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    };
    check(status)
}

fn enabled_at(subkey: &str, exe: &Path) -> bool {
    // An entry for another copy of Desktop (it was moved, or this is a
    // development build) doesn't count: clicking then points it here.
    matches!((read(subkey), command(exe)), (Ok(Some(value)), Ok(ours)) if value == ours)
}

/// Whether Windows starts this copy of Desktop at login.
pub fn is_enabled() -> bool {
    std::env::current_exe().is_ok_and(|exe| enabled_at(RUN_KEY, &exe))
}

/// Turns start at login on (for this copy of Desktop) or off.
pub fn set_enabled(enabled: bool) -> io::Result<()> {
    write(RUN_KEY, &std::env::current_exe()?, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A key of its own, in this user's hive, deleted afterwards: the real
    /// registry, never the real `Run` list.
    struct Scratch(String);

    impl Scratch {
        fn new(what: &str) -> Self {
            Self(format!(
                r"Software\Parousia-test\{what}-{}",
                std::process::id()
            ))
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            use windows_sys::Win32::System::Registry::RegDeleteKeyW;
            // SAFETY: the name is NUL-terminated.
            unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, wide(&self.0).as_ptr()) };
        }
    }

    #[test]
    fn the_entry_is_written_read_and_removed() {
        let scratch = Scratch::new("startup");
        let exe = PathBuf::from(r"C:\Program Files\Parousia\Parousia-Desktop.exe");
        assert!(!enabled_at(&scratch.0, &exe));

        write(&scratch.0, &exe, true).unwrap();
        assert_eq!(
            read(&scratch.0).unwrap().as_deref(),
            Some(r#""C:\Program Files\Parousia\Parousia-Desktop.exe""#)
        );
        assert!(enabled_at(&scratch.0, &exe));

        // Turning it on twice, or off twice, is fine.
        write(&scratch.0, &exe, true).unwrap();
        write(&scratch.0, &exe, false).unwrap();
        write(&scratch.0, &exe, false).unwrap();
        assert!(!enabled_at(&scratch.0, &exe));
        assert_eq!(read(&scratch.0).unwrap(), None);
    }

    #[test]
    fn an_entry_for_another_copy_isnt_this_ones() {
        let scratch = Scratch::new("other");
        let old = PathBuf::from(r"C:\Old\Parousia-Desktop.exe");
        let new = PathBuf::from(r"C:\New\Parousia-Desktop.exe");
        write(&scratch.0, &old, true).unwrap();
        assert!(!enabled_at(&scratch.0, &new));
        write(&scratch.0, &new, true).unwrap();
        assert!(enabled_at(&scratch.0, &new));
    }

    #[test]
    fn a_path_that_cant_be_quoted_is_refused() {
        assert!(command(Path::new(r#"C:\a"b\Desktop.exe"#)).is_err());
        assert!(command(Path::new(&"x".repeat(MAX_CHARS))).is_err());
    }
}
