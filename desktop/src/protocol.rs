//! Wire messages for the browser <-> Desktop WebSocket. Schemas are strict:
//! unknown message types, unknown fields, and wrong types are all malformed.
//! `presence.rs` bounds the contents.

use serde::{Deserialize, Serialize};

use crate::hub::{Setting, Status};
use crate::platform::Platform;

/// Must match `browser/src/core/desktop-protocol.ts`.
pub const PROTOCOL_VERSION: u32 = 6;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ClientMessage {
    /// The first message on every connection. `protocolVersion` is checked
    /// through `Envelope` before this is parsed.
    Hello {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        /// Display name, e.g. "Firefox on Linux". Untrusted.
        name: String,
    },
    Presence {
        presence: Box<PresenceWire>,
        /// Where this Presence may be shown; missing means everywhere (the
        /// userscript has no settings to choose from).
        #[serde(default)]
        platforms: Option<Vec<Platform>>,
    },
    /// Answered with `pong`. Empty struct variants, not unit ones: serde only
    /// rejects unknown fields on struct variants.
    Ping {},
    Status {},
    /// Changes a setting. Only honored on a connection the OS confirmed comes
    /// from this user (see `identity::Peer::same_user`).
    Set {
        setting: Setting,
        value: bool,
    },
}

/// Just enough of a first message to answer `unsupported_version` instead of
/// `malformed` when a client from another protocol version connects.
#[derive(Debug, Deserialize)]
pub struct Envelope {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMessage {
    Welcome {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
    Reject {
        reason: RejectReason,
    },
    Pong,
    Status {
        status: Box<Status>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    UnsupportedVersion,
    Malformed,
    Timeout,
    /// An extension origin that isn't an allowed Parousia build.
    OriginNotAllowed,
    /// Too many messages; the connection is closed.
    RateLimited,
    /// A `set` from a connection the OS couldn't confirm is this user's.
    NotPermitted,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PresenceWire {
    pub activity: Option<ActivityWire>,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityWire {
    pub id: String,
    pub name: String,
    pub details: Option<String>,
    pub state: Option<String>,
    pub assets: Option<ActivityAssetsWire>,
    pub timestamps: Option<ActivityTimestampsWire>,
    /// The Discord Application to show this Activity as, instead of
    /// Desktop's own.
    #[serde(rename = "discordClientId")]
    pub discord_client_id: Option<String>,
    #[serde(rename = "detailsUrl")]
    pub details_url: Option<String>,
    #[serde(rename = "stateUrl")]
    pub state_url: Option<String>,
    pub buttons: Option<Vec<ActivityButtonWire>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityButtonWire {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityAssetsWire {
    #[serde(rename = "largeImage")]
    pub large_image: Option<String>,
    #[serde(rename = "largeText")]
    pub large_text: Option<String>,
    #[serde(rename = "smallImage")]
    pub small_image: Option<String>,
    #[serde(rename = "smallText")]
    pub small_text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityTimestampsWire {
    pub start: Option<i64>,
    pub end: Option<i64>,
}

pub fn encode(message: &ServerMessage) -> String {
    serde_json::to_string(message).expect("ServerMessage always serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Result<ClientMessage, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn parses_every_client_message() {
        assert!(matches!(
            parse(r#"{"type":"hello","protocolVersion":6,"name":"Firefox on Linux"}"#).unwrap(),
            ClientMessage::Hello { protocol_version: 6, name } if name == "Firefox on Linux"
        ));
        assert!(matches!(
            parse(r#"{"type":"presence","presence":{"activity":null,"updatedAt":1}}"#).unwrap(),
            ClientMessage::Presence { presence, platforms: None } if presence.activity.is_none()
        ));
        assert!(matches!(
            parse(r#"{"type":"presence","presence":{"activity":null,"updatedAt":1},"platforms":["discord","stoat"]}"#).unwrap(),
            ClientMessage::Presence { platforms: Some(list), .. } if list == [Platform::Discord, Platform::Stoat]
        ));
        assert!(matches!(
            parse(r#"{"type":"ping"}"#).unwrap(),
            ClientMessage::Ping {}
        ));
        assert!(matches!(
            parse(r#"{"type":"status"}"#).unwrap(),
            ClientMessage::Status {}
        ));
        assert!(matches!(
            parse(r#"{"type":"set","setting":"allowUserscripts","value":true}"#).unwrap(),
            ClientMessage::Set {
                setting: Setting::AllowUserscripts,
                value: true
            }
        ));
    }

    #[test]
    fn parses_a_full_activity() {
        let json = r#"{"type":"presence","presence":{"activity":{"id":"example","name":"Example",
            "details":"Details","state":"State",
            "assets":{"largeImage":"l.png","largeText":"L","smallImage":"s.png","smallText":"S"},
            "timestamps":{"start":100,"end":200},"discordClientId":"1553980756731363428",
            "detailsUrl":"https://example.com/d","stateUrl":"https://example.com/s",
            "buttons":[{"label":"Open","url":"https://example.com"}]},"updatedAt":5000}}"#;
        let ClientMessage::Presence { presence, .. } = parse(json).unwrap() else {
            panic!("expected presence");
        };
        let activity = presence.activity.unwrap();
        assert_eq!(
            activity.assets.unwrap().large_image.as_deref(),
            Some("l.png")
        );
        assert_eq!(activity.timestamps.unwrap().start, Some(100));
        assert_eq!(
            activity.discord_client_id.as_deref(),
            Some("1553980756731363428")
        );
        assert_eq!(activity.buttons.unwrap()[0].label, "Open");
    }

    #[test]
    fn schemas_are_strict() {
        for json in [
            r#"{"type":"unknown"}"#,
            r#"{"type":"hello","protocolVersion":6}"#,
            r#"{"type":"hello","protocolVersion":6,"name":"x","extra":"y"}"#,
            r#"{"type":"hello","protocolVersion":"5","name":"x"}"#,
            r#"{"type":"presence"}"#,
            r#"{"type":"presence","presence":{"activity":null,"updatedAt":1,"extra":1}}"#,
            r#"{"type":"presence","presence":{"activity":{"id":"a","name":"A","clientId":"1"},"updatedAt":1}}"#,
            r#"{"type":"presence","presence":{"activity":{"id":"a","name":"A","buttons":[{"label":"x","url":"u","extra":1}]},"updatedAt":1}}"#,
            // The page's address stays in the browser since protocol 6.
            r#"{"type":"presence","presence":{"activity":{"id":"a","name":"A","url":"https://example.com"},"updatedAt":1}}"#,
            r#"{"type":"presence","presence":{"activity":null,"updatedAt":1},"platforms":["myspace"]}"#,
            r#"{"type":"presence","presence":{"activity":null,"updatedAt":1},"platforms":"discord"}"#,
            r#"{"type":"ping","x":1}"#,
            r#"{"type":"status","all":true}"#,
            r#"{"type":"set","setting":"allowedOrigins","value":true}"#,
            r#"{"type":"set","setting":"webSocket","value":false}"#,
            r#"{"type":"set","setting":"allowUserscripts","value":"yes"}"#,
            r#"[]"#,
            r#"null"#,
        ] {
            assert!(parse(json).is_err(), "{json}");
        }
    }

    #[test]
    fn envelope_reads_the_version_of_any_first_message() {
        let old: Envelope =
            serde_json::from_str(r#"{"type":"hello","protocolVersion":2,"clientId":"x"}"#).unwrap();
        assert_eq!(
            (old.kind.as_str(), old.protocol_version),
            ("hello", Some(2))
        );
    }

    #[test]
    fn serializes_server_messages() {
        assert_eq!(
            encode(&ServerMessage::Welcome {
                protocol_version: 6
            }),
            r#"{"type":"welcome","protocolVersion":6}"#
        );
        assert_eq!(
            encode(&ServerMessage::Reject {
                reason: RejectReason::OriginNotAllowed
            }),
            r#"{"type":"reject","reason":"origin_not_allowed"}"#
        );
        assert_eq!(encode(&ServerMessage::Pong), r#"{"type":"pong"}"#);
    }
}
