//! The adapter against a fake Discord: a Unix socket speaking Discord's
//! framing, recording what it's sent and answering like the real app.

use std::io::Write;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};

use super::*;
use crate::config::tests::temp_dir;
use crate::presence::ActivityButton;

const FAST: Timing = Timing {
    retry_first: Duration::from_millis(20),
    retry_max: Duration::from_millis(80),
    linger: Duration::from_millis(150),
    handshake: Duration::from_millis(500),
    window: Duration::from_millis(400),
    per_window: 3,
};

#[derive(Debug, Clone)]
struct Received {
    conn: usize,
    op: u32,
    body: Value,
}

#[derive(Default)]
struct Behavior {
    /// Client ids whose handshake is refused, like Discord's "Invalid Client ID".
    refuse: Vec<String>,
    fail_activities: bool,
}

struct FakeDiscord {
    path: PathBuf,
    received: Arc<Mutex<Vec<Received>>>,
    streams: Arc<Mutex<Vec<UnixStream>>>,
    behavior: Arc<Mutex<Behavior>>,
    running: Arc<AtomicBool>,
}

impl FakeDiscord {
    fn new() -> Self {
        let dir = temp_dir("discord");
        Self {
            path: dir.join("discord-ipc-0"),
            received: Arc::default(),
            streams: Arc::default(),
            behavior: Arc::default(),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    fn endpoints(&self) -> Endpoints {
        Endpoints::at(self.path.parent().unwrap().to_path_buf())
    }

    fn start(&self) {
        let _ = std::fs::remove_file(&self.path);
        let listener = UnixListener::bind(&self.path).unwrap();
        self.running.store(true, Ordering::SeqCst);
        let (received, streams, behavior, running) = (
            Arc::clone(&self.received),
            Arc::clone(&self.streams),
            Arc::clone(&self.behavior),
            Arc::clone(&self.running),
        );
        thread::spawn(move || {
            for stream in listener.incoming() {
                if !running.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(stream) = stream else { return };
                let conn = {
                    let mut streams = lock(&streams);
                    streams.push(stream.try_clone().unwrap());
                    streams.len()
                };
                let (received, behavior) = (Arc::clone(&received), Arc::clone(&behavior));
                thread::spawn(move || serve(stream, conn, &received, &behavior));
            }
        });
    }

    /// Discord quitting: every connection ends and the socket goes away.
    fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        for stream in lock(&self.streams).drain(..) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        // Wakes the accept loop so it sees `running` is off.
        let _ = UnixStream::connect(&self.path);
        let _ = std::fs::remove_file(&self.path);
    }

    fn received(&self) -> Vec<Received> {
        lock(&self.received).clone()
    }

    fn activities(&self) -> Vec<Value> {
        self.received()
            .into_iter()
            .filter(|r| r.op == ipc::OP_FRAME && r.body["cmd"] == "SET_ACTIVITY")
            .map(|r| r.body["args"]["activity"].clone())
            .collect()
    }

    fn handshakes(&self) -> Vec<String> {
        self.received()
            .into_iter()
            .filter(|r| r.op == ipc::OP_HANDSHAKE)
            .map(|r| r.body["client_id"].as_str().unwrap().to_string())
            .collect()
    }

    fn ping(&self, conn: usize) {
        let mut stream = lock(&self.streams)[conn - 1].try_clone().unwrap();
        stream
            .write_all(&ipc::encode(ipc::OP_PING, br#"{"nonce":"p"}"#).unwrap())
            .unwrap();
    }
}

fn serve(
    mut stream: UnixStream,
    conn: usize,
    received: &Mutex<Vec<Received>>,
    behavior: &Mutex<Behavior>,
) {
    while let Ok((op, body)) = ipc::read_frame(&mut stream) {
        let body: Value = serde_json::from_slice(&body).unwrap();
        lock(received).push(Received {
            conn,
            op,
            body: body.clone(),
        });
        let reply = match op {
            ipc::OP_HANDSHAKE => {
                let client_id = body["client_id"].as_str().unwrap_or_default();
                if lock(behavior).refuse.iter().any(|id| id == client_id) {
                    let close = json!({ "code": 4000, "message": "Invalid Client ID" });
                    let _ = stream.write_all(
                        &ipc::encode(ipc::OP_CLOSE, close.to_string().as_bytes()).unwrap(),
                    );
                    return;
                }
                json!({ "cmd": "DISPATCH", "evt": "READY", "data": { "v": 1, "user": { "id": "1" } } })
            }
            ipc::OP_FRAME if lock(behavior).fail_activities => json!({
                "cmd": "SET_ACTIVITY", "evt": "ERROR", "nonce": body["nonce"],
                "data": { "code": 4000, "message": "child \"activity\" fails because [\"details\" length must be at least 2 characters long]" },
            }),
            ipc::OP_FRAME => json!({
                "cmd": "SET_ACTIVITY", "evt": null, "nonce": body["nonce"],
                "data": body["args"]["activity"],
            }),
            _ => continue,
        };
        if stream
            .write_all(&ipc::encode(ipc::OP_FRAME, reply.to_string().as_bytes()).unwrap())
            .is_err()
        {
            return;
        }
    }
}

fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "timed out waiting for {what}"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn adapter(discord: &FakeDiscord) -> (DiscordAdapter, Arc<Mutex<Vec<String>>>) {
    let reports = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&reports);
    let adapter = DiscordAdapter::with(
        discord.endpoints(),
        PAROUSIA_CLIENT_ID.to_string(),
        FAST,
        Box::new(move |text| lock(&log).push(text)),
    );
    (adapter, reports)
}

fn activity(name: &str) -> Activity {
    Activity {
        id: name.to_lowercase(),
        name: name.to_string(),
        details: Some(format!("Playing {name}")),
        state: None,
        assets: None,
        timestamps: None,
        discord_client_id: None,
        details_url: None,
        state_url: None,
        buttons: vec![ActivityButton {
            label: "Open".into(),
            url: "https://jena.systems/".into(),
        }],
    }
}

#[test]
fn shows_an_activity_clears_it_and_lets_go_after_the_linger() {
    let discord = FakeDiscord::new();
    discord.start();
    let (adapter, reports) = adapter(&discord);

    adapter.show(Some(activity("Chess")));
    wait_for("the activity", || discord.activities().len() == 1);
    assert_eq!(discord.handshakes(), [PAROUSIA_CLIENT_ID]);
    let sent = &discord.activities()[0];
    assert_eq!(sent["details"], "Playing Chess");
    assert_eq!(sent["buttons"][0]["label"], "Open");
    let set = discord
        .received()
        .into_iter()
        .find(|r| r.body["cmd"] == "SET_ACTIVITY")
        .unwrap();
    assert_eq!(set.body["args"]["pid"], std::process::id());
    wait_for("showing", || {
        adapter.status().state == AdapterState::Showing
    });
    assert_eq!(adapter.status().activity.as_deref(), Some("Chess"));

    adapter.show(None);
    wait_for("the clear", || discord.activities().len() == 2);
    assert_eq!(
        discord.activities()[1],
        Value::Null,
        "no activity clears it"
    );
    assert_eq!(adapter.status().state, AdapterState::Connected);
    wait_for("letting go", || {
        adapter.status().state == AdapterState::Idle
    });
    assert_eq!(discord.handshakes().len(), 1, "one connection throughout");
    wait_for("the worker to end", || !worker_running(&adapter));

    // The next Activity starts it again.
    adapter.show(Some(activity("Tablut")));
    wait_for("the next activity", || discord.activities().len() == 3);
    assert_eq!(discord.handshakes().len(), 2);
    assert!(
        lock(&reports).contains(&"Discord: showing Chess".to_string()),
        "{:?}",
        lock(&reports)
    );
}

fn worker_running(adapter: &DiscordAdapter) -> bool {
    lock(&adapter.shared.inbox.pending).running
}

#[test]
fn nothing_to_show_means_no_thread_and_no_connection() {
    let discord = FakeDiscord::new();
    discord.start();
    let (adapter, _) = adapter(&discord);
    adapter.show(None);
    assert!(!worker_running(&adapter));
    thread::sleep(Duration::from_millis(100));
    assert!(discord.received().is_empty());
    assert_eq!(adapter.status().state, AdapterState::Idle);
}

#[test]
fn an_activity_with_its_own_application_reconnects_as_it() {
    let discord = FakeDiscord::new();
    discord.start();
    let (adapter, _) = adapter(&discord);

    adapter.show(Some(activity("Chess")));
    wait_for("the first activity", || discord.activities().len() == 1);
    let mut own = activity("YouTube");
    own.discord_client_id = Some("463097721130188830".into());
    adapter.show(Some(own));
    wait_for("the second activity", || discord.activities().len() == 2);
    assert_eq!(
        discord.handshakes(),
        [PAROUSIA_CLIENT_ID, "463097721130188830"]
    );
    let last = discord.received().into_iter().last().unwrap();
    assert_eq!(last.conn, 2, "sent on the new connection");
}

#[test]
fn waits_for_discord_to_start_then_shows_the_activity() {
    let discord = FakeDiscord::new();
    let (adapter, _) = adapter(&discord);
    adapter.show(Some(activity("Chess")));
    wait_for("not running", || {
        adapter.status().state == AdapterState::NotRunning
    });
    thread::sleep(Duration::from_millis(100));
    discord.start();
    wait_for("the activity", || discord.activities().len() == 1);
    assert_eq!(adapter.status().state, AdapterState::Showing);
}

#[test]
fn shows_the_activity_again_after_discord_restarts() {
    let discord = FakeDiscord::new();
    discord.start();
    let (adapter, _) = adapter(&discord);
    adapter.show(Some(activity("Chess")));
    wait_for("the activity", || discord.activities().len() == 1);

    discord.stop();
    wait_for("noticing Discord quit", || {
        adapter.status().state == AdapterState::NotRunning
    });
    discord.start();
    wait_for("the activity again", || discord.activities().len() == 2);
    assert_eq!(discord.activities()[1]["details"], "Playing Chess");
    assert_eq!(discord.handshakes().len(), 2);
}

#[test]
fn fast_changes_are_coalesced_under_discords_rate_limit() {
    let discord = FakeDiscord::new();
    discord.start();
    let (adapter, _) = adapter(&discord);
    let started = Instant::now();
    // The window allows 3 updates; each of these waits for the one before.
    for (i, name) in ["One", "Two", "Three"].into_iter().enumerate() {
        adapter.show(Some(activity(name)));
        wait_for(name, || discord.activities().len() == i + 1);
    }
    // Both of these arrive while the window is full: only the latest goes,
    // once it reopens.
    adapter.show(Some(activity("Four")));
    thread::sleep(FAST.window / 8);
    adapter.show(Some(activity("Five")));
    thread::sleep(FAST.window / 8);
    assert_eq!(discord.activities().len(), 3, "the window is full");
    wait_for("the latest", || discord.activities().len() == 4);
    assert!(started.elapsed() >= FAST.window);
    assert_eq!(discord.activities()[3]["name"], "Five");

    // A burst is coalesced before it even reaches the window.
    for i in 0..50 {
        adapter.show(Some(activity(&format!("Burst {i}"))));
    }
    wait_for("the burst's last", || {
        discord.activities().last().unwrap()["name"] == "Burst 49"
    });
    thread::sleep(FAST.window);
    let names: Vec<Value> = discord.activities()[4..]
        .iter()
        .map(|a| a["name"].clone())
        .collect();
    assert!(names.len() <= FAST.per_window, "{names:?}");
    assert_eq!(names.last().unwrap(), "Burst 49", "{names:?}");
}

#[test]
fn a_refused_application_is_reported_and_tried_again_later() {
    let discord = FakeDiscord::new();
    lock(&discord.behavior).refuse = vec![PAROUSIA_CLIENT_ID.to_string()];
    discord.start();
    let (adapter, _) = adapter(&discord);
    adapter.show(Some(activity("Chess")));
    wait_for("the refusal", || {
        adapter.status().state == AdapterState::Refused
    });
    assert_eq!(adapter.status().error.as_deref(), Some("Invalid Client ID"));
    wait_for("another try", || discord.handshakes().len() >= 2);
    assert!(discord.activities().is_empty());
}

#[test]
fn a_refused_activity_is_reported_and_not_resent() {
    let discord = FakeDiscord::new();
    lock(&discord.behavior).fail_activities = true;
    discord.start();
    let (adapter, _) = adapter(&discord);
    adapter.show(Some(activity("Chess")));
    wait_for("the refusal", || {
        adapter.status().state == AdapterState::Refused
    });
    assert!(
        adapter
            .status()
            .error
            .unwrap()
            .contains("at least 2 characters")
    );
    thread::sleep(FAST.window);
    assert_eq!(discord.activities().len(), 1);
}

#[test]
fn pings_are_answered() {
    let discord = FakeDiscord::new();
    discord.start();
    let (adapter, _) = adapter(&discord);
    adapter.show(Some(activity("Chess")));
    wait_for("the activity", || discord.activities().len() == 1);
    discord.ping(1);
    wait_for("the pong", || {
        discord
            .received()
            .iter()
            .any(|r| r.op == ipc::OP_PONG && r.body["nonce"] == "p")
    });
}

#[test]
fn a_discord_that_never_answers_the_handshake_is_given_up_on() {
    let dir = temp_dir("discord-silent");
    let listener = UnixListener::bind(dir.join("discord-ipc-0")).unwrap();
    let accepted = Arc::new(Mutex::new(Vec::new()));
    let keep = Arc::clone(&accepted);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            lock(&keep).push(stream);
        }
    });
    let adapter = DiscordAdapter::with(
        Endpoints::at(dir),
        PAROUSIA_CLIENT_ID.to_string(),
        Timing {
            handshake: Duration::from_millis(50),
            ..FAST
        },
        Box::new(|_| {}),
    );
    adapter.show(Some(activity("Chess")));
    wait_for("giving up", || {
        adapter.status().error.as_deref() == Some("Discord didn't answer")
    });
    wait_for("another try", || lock(&accepted).len() >= 2);
}
