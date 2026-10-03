//! Wire messages for the browser <-> Desktop WebSocket. Schemas are strict:
//! unknown message types, unknown fields, and wrong types are all malformed.
//! `presence.rs` bounds the contents.

use serde::{Deserialize, Serialize};

use crate::adapters::Platform;
use crate::app::hub::{Setting, Status};

/// Must match `browser/src/core/desktop-protocol.ts`. Raised only when an
/// older peer can't read the wire any more; additions are optional fields,
/// which peers ignore (see `PresenceWire`), so they never raise it.
pub const PROTOCOL_VERSION: u32 = 1;

/// This build's release version, sent in `welcome`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A release version's major number, or `None` for text that isn't one.
/// Peers on different majors don't connect; everything else does.
pub fn major(version: &str) -> Option<u32> {
    let digits = version.split(['.', '-', '+']).next()?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Whether a client's `hello` is for this Desktop: the same protocol and the
/// same major version. A minor, patch, or beta difference isn't a reason to
/// refuse; the client tells its user to update instead.
pub fn compatible(protocol_version: Option<u32>, version: Option<&str>) -> bool {
    protocol_version == Some(PROTOCOL_VERSION)
        && version
            .and_then(major)
            .is_some_and(|m| Some(m) == major(VERSION))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(try_from = "ClientWire")]
pub enum ClientMessage {
    /// The first message on every connection. `protocolVersion` is checked
    /// through `Envelope` before this is parsed.
    Hello {
        protocol_version: u32,
        /// The client's release version, for the major check. Untrusted.
        version: String,
        /// Display name, e.g. "Firefox on Linux". Untrusted.
        name: String,
    },
    Presence {
        presence: Box<PresenceWire>,
        /// Where this Presence may be shown; missing means everywhere (the
        /// userscript has no settings to choose from).
        platforms: Option<Vec<Platform>>,
    },
    /// Answered with `pong`.
    Ping {},
    Status {},
    /// Changes a setting. Only honored on a connection the OS confirmed comes
    /// from this user (see `identity::Peer::same_user`).
    Set {
        setting: Setting,
        value: bool,
    },
}

/// Every field of every client message, read in one pass; `ClientMessage`
/// then takes the ones its `type` has and refuses any other. (serde's own
/// tagged enums first copy the whole message into a tree of values to find
/// the tag, an allocation per value, and double the code for each type.)
/// A field is either absent or a value of its type: `null` counts as neither,
/// except for `platforms`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientWire {
    #[serde(rename = "type")]
    kind: MessageType,
    #[serde(default, deserialize_with = "present")]
    protocol_version: Option<u32>,
    #[serde(default, deserialize_with = "present")]
    version: Option<String>,
    #[serde(default, deserialize_with = "present")]
    name: Option<String>,
    #[serde(default, deserialize_with = "present")]
    presence: Option<Box<PresenceWire>>,
    #[serde(default)]
    platforms: Option<Vec<Platform>>,
    #[serde(default, deserialize_with = "present")]
    setting: Option<Setting>,
    #[serde(default, deserialize_with = "present")]
    value: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum MessageType {
    Hello,
    Presence,
    Ping,
    Status,
    Set,
}

/// A field that's there: `null` isn't a value of `T`, so it's refused.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

impl TryFrom<ClientWire> for ClientMessage {
    type Error = &'static str;

    fn try_from(wire: ClientWire) -> Result<Self, Self::Error> {
        let ClientWire {
            kind,
            protocol_version,
            version,
            name,
            presence,
            platforms,
            setting,
            value,
        } = wire;
        Ok(
            match (
                kind,
                (protocol_version, version, name),
                (presence, platforms),
                (setting, value),
            ) {
                (
                    MessageType::Hello,
                    (Some(protocol_version), Some(version), Some(name)),
                    (None, None),
                    (None, None),
                ) => Self::Hello {
                    protocol_version,
                    version,
                    name,
                },
                (
                    MessageType::Presence,
                    (None, None, None),
                    (Some(presence), platforms),
                    (None, None),
                ) => Self::Presence {
                    presence,
                    platforms,
                },
                (MessageType::Ping, (None, None, None), (None, None), (None, None)) => {
                    Self::Ping {}
                }
                (MessageType::Status, (None, None, None), (None, None), (None, None)) => {
                    Self::Status {}
                }
                (
                    MessageType::Set,
                    (None, None, None),
                    (None, None),
                    (Some(setting), Some(value)),
                ) => Self::Set { setting, value },
                _ => return Err("missing fields, or fields another message type has"),
            },
        )
    }
}

/// Just enough of a first message to answer `unsupported_version` instead of
/// `malformed` when a client from another protocol or major version connects.
#[derive(Debug, Deserialize)]
pub struct Envelope {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: Option<u32>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMessage {
    Welcome {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        /// Desktop's release version, so the extension can say which side to update.
        version: &'static str,
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

/// A Presence and everything inside it ignores fields it doesn't know, so an
/// extension newer than Desktop can add optional fields without breaking the
/// link. Values it does know are still checked in full (`presence.rs`).
#[derive(Debug, Clone, Deserialize)]
pub struct PresenceWire {
    pub activity: Option<ActivityWire>,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
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
    /// Left out: playing.
    #[serde(rename = "type")]
    pub kind: Option<ActivityType>,
    #[serde(rename = "statusDisplayType")]
    pub status_display_type: Option<StatusDisplayType>,
    pub party: Option<ActivityPartyWire>,
}

/// The verb Discord puts before an activity's name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityType {
    Playing,
    Listening,
    Watching,
    Competing,
}

/// Which line Discord shows in the member list's status text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusDisplayType {
    Name,
    State,
    Details,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct ActivityPartyWire {
    pub size: u32,
    pub max: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActivityButtonWire {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActivityAssetsWire {
    #[serde(rename = "largeImage")]
    pub large_image: Option<String>,
    #[serde(rename = "largeText")]
    pub large_text: Option<String>,
    #[serde(rename = "largeUrl")]
    pub large_url: Option<String>,
    #[serde(rename = "smallImage")]
    pub small_image: Option<String>,
    #[serde(rename = "smallText")]
    pub small_text: Option<String>,
    #[serde(rename = "smallUrl")]
    pub small_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
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
            parse(r#"{"type":"hello","protocolVersion":1,"version":"1.2.3","name":"Firefox on Linux"}"#).unwrap(),
            ClientMessage::Hello { protocol_version: 1, version, name }
                if version == "1.2.3" && name == "Firefox on Linux"
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
            "assets":{"largeImage":"l.png","largeText":"L","largeUrl":"https://example.com/l",
                "smallImage":"s.png","smallText":"S","smallUrl":"https://example.com/s"},
            "timestamps":{"start":100,"end":200},"discordClientId":"1553980756731363428",
            "type":"listening","statusDisplayType":"state","party":{"size":1,"max":4},
            "detailsUrl":"https://example.com/d","stateUrl":"https://example.com/s",
            "buttons":[{"label":"Open","url":"https://example.com"}]},"updatedAt":5000}}"#;
        let ClientMessage::Presence { presence, .. } = parse(json).unwrap() else {
            panic!("expected presence");
        };
        let activity = presence.activity.unwrap();
        let assets = activity.assets.unwrap();
        assert_eq!(assets.large_image.as_deref(), Some("l.png"));
        assert_eq!(assets.small_url.as_deref(), Some("https://example.com/s"));
        assert_eq!(activity.timestamps.unwrap().start, Some(100));
        assert_eq!(
            activity.discord_client_id.as_deref(),
            Some("1553980756731363428")
        );
        assert_eq!(activity.buttons.unwrap()[0].label, "Open");
        assert_eq!(activity.kind, Some(ActivityType::Listening));
        assert_eq!(activity.status_display_type, Some(StatusDisplayType::State));
        assert_eq!(activity.party.unwrap().max, 4);
    }

    #[test]
    fn schemas_are_strict() {
        for json in [
            r#"{"type":"unknown"}"#,
            r#"{"type":"hello","protocolVersion":1,"version":"1.0.0"}"#,
            r#"{"type":"hello","protocolVersion":1,"name":"x"}"#,
            r#"{"type":"hello","protocolVersion":1,"version":"1.0.0","name":"x","extra":"y"}"#,
            r#"{"type":"hello","protocolVersion":"1","version":"1.0.0","name":"x"}"#,
            r#"{"type":"presence"}"#,
            r#"{"type":"presence","presence":{"activity":{"id":"a","name":"A","buttons":[{"label":"x"}]},"updatedAt":1}}"#,
            r#"{"type":"presence","presence":{"activity":{"id":"a","name":"A","type":"streaming"},"updatedAt":1}}"#,
            r#"{"type":"presence","presence":{"activity":{"id":"a","name":"A","statusDisplayType":"url"},"updatedAt":1}}"#,
            r#"{"type":"presence","presence":{"activity":{"id":"a","name":"A","party":{"size":1}},"updatedAt":1}}"#,
            r#"{"type":"presence","presence":{"activity":null,"updatedAt":1},"platforms":["myspace"]}"#,
            r#"{"type":"presence","presence":{"activity":null,"updatedAt":1},"platforms":"discord"}"#,
            r#"{"type":"ping","x":1}"#,
            r#"{"type":"status","all":true}"#,
            r#"{"type":"set","setting":"allowedOrigins","value":true}"#,
            r#"{"type":"set","setting":"webSocket","value":false}"#,
            r#"{"type":"set","setting":"allowUserscripts","value":"yes"}"#,
            r#"[]"#,
            r#"null"#,
            r#"{"type":"ping","presence":null}"#,
            r#"{"type":"ping","setting":"allowUserscripts"}"#,
            r#"{"type":"status","name":"x"}"#,
            r#"{"type":"hello","protocolVersion":1,"version":"1.0.0","name":"x","value":true}"#,
            r#"{"type":"hello","protocolVersion":null,"version":"1.0.0","name":"x"}"#,
            r#"{"type":"presence","presence":{"activity":null,"updatedAt":1},"version":"1.0.0"}"#,
            r#"{"type":"set","setting":"allowUserscripts"}"#,
            r#"{"type":"set","setting":"allowUserscripts","value":null}"#,
            r#"{"type":"ping","type":"ping"}"#,
            r#"{"presence":{"activity":null,"updatedAt":1}}"#,
        ] {
            assert!(parse(json).is_err(), "{json}");
        }
    }

    /// A newer extension's additions are optional fields; they're skipped, not refused.
    #[test]
    fn a_presence_ignores_fields_it_does_not_know() {
        for json in [
            r#"{"type":"presence","presence":{"activity":null,"updatedAt":1,"extra":1}}"#,
            r#"{"type":"presence","presence":{"activity":{"id":"a","name":"A","clientId":"1","url":"https://example.com"},"updatedAt":1}}"#,
            r#"{"type":"presence","presence":{"activity":{"id":"a","name":"A","buttons":[{"label":"x","url":"u","extra":1}],"party":{"size":1,"max":2,"id":"x"}},"updatedAt":1}}"#,
        ] {
            assert!(parse(json).is_ok(), "{json}");
        }
    }

    #[test]
    fn envelope_reads_the_versions_of_any_first_message() {
        let old: Envelope =
            serde_json::from_str(r#"{"type":"hello","protocolVersion":2,"clientId":"x"}"#).unwrap();
        assert_eq!(
            (old.kind.as_str(), old.protocol_version, old.version),
            ("hello", Some(2), None)
        );
    }

    #[test]
    fn majors_are_read_from_release_versions() {
        for (version, expected) in [
            ("1.0.0", Some(1)),
            ("1.0.0-beta.1", Some(1)),
            // Firefox's store revision of a release.
            ("1.1.0.1", Some(1)),
            ("12.3.4+build", Some(12)),
            ("2", Some(2)),
            ("", None),
            (".1.0", None),
            ("v1.0.0", None),
            ("-1.0.0", None),
            ("1x.0.0", None),
            ("99999999999.0.0", None),
        ] {
            assert_eq!(major(version), expected, "{version:?}");
        }
    }

    #[test]
    fn only_another_major_or_protocol_is_incompatible() {
        let own = major(VERSION).unwrap();
        for version in [
            VERSION.to_string(),
            format!("{own}.0.0"),
            format!("{own}.7.3"),
            format!("{own}.0.0-beta.9"),
        ] {
            assert!(
                compatible(Some(PROTOCOL_VERSION), Some(&version)),
                "{version}"
            );
        }
        for (protocol, version) in [
            (Some(PROTOCOL_VERSION), Some(format!("{}.0.0", own + 1))),
            (Some(PROTOCOL_VERSION), Some("nonsense".to_string())),
            (Some(PROTOCOL_VERSION), None),
            (Some(PROTOCOL_VERSION + 1), Some(VERSION.to_string())),
            (None, Some(VERSION.to_string())),
        ] {
            assert!(
                !compatible(protocol, version.as_deref()),
                "{protocol:?} {version:?}"
            );
        }
    }

    #[test]
    fn serializes_server_messages() {
        assert_eq!(
            encode(&ServerMessage::Welcome {
                protocol_version: 1,
                version: "1.0.0-beta.1"
            }),
            r#"{"type":"welcome","protocolVersion":1,"version":"1.0.0-beta.1"}"#
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
