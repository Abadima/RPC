//! Linux desktop integration over the session bus: a StatusNotifierItem
//! (KDE Plasma, and GNOME with the AppIndicator extension) whose menu shows
//! Desktop's status, connected browsers, diagnostics, recent
//! events, and settings; and desktop notifications, which work with or
//! without a tray host (plain GNOME included). The tray is optional: without
//! a watcher the item just isn't shown, and everything is still reachable
//! through notifications, the CLI, and Parousia's dashboard.
//!
//! Runs on the main thread, blocked reading the session bus: no timers, no
//! polling. Hub changes arrive from other threads and are pushed out as
//! `LayoutUpdated`/`NewToolTip` signals.
//!
//! Anything on the session bus runs as this user (out of scope); sandboxed
//! Flatpak apps only reach the names their manifest grants.

mod dbus;
mod menu;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use dbus::{Bus, Kind, Message, Value};
use menu::Action;

use crate::hub::{Hub, HubEvent};

const ITEM_PATH: &str = "/StatusNotifierItem";
const MENU_PATH: &str = "/MenuBar";
const ITEM_INTERFACE: &str = "org.kde.StatusNotifierItem";
const MENU_INTERFACE: &str = "com.canonical.dbusmenu";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const INTROSPECTABLE: &str = "org.freedesktop.DBus.Introspectable";
const WATCHER: &str = "org.kde.StatusNotifierWatcher";
const BUS: &str = "org.freedesktop.DBus";
const UNKNOWN_METHOD: &str = "org.freedesktop.DBus.Error.UnknownMethod";
const INVALID_ARGS: &str = "org.freedesktop.DBus.Error.InvalidArgs";

/// Generated from `browser/icons/icon-{32,48}.png` with
/// `magick icon-N.png -depth 8 RGBA:tray-N.rgba`; reordered to the ARGB
/// SNI wants at startup.
const ICONS: [(i32, &[u8]); 2] = [
    (32, include_bytes!("../../assets/tray-32.rgba")),
    (48, include_bytes!("../../assets/tray-48.rgba")),
];

pub enum Exit {
    Quit,
    Unavailable(String),
}

struct Tray {
    bus: Bus,
    hub: Arc<Hub>,
    name: String,
    revision: AtomicU32,
    pixmaps: Value,
    /// The menu as last sent, to answer `AboutToShow` honestly.
    shown: Mutex<Option<menu::Item>>,
}

pub fn run(hub: Arc<Hub>) -> Exit {
    let (bus, mut reader) = match Bus::connect_session() {
        Ok(connection) => connection,
        Err(err) => return Exit::Unavailable(format!("no session bus: {err}")),
    };
    let tray = Arc::new(Tray {
        bus,
        hub: Arc::clone(&hub),
        name: format!("org.kde.StatusNotifierItem-{}-1", std::process::id()),
        revision: AtomicU32::new(1),
        pixmaps: pixmaps(),
        shown: Mutex::new(None),
    });

    // Hello has to be first; the rest can be pipelined behind it.
    let setup = [
        Message::method_call(BUS, "/org/freedesktop/DBus", BUS, "Hello", vec![]),
        Message::method_call(
            BUS,
            "/org/freedesktop/DBus",
            BUS,
            "RequestName",
            vec![Value::str(&tray.name), Value::U32(4)],
        ),
        Message::method_call(
            BUS,
            "/org/freedesktop/DBus",
            BUS,
            "AddMatch",
            vec![Value::Str(format!(
                "type='signal',sender='{BUS}',interface='{BUS}',member='NameOwnerChanged',arg0='{WATCHER}'"
            ))],
        ),
    ];
    for message in &setup {
        if let Err(err) = tray.bus.send(message) {
            return Exit::Unavailable(format!("session bus setup failed: {err}"));
        }
    }
    let mut register_serial = tray.register();

    let listener = Arc::clone(&tray);
    hub.set_listener(Box::new(move |event| listener.on_hub_event(event)));

    loop {
        let message = match dbus::read_message(&mut reader) {
            Ok(message) => message,
            Err(err) => return Exit::Unavailable(format!("lost the session bus: {err}")),
        };
        match message.kind {
            Kind::MethodCall => {
                if let Some(Action::Quit) = tray.handle_call(&message) {
                    return Exit::Quit;
                }
            }
            Kind::Signal if is_watcher_restart(&message) => register_serial = tray.register(),
            Kind::Error
                if message.reply_serial.is_some()
                    && message.reply_serial == register_serial
                    && hub.debug() =>
            {
                println!(
                    "Parousia Desktop: no system tray is running yet; the icon appears when one starts"
                );
            }
            _ => {}
        }
    }
}

/// `NameOwnerChanged(watcher, old, new)` with a new owner: a tray host
/// (re)started and needs to hear about us.
fn is_watcher_restart(message: &Message) -> bool {
    message.member.as_deref() == Some("NameOwnerChanged")
        && message.body.first().and_then(Value::as_str) == Some(WATCHER)
        && message
            .body
            .get(2)
            .and_then(Value::as_str)
            .is_some_and(|owner| !owner.is_empty())
}

/// SNI pixmaps are ARGB32 in network byte order.
fn pixmaps() -> Value {
    Value::Array(
        "(iiay)".into(),
        ICONS
            .iter()
            .map(|(size, rgba)| {
                let argb = rgba
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .flat_map(|[r, g, b, a]| [*a, *r, *g, *b])
                    .collect();
                Value::Struct(vec![
                    Value::I32(*size),
                    Value::I32(*size),
                    Value::Bytes(argb),
                ])
            })
            .collect(),
    )
}

impl Tray {
    fn register(&self) -> Option<u32> {
        let call = Message::method_call(
            WATCHER,
            "/StatusNotifierWatcher",
            WATCHER,
            "RegisterStatusNotifierItem",
            vec![Value::str(&self.name)],
        );
        self.bus.send(&call).ok()
    }

    fn menu(&self) -> menu::Item {
        menu::build(&self.hub.status())
    }

    fn on_hub_event(&self, event: HubEvent) {
        match event {
            HubEvent::Changed => {}
            HubEvent::Refused { origin } => self.notify(
                "Unrecognized extension blocked",
                &format!(
                    "{origin} tried to connect. If it's your Parousia build, allow it under Diagnostics in the Parousia menu, or run `Parousia-Desktop allow {origin}`."
                ),
            ),
            HubEvent::ShowRequested => {
                let status = self.hub.status();
                self.notify(
                    "Parousia Desktop is running",
                    &format!(
                        "{}. Status and settings: the Parousia extension's dashboard, the tray menu, or `Parousia-Desktop status`.",
                        menu::status_line(&status)
                    ),
                );
            }
        }
        self.refresh();
    }

    /// Tells hosts the menu and tooltip changed; they re-fetch what they show.
    fn refresh(&self) {
        let revision = self.revision.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.bus.send(&Message::signal(
            MENU_PATH,
            MENU_INTERFACE,
            "LayoutUpdated",
            vec![Value::U32(revision), Value::I32(menu::ROOT)],
        ));
        let _ = self.bus.send(&Message::signal(
            ITEM_PATH,
            ITEM_INTERFACE,
            "NewToolTip",
            vec![],
        ));
    }

    /// Fire-and-forget desktop notification.
    fn notify(&self, summary: &str, body: &str) {
        let hints = vec![("urgency", Value::Byte(1))];
        let mut call = Message::method_call(
            "org.freedesktop.Notifications",
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
            "Notify",
            vec![
                Value::str("Parousia Desktop"),
                Value::U32(0),
                Value::str(""),
                Value::str(summary),
                Value::str(body),
                Value::Array("s".into(), vec![]),
                Value::dict(hints),
                Value::I32(-1),
            ],
        );
        call.flags |= dbus::NO_REPLY_EXPECTED;
        let _ = self.bus.send(&call);
    }

    fn reply(&self, call: &Message, body: Vec<Value>) {
        if call.expects_reply() {
            let _ = self.bus.send(&Message::method_return(call, body));
        }
    }

    fn fail(&self, call: &Message, name: &str, text: &str) {
        if call.expects_reply() {
            let _ = self.bus.send(&Message::error(call, name, text));
        }
    }

    /// Answers one method call. Returns the action a menu click asked for,
    /// after the reply has been sent.
    fn handle_call(&self, call: &Message) -> Option<Action> {
        let path = call.path.as_deref().unwrap_or("");
        let interface = call.interface.as_deref().unwrap_or("");
        let member = call.member.as_deref().unwrap_or("");
        match (path, interface, member) {
            (_, "org.freedesktop.DBus.Peer", "Ping") => self.reply(call, vec![]),
            (_, INTROSPECTABLE, "Introspect") => {
                self.reply(call, vec![Value::Str(introspection(path))])
            }
            (ITEM_PATH, PROPERTIES, "Get" | "GetAll")
            | (MENU_PATH, PROPERTIES, "Get" | "GetAll") => {
                self.properties(call, path, member);
            }
            (ITEM_PATH, PROPERTIES, "Set") | (MENU_PATH, PROPERTIES, "Set") => {
                self.fail(
                    call,
                    "org.freedesktop.DBus.Error.PropertyReadOnly",
                    "read-only",
                );
            }
            // An error here is what makes hosts open the menu on a left
            // click (GNOME's AppIndicator extension and older Plasma).
            (ITEM_PATH, ITEM_INTERFACE, "Activate" | "ContextMenu") => {
                self.fail(call, UNKNOWN_METHOD, "ItemIsMenu");
            }
            (ITEM_PATH, ITEM_INTERFACE, "SecondaryActivate" | "Scroll") => self.reply(call, vec![]),
            (MENU_PATH, MENU_INTERFACE, _) => return self.menu_call(call, member),
            _ => self.fail(call, UNKNOWN_METHOD, "no such method"),
        }
        None
    }

    fn properties(&self, call: &Message, path: &str, member: &str) {
        let interface = call.body.first().and_then(Value::as_str).unwrap_or("");
        let all = match (path, interface) {
            (ITEM_PATH, ITEM_INTERFACE) => self.item_properties(),
            (MENU_PATH, MENU_INTERFACE) => vec![
                ("Version", Value::U32(3)),
                ("TextDirection", Value::str("ltr")),
                ("Status", Value::str("normal")),
                ("IconThemePath", Value::Array("s".into(), vec![])),
            ],
            _ => {
                self.fail(call, INVALID_ARGS, "no such interface");
                return;
            }
        };
        if member == "GetAll" {
            self.reply(call, vec![Value::dict(all)]);
            return;
        }
        let name = call.body.get(1).and_then(Value::as_str).unwrap_or("");
        match all.into_iter().find(|(key, _)| *key == name) {
            Some((_, value)) => self.reply(call, vec![Value::variant(value)]),
            None => self.fail(
                call,
                "org.freedesktop.DBus.Error.UnknownProperty",
                "no such property",
            ),
        }
    }

    fn item_properties(&self) -> Vec<(&'static str, Value)> {
        let no_pixmaps = Value::Array("(iiay)".into(), vec![]);
        let status = menu::status_line(&self.hub.status());
        vec![
            ("Category", Value::str("ApplicationStatus")),
            ("Id", Value::str("parousia-desktop")),
            ("Title", Value::str("Parousia Desktop")),
            ("Status", Value::str("Active")),
            ("WindowId", Value::I32(0)),
            ("IconName", Value::str("")),
            ("IconPixmap", self.pixmaps.clone()),
            ("OverlayIconName", Value::str("")),
            ("OverlayIconPixmap", no_pixmaps.clone()),
            ("AttentionIconName", Value::str("")),
            ("AttentionIconPixmap", no_pixmaps.clone()),
            ("AttentionMovieName", Value::str("")),
            (
                "ToolTip",
                Value::Struct(vec![
                    Value::str(""),
                    no_pixmaps,
                    Value::str("Parousia Desktop"),
                    Value::Str(status),
                ]),
            ),
            ("ItemIsMenu", Value::Bool(true)),
            ("Menu", Value::Path(MENU_PATH.into())),
            ("IconThemePath", Value::str("")),
        ]
    }

    fn menu_call(&self, call: &Message, member: &str) -> Option<Action> {
        let filter = |value: Option<&Value>| -> Vec<String> {
            value
                .and_then(Value::as_array)
                .unwrap_or_default()
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        };
        match member {
            "GetLayout" => {
                let parent = call
                    .body
                    .first()
                    .and_then(Value::as_i32)
                    .unwrap_or(menu::ROOT);
                let depth = call.body.get(1).and_then(Value::as_i32).unwrap_or(-1);
                let props = filter(call.body.get(2));
                let current = self.menu();
                let Some(item) = current.find(parent) else {
                    self.fail(call, INVALID_ARGS, "no such item");
                    return None;
                };
                let depth = usize::try_from(depth).ok();
                let layout = menu::layout(item, depth, &props);
                let revision = self.revision.load(Ordering::Relaxed);
                *self.shown.lock().unwrap_or_else(|p| p.into_inner()) = Some(current);
                self.reply(call, vec![Value::U32(revision), layout]);
            }
            "GetGroupProperties" => {
                let ids: Vec<i32> = call
                    .body
                    .first()
                    .and_then(Value::as_array)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(Value::as_i32)
                    .collect();
                let props = filter(call.body.get(1));
                let current = self.menu();
                let items: Vec<Value> = current
                    .all()
                    .into_iter()
                    .filter(|item| ids.is_empty() || ids.contains(&item.id))
                    .map(|item| {
                        Value::Struct(vec![Value::I32(item.id), menu::properties(item, &props)])
                    })
                    .collect();
                self.reply(call, vec![Value::Array("(ia{sv})".into(), items)]);
            }
            "GetProperty" => {
                let id = call.body.first().and_then(Value::as_i32).unwrap_or(-1);
                let name = call.body.get(1).and_then(Value::as_str).unwrap_or("");
                let current = self.menu();
                let value = current.find(id).and_then(|item| {
                    let Value::Array(_, entries) = menu::properties(item, &[name.to_string()])
                    else {
                        return None;
                    };
                    entries.into_iter().next().and_then(|entry| match entry {
                        Value::Entry(_, value) => Some(*value),
                        _ => None,
                    })
                });
                match value {
                    Some(value) => self.reply(call, vec![value]),
                    None => self.fail(call, INVALID_ARGS, "no such item or property"),
                }
            }
            "Event" => {
                let id = call.body.first().and_then(Value::as_i32).unwrap_or(-1);
                let event = call.body.get(1).and_then(Value::as_str).unwrap_or("");
                self.reply(call, vec![]);
                if event == "clicked" {
                    return self.activate(id);
                }
            }
            "EventGroup" => {
                let events = call
                    .body
                    .first()
                    .and_then(Value::as_array)
                    .unwrap_or_default()
                    .to_vec();
                self.reply(call, vec![Value::Array("i".into(), vec![])]);
                for event in events {
                    let Value::Struct(fields) = event else {
                        continue;
                    };
                    let id = fields.first().and_then(Value::as_i32).unwrap_or(-1);
                    if fields.get(1).and_then(Value::as_str) == Some("clicked")
                        && let Some(Action::Quit) = self.activate(id)
                    {
                        return Some(Action::Quit);
                    }
                }
            }
            "AboutToShow" => {
                let changed = self.menu_changed();
                self.reply(call, vec![Value::Bool(changed)]);
            }
            "AboutToShowGroup" => {
                let changed = self.menu_changed();
                let updates = if changed {
                    vec![Value::I32(menu::ROOT)]
                } else {
                    vec![]
                };
                self.reply(
                    call,
                    vec![
                        Value::Array("i".into(), updates),
                        Value::Array("i".into(), vec![]),
                    ],
                );
            }
            _ => self.fail(call, UNKNOWN_METHOD, "no such method"),
        }
        None
    }

    /// Whether the menu differs from what the host last fetched (newer
    /// "connected N min ago" times, say). Hosts ask right before showing it.
    fn menu_changed(&self) -> bool {
        let current = self.menu();
        let changed = self
            .shown
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            != Some(&current);
        if changed {
            self.revision.fetch_add(1, Ordering::Relaxed);
        }
        changed
    }

    fn activate(&self, id: i32) -> Option<Action> {
        let action = menu::action_for(&self.hub.status(), id)?;
        match &action {
            Action::Allow(origin) => {
                if let Err(err) = self.hub.allow(origin) {
                    self.notify("Couldn't allow that extension", &err);
                }
            }
            Action::Toggle(setting, value) => {
                if let Err(err) = self.hub.set(*setting, *value) {
                    self.notify("Couldn't change the setting", &err);
                }
            }
            Action::Debug(on) => self.hub.set_debug(*on),
            Action::Quit => {}
        }
        Some(action)
    }
}

fn introspection(path: &str) -> String {
    let body = match path {
        ITEM_PATH => format!(
            r#"<interface name="{ITEM_INTERFACE}">
<method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
<method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
<method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
<method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
<signal name="NewTitle"/><signal name="NewIcon"/><signal name="NewAttentionIcon"/><signal name="NewOverlayIcon"/><signal name="NewToolTip"/>
<signal name="NewStatus"><arg name="status" type="s"/></signal>
<property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/>
<property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/>
<property name="WindowId" type="i" access="read"/><property name="IconName" type="s" access="read"/>
<property name="IconPixmap" type="a(iiay)" access="read"/><property name="OverlayIconName" type="s" access="read"/>
<property name="OverlayIconPixmap" type="a(iiay)" access="read"/><property name="AttentionIconName" type="s" access="read"/>
<property name="AttentionIconPixmap" type="a(iiay)" access="read"/><property name="AttentionMovieName" type="s" access="read"/>
<property name="ToolTip" type="(sa(iiay)ss)" access="read"/><property name="ItemIsMenu" type="b" access="read"/>
<property name="Menu" type="o" access="read"/><property name="IconThemePath" type="s" access="read"/>
</interface>"#
        ),
        MENU_PATH => format!(
            r#"<interface name="{MENU_INTERFACE}">
<method name="GetLayout"><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/><arg type="u" direction="out"/><arg type="(ia{{sv}}av)" direction="out"/></method>
<method name="GetGroupProperties"><arg type="ai" direction="in"/><arg type="as" direction="in"/><arg type="a(ia{{sv}})" direction="out"/></method>
<method name="GetProperty"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
<method name="Event"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="u" direction="in"/></method>
<method name="EventGroup"><arg type="a(isvu)" direction="in"/><arg type="ai" direction="out"/></method>
<method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
<method name="AboutToShowGroup"><arg type="ai" direction="in"/><arg type="ai" direction="out"/><arg type="ai" direction="out"/></method>
<signal name="ItemsPropertiesUpdated"><arg type="a(ia{{sv}})"/><arg type="a(ias)"/></signal>
<signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
<signal name="ItemActivationRequested"><arg type="i"/><arg type="u"/></signal>
<property name="Version" type="u" access="read"/><property name="TextDirection" type="s" access="read"/>
<property name="Status" type="s" access="read"/><property name="IconThemePath" type="as" access="read"/>
</interface>"#
        ),
        _ => r#"<node name="StatusNotifierItem"/><node name="MenuBar"/>"#.to_string(),
    };
    format!(
        "<!DOCTYPE node PUBLIC \"-//freedesktop//DTD D-BUS Object Introspection 1.0//EN\" \"http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd\">\n<node>\n<interface name=\"{INTROSPECTABLE}\"><method name=\"Introspect\"><arg type=\"s\" direction=\"out\"/></method></interface>\n<interface name=\"{PROPERTIES}\"><method name=\"Get\"><arg type=\"s\" direction=\"in\"/><arg type=\"s\" direction=\"in\"/><arg type=\"v\" direction=\"out\"/></method><method name=\"GetAll\"><arg type=\"s\" direction=\"in\"/><arg type=\"a{{sv}}\" direction=\"out\"/></method></interface>\n{body}\n</node>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixmaps_reorder_rgba_to_argb() {
        let Value::Array(_, icons) = pixmaps() else {
            panic!()
        };
        assert_eq!(icons.len(), 2);
        let Value::Struct(fields) = &icons[0] else {
            panic!()
        };
        assert_eq!(fields[0], Value::I32(32));
        let Value::Bytes(argb) = &fields[2] else {
            panic!()
        };
        assert_eq!(argb.len(), 32 * 32 * 4);
        let rgba = ICONS[0].1;
        assert_eq!(&argb[..4], &[rgba[3], rgba[0], rgba[1], rgba[2]]);
    }

    #[test]
    fn watcher_restarts_are_recognized() {
        let signal = |args: [&str; 3]| Message {
            body: args.iter().map(|a| Value::str(a)).collect(),
            ..Message::signal("/org/freedesktop/DBus", BUS, "NameOwnerChanged", vec![])
        };
        assert!(is_watcher_restart(&signal([WATCHER, "", ":1.5"])));
        assert!(!is_watcher_restart(&signal([WATCHER, ":1.5", ""])));
        assert!(!is_watcher_restart(&signal([
            "org.example.Other",
            "",
            ":1.5"
        ])));
    }

    #[test]
    fn introspection_is_well_formed_enough_for_hosts() {
        for path in [ITEM_PATH, MENU_PATH, "/"] {
            let xml = introspection(path);
            assert_eq!(
                xml.matches("<node").count() - xml.matches("<node name").count(),
                1
            );
            assert!(xml.ends_with("</node>"));
        }
        assert!(introspection(MENU_PATH).contains("(ia{sv}av)"));
    }
}
