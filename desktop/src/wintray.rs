//! The Windows notification-area icon: a tooltip with the status line, the
//! same menu as the Linux tray (`tray/menu.rs`) on click, and balloon
//! notifications for blocked extensions.
//!
//! Runs on the main thread, blocked in `GetMessageW`: no timers, no polling.
//! Hub changes arrive from other threads and are handed over as a posted
//! message, so all icon and menu work stays on this thread.

#[path = "tray/menu.rs"]
mod menu;

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{
    NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIM_ADD, NIM_DELETE, NIM_MODIFY,
    NOTIFYICONDATAW, Shell_NotifyIconW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIcon, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu,
    DispatchMessageW, GetCursorPos, GetMessageW, MF_CHECKED, MF_GRAYED, MF_POPUP, MF_SEPARATOR,
    MF_STRING, MSG, PostMessageW, PostQuitMessage, RegisterClassW, RegisterWindowMessageW,
    SetForegroundWindow, TPM_BOTTOMALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenu,
    TranslateMessage, WM_APP, WM_CONTEXTMENU, WM_LBUTTONUP, WM_NULL, WM_RBUTTONUP, WNDCLASSW,
};

use crate::hub::{Hub, HubEvent};
use crate::winsys::wide;
use menu::Action;

/// Generated from `browser/icons/icon-32.png` with
/// `magick icon-32.png -depth 8 RGBA:tray-32.rgba`; reordered to BGRA below.
const ICON: &[u8] = include_bytes!("../assets/tray-32.rgba");
const ICON_SIZE: i32 = 32;

/// The shell reports clicks on the icon with this message.
const WM_TRAY: u32 = WM_APP + 1;
/// Posted from other threads when the hub changed.
const WM_HUB: u32 = WM_APP + 2;

pub enum Exit {
    Quit,
    Unavailable(String),
}

static HUB: OnceLock<Arc<Hub>> = OnceLock::new();
static WINDOW: AtomicIsize = AtomicIsize::new(0);
static ICON_HANDLE: AtomicIsize = AtomicIsize::new(0);
/// Registered message that Explorer broadcasts when it (re)starts and
/// forgets every icon.
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
/// A balloon waiting for the tray thread to show it.
static NOTICE: Mutex<Option<(String, String)>> = Mutex::new(None);

pub fn run(hub: Arc<Hub>) -> Exit {
    let _ = HUB.set(Arc::clone(&hub));
    // SAFETY: Win32 setup on the thread that will also pump the messages; the
    // class name outlives registration and window creation.
    unsafe {
        let instance = GetModuleHandleW(null());
        let class_name = wide("ParousiaDesktopTray");
        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            lpszClassName: class_name.as_ptr(),
            ..zeroed()
        };
        if RegisterClassW(&class) == 0 {
            return Exit::Unavailable("couldn't register the tray window class".into());
        }
        // A real (never shown) top-level window, not message-only, so it
        // receives Explorer's `TaskbarCreated` broadcast.
        let window = CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            null_mut(),
            null_mut(),
            instance,
            null(),
        );
        if window.is_null() {
            return Exit::Unavailable("couldn't create the tray window".into());
        }
        WINDOW.store(window as isize, Ordering::Release);
        TASKBAR_CREATED.store(
            RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()),
            Ordering::Release,
        );
        ICON_HANDLE.store(create_icon(instance) as isize, Ordering::Release);
        // Fails while Explorer isn't up yet; `TaskbarCreated` retries.
        add_icon(window);
    }

    hub.set_listener(Box::new(|event| {
        let notice = match event {
            HubEvent::Changed => None,
            HubEvent::Refused { origin } => Some((
                "Unrecognized extension blocked".to_string(),
                format!(
                    "{origin} tried to connect. If it's your Parousia build, allow it under Diagnostics in the tray menu."
                ),
            )),
            HubEvent::ShowRequested => Some((
                "Parousia Desktop is running".to_string(),
                "Status and settings are in the tray menu.".to_string(),
            )),
        };
        if notice.is_some() {
            *NOTICE.lock().unwrap_or_else(|p| p.into_inner()) = notice;
        }
        let window = WINDOW.load(Ordering::Acquire);
        // SAFETY: posting to a window from another thread is what
        // `PostMessageW` is for; a stale handle just fails.
        unsafe { PostMessageW(window as HWND, WM_HUB, 0, 0) };
    }));

    // SAFETY: the standard message pump for the window created above.
    unsafe {
        let mut message: MSG = zeroed();
        while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Exit::Quit
}

unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_TRAY => {
            if matches!(
                lparam as u32 & 0xFFFF,
                WM_LBUTTONUP | WM_RBUTTONUP | WM_CONTEXTMENU
            ) {
                // SAFETY: on the tray thread, with its window.
                unsafe { show_menu(window) };
            }
            0
        }
        WM_HUB => {
            // SAFETY: as above.
            unsafe { modify_icon(window) };
            0
        }
        other if other == TASKBAR_CREATED.load(Ordering::Acquire) && other != 0 => {
            // SAFETY: as above.
            unsafe { add_icon(window) };
            0
        }
        // SAFETY: the default handler for whatever we don't handle.
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

/// BGRA, top-down, as `CreateIcon` wants; the alpha channel does the masking.
fn create_icon(instance: *mut c_void) -> *mut c_void {
    let bgra: Vec<u8> = ICON
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|[r, g, b, a]| [*b, *g, *r, *a])
        .collect();
    let and_mask = [0u8; (ICON_SIZE * ICON_SIZE / 8) as usize];
    // SAFETY: both buffers are the sizes the call reads for a 32x32 icon.
    unsafe {
        CreateIcon(
            instance,
            ICON_SIZE,
            ICON_SIZE,
            1,
            32,
            and_mask.as_ptr(),
            bgra.as_ptr(),
        )
    }
}

fn copy_wide<const N: usize>(into: &mut [u16; N], text: &str) {
    // Leave room for the terminator; a cut-off tooltip beats no tooltip.
    for (slot, unit) in into[..N - 1].iter_mut().zip(text.encode_utf16()) {
        *slot = unit;
    }
}

unsafe fn icon_data(window: HWND) -> NOTIFYICONDATAW {
    // SAFETY: an all-zero NOTIFYICONDATAW is the documented starting point.
    let mut data: NOTIFYICONDATAW = unsafe { zeroed() };
    data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = window;
    data.uID = 1;
    data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    data.uCallbackMessage = WM_TRAY;
    data.hIcon = ICON_HANDLE.load(Ordering::Acquire) as *mut c_void;
    if let Some(hub) = HUB.get() {
        copy_wide(&mut data.szTip, &menu::status_line(&hub.status()));
    }
    data
}

unsafe fn add_icon(window: HWND) {
    // SAFETY: `data` is fully initialized by `icon_data`.
    unsafe {
        let data = icon_data(window);
        Shell_NotifyIconW(NIM_ADD, &data);
    }
}

/// Refreshes the tooltip and shows a pending balloon, if any.
unsafe fn modify_icon(window: HWND) {
    // SAFETY: as `add_icon`.
    unsafe {
        let mut data = icon_data(window);
        if let Some((title, body)) = NOTICE.lock().unwrap_or_else(|p| p.into_inner()).take() {
            data.uFlags |= NIF_INFO;
            data.dwInfoFlags = NIIF_INFO;
            copy_wide(&mut data.szInfoTitle, &title);
            copy_wide(&mut data.szInfo, &body);
        }
        Shell_NotifyIconW(NIM_MODIFY, &data);
    }
}

unsafe fn remove_icon(window: HWND) {
    // SAFETY: as `add_icon`; deleting only needs the window and id.
    unsafe {
        let data = icon_data(window);
        Shell_NotifyIconW(NIM_DELETE, &data);
    }
}

/// `&` starts a mnemonic in a Win32 menu label; a literal one is doubled.
fn label(text: &str) -> Vec<u16> {
    wide(&text.replace('&', "&&"))
}

/// Submenus are destroyed with their parent.
unsafe fn build_menu(items: &[menu::Item]) -> *mut c_void {
    // SAFETY: labels are NUL-terminated and copied by `AppendMenuW`.
    unsafe {
        let popup = CreatePopupMenu();
        for item in items {
            if item.separator {
                AppendMenuW(popup, MF_SEPARATOR, 0, null());
            } else if !item.children.is_empty() {
                let submenu = build_menu(&item.children);
                AppendMenuW(
                    popup,
                    MF_POPUP | MF_STRING,
                    submenu as usize,
                    label(&item.label).as_ptr(),
                );
            } else {
                let mut flags = MF_STRING;
                if !item.enabled {
                    flags |= MF_GRAYED;
                }
                if item.checked == Some(true) {
                    flags |= MF_CHECKED;
                }
                AppendMenuW(popup, flags, item.id as usize, label(&item.label).as_ptr());
            }
        }
        popup
    }
}

unsafe fn show_menu(window: HWND) {
    let Some(hub) = HUB.get() else { return };
    let status = hub.status();
    let tree = menu::build(&status);
    // SAFETY: the menu is built, shown, and destroyed on this thread.
    let chosen = unsafe {
        let popup = build_menu(&tree.children);
        let mut at: POINT = zeroed();
        GetCursorPos(&mut at);
        // Without this the menu doesn't close when the user clicks elsewhere.
        SetForegroundWindow(window);
        let chosen = TrackPopupMenu(
            popup,
            TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN,
            at.x,
            at.y,
            0,
            window,
            null(),
        );
        PostMessageW(window, WM_NULL, 0, 0);
        DestroyMenu(popup);
        chosen
    };
    // Resolved against a fresh status, like the Linux tray: a stale "Allow"
    // can only allow the origin it was shown for, or nothing.
    let Some(action) = menu::action_for(&hub.status(), chosen) else {
        return;
    };
    match action {
        Action::Allow(origin) => {
            if let Err(err) = hub.allow(&origin) {
                notify("Couldn't allow that extension", &err);
            }
        }
        Action::Toggle(setting, value) => {
            if let Err(err) = hub.set(setting, value) {
                notify("Couldn't change the setting", &err);
            }
        }
        Action::Debug(on) => hub.set_debug(on),
        Action::Quit => {
            // SAFETY: on the tray thread; removes the icon so it doesn't
            // linger in the tray until the mouse passes over it.
            unsafe {
                remove_icon(window);
                PostQuitMessage(0);
            }
        }
    }
}

fn notify(title: &str, body: &str) {
    *NOTICE.lock().unwrap_or_else(|p| p.into_inner()) = Some((title.to_string(), body.to_string()));
    let window = WINDOW.load(Ordering::Acquire);
    // SAFETY: as in the hub listener.
    unsafe { PostMessageW(window as HWND, WM_HUB, 0, 0) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_text_is_cut_and_stays_terminated() {
        let mut tip = [0u16; 8];
        copy_wide(&mut tip, "0123456789");
        assert_eq!(String::from_utf16_lossy(&tip[..7]), "0123456");
        assert_eq!(tip[7], 0);
    }

    #[test]
    fn ampersands_are_doubled_in_labels() {
        assert_eq!(label("a & b"), wide("a && b"));
    }

    #[test]
    fn the_icon_is_a_32_pixel_rgba_square() {
        assert_eq!(ICON.len(), (ICON_SIZE * ICON_SIZE * 4) as usize);
    }
}
