//! The tray menu, rebuilt from a status report whenever it's asked for.
//!
//! Item ids come from content, not position: fixed ids for fixed items,
//! connection ids for browsers, and a hash of the origin for each refused
//! extension. A click on a menu the panel rendered a moment ago is resolved
//! against the current status, so a stale "Allow" can only ever allow the
//! origin it was shown for, or nothing.

use crate::control::{ago, web_socket_line};
use crate::hub::{ClientStatus, Setting, Status};

use super::dbus::Value;

pub const ROOT: i32 = 0;
const TITLE: i32 = 1;
const STATUS: i32 = 2;
const SEPARATOR_1: i32 = 3;
const BROWSERS: i32 = 10;
const DIAGNOSTICS: i32 = 20;
const WEB_SOCKET: i32 = 24;
const REFUSED: i32 = 25;
const EVENTS: i32 = 26;
const SETTINGS: i32 = 30;
const TOGGLE_USERSCRIPTS: i32 = 32;
const TOGGLE_DEBUG: i32 = 33;
const SEPARATOR_2: i32 = 40;
const QUIT: i32 = 41;
const EVENT_BASE: i32 = 100;
/// Refused origins live in `[REFUSED_BIT, CLIENT_BIT)`.
const REFUSED_BIT: i32 = 1 << 29;
/// Connections live above this, `base | 0..3` each.
const CLIENT_BIT: i32 = 1 << 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Allow(String),
    Toggle(Setting, bool),
    Debug(bool),
    Quit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub id: i32,
    pub label: String,
    pub enabled: bool,
    pub separator: bool,
    /// `Some` for a checkmark item.
    pub checked: Option<bool>,
    pub children: Vec<Item>,
}

impl Item {
    fn action(id: i32, label: impl Into<String>) -> Self {
        Self {
            id,
            label: label.into(),
            enabled: true,
            separator: false,
            checked: None,
            children: Vec::new(),
        }
    }

    fn info(id: i32, label: impl Into<String>) -> Self {
        Self {
            enabled: false,
            ..Self::action(id, label)
        }
    }

    fn separator(id: i32) -> Self {
        Self {
            separator: true,
            ..Self::action(id, "")
        }
    }

    fn check(id: i32, label: &str, checked: bool) -> Self {
        Self {
            checked: Some(checked),
            ..Self::action(id, label)
        }
    }

    fn submenu(id: i32, label: impl Into<String>, children: Vec<Item>) -> Self {
        Self {
            children,
            ..Self::action(id, label)
        }
    }

    pub fn find(&self, id: i32) -> Option<&Item> {
        if self.id == id {
            return Some(self);
        }
        self.children.iter().find_map(|child| child.find(id))
    }

    pub fn all(&self) -> Vec<&Item> {
        let mut items = vec![self];
        for child in &self.children {
            items.extend(child.all());
        }
        items
    }
}

fn client_base(client: &ClientStatus) -> i32 {
    CLIENT_BIT | ((client.id as i32 & 0x0FFF_FFFF) << 2)
}

/// FNV-1a, folded into the refused-origin id range.
fn refused_id(origin: &str) -> i32 {
    let hash = origin.bytes().fold(0x811c_9dc5_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
    });
    REFUSED_BIT | (hash & (REFUSED_BIT as u32 - 1)) as i32
}

/// The one-line summary used for the status item, the tooltip, and notifications.
pub fn status_line(status: &Status) -> String {
    if let Some((client, activity)) = status
        .clients
        .iter()
        .find_map(|c| c.activity.as_ref().map(|a| (c, a)))
    {
        return format!("Sharing {activity} from {}", client.name);
    }
    match status.clients.len() {
        0 => "Running, no browsers connected".to_string(),
        1 => "Running, 1 browser connected".to_string(),
        n => format!("Running, {n} browsers connected"),
    }
}

pub fn build(status: &Status) -> Item {
    let browsers = if status.clients.is_empty() {
        Item::info(BROWSERS, "No browsers connected")
    } else {
        Item::submenu(
            BROWSERS,
            format!("Browsers ({})", status.clients.len()),
            status.clients.iter().map(client_item).collect(),
        )
    };

    let mut diagnostics = vec![Item::info(
        WEB_SOCKET,
        format!("WebSocket: {}", web_socket_line(status)),
    )];
    if !status.refused.is_empty() {
        diagnostics.push(Item::submenu(
            REFUSED,
            format!("Refused extensions ({})", status.refused.len()),
            status
                .refused
                .iter()
                .map(|refused| {
                    Item::action(
                        refused_id(&refused.origin),
                        format!(
                            "Allow {} (tried {}×, {})",
                            refused.origin,
                            refused.count,
                            ago(refused.secs_ago)
                        ),
                    )
                })
                .collect(),
        ));
    }
    if !status.events.is_empty() {
        diagnostics.push(Item::submenu(
            EVENTS,
            "Recent events",
            status
                .events
                .iter()
                .take(10)
                .zip(EVENT_BASE..)
                .map(|(event, id)| {
                    Item::info(id, format!("{} · {}", ago(event.secs_ago), event.text))
                })
                .collect(),
        ));
    }

    let settings = Item::submenu(
        SETTINGS,
        "Settings",
        vec![
            Item::check(
                TOGGLE_USERSCRIPTS,
                "Allow userscripts (any web page can connect)",
                status.settings.allow_userscripts,
            ),
            Item::check(TOGGLE_DEBUG, "Debug logging (this run)", status.debug),
        ],
    );

    Item::submenu(
        ROOT,
        "",
        vec![
            Item::info(TITLE, "Parousia Desktop"),
            Item::info(STATUS, status_line(status)),
            Item::separator(SEPARATOR_1),
            browsers,
            Item::submenu(DIAGNOSTICS, "Diagnostics", diagnostics),
            settings,
            Item::separator(SEPARATOR_2),
            Item::action(QUIT, "Quit Parousia Desktop"),
        ],
    )
}

fn client_item(client: &ClientStatus) -> Item {
    let base = client_base(client);
    Item::submenu(
        base,
        client.name.clone(),
        vec![
            Item::info(base | 1, client.identity.clone()),
            Item::info(
                base | 2,
                match &client.activity {
                    Some(activity) => format!(
                        "Connected {}, sharing {activity}",
                        ago(client.connected_secs)
                    ),
                    None => format!("Connected {}, nothing to share", ago(client.connected_secs)),
                },
            ),
        ],
    )
}

/// What clicking `id` means, resolved against the current status.
pub fn action_for(status: &Status, id: i32) -> Option<Action> {
    match id {
        TOGGLE_USERSCRIPTS => Some(Action::Toggle(
            Setting::AllowUserscripts,
            !status.settings.allow_userscripts,
        )),
        TOGGLE_DEBUG => Some(Action::Debug(!status.debug)),
        QUIT => Some(Action::Quit),
        id if (REFUSED_BIT..CLIENT_BIT).contains(&id) => {
            let mut matches = status
                .refused
                .iter()
                .filter(|r| refused_id(&r.origin) == id);
            match (matches.next(), matches.next()) {
                (Some(refused), None) => Some(Action::Allow(refused.origin.clone())),
                // A hash collision between two refused origins: do nothing
                // rather than guess.
                _ => None,
            }
        }
        _ => None,
    }
}

/// dbusmenu treats `_` as a mnemonic marker; a literal one is doubled.
fn escape_label(label: &str) -> String {
    label.replace('_', "__")
}

pub fn properties(item: &Item, filter: &[String]) -> Value {
    let wanted = |name: &str| filter.is_empty() || filter.iter().any(|f| f == name);
    let mut entries = Vec::new();
    if item.separator {
        if wanted("type") {
            entries.push(("type", Value::str("separator")));
        }
    } else if wanted("label") {
        entries.push(("label", Value::Str(escape_label(&item.label))));
    }
    if !item.enabled && wanted("enabled") {
        entries.push(("enabled", Value::Bool(false)));
    }
    if let Some(checked) = item.checked {
        if wanted("toggle-type") {
            entries.push(("toggle-type", Value::str("checkmark")));
        }
        if wanted("toggle-state") {
            entries.push(("toggle-state", Value::I32(i32::from(checked))));
        }
    }
    if !item.children.is_empty() && wanted("children-display") {
        entries.push(("children-display", Value::str("submenu")));
    }
    Value::dict(entries)
}

/// `(ia{sv}av)`, recursing `depth` levels (`None` for all of them).
pub fn layout(item: &Item, depth: Option<usize>, filter: &[String]) -> Value {
    let children = match depth {
        Some(0) => Vec::new(),
        _ => item
            .children
            .iter()
            .map(|child| Value::variant(layout(child, depth.map(|d| d - 1), filter)))
            .collect(),
    };
    Value::Struct(vec![
        Value::I32(item.id),
        properties(item, filter),
        Value::Array("v".into(), children),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::Gate;
    use crate::hub::tests::{CHROMIUM, OTHER, test_hub};

    fn labels(item: &Item) -> Vec<String> {
        item.all()
            .iter()
            .filter(|i| !i.separator)
            .map(|i| i.label.clone())
            .collect()
    }

    #[test]
    fn an_idle_desktop_shows_its_status_diagnostics_and_settings() {
        let hub = test_hub();
        let menu = build(&hub.status());
        let labels = labels(&menu);
        for expected in [
            "Running, no browsers connected",
            "No browsers connected",
            "Allow userscripts (any web page can connect)",
            "Quit Parousia Desktop",
        ] {
            assert!(
                labels.contains(&expected.to_string()),
                "missing {expected:?} in {labels:?}"
            );
        }
        assert!(
            labels
                .iter()
                .any(|label| label.starts_with("WebSocket: listening on 127.0.0.1:57179")),
            "{labels:?}"
        );
        assert_eq!(menu.find(TOGGLE_USERSCRIPTS).unwrap().checked, Some(false));
    }

    #[test]
    fn debug_logging_toggles_for_this_run() {
        let mut status = test_hub().status();
        assert_eq!(action_for(&status, TOGGLE_DEBUG), Some(Action::Debug(true)));
        status.debug = true;
        assert_eq!(
            action_for(&status, TOGGLE_DEBUG),
            Some(Action::Debug(false))
        );
    }

    #[test]
    fn toggles_flip_the_current_setting() {
        let hub = test_hub();
        let status = hub.status();
        assert_eq!(
            action_for(&status, TOGGLE_USERSCRIPTS),
            Some(Action::Toggle(Setting::AllowUserscripts, true))
        );
        assert_eq!(action_for(&status, STATUS), None);
    }

    #[test]
    fn connected_browsers_are_listed_with_their_identity() {
        let hub = test_hub();
        let Gate::Admit(peer) = hub.ws_gate(CHROMIUM, true) else {
            panic!("not admitted");
        };
        hub.connect(peer, "Chromium on Linux", crate::hub::tests::noop_closer());
        let menu = build(&hub.status());
        let browsers = menu.find(BROWSERS).unwrap();
        assert_eq!(browsers.label, "Browsers (1)");
        assert_eq!(browsers.children[0].label, "Chromium on Linux");
        assert_eq!(browsers.children[0].children[0].label, CHROMIUM);
    }

    #[test]
    fn refused_extensions_can_be_allowed_and_a_stale_click_does_nothing() {
        let hub = test_hub();
        hub.ws_gate(OTHER, true);
        let status = hub.status();
        let menu = build(&status);
        let allow = &menu.find(REFUSED).unwrap().children[0];
        assert!(allow.label.starts_with(&format!("Allow {OTHER}")));
        assert_eq!(
            action_for(&status, allow.id),
            Some(Action::Allow(OTHER.to_string()))
        );

        hub.allow(OTHER).unwrap();
        assert_eq!(action_for(&hub.status(), allow.id), None);
    }

    #[test]
    fn ids_stay_in_their_ranges() {
        for origin in [OTHER, CHROMIUM, "moz-extension://x"] {
            let id = refused_id(origin);
            assert!((REFUSED_BIT..CLIENT_BIT).contains(&id));
        }
        const { assert!(EVENT_BASE + 10 < REFUSED_BIT) };
    }

    #[test]
    fn checkmarks_and_submenus_are_marked_for_the_host() {
        let item = Item::check(99, "my_setting", true);
        assert_eq!(
            properties(&item, &[]),
            Value::dict(vec![
                ("label", Value::str("my__setting")),
                ("toggle-type", Value::str("checkmark")),
                ("toggle-state", Value::I32(1)),
            ])
        );
        let menu = build(&test_hub().status());
        let Value::Struct(fields) = layout(&menu, Some(0), &[]) else {
            panic!()
        };
        assert_eq!(fields[2], Value::Array("v".into(), vec![]));
    }
}
