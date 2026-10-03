//! Discord Rich Presence through the Discord app's local RPC (`ipc.rs` for
//! the framing, `platform::discord` for the socket or pipe).
//!
//! A worker thread owns the connection and does everything that waits:
//! finding Discord, the handshake, retrying, and pacing updates. `show`
//! only hands over the latest Activity, so the Hub never waits on Discord.
//! The worker starts when there's something to show and ends once there's
//! nothing to show and no connection, so an idle Desktop has no thread for
//! Discord at all.
//!
//! - Connects only while there's something to show, and lets go 30 seconds
//!   after clearing it, so switching tabs doesn't reconnect every time.
//! - Discord not running: tries again after 1 second, doubling up to 30,
//!   and right away whenever the Activity changes. Nothing to show, no tries.
//! - Discord quitting or restarting ends the connection; the current
//!   Activity is shown again once Discord is back.
//! - Discord accepts 5 activity updates per 20 seconds. Faster changes are
//!   coalesced: only the latest is sent once the window allows. (Rapid
//!   changes within one Activity rarely get that far: `coalesce` holds them
//!   back for every platform first.)
//! - Discord binds a connection to one Application, so an Activity with its
//!   own `discordClientId` reconnects as that Application.

mod activity;
pub mod ipc;

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::adapters::{AdapterState, AdapterStatus, Platform, PlatformAdapter, Reporter};
use crate::app::presence::{Activity, display_text};
use crate::platform::discord::{Endpoints, Link};

use activity::{DiscordActivity, to_discord_activity};
use ipc::{Incoming, OP_CLOSE, OP_FRAME, OP_HANDSHAKE, OP_PING, OP_PONG};

/// Parousia's own Discord Application, for Activities without their own.
/// Public, like every Discord client id; `discordClientId` in config.json
/// replaces it.
pub const PAROUSIA_CLIENT_ID: &str = "1553980756731363428";

const MAX_ERROR_CHARS: usize = 120;
const MAX_NAME_CHARS: usize = 64;

#[derive(Debug, Clone, Copy)]
struct Timing {
    retry_first: Duration,
    retry_max: Duration,
    linger: Duration,
    handshake: Duration,
    window: Duration,
    per_window: usize,
}

const TIMING: Timing = Timing {
    retry_first: Duration::from_secs(1),
    retry_max: Duration::from_secs(30),
    linger: Duration::from_secs(30),
    handshake: Duration::from_secs(5),
    window: Duration::from_secs(20),
    per_window: 5,
};

enum Event {
    Show(Option<Box<Activity>>),
    Incoming { conn: u64, incoming: Incoming },
}

/// What the worker hasn't looked at yet. Only the latest Activity matters,
/// so a new one replaces any still waiting; Discord's frames queue in order.
/// (A mutex and a condvar: std's mpsc compiles in three kinds of channel.)
#[derive(Default)]
struct Inbox {
    pending: Mutex<Pending>,
    ready: Condvar,
}

#[derive(Default)]
struct Pending {
    show: Option<Option<Box<Activity>>>,
    incoming: VecDeque<(u64, Incoming)>,
    /// Whether a worker thread is running (or starting).
    running: bool,
    /// Numbers connections across workers, so a closed connection's late
    /// frames can't be mistaken for a newer one's.
    next_conn: u64,
}

impl Inbox {
    /// Whether the worker should end: nothing left to look at. Checked and
    /// marked under the same lock `show` takes, so an Activity arriving now
    /// either keeps this worker going or starts the next one.
    fn finish(&self) -> bool {
        let mut pending = lock(&self.pending);
        pending.running = pending.show.is_some() || !pending.incoming.is_empty();
        !pending.running
    }

    fn deliver(&self, conn: u64, incoming: Incoming) {
        lock(&self.pending).incoming.push_back((conn, incoming));
        self.ready.notify_one();
    }

    /// The next event, waiting for one until `deadline` (or for good).
    fn next(&self, deadline: Option<Instant>) -> Option<Event> {
        let mut pending = lock(&self.pending);
        loop {
            if let Some((conn, incoming)) = pending.incoming.pop_front() {
                return Some(Event::Incoming { conn, incoming });
            }
            if let Some(activity) = pending.show.take() {
                return Some(Event::Show(activity));
            }
            pending = match deadline {
                None => self
                    .ready
                    .wait(pending)
                    .unwrap_or_else(PoisonError::into_inner),
                Some(at) => {
                    let left = at
                        .checked_duration_since(Instant::now())
                        .filter(|left| !left.is_zero())?;
                    self.ready
                        .wait_timeout(pending, left)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0
                }
            };
        }
    }
}

/// What the adapter and each worker it starts share.
struct Shared {
    inbox: Inbox,
    endpoints: Endpoints,
    default_client_id: String,
    timing: Timing,
    status: Mutex<AdapterStatus>,
    report: Reporter,
}

pub struct DiscordAdapter {
    shared: Arc<Shared>,
}

impl DiscordAdapter {
    /// Starts no thread until there's something to show.
    pub fn new(default_client_id: String, report: Reporter) -> Self {
        Self::with(Endpoints::discover(), default_client_id, TIMING, report)
    }

    fn with(
        endpoints: Endpoints,
        default_client_id: String,
        timing: Timing,
        report: Reporter,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                inbox: Inbox::default(),
                endpoints,
                default_client_id,
                timing,
                status: Mutex::new(AdapterStatus {
                    platform: Platform::Discord,
                    state: AdapterState::Idle,
                    activity: None,
                    error: None,
                }),
                report,
            }),
        }
    }
}

impl PlatformAdapter for DiscordAdapter {
    fn platform(&self) -> Platform {
        Platform::Discord
    }

    fn show(&self, activity: Option<Activity>) {
        let inbox = &self.shared.inbox;
        let mut pending = lock(&inbox.pending);
        // With no worker, Discord shows nothing of Parousia's: nothing to clear.
        if !pending.running && activity.is_none() {
            return;
        }
        pending.show = Some(activity.map(Box::new));
        if pending.running {
            drop(pending);
            inbox.ready.notify_one();
            return;
        }
        pending.running = true;
        drop(pending);
        let shared = Arc::clone(&self.shared);
        let started = thread::Builder::new()
            .name("discord".into())
            .spawn(move || Worker::new(shared).run());
        if started.is_err() {
            // The next Activity tries again.
            lock(&inbox.pending).running = false;
        }
    }

    fn status(&self) -> AdapterStatus {
        lock(&self.shared.status).clone()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// An Activity as Discord will show it, and as which Application.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    client_id: String,
    activity: DiscordActivity,
    name: String,
}

struct Conn {
    id: u64,
    client_id: String,
    link: Link,
    ready: bool,
    deadline: Instant,
}

struct Worker {
    shared: Arc<Shared>,
    timing: Timing,
    /// What the Hub wants shown.
    desired: Option<Target>,
    /// What this connection has shown (`None` once cleared).
    shown: Option<Target>,
    conn: Option<Conn>,
    nonce: u64,
    /// When recent activity updates were sent, for Discord's rate limit.
    sent: VecDeque<Instant>,
    retry_at: Option<Instant>,
    backoff: Duration,
    linger_until: Option<Instant>,
}

#[derive(Serialize)]
struct Handshake<'a> {
    v: u8,
    client_id: &'a str,
}

/// Without an `activity`, clears what this connection showed.
#[derive(Serialize)]
struct SetActivity<'a> {
    cmd: &'static str,
    args: SetActivityArgs<'a>,
    nonce: String,
}

#[derive(Serialize)]
struct SetActivityArgs<'a> {
    pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    activity: Option<&'a DiscordActivity>,
}

fn encode(message: &impl Serialize) -> Vec<u8> {
    serde_json::to_vec(message).expect("Discord messages always serialize")
}

/// The parts of Discord's replies that matter here.
#[derive(Deserialize)]
struct Reply {
    cmd: Option<String>,
    evt: Option<String>,
    data: Option<ReplyData>,
}

#[derive(Deserialize)]
struct ReplyData {
    code: Option<i64>,
    message: Option<String>,
}

impl Worker {
    fn new(shared: Arc<Shared>) -> Self {
        let timing = shared.timing;
        Self {
            shared,
            timing,
            desired: None,
            shown: None,
            conn: None,
            nonce: 0,
            sent: VecDeque::new(),
            retry_at: None,
            backoff: timing.retry_first,
            linger_until: None,
        }
    }

    /// Until there's nothing to show and no connection. Discord's rate
    /// window is shorter than the linger, so nothing worth keeping ends
    /// with the thread.
    fn run(mut self) {
        loop {
            let wake = self.step(Instant::now());
            let idle = wake.is_none() && self.conn.is_none() && self.desired.is_none();
            if idle && self.shared.inbox.finish() {
                return;
            }
            if let Some(event) = self.shared.inbox.next(wake) {
                self.handle(event, Instant::now());
            }
        }
    }

    fn handle(&mut self, event: Event, now: Instant) {
        match event {
            Event::Show(activity) => {
                // Fields in this order: the client id moves out of the Activity last.
                let desired = activity.map(|activity| Target {
                    activity: to_discord_activity(&activity),
                    name: display_text(&activity.name, MAX_NAME_CHARS),
                    client_id: activity
                        .discord_client_id
                        .unwrap_or_else(|| self.shared.default_client_id.clone()),
                });
                if desired != self.desired && desired.is_some() && self.conn.is_none() {
                    // Something new to show: worth trying Discord again now.
                    self.retry_at = None;
                    self.backoff = self.timing.retry_first;
                }
                self.desired = desired;
            }
            Event::Incoming { conn, incoming } => {
                if self.conn.as_ref().is_some_and(|c| c.id == conn) {
                    self.incoming(incoming, now);
                }
            }
        }
    }

    fn incoming(&mut self, incoming: Incoming, now: Instant) {
        match incoming {
            Incoming::Closed => {
                self.drop_conn();
                if self.desired.is_some() {
                    self.retry_later(now, AdapterState::NotRunning, None);
                } else {
                    self.set_status(AdapterState::Idle, None);
                }
            }
            Incoming::Frame(OP_PING, body) => {
                if let Some(conn) = &mut self.conn {
                    let _ = conn.link.send(OP_PONG, &body);
                }
            }
            Incoming::Frame(OP_CLOSE, body) => {
                let reason = serde_json::from_slice::<ReplyData>(&body)
                    .ok()
                    .and_then(|data| data.message)
                    .unwrap_or_else(|| "closed the connection".into());
                self.drop_conn();
                self.retry_later(now, AdapterState::Refused, Some(reason));
            }
            Incoming::Frame(OP_FRAME, body) => {
                let Ok(reply) = serde_json::from_slice::<Reply>(&body) else {
                    return;
                };
                match (reply.cmd.as_deref(), reply.evt.as_deref()) {
                    (_, Some("READY")) => {
                        if let Some(conn) = &mut self.conn {
                            conn.ready = true;
                        }
                        self.backoff = self.timing.retry_first;
                        self.set_status(AdapterState::Connected, None);
                    }
                    (Some("SET_ACTIVITY"), Some("ERROR")) => {
                        // Not retried: the same Activity would be refused again.
                        let error = reply.data.map_or_else(
                            || "refused the activity".into(),
                            |data| match (data.code, data.message) {
                                (_, Some(message)) => message,
                                (Some(code), None) => format!("error {code}"),
                                (None, None) => "refused the activity".into(),
                            },
                        );
                        self.set_status(AdapterState::Refused, Some(error));
                    }
                    _ => {}
                }
            }
            Incoming::Frame(..) => {}
        }
    }

    /// Moves toward showing what's wanted; returns when to look again.
    fn step(&mut self, now: Instant) -> Option<Instant> {
        if self
            .conn
            .as_ref()
            .is_some_and(|conn| !conn.ready && now >= conn.deadline)
        {
            self.drop_conn();
            self.retry_later(
                now,
                AdapterState::NotRunning,
                Some("Discord didn't answer".into()),
            );
        }
        // Read in place: the worker wakes for every frame and deadline, and
        // only a send needs its own copy of what's wanted.
        let Some(want) = &self.desired else {
            return self.wind_down(now);
        };
        if self
            .conn
            .as_ref()
            .is_some_and(|conn| conn.client_id != want.client_id)
        {
            self.drop_conn();
        }
        self.linger_until = None;
        let Some(conn) = &self.conn else {
            if let Some(at) = self.retry_at.filter(|&at| now < at) {
                return Some(at);
            }
            self.connect(now);
            return self.conn.as_ref().map(|c| c.deadline).or(self.retry_at);
        };
        if !conn.ready {
            return Some(conn.deadline);
        }
        if self.shown == self.desired {
            return None;
        }
        if let Some(at) = self.rate_limited_until(now) {
            return Some(at);
        }
        self.set_activity(now, self.desired.clone());
        None
    }

    /// Nothing to show: clear what was shown, then let go after the linger.
    fn wind_down(&mut self, now: Instant) -> Option<Instant> {
        self.retry_at = None;
        self.backoff = self.timing.retry_first;
        let Some(conn) = &self.conn else {
            self.set_status(AdapterState::Idle, None);
            return None;
        };
        if conn.ready && self.shown.is_some() {
            if let Some(at) = self.rate_limited_until(now) {
                return Some(at);
            }
            self.set_activity(now, None);
            self.linger_until = Some(now + self.timing.linger);
        }
        match self.linger_until {
            Some(at) if now < at && self.conn.is_some() => Some(at),
            _ => {
                self.drop_conn();
                self.set_status(AdapterState::Idle, None);
                None
            }
        }
    }

    /// Connects as the Application of what's wanted.
    fn connect(&mut self, now: Instant) {
        let Some(client_id) = self.desired.as_ref().map(|want| want.client_id.clone()) else {
            return;
        };
        let id = {
            let mut pending = lock(&self.shared.inbox.pending);
            pending.next_conn += 1;
            pending.next_conn
        };
        let shared = Arc::clone(&self.shared);
        let deliver = Box::new(move |incoming| shared.inbox.deliver(id, incoming));
        let hello = encode(&Handshake {
            v: 1,
            client_id: &client_id,
        });
        let opened = crate::platform::discord::open(&self.shared.endpoints, deliver)
            .and_then(|mut link| link.send(OP_HANDSHAKE, &hello).map(|()| link));
        match opened {
            Ok(link) => {
                self.set_status(AdapterState::Connecting, None);
                self.conn = Some(Conn {
                    id,
                    client_id,
                    link,
                    ready: false,
                    deadline: now + self.timing.handshake,
                });
            }
            Err(_) => self.retry_later(now, AdapterState::NotRunning, None),
        }
    }

    fn set_activity(&mut self, now: Instant, target: Option<Target>) {
        let Some(conn) = &mut self.conn else {
            return;
        };
        self.nonce += 1;
        let command = encode(&SetActivity {
            cmd: "SET_ACTIVITY",
            args: SetActivityArgs {
                pid: std::process::id(),
                activity: target.as_ref().map(|target| &target.activity),
            },
            nonce: self.nonce.to_string(),
        });
        if conn.link.send(OP_FRAME, &command).is_err() {
            self.drop_conn();
            self.retry_later(now, AdapterState::NotRunning, None);
            return;
        }
        self.sent.push_back(now);
        match &target {
            Some(target) => self.set_showing(Some(target.name.clone())),
            None => self.set_showing(None),
        }
        self.shown = target;
    }

    fn rate_limited_until(&mut self, now: Instant) -> Option<Instant> {
        while self
            .sent
            .front()
            .is_some_and(|&at| at + self.timing.window <= now)
        {
            self.sent.pop_front();
        }
        (self.sent.len() >= self.timing.per_window)
            .then(|| self.sent.front().map(|&at| at + self.timing.window))
            .flatten()
    }

    fn drop_conn(&mut self) {
        self.conn = None;
        self.shown = None;
        self.linger_until = None;
    }

    fn retry_later(&mut self, now: Instant, state: AdapterState, error: Option<String>) {
        self.retry_at = Some(now + self.backoff);
        self.backoff = (self.backoff * 2).min(self.timing.retry_max);
        self.set_status(state, error);
    }

    fn set_showing(&mut self, activity: Option<String>) {
        let state = if activity.is_some() {
            AdapterState::Showing
        } else {
            AdapterState::Connected
        };
        self.update_status(state, activity, None);
    }

    fn set_status(&mut self, state: AdapterState, error: Option<String>) {
        self.update_status(state, None, error);
    }

    /// Tells the Hub only about actual changes, so retrying while Discord
    /// is closed doesn't fill the event log.
    fn update_status(
        &mut self,
        state: AdapterState,
        activity: Option<String>,
        error: Option<String>,
    ) {
        let error = error.map(|e| display_text(&e, MAX_ERROR_CHARS));
        let text = {
            let mut status = lock(&self.shared.status);
            if status.state == state && status.activity == activity && status.error == error {
                return;
            }
            status.state = state;
            status.activity = activity;
            status.error = error;
            status.describe()
        };
        (self.shared.report)(text);
    }
}

#[cfg(test)]
mod tests;
