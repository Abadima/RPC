//! One client connection, independent of framing (`ws.rs` supplies the
//! WebSocket; tests supply a scripted channel).
//!
//! 1. The client sends `hello` (protocol and release versions, display name) within
//!    `HANDSHAKE_TIMEOUT`; Desktop answers `welcome`, or `reject` and closes.
//! 2. `presence`, `ping`, `status`, and `set` until either side closes
//!    (`status` and `set` only from extensions, `set` only from this OS
//!    user). A bad frame gets a non-fatal `reject`; flooding gets
//!    `rate_limited` and a close.

use std::io;
use std::time::{Duration, Instant};

use crate::adapters::Platforms;
use crate::app::hub::{Closer, Hub};
use crate::app::presence::Presence;
use crate::link::identity::{ClientKind, Peer};
use crate::link::protocol::{
    self, ClientMessage, Envelope, PROTOCOL_VERSION, RejectReason, ServerMessage, VERSION,
};
use crate::link::rate::TokenBucket;

pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounds every message in either direction.
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024;
/// Presence changes when a tab or page does, so real clients stay far below
/// this; anything faster is a bug or abuse.
const MESSAGE_BURST: u32 = 20;
const MESSAGES_PER_SECOND: u32 = 5;

/// A message-oriented, bidirectional link to one client.
pub trait Channel {
    /// The next text message; `Ok(None)` once the peer has gone.
    /// `ErrorKind::TimedOut` when a read timeout elapses.
    fn recv(&mut self) -> io::Result<Option<String>>;
    fn send(&mut self, text: &str) -> io::Result<()>;
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()>;
    /// Something another thread can call to end this connection.
    fn closer(&self) -> io::Result<Closer>;
    /// Best-effort orderly close after a fatal `reject`.
    fn close(&mut self);
}

pub fn run(channel: &mut impl Channel, peer: &Peer, hub: &Hub) {
    let Some(name) = handshake(channel) else {
        return;
    };
    let Ok(closer) = channel.closer() else {
        return;
    };
    let id = hub.connect(peer.clone(), &name, closer);
    let welcome = ServerMessage::Welcome {
        protocol_version: PROTOCOL_VERSION,
        version: VERSION,
    };
    if channel.send(&protocol::encode(&welcome)).is_ok() && channel.set_read_timeout(None).is_ok() {
        serve(channel, peer, hub, id);
    }
    hub.disconnect(id);
}

fn handshake(channel: &mut impl Channel) -> Option<String> {
    channel.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).ok()?;
    let text = match channel.recv() {
        Ok(Some(text)) => text,
        Ok(None) => return None,
        Err(err) if err.kind() == io::ErrorKind::TimedOut => {
            return reject(channel, RejectReason::Timeout);
        }
        Err(_) => return None,
    };
    if let Ok(envelope) = serde_json::from_str::<Envelope>(&text)
        && envelope.kind == "hello"
        && !protocol::compatible(envelope.protocol_version, envelope.version.as_deref())
    {
        return reject(channel, RejectReason::UnsupportedVersion);
    }
    match serde_json::from_str::<ClientMessage>(&text) {
        Ok(ClientMessage::Hello {
            name,
            protocol_version,
            version,
        }) if protocol::compatible(Some(protocol_version), Some(&version)) => Some(name),
        _ => reject(channel, RejectReason::Malformed),
    }
}

fn reject<C: Channel>(channel: &mut C, reason: RejectReason) -> Option<String> {
    let _ = channel.send(&protocol::encode(&ServerMessage::Reject { reason }));
    channel.close();
    None
}

fn serve(channel: &mut impl Channel, peer: &Peer, hub: &Hub, id: u64) {
    let mut bucket = TokenBucket::new(MESSAGE_BURST, MESSAGES_PER_SECOND);
    // Status lists every client and the allowlist, and settings are Desktop's
    // own; a userscript is any web page, so it only publishes Presence.
    let trusted = peer.kind != ClientKind::Userscript;
    while let Ok(Some(text)) = channel.recv() {
        if !bucket.take(Instant::now()) {
            if hub.debug() {
                println!(
                    "parousia-desktop: closed {} for sending too fast",
                    peer.identity
                );
            }
            reject(channel, RejectReason::RateLimited);
            return;
        }
        let malformed = ServerMessage::Reject {
            reason: RejectReason::Malformed,
        };
        let reply = match serde_json::from_str::<ClientMessage>(&text) {
            Ok(ClientMessage::Presence {
                presence,
                platforms,
            }) => match Presence::try_from(*presence) {
                Ok(presence) => {
                    hub.update_presence(id, presence, Platforms::from_wire(platforms.as_deref()));
                    None
                }
                Err(_) => Some(malformed),
            },
            Ok(ClientMessage::Ping {}) => Some(ServerMessage::Pong),
            Ok(ClientMessage::Status {}) if trusted => Some(status(hub)),
            Ok(ClientMessage::Set { setting, value }) if trusted && peer.same_user => {
                if let Err(err) = hub.set(setting, value)
                    && hub.debug()
                {
                    eprintln!("parousia-desktop: {err}");
                }
                Some(status(hub))
            }
            Ok(ClientMessage::Status {} | ClientMessage::Set { .. }) => {
                Some(ServerMessage::Reject {
                    reason: RejectReason::NotPermitted,
                })
            }
            // `hello` is only valid once, as the first message.
            Ok(ClientMessage::Hello { .. }) | Err(_) => Some(malformed),
        };
        if let Some(reply) = reply
            && channel.send(&protocol::encode(&reply)).is_err()
        {
            return;
        }
    }
}

fn status(hub: &Hub) -> ServerMessage {
    ServerMessage::Status {
        status: Box::new(hub.status()),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::app::config::Settings;
    use crate::app::hub::tests::{CHROMIUM, noop_closer, test_hub, test_hub_with};
    use std::collections::VecDeque;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// `incoming` is what the client sends, in order; `outgoing` collects
    /// what Desktop sent, as JSON values.
    pub struct ScriptedChannel {
        pub incoming: VecDeque<io::Result<Option<String>>>,
        pub outgoing: Vec<serde_json::Value>,
        pub closed: bool,
        pub shut_down: Arc<AtomicBool>,
    }

    impl ScriptedChannel {
        pub fn new(messages: &[&str]) -> Self {
            Self {
                incoming: messages.iter().map(|m| Ok(Some(m.to_string()))).collect(),
                outgoing: Vec::new(),
                closed: false,
                shut_down: Arc::new(AtomicBool::new(false)),
            }
        }

        fn types(&self) -> Vec<String> {
            self.outgoing
                .iter()
                .map(|m| match m["type"].as_str() {
                    Some("reject") => format!("reject:{}", m["reason"].as_str().unwrap()),
                    Some(other) => other.to_string(),
                    None => "?".into(),
                })
                .collect()
        }
    }

    impl Channel for ScriptedChannel {
        fn recv(&mut self) -> io::Result<Option<String>> {
            self.incoming.pop_front().unwrap_or(Ok(None))
        }

        fn send(&mut self, text: &str) -> io::Result<()> {
            self.outgoing.push(serde_json::from_str(text).unwrap());
            Ok(())
        }

        fn set_read_timeout(&mut self, _timeout: Option<Duration>) -> io::Result<()> {
            Ok(())
        }

        fn closer(&self) -> io::Result<Closer> {
            let flag = Arc::clone(&self.shut_down);
            Ok(Box::new(move || flag.store(true, Ordering::SeqCst)))
        }

        fn close(&mut self) {
            self.closed = true;
        }
    }

    const HELLO: &str =
        r#"{"type":"hello","protocolVersion":1,"version":"1.0.0","name":"Chromium on Linux"}"#;

    fn peer(same_user: bool) -> Peer {
        Peer {
            kind: ClientKind::ChromiumExtension,
            identity: CHROMIUM.to_string(),
            same_user,
        }
    }

    #[test]
    fn a_client_says_hello_then_streams_presence_pings_and_asks_for_status() {
        let hub = test_hub();
        let mut channel = ScriptedChannel::new(&[
            HELLO,
            r#"{"type":"presence","presence":{"activity":null,"updatedAt":1}}"#,
            r#"{"type":"ping"}"#,
            "{not json}",
            r#"{"type":"status"}"#,
        ]);
        run(&mut channel, &peer(true), &hub);

        assert_eq!(
            channel.types(),
            ["welcome", "pong", "reject:malformed", "status"]
        );
        let status = &channel.outgoing[3]["status"];
        assert_eq!(status["clients"][0]["name"], "Chromium on Linux");
        assert!(!channel.closed, "a bad frame isn't fatal");
        assert!(
            hub.status().clients.is_empty(),
            "dropped once the client went away"
        );
    }

    #[test]
    fn a_client_on_another_minor_patch_or_beta_is_welcome() {
        for version in ["1.0.0", "1.9.2", "1.0.0-beta.7"] {
            let hub = test_hub();
            let hello = format!(
                r#"{{"type":"hello","protocolVersion":1,"version":"{version}","name":"Newer"}}"#
            );
            let mut channel = ScriptedChannel::new(&[&hello]);
            run(&mut channel, &peer(true), &hub);
            assert_eq!(channel.outgoing[0]["type"], "welcome", "{version}");
            assert_eq!(channel.outgoing[0]["version"], VERSION);
        }
    }

    #[test]
    fn anything_but_a_compatible_hello_first_is_rejected_and_closed() {
        for (first, reason) in [
            (
                r#"{"type":"presence","presence":{"activity":null,"updatedAt":1}}"#,
                "reject:malformed",
            ),
            (
                r#"{"type":"hello","protocolVersion":2,"version":"1.0.0","name":"Another protocol"}"#,
                "reject:unsupported_version",
            ),
            (
                r#"{"type":"hello","protocolVersion":1,"version":"2.0.0","name":"Another major"}"#,
                "reject:unsupported_version",
            ),
            (
                r#"{"type":"hello","protocolVersion":1,"version":"0.9.0","name":"Another major"}"#,
                "reject:unsupported_version",
            ),
            (
                r#"{"type":"hello","protocolVersion":1,"name":"No version"}"#,
                "reject:unsupported_version",
            ),
            (
                r#"{"type":"hello","protocolVersion":1,"version":"1.0.0"}"#,
                "reject:malformed",
            ),
            ("garbage", "reject:malformed"),
        ] {
            let hub = test_hub();
            let mut channel = ScriptedChannel::new(&[first]);
            run(&mut channel, &peer(true), &hub);
            assert_eq!(channel.types(), [reason], "{first}");
            assert!(channel.closed);
            assert!(hub.status().events.is_empty(), "never counted as connected");
        }
    }

    #[test]
    fn a_silent_client_times_out() {
        let hub = test_hub();
        let mut channel = ScriptedChannel::new(&[]);
        channel
            .incoming
            .push_back(Err(io::Error::from(io::ErrorKind::TimedOut)));
        run(&mut channel, &peer(true), &hub);
        assert_eq!(channel.types(), ["reject:timeout"]);
    }

    #[test]
    fn oversized_presence_fields_are_rejected_without_ending_the_session() {
        let hub = test_hub();
        let long = "x".repeat(600);
        let presence = format!(
            r#"{{"type":"presence","presence":{{"activity":{{"id":"a","name":"{long}"}},"updatedAt":1}}}}"#
        );
        let mut channel = ScriptedChannel::new(&[HELLO, &presence, r#"{"type":"ping"}"#]);
        run(&mut channel, &peer(true), &hub);
        assert_eq!(channel.types(), ["welcome", "reject:malformed", "pong"]);
    }

    #[test]
    fn flooding_closes_the_connection() {
        let hub = test_hub();
        let mut messages = vec![HELLO];
        messages.extend(std::iter::repeat_n(r#"{"type":"ping"}"#, 60));
        let mut channel = ScriptedChannel::new(&messages);
        run(&mut channel, &peer(true), &hub);
        let types = channel.types();
        assert_eq!(
            types.last().map(String::as_str),
            Some("reject:rate_limited")
        );
        assert!(types.len() < 30, "stopped reading soon after the burst");
        assert!(channel.closed);
    }

    #[test]
    fn only_a_same_user_connection_may_change_settings() {
        let set = r#"{"type":"set","setting":"allowUserscripts","value":true}"#;
        let hub = test_hub();
        let mut unverified = ScriptedChannel::new(&[HELLO, set]);
        run(&mut unverified, &peer(false), &hub);
        assert_eq!(unverified.types(), ["welcome", "reject:not_permitted"]);
        assert!(!hub.status().settings.allow_userscripts);

        let mut verified = ScriptedChannel::new(&[HELLO, set]);
        run(&mut verified, &peer(true), &hub);
        assert_eq!(verified.types(), ["welcome", "status"]);
        assert_eq!(
            verified.outgoing[1]["status"]["settings"]["allowUserscripts"],
            true
        );
    }

    #[test]
    fn a_userscript_may_only_publish_presence() {
        let hub = test_hub_with(Settings {
            allow_userscripts: true,
            ..Settings::default()
        });
        let page = Peer {
            kind: ClientKind::Userscript,
            identity: "https://example.com".to_string(),
            same_user: true,
        };
        let mut channel = ScriptedChannel::new(&[
            HELLO,
            r#"{"type":"status"}"#,
            r#"{"type":"set","setting":"allowUserscripts","value":false}"#,
            r#"{"type":"ping"}"#,
        ]);
        run(&mut channel, &page, &hub);
        assert_eq!(
            channel.types(),
            [
                "welcome",
                "reject:not_permitted",
                "reject:not_permitted",
                "pong"
            ]
        );
        assert!(hub.status().settings.allow_userscripts);
    }

    #[test]
    fn a_status_report_fits_in_one_frame_even_when_full() {
        let hub = test_hub();
        for i in 0..64 {
            let peer = peer(true);
            hub.connect(peer, &format!("{i} {}", "n".repeat(80)), noop_closer());
        }
        for i in 0..40 {
            hub.ws_gate(
                &format!(
                    "chrome-extension://{}",
                    format!("{i:a>32}").replace(char::is_numeric, "b")
                ),
                true,
            );
        }
        let text = protocol::encode(&status(&hub));
        assert!(text.len() < MAX_MESSAGE_SIZE, "{} bytes", text.len());
    }
}
