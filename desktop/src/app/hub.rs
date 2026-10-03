//! Desktop's shared state: settings, the live connections with the latest
//! Presence each one reported, the platform adapters, a short in-memory
//! event log, and the extensions recently turned away. Nothing about a
//! client outlives its connection. Sessions (`session.rs`), the tray, the
//! console, and control requests all go through here.
//!
//! What each platform shows: of the connections that allow it, the one
//! whose Activity changed most recently. When that one clears or goes away,
//! the next most recent still-current Activity takes over.

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::adapters::coalesce::Coalesced;
use crate::adapters::{AdapterStatus, PlatformAdapter, Platforms, Reporter};
use crate::app::config::Settings;
use crate::app::presence::{Activity, Presence, display_text};
use crate::link::identity::{self, ClientKind, Origin, Peer};

const MAX_EVENTS: usize = 20;
const MAX_REFUSED: usize = 8;
const MAX_TEXT_CHARS: usize = 120;
const MAX_NAME_CHARS: usize = 64;
/// Keeps a status report inside one protocol frame.
const MAX_LISTED_CLIENTS: usize = 32;

/// Ends a live connection from another thread (its socket's `shutdown`).
pub type Closer = Box<dyn Fn() + Send + Sync>;
pub type ConnId = u64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubEvent {
    Changed,
    /// An extension origin that isn't allowed tried to connect, for the first
    /// time since it was last on the refused list.
    Refused {
        origin: String,
    },
    /// Someone launched Desktop again while it was running: show where it is.
    ShowRequested,
}

pub type Listener = Box<dyn Fn(HubEvent) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Setting {
    AllowUserscripts,
}

/// What `status` answers with: one shape for the CLI, the tray, and
/// Parousia's dashboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub version: String,
    pub clients: Vec<ClientStatus>,
    pub transport: TransportStatus,
    pub settings: Settings,
    pub refused: Vec<RefusedStatus>,
    pub events: Vec<EventStatus>,
    pub debug: bool,
    /// Each platform adapter's state.
    pub platforms: Vec<AdapterStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    pub id: ConnId,
    pub name: String,
    pub kind: ClientKind,
    pub identity: String,
    pub connected_secs: u64,
    pub activity: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportStatus {
    /// Where the WebSocket listens.
    pub address: String,
    /// Whether connections from other OS users are detected and closed.
    pub same_user_check: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedStatus {
    pub origin: String,
    pub count: u32,
    pub secs_ago: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventStatus {
    pub secs_ago: u64,
    pub text: String,
}

/// What the WebSocket upgrade does with an `Origin`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    Admit(Peer),
    /// An exact extension origin that isn't allowed: told so, so Parousia's
    /// popup can explain what to do.
    NotAllowed,
    /// Everything else: a plain 403 that says nothing about Desktop.
    Forbidden,
}

pub struct Hub {
    inner: Mutex<Inner>,
    config_path: PathBuf,
    address: String,
    listener: Mutex<Option<Listener>>,
}

struct Inner {
    settings: Settings,
    connections: BTreeMap<ConnId, Live>,
    next_id: ConnId,
    events: VecDeque<(u64, String)>,
    refused: Vec<Refused>,
    /// Debug mode: off at every start, so Desktop prints nothing and keeps no
    /// event history unless someone turns it on for this run.
    debug: bool,
    adapters: Vec<Routed>,
    /// Orders Presence changes across connections.
    next_seq: u64,
}

struct Live {
    peer: Peer,
    name: String,
    since: u64,
    presence: Option<Presence>,
    platforms: Platforms,
    /// When this connection's Presence last changed, in `next_seq` order.
    seq: u64,
    closer: Closer,
}

struct Routed {
    adapter: Box<dyn PlatformAdapter>,
    /// What it was last told to show.
    given: Option<Activity>,
}

struct Refused {
    origin: String,
    count: u32,
    last: u64,
}

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

impl Hub {
    pub fn new(settings: Settings, config_path: PathBuf, address: String) -> Self {
        Self {
            inner: Mutex::new(Inner {
                settings,
                connections: BTreeMap::new(),
                next_id: 1,
                events: VecDeque::new(),
                refused: Vec::new(),
                debug: false,
                adapters: Vec::new(),
                next_seq: 0,
            }),
            config_path,
            address,
            listener: Mutex::new(None),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // Only the tray (Linux, Windows) listens so far.
    #[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
    pub fn set_listener(&self, listener: Listener) {
        *self.listener.lock().unwrap_or_else(|p| p.into_inner()) = Some(listener);
    }

    fn notify(&self, event: HubEvent) {
        if let Some(listener) = self
            .listener
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            listener(event);
        }
    }

    pub fn request_show(&self) {
        self.notify(HubEvent::ShowRequested);
    }

    /// Adds a platform adapter and tells it what to show right away. Every
    /// adapter gets the same coalescing here, so none has to do its own.
    pub fn add_adapter(&self, adapter: Box<dyn PlatformAdapter>) {
        let mut inner = self.lock();
        inner.adapters.push(Routed {
            adapter: Box::new(Coalesced::new(adapter)),
            given: None,
        });
        route(&mut inner);
    }

    /// For an adapter to report what it's doing: kept in the event log in
    /// debug mode, and the tray is refreshed. Holds the Hub weakly, since
    /// the Hub owns the adapter.
    pub fn reporter(self: &Arc<Self>) -> Reporter {
        let hub: Weak<Self> = Arc::downgrade(self);
        Box::new(move |text| {
            let Some(hub) = hub.upgrade() else {
                return;
            };
            log_event(&mut hub.lock(), text);
            hub.notify(HubEvent::Changed);
        })
    }

    /// The WebSocket's gate: only allowed Parousia extension origins, and web
    /// origins while userscripts are allowed.
    pub fn ws_gate(&self, origin: &str, same_user: bool) -> Gate {
        let mut inner = self.lock();
        let kind = match identity::classify_origin(origin) {
            Origin::Extension(kind)
                if identity::is_allowed_origin(origin, &inner.settings.allowed_origins) =>
            {
                kind
            }
            Origin::Extension(_) => {
                let first = record_refusal(&mut inner, origin);
                let debug = inner.debug;
                drop(inner);
                if first {
                    if debug {
                        println!(
                            "parousia-desktop: refused {origin}: not an allowed Parousia build (`Parousia-Desktop allow {origin}` if it is)"
                        );
                    }
                    self.notify(HubEvent::Refused {
                        origin: origin.to_string(),
                    });
                }
                self.notify(HubEvent::Changed);
                return Gate::NotAllowed;
            }
            Origin::Web if inner.settings.allow_userscripts => ClientKind::Userscript,
            Origin::Web | Origin::Invalid => return Gate::Forbidden,
        };
        Gate::Admit(Peer {
            kind,
            identity: origin.to_string(),
            same_user,
        })
    }

    pub fn connect(&self, peer: Peer, name: &str, closer: Closer) -> ConnId {
        let name = sanitize_name(name, peer.kind);
        let mut inner = self.lock();
        let id = inner.next_id;
        inner.next_id += 1;
        let text = format!("{name} connected");
        if inner.debug {
            println!("parousia-desktop: {text} from {}", peer.identity);
        }
        record_event(&mut inner, text);
        inner.connections.insert(
            id,
            Live {
                peer,
                name,
                since: unix_now(),
                presence: None,
                platforms: Platforms::ALL,
                seq: 0,
                closer,
            },
        );
        drop(inner);
        self.notify(HubEvent::Changed);
        id
    }

    /// `platforms` are where this connection's Presence may be shown.
    pub fn update_presence(&self, id: ConnId, presence: Presence, platforms: Platforms) {
        let mut inner = self.lock();
        let debug = inner.debug;
        let seq = inner.next_seq + 1;
        let Some(live) = inner.connections.get_mut(&id) else {
            return;
        };
        let changed = live.presence.as_ref().map(|p| &p.activity) != Some(&presence.activity);
        let rerouted = changed || live.platforms != platforms;
        if changed && debug {
            println!(
                "parousia-desktop: presence from {}: {}",
                live.name,
                presence
                    .activity
                    .as_ref()
                    .map_or("none".to_string(), |activity| display_text(
                        &activity.id,
                        MAX_NAME_CHARS
                    ))
            );
        }
        live.presence = Some(presence);
        live.platforms = platforms;
        if rerouted {
            live.seq = seq;
            inner.next_seq = seq;
            route(&mut inner);
        }
        drop(inner);
        if changed {
            self.notify(HubEvent::Changed);
        }
    }

    /// Drops the connection and, with it, whatever Presence it reported.
    pub fn disconnect(&self, id: ConnId) {
        let mut inner = self.lock();
        let Some(live) = inner.connections.remove(&id) else {
            return;
        };
        let text = format!("{} disconnected", live.name);
        log_event(&mut inner, text);
        route(&mut inner);
        drop(inner);
        self.notify(HubEvent::Changed);
    }

    pub fn debug(&self) -> bool {
        self.lock().debug
    }

    /// Turns debug mode on or off for this run only; it's never saved.
    /// Turning it off also forgets the event history kept meanwhile.
    pub fn set_debug(&self, on: bool) {
        let mut inner = self.lock();
        if inner.debug == on {
            return;
        }
        if !on {
            inner.events.clear();
        }
        inner.debug = on;
        drop(inner);
        if on {
            println!("parousia-desktop: debug logging on");
        }
        self.notify(HubEvent::Changed);
    }

    pub fn set(&self, setting: Setting, value: bool) -> Result<(), String> {
        let mut inner = self.lock();
        let mut next = inner.settings.clone();
        match setting {
            Setting::AllowUserscripts => next.allow_userscripts = value,
        }
        if next == inner.settings {
            return Ok(());
        }
        next.save(&self.config_path)
            .map_err(|err| format!("couldn't save settings: {err}"))?;
        inner.settings = next;
        let text = format!(
            "{} turned {}",
            match setting {
                Setting::AllowUserscripts => "Userscripts",
            },
            if value { "on" } else { "off" }
        );
        log_event(&mut inner, text);
        // Turning something off also ends the connections it let in.
        let closers = if value {
            Vec::new()
        } else {
            take_closers(&mut inner, |live| match setting {
                Setting::AllowUserscripts => live.peer.kind == ClientKind::Userscript,
            })
        };
        drop(inner);
        closers.iter().for_each(|close| close());
        self.notify(HubEvent::Changed);
        Ok(())
    }

    /// Only ever called from a local UI (CLI, console, tray), never on a
    /// browser's behalf.
    pub fn allow(&self, origin: &str) -> Result<(), String> {
        identity::validate_allowed_origin(origin).map_err(|err| err.to_string())?;
        let mut inner = self.lock();
        if inner.settings.allowed_origins.iter().any(|o| o == origin) {
            return Ok(());
        }
        let mut next = inner.settings.clone();
        next.allowed_origins.push(origin.to_string());
        next.save(&self.config_path)
            .map_err(|err| format!("couldn't save settings: {err}"))?;
        inner.settings = next;
        inner.refused.retain(|refused| refused.origin != origin);
        log_event(&mut inner, format!("Allowed {origin}"));
        drop(inner);
        self.notify(HubEvent::Changed);
        Ok(())
    }

    pub fn disallow(&self, origin: &str) -> Result<(), String> {
        let mut inner = self.lock();
        if !inner.settings.allowed_origins.iter().any(|o| o == origin) {
            return Err(format!("{origin} isn't in allowedOrigins"));
        }
        let mut next = inner.settings.clone();
        next.allowed_origins.retain(|o| o != origin);
        next.save(&self.config_path)
            .map_err(|err| format!("couldn't save settings: {err}"))?;
        inner.settings = next;
        log_event(&mut inner, format!("Disallowed {origin}"));
        let closers = take_closers(&mut inner, |live| live.peer.identity == origin);
        drop(inner);
        closers.iter().for_each(|close| close());
        self.notify(HubEvent::Changed);
        Ok(())
    }

    pub fn status(&self) -> Status {
        let inner = self.lock();
        let now = unix_now();
        Status {
            version: env!("CARGO_PKG_VERSION").to_string(),
            clients: inner
                .connections
                .iter()
                .take(MAX_LISTED_CLIENTS)
                .map(|(id, live)| ClientStatus {
                    id: *id,
                    name: live.name.clone(),
                    kind: live.peer.kind,
                    identity: truncate(&live.peer.identity, MAX_TEXT_CHARS),
                    connected_secs: now.saturating_sub(live.since),
                    activity: live
                        .presence
                        .as_ref()
                        .and_then(|p| p.activity.as_ref())
                        .map(|activity| display_text(&activity.name, MAX_NAME_CHARS)),
                })
                .collect(),
            transport: TransportStatus {
                address: self.address.clone(),
                same_user_check: crate::platform::VERIFIES_PEERS,
            },
            settings: inner.settings.clone(),
            refused: inner
                .refused
                .iter()
                .map(|refused| RefusedStatus {
                    origin: refused.origin.clone(),
                    count: refused.count,
                    secs_ago: now.saturating_sub(refused.last),
                })
                .collect(),
            events: inner
                .events
                .iter()
                .rev()
                .map(|(at, text)| EventStatus {
                    secs_ago: now.saturating_sub(*at),
                    text: text.clone(),
                })
                .collect(),
            debug: inner.debug,
            platforms: inner
                .adapters
                .iter()
                .map(|routed| routed.adapter.status())
                .collect(),
        }
    }
}

/// Tells each adapter what it should now show, if that changed.
fn route(inner: &mut Inner) {
    let Inner {
        adapters,
        connections,
        ..
    } = inner;
    for routed in adapters {
        let platform = routed.adapter.platform();
        let winner = connections
            .values()
            .filter(|live| live.platforms.contains(platform))
            .filter_map(|live| {
                let activity = live.presence.as_ref()?.activity.as_ref()?;
                Some((live.seq, activity))
            })
            .max_by_key(|(seq, _)| *seq)
            .map(|(_, activity)| activity);
        // Compared before copying: most reroutes leave a platform's winner as it was.
        if winner != routed.given.as_ref() {
            routed.given = winner.cloned();
            routed.adapter.show(routed.given.clone());
        }
    }
}

/// Debug mode only: prints `text` and keeps it among the recent events.
fn log_event(inner: &mut Inner, text: String) {
    if inner.debug {
        println!("parousia-desktop: {text}");
    }
    record_event(inner, text);
}

/// Debug mode only: keeps `text` among the recent events, without printing it.
fn record_event(inner: &mut Inner, text: String) {
    if !inner.debug {
        return;
    }
    if inner.events.len() == MAX_EVENTS {
        inner.events.pop_front();
    }
    inner
        .events
        .push_back((unix_now(), truncate(&text, MAX_TEXT_CHARS)));
}

/// Returns whether `origin` wasn't already on the refused list.
fn record_refusal(inner: &mut Inner, origin: &str) -> bool {
    let now = unix_now();
    if let Some(refused) = inner.refused.iter_mut().find(|r| r.origin == origin) {
        refused.count = refused.count.saturating_add(1);
        refused.last = now;
        return false;
    }
    if inner.refused.len() == MAX_REFUSED
        && let Some(oldest) = (0..inner.refused.len()).min_by_key(|&i| inner.refused[i].last)
    {
        inner.refused.remove(oldest);
    }
    inner.refused.push(Refused {
        origin: origin.to_string(),
        count: 1,
        last: now,
    });
    record_event(inner, format!("Refused {origin} (not allowed)"));
    true
}

fn take_closers(inner: &mut Inner, matches: impl Fn(&Live) -> bool) -> Vec<Closer> {
    let ids: Vec<ConnId> = inner
        .connections
        .iter()
        .filter(|(_, live)| matches(live))
        .map(|(id, _)| *id)
        .collect();
    let mut closers = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(live) = inner.connections.remove(&id) else {
            continue;
        };
        // Removed here, so the session's own `disconnect` finds nothing to log.
        let text = format!("{} disconnected", live.name);
        log_event(inner, text);
        closers.push(live.closer);
    }
    route(inner);
    closers
}

fn truncate(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// Client-supplied names end up in logs and menus (see `display_text`).
fn sanitize_name(name: &str, kind: ClientKind) -> String {
    match display_text(name, MAX_NAME_CHARS).trim() {
        "" => kind.describe().to_string(),
        trimmed => trimmed.to_string(),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::adapters::Platform;
    use crate::app::config::tests::temp_dir;
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub const CHROMIUM: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    pub const FIREFOX: &str = "moz-extension://2c127fa4-62c7-7e4f-90e5-472b45eecfdc";
    pub const OTHER: &str = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";

    pub fn test_hub() -> Hub {
        test_hub_with(Settings {
            allowed_origins: vec![CHROMIUM.to_string(), FIREFOX.to_string()],
            ..Settings::default()
        })
    }

    pub fn test_hub_with(settings: Settings) -> Hub {
        Hub::new(
            settings,
            temp_dir("hub").join("config.json"),
            "127.0.0.1:57179".to_string(),
        )
    }

    pub fn noop_closer() -> Closer {
        Box::new(|| {})
    }

    fn counting_closer(count: &Arc<AtomicUsize>) -> Closer {
        let count = Arc::clone(count);
        Box::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        })
    }

    fn admit(hub: &Hub, origin: &str) -> Peer {
        match hub.ws_gate(origin, true) {
            Gate::Admit(peer) => peer,
            other => panic!("{origin} not admitted: {other:?}"),
        }
    }

    #[test]
    fn only_allowed_extension_origins_get_through() {
        let hub = test_hub();
        assert_eq!(admit(&hub, CHROMIUM).kind, ClientKind::ChromiumExtension);
        assert_eq!(admit(&hub, FIREFOX).kind, ClientKind::FirefoxExtension);
        assert_eq!(hub.ws_gate(OTHER, true), Gate::NotAllowed);
        for quiet in [
            "https://example.com",
            "null",
            "",
            "file://",
            "safari-web-extension://x",
        ] {
            assert_eq!(hub.ws_gate(quiet, true), Gate::Forbidden, "{quiet}");
        }
    }

    #[test]
    fn userscripts_are_opt_in() {
        let hub = test_hub();
        assert_eq!(hub.ws_gate("https://example.com", true), Gate::Forbidden);
        hub.set(Setting::AllowUserscripts, true).unwrap();
        for web in ["https://example.com", "null"] {
            assert_eq!(admit(&hub, web).kind, ClientKind::Userscript);
        }
    }

    #[test]
    fn turning_userscripts_off_drops_their_connections_only() {
        let hub = test_hub_with(Settings {
            allowed_origins: vec![CHROMIUM.to_string()],
            allow_userscripts: true,
            ..Settings::default()
        });
        hub.set_debug(true);
        let closed = Arc::new(AtomicUsize::new(0));
        hub.connect(admit(&hub, CHROMIUM), "Chromium", counting_closer(&closed));
        hub.connect(
            admit(&hub, "https://example.com"),
            "Page",
            counting_closer(&closed),
        );

        hub.set(Setting::AllowUserscripts, false).unwrap();
        assert_eq!(hub.ws_gate("https://example.com", true), Gate::Forbidden);
        assert_eq!(closed.load(Ordering::SeqCst), 1, "only the userscript");
        let status = hub.status();
        assert_eq!(status.clients.len(), 1);
        assert!(
            status
                .events
                .iter()
                .any(|event| event.text == "Page disconnected"),
            "the drop shows up in the event log"
        );
    }

    #[test]
    fn settings_changes_are_saved() {
        let hub = test_hub();
        hub.set(Setting::AllowUserscripts, true).unwrap();
        assert!(Settings::load(&hub.config_path).unwrap().allow_userscripts);
    }

    #[test]
    fn refused_extensions_are_listed_once_each_and_can_be_allowed() {
        let hub = test_hub();
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&events);
        hub.set_listener(Box::new(move |event| seen.lock().unwrap().push(event)));

        for _ in 0..3 {
            assert_eq!(hub.ws_gate(OTHER, true), Gate::NotAllowed);
        }
        let status = hub.status();
        assert_eq!(status.refused.len(), 1);
        assert_eq!(status.refused[0].count, 3);
        let first_refusals = events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, HubEvent::Refused { .. }))
            .count();
        assert_eq!(first_refusals, 1);

        hub.allow(OTHER).unwrap();
        assert_eq!(admit(&hub, OTHER).identity, OTHER);
        assert!(hub.status().refused.is_empty());
        assert!(
            Settings::load(&hub.config_path)
                .unwrap()
                .allowed_origins
                .contains(&OTHER.to_string())
        );
    }

    #[test]
    fn only_exact_extension_origins_can_be_allowed_and_disallowing_closes_them() {
        let hub = test_hub();
        assert!(hub.allow("https://example.com").is_err());
        assert!(hub.allow("*").is_err());

        let closed = Arc::new(AtomicUsize::new(0));
        hub.connect(admit(&hub, CHROMIUM), "Chromium", counting_closer(&closed));
        hub.disallow(CHROMIUM).unwrap();
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert_eq!(hub.ws_gate(CHROMIUM, true), Gate::NotAllowed);
        assert!(hub.disallow(CHROMIUM).is_err());
    }

    pub fn example_activity(id: &str) -> Activity {
        Activity {
            id: id.into(),
            name: id.to_uppercase(),
            details: None,
            state: None,
            assets: None,
            timestamps: None,
            discord_client_id: None,
            details_url: None,
            state_url: None,
            buttons: Vec::new(),
            kind: None,
            status_display_type: None,
            party: None,
        }
    }

    fn presence(activity: Option<&str>) -> Presence {
        Presence {
            activity: activity.map(example_activity),
            updated_at: 1,
        }
    }

    #[test]
    fn presence_is_kept_per_connection_and_dropped_with_it() {
        let hub = test_hub();
        hub.set_debug(true);
        let id = hub.connect(admit(&hub, CHROMIUM), "Chromium on Linux", noop_closer());
        hub.update_presence(id, presence(Some("example")), Platforms::ALL);
        let status = hub.status();
        assert_eq!(status.clients[0].activity.as_deref(), Some("EXAMPLE"));
        hub.disconnect(id);
        let status = hub.status();
        assert!(status.clients.is_empty());
        assert_eq!(status.events[0].text, "Chromium on Linux disconnected");
        assert_eq!(status.events[1].text, "Chromium on Linux connected");
    }

    /// Records what the Hub tells it to show.
    struct Recorder {
        platform: Platform,
        shown: Arc<Mutex<Vec<Option<String>>>>,
    }

    impl PlatformAdapter for Recorder {
        fn platform(&self) -> Platform {
            self.platform
        }

        fn show(&self, activity: Option<Activity>) {
            self.shown.lock().unwrap().push(activity.map(|a| a.id));
        }

        fn status(&self) -> AdapterStatus {
            AdapterStatus {
                platform: self.platform,
                state: crate::adapters::AdapterState::Idle,
                activity: None,
                error: None,
            }
        }
    }

    fn recorder(hub: &Hub, platform: Platform) -> Arc<Mutex<Vec<Option<String>>>> {
        let shown = Arc::new(Mutex::new(Vec::new()));
        hub.add_adapter(Box::new(Recorder {
            platform,
            shown: Arc::clone(&shown),
        }));
        shown
    }

    fn calls(shown: &Mutex<Vec<Option<String>>>) -> Vec<Option<String>> {
        shown.lock().unwrap().clone()
    }

    fn ids(expected: &[Option<&str>]) -> Vec<Option<String>> {
        expected.iter().map(|id| id.map(String::from)).collect()
    }

    #[test]
    fn the_latest_change_wins_and_the_next_takes_over_when_it_ends() {
        let hub = test_hub();
        let discord = recorder(&hub, Platform::Discord);
        let chrome = hub.connect(admit(&hub, CHROMIUM), "Chromium", noop_closer());
        let firefox = hub.connect(admit(&hub, FIREFOX), "Firefox", noop_closer());

        hub.update_presence(chrome, presence(Some("youtube")), Platforms::ALL);
        hub.update_presence(firefox, presence(Some("jena")), Platforms::ALL);
        // Resending the same thing isn't a change, so Firefox keeps it.
        hub.update_presence(chrome, presence(Some("youtube")), Platforms::ALL);
        // Firefox moves on to nothing: Chromium's is still current.
        hub.update_presence(firefox, presence(None), Platforms::ALL);
        hub.update_presence(firefox, presence(Some("jena")), Platforms::ALL);
        hub.disconnect(firefox);
        hub.disconnect(chrome);
        assert_eq!(
            calls(&discord),
            ids(&[
                Some("youtube"),
                Some("jena"),
                Some("youtube"),
                Some("jena"),
                Some("youtube"),
                None
            ])
        );
    }

    #[test]
    fn adapters_are_given_coalescing_but_a_new_subject_still_goes_at_once() {
        let hub = test_hub();
        let discord = recorder(&hub, Platform::Discord);
        let chrome = hub.connect(admit(&hub, CHROMIUM), "Chromium", noop_closer());
        hub.update_presence(chrome, presence(Some("youtube")), Platforms::ALL);
        let mut next_video = presence(Some("youtube"));
        next_video.activity.as_mut().unwrap().details = Some("another video".into());
        hub.update_presence(chrome, next_video, Platforms::ALL);
        assert_eq!(calls(&discord), ids(&[Some("youtube")]), "the update waits");
        hub.update_presence(chrome, presence(Some("github")), Platforms::ALL);
        assert_eq!(calls(&discord), ids(&[Some("youtube"), Some("github")]));
    }

    #[test]
    fn a_platform_only_shows_connections_that_allow_it() {
        let hub = test_hub();
        let discord = recorder(&hub, Platform::Discord);
        let stoat = recorder(&hub, Platform::Stoat);
        let chrome = hub.connect(admit(&hub, CHROMIUM), "Chromium", noop_closer());
        let firefox = hub.connect(admit(&hub, FIREFOX), "Firefox", noop_closer());

        let stoat_only = Platforms::from_wire(Some(&[Platform::Stoat]));
        hub.update_presence(chrome, presence(Some("youtube")), Platforms::ALL);
        hub.update_presence(firefox, presence(Some("jena")), stoat_only);
        assert_eq!(calls(&discord), ids(&[Some("youtube")]));
        assert_eq!(calls(&stoat), ids(&[Some("youtube"), Some("jena")]));

        // Turning Discord off in Chromium clears it there, and nothing else
        // allows Discord.
        let none = Platforms::from_wire(Some(&[]));
        hub.update_presence(chrome, presence(Some("youtube")), none);
        assert_eq!(calls(&discord), ids(&[Some("youtube"), None]));
        assert_eq!(calls(&stoat), ids(&[Some("youtube"), Some("jena")]));
    }

    #[test]
    fn disallowing_a_browser_clears_what_it_showed() {
        let hub = test_hub();
        let chrome = hub.connect(admit(&hub, CHROMIUM), "Chromium", noop_closer());
        hub.update_presence(chrome, presence(Some("youtube")), Platforms::ALL);
        // Added late: told about what's already there.
        let discord = recorder(&hub, Platform::Discord);
        hub.disallow(CHROMIUM).unwrap();
        assert_eq!(calls(&discord), ids(&[Some("youtube"), None]));
        assert_eq!(hub.status().platforms.len(), 1);
    }

    #[test]
    fn adapters_report_into_the_debug_log() {
        let hub = Arc::new(test_hub());
        let report = hub.reporter();
        report("Discord: connecting".into());
        assert!(hub.status().events.is_empty(), "silent by default");
        hub.set_debug(true);
        report("Discord: showing Jena Hub".into());
        assert_eq!(hub.status().events[0].text, "Discord: showing Jena Hub");
    }

    #[test]
    fn debug_mode_is_off_by_default_and_keeps_nothing() {
        let hub = test_hub();
        hub.ws_gate(OTHER, true);
        assert!(!hub.status().debug);
        assert!(hub.status().events.is_empty());
        // The refusal itself is still tracked: the "Allow" shortcut needs it.
        assert_eq!(hub.status().refused.len(), 1);

        hub.set_debug(true);
        hub.ws_gate("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true);
        assert_eq!(hub.status().events.len(), 1);
        hub.set_debug(false);
        assert!(hub.status().events.is_empty());
    }

    #[test]
    fn the_event_log_and_refused_list_are_bounded() {
        let hub = test_hub();
        hub.set_debug(true);
        for i in 0..50 {
            let peer = admit(&hub, FIREFOX);
            let id = hub.connect(peer, &format!("client {i}"), noop_closer());
            hub.disconnect(id);
        }
        for letter in "abcdefghijklmnop".chars() {
            let origin = format!("chrome-extension://{}{letter}", "p".repeat(31));
            hub.ws_gate(&origin, true);
        }
        let status = hub.status();
        assert_eq!(status.events.len(), MAX_EVENTS);
        assert_eq!(status.refused.len(), MAX_REFUSED);
    }

    #[test]
    fn names_are_bounded_and_stripped_of_control_and_direction_characters() {
        assert_eq!(
            sanitize_name("Fire\u{202E}fox\n on Linux", ClientKind::FirefoxExtension),
            "Firefox on Linux"
        );
        assert_eq!(sanitize_name("   ", ClientKind::Userscript), "userscript");
        assert_eq!(
            sanitize_name(&"x".repeat(200), ClientKind::Userscript).len(),
            MAX_NAME_CHARS
        );
    }
}
