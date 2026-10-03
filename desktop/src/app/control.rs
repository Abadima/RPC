//! Managing a running Desktop without a tray: status, settings, and which
//! extension origins are allowed. The CLI sends these over the control
//! socket (`platform/unix/control.rs`) or named pipe (`platform/windows/control.rs`),
//! which only this user can reach; the
//! console and the tray call `handle` in-process. Allowing an origin is only
//! possible from here, never from a browser.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

use crate::app::hub::{Hub, Setting, Status};
use crate::link::session::MAX_MESSAGE_SIZE;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "control", rename_all = "kebab-case", try_from = "RequestWire")]
pub enum ControlRequest {
    Status,
    Set {
        setting: Setting,
        value: bool,
    },
    Allow {
        origin: String,
    },
    Disallow {
        origin: String,
    },
    /// Point the user at the running Desktop (a notification, where there's
    /// a desktop session). Sent when Desktop is launched a second time.
    Show,
    /// Debug logging for this run only (see `Hub::set_debug`).
    Debug {
        on: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "kebab-case", try_from = "ResponseWire")]
pub enum ControlResponse {
    Status { status: Box<Status> },
    Error { message: String },
}

// Both are read as every field either has, then sorted by the tag: serde's
// own tagged enums first copy the message into a tree of values to find the
// tag, which doubles the code for everything inside (a whole `Status`).

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RequestKind {
    Status,
    Set,
    Allow,
    Disallow,
    Show,
    Debug,
}

#[derive(Deserialize)]
struct RequestWire {
    control: RequestKind,
    setting: Option<Setting>,
    value: Option<bool>,
    origin: Option<String>,
    on: Option<bool>,
}

impl TryFrom<RequestWire> for ControlRequest {
    type Error = &'static str;

    fn try_from(wire: RequestWire) -> Result<Self, Self::Error> {
        let missing = "a field this request needs is missing";
        Ok(match wire.control {
            RequestKind::Status => Self::Status,
            RequestKind::Show => Self::Show,
            RequestKind::Set => Self::Set {
                setting: wire.setting.ok_or(missing)?,
                value: wire.value.ok_or(missing)?,
            },
            RequestKind::Allow => Self::Allow {
                origin: wire.origin.ok_or(missing)?,
            },
            RequestKind::Disallow => Self::Disallow {
                origin: wire.origin.ok_or(missing)?,
            },
            RequestKind::Debug => Self::Debug {
                on: wire.on.ok_or(missing)?,
            },
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ResponseKind {
    Status,
    Error,
}

#[derive(Deserialize)]
struct ResponseWire {
    result: ResponseKind,
    status: Option<Box<Status>>,
    message: Option<String>,
}

impl TryFrom<ResponseWire> for ControlResponse {
    type Error = &'static str;

    fn try_from(wire: ResponseWire) -> Result<Self, &'static str> {
        let missing = "a field this response needs is missing";
        Ok(match wire.result {
            ResponseKind::Status => Self::Status {
                status: wire.status.ok_or(missing)?,
            },
            ResponseKind::Error => Self::Error {
                message: wire.message.ok_or(missing)?,
            },
        })
    }
}

// The control channel's framing, the same over a Unix socket and a named pipe.
// Every frame is a 4-byte little-endian length and that many bytes of JSON.

/// `Ok(None)` on a clean end of stream between frames.
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<String>> {
    let mut len = [0u8; 4];
    match reader.read_exact(&mut len) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err),
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_MESSAGE_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    String::from_utf8(body)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame is not UTF-8"))
}

pub fn write_frame(writer: &mut impl Write, text: &str) -> io::Result<()> {
    if text.len() > MAX_MESSAGE_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let len = u32::try_from(text.len()).expect("bounded by MAX_MESSAGE_SIZE");
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(text.as_bytes())?;
    writer.flush()
}

pub fn handle(request: ControlRequest, hub: &Hub) -> ControlResponse {
    let result = match request {
        ControlRequest::Status => Ok(()),
        ControlRequest::Set { setting, value } => hub.set(setting, value),
        ControlRequest::Allow { origin } => hub.allow(&origin),
        ControlRequest::Disallow { origin } => hub.disallow(&origin),
        ControlRequest::Show => {
            hub.request_show();
            Ok(())
        }
        ControlRequest::Debug { on } => {
            hub.set_debug(on);
            Ok(())
        }
    };
    match result {
        Ok(()) => ControlResponse::Status {
            status: Box::new(hub.status()),
        },
        Err(message) => ControlResponse::Error { message },
    }
}

pub fn ago(secs: u64) -> String {
    match secs {
        0..60 => "just now".to_string(),
        60..3600 => format!("{} min ago", secs / 60),
        3600..86_400 => format!("{} h ago", secs / 3600),
        _ => format!("{} days ago", secs / 86_400),
    }
}

pub fn web_socket_line(status: &Status) -> String {
    if status.transport.same_user_check {
        format!(
            "listening on {} (other OS users refused)",
            status.transport.address
        )
    } else {
        format!("listening on {}", status.transport.address)
    }
}

pub fn describe(response: &ControlResponse) -> String {
    let status = match response {
        ControlResponse::Error { message } => return format!("Error: {message}"),
        ControlResponse::Status { status } => status,
    };
    let mut lines = vec![
        format!("Parousia Desktop {}", status.version),
        format!("WebSocket: {}", web_socket_line(status)),
        format!(
            "Userscripts: {}",
            if status.settings.allow_userscripts {
                "allowed (any web page can connect)"
            } else {
                "not allowed"
            }
        ),
        format!(
            "Debug logging: {}",
            if status.debug {
                "on for this run"
            } else {
                "off"
            }
        ),
    ];
    lines.extend(status.platforms.iter().map(|platform| platform.describe()));
    if status.settings.allowed_origins.is_empty() {
        lines.push("Allowed extensions: built-in store listings only".to_string());
    } else {
        lines.push("Allowed extensions:".to_string());
        lines.extend(
            status
                .settings
                .allowed_origins
                .iter()
                .map(|o| format!("  {o}")),
        );
    }
    if status.clients.is_empty() {
        lines.push("No browsers connected.".to_string());
    } else {
        lines.push(format!("Connected ({}):", status.clients.len()));
        for client in &status.clients {
            let sharing = client
                .activity
                .as_ref()
                .map_or(String::new(), |a| format!(", sharing {a}"));
            lines.push(format!(
                "  {} ({}), since {}{sharing}",
                client.name,
                client.identity,
                ago(client.connected_secs)
            ));
        }
    }
    if !status.refused.is_empty() {
        lines.push(
            "Refused extensions (allow one with `Parousia-Desktop allow <origin>`):".to_string(),
        );
        for refused in &status.refused {
            lines.push(format!(
                "  {} ({} time{}, last {})",
                refused.origin,
                refused.count,
                if refused.count == 1 { "" } else { "s" },
                ago(refused.secs_ago)
            ));
        }
    }
    if !status.events.is_empty() {
        lines.push("Recent events:".to_string());
        for event in status.events.iter().take(10) {
            lines.push(format!("  {:>11}  {}", ago(event.secs_ago), event.text));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{AdapterState, AdapterStatus, Platform};
    use crate::app::hub::tests::{CHROMIUM, OTHER, test_hub};

    #[test]
    fn requests_change_settings_and_the_allowlist() {
        let hub = test_hub();
        let ControlResponse::Status { status } = handle(
            ControlRequest::Set {
                setting: Setting::AllowUserscripts,
                value: true,
            },
            &hub,
        ) else {
            panic!("expected status");
        };
        assert!(status.settings.allow_userscripts);

        hub.ws_gate(OTHER, true);
        let response = handle(
            ControlRequest::Allow {
                origin: OTHER.to_string(),
            },
            &hub,
        );
        assert!(
            matches!(response, ControlResponse::Status { status } if status.settings.allowed_origins.contains(&OTHER.to_string()))
        );
        assert!(matches!(
            handle(
                ControlRequest::Allow {
                    origin: "https://example.com".into()
                },
                &hub
            ),
            ControlResponse::Error { .. }
        ));
    }

    #[test]
    fn frames_round_trip_and_oversized_ones_are_refused() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, r#"{"a":1}"#).unwrap();
        assert_eq!(&buffer[..4], &7u32.to_le_bytes());
        assert_eq!(
            read_frame(&mut buffer.as_slice()).unwrap().as_deref(),
            Some(r#"{"a":1}"#)
        );
        assert_eq!(read_frame(&mut [].as_slice()).unwrap(), None);

        let mut huge = ((MAX_MESSAGE_SIZE + 1) as u32).to_le_bytes().to_vec();
        huge.extend(std::iter::repeat_n(b'x', 8));
        assert_eq!(
            read_frame(&mut huge.as_slice()).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(write_frame(&mut Vec::new(), &"x".repeat(MAX_MESSAGE_SIZE + 1)).is_err());
    }

    #[test]
    fn every_request_and_response_reads_back_as_written() {
        let hub = test_hub();
        for request in [
            ControlRequest::Status,
            ControlRequest::Show,
            ControlRequest::Set {
                setting: Setting::AllowUserscripts,
                value: true,
            },
            ControlRequest::Allow {
                origin: OTHER.into(),
            },
            ControlRequest::Disallow {
                origin: OTHER.into(),
            },
            ControlRequest::Debug { on: true },
        ] {
            let json = serde_json::to_string(&request).unwrap();
            assert_eq!(
                serde_json::from_str::<ControlRequest>(&json).unwrap(),
                request
            );
        }
        for response in [
            handle(ControlRequest::Status, &hub),
            ControlResponse::Error {
                message: "no".into(),
            },
        ] {
            let json = serde_json::to_string(&response).unwrap();
            assert_eq!(
                serde_json::from_str::<ControlResponse>(&json).unwrap(),
                response
            );
        }
        for bad in [
            r#"{"control":"set","setting":"allowUserscripts"}"#,
            r#"{"control":"allow"}"#,
            r#"{"control":"debug","on":"yes"}"#,
            r#"{"control":"format-disk"}"#,
            r#"{"origin":"x"}"#,
        ] {
            assert!(
                serde_json::from_str::<ControlRequest>(bad).is_err(),
                "{bad}"
            );
        }
        assert!(serde_json::from_str::<ControlResponse>(r#"{"result":"status"}"#).is_err());
    }

    #[test]
    fn requests_have_a_stable_wire_shape() {
        assert_eq!(
            serde_json::to_string(&ControlRequest::Set {
                setting: Setting::AllowUserscripts,
                value: false
            })
            .unwrap(),
            r#"{"control":"set","setting":"allowUserscripts","value":false}"#
        );
        assert_eq!(
            serde_json::from_str::<ControlRequest>(r#"{"control":"allow","origin":"x"}"#).unwrap(),
            ControlRequest::Allow { origin: "x".into() }
        );
    }

    /// A page can pick an Activity's name; in a terminal, an escape sequence
    /// in it would be a command (a window title, the clipboard).
    #[test]
    fn status_in_a_terminal_carries_no_escape_sequences() {
        use crate::app::presence::{Activity, Presence};
        use crate::link::identity::{ClientKind, Peer};

        let hub = test_hub();
        hub.set_debug(true);
        let peer = Peer {
            kind: ClientKind::ChromiumExtension,
            identity: CHROMIUM.into(),
            same_user: true,
        };
        let id = hub.connect(peer, "Chromium\u{1b}[2J", Box::new(|| {}));
        let activity = Activity {
            name: "Video\u{1b}]52;c;cGF5bG9hZA==\u{7}\u{9b}2J".into(),
            ..crate::app::hub::tests::example_activity("page\u{1b}[31m")
        };
        hub.update_presence(
            id,
            Presence {
                activity: Some(activity),
                updated_at: 1,
            },
            crate::adapters::Platforms::ALL,
        );
        let text = describe(&handle(ControlRequest::Status, &hub));
        assert!(text.contains("sharing Video]52;c;cGF5bG9hZA==2J"), "{text}");
        assert!(
            !text.chars().any(|c| c.is_control() && c != '\n'),
            "{text:?}"
        );
    }

    #[test]
    fn describe_covers_transport_clients_refusals_and_events() {
        let hub = test_hub();
        hub.ws_gate(OTHER, true);
        let mut status = hub.status();
        status.platforms.push(AdapterStatus {
            platform: Platform::Discord,
            state: AdapterState::Showing,
            activity: Some("Jena Hub".into()),
            error: None,
        });
        assert!(
            describe(&ControlResponse::Status {
                status: Box::new(status)
            })
            .contains("\nDiscord: showing Jena Hub\n")
        );
        let text = describe(&handle(ControlRequest::Status, &hub));
        assert!(text.contains("WebSocket: listening on 127.0.0.1:57179"));
        assert!(text.contains("Userscripts: not allowed"));
        assert!(text.contains(CHROMIUM));
        assert!(text.contains(&format!("  {OTHER} (1 time, last just now)")));
        assert!(text.contains("No browsers connected."));
    }
}
