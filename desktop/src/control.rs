//! Managing a running Desktop without a tray: status, settings, and which
//! extension origins are allowed. The CLI sends these over the IPC socket
//! (`ipc.rs`), which only this user can reach; the console and the tray call
//! `handle` in-process. Allowing an origin is only possible from here, never
//! from a browser.

use serde::{Deserialize, Serialize};

use crate::hub::{Hub, Setting, Status};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "control", rename_all = "kebab-case")]
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
#[serde(tag = "result", rename_all = "kebab-case")]
pub enum ControlResponse {
    Status { status: Box<Status> },
    Error { message: String },
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
    use crate::hub::tests::{CHROMIUM, OTHER, test_hub};

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

    #[test]
    fn describe_covers_transport_clients_refusals_and_events() {
        let hub = test_hub();
        hub.ws_gate(OTHER, true);
        let text = describe(&handle(ControlRequest::Status, &hub));
        assert!(text.contains("WebSocket: listening on 127.0.0.1:57179"));
        assert!(text.contains("Userscripts: not allowed"));
        assert!(text.contains(CHROMIUM));
        assert!(text.contains(&format!("  {OTHER} (1 time, last just now)")));
        assert!(text.contains("No browsers connected."));
    }
}
