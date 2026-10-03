//! Parousia's Activity as a Discord Rich Presence activity: the `activity`
//! of an RPC `SET_ACTIVITY`. Same rules as `toDiscordPresence` in
//! `browser/src/compat/discord-rpc-extension.ts`, which reaches Discord
//! through Discord-RPC-Extension's app; both are tested against the cases in
//! `adapters/discord/activity-mapping.json`.
//!
//! Discord turns down a whole activity over one field it doesn't accept, so a
//! field it can't take is left out instead:
//! - Text (name, details, state, image captions) is trimmed. Under 2 UTF-16
//!   units it's left out; over 128 it's cut to 127 and ends in "…".
//! - Images (asset keys or URLs): at most 256 UTF-16 units.
//! - Links for the details and state lines, and on the images: `http(s)`, at
//!   most 256. An image's link goes only with that image.
//! - The type (Listening, Watching, Competing; Playing is Discord's default
//!   and is left out), which line the status shows (the name is the default
//!   and is left out), and the party (a Playing activity's "2 of 5").
//! - Buttons: the first 2 with a label, cut to 32 like text; URL `http(s)`,
//!   at most 512.
//! - Times: milliseconds from 1 through 2147483647000, the most the RPC
//!   library behind Discord-RPC-Extension's app accepts.

use serde::Serialize;

use crate::app::presence::{Activity, ActivityType, StatusDisplayType};

const MAX_TEXT: usize = 128;
const MIN_TEXT: usize = 2;
const MAX_IMAGE: usize = 256;
const MAX_LINK: usize = 256;
const MAX_BUTTON_LABEL: usize = 32;
const MAX_BUTTON_URL: usize = 512;
const MAX_BUTTONS: usize = 2;
const MAX_TIME: i64 = 2_147_483_647_000;
const MAX_PARTY_ID: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiscordActivity {
    /// Discord's activity type: 2 Listening, 3 Watching, 5 Competing.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_url: Option<String>,
    /// Discord's `status_display_type`: 1 State, 2 Details.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_display_type: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub party: Option<Party>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamps: Option<Timestamps>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets: Option<Assets>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub buttons: Vec<Button>,
    pub instance: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Timestamps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Party {
    pub id: String,
    pub size: [u32; 2],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Assets {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Button {
    pub label: String,
    pub url: String,
}

pub fn to_discord_activity(activity: &Activity) -> DiscordActivity {
    let assets = activity.assets.as_ref().map(|assets| {
        let large_image = image(assets.large_image.as_deref());
        let small_image = image(assets.small_image.as_deref());
        Assets {
            large_url: large_image
                .as_ref()
                .and_then(|_| link(assets.large_url.as_deref(), MAX_LINK)),
            small_url: small_image
                .as_ref()
                .and_then(|_| link(assets.small_url.as_deref(), MAX_LINK)),
            large_image,
            large_text: text(assets.large_text.as_deref(), MAX_TEXT),
            small_image,
            small_text: text(assets.small_text.as_deref(), MAX_TEXT),
        }
    });
    let kind = match activity.kind {
        None | Some(ActivityType::Playing) => None,
        Some(ActivityType::Listening) => Some(2),
        Some(ActivityType::Watching) => Some(3),
        Some(ActivityType::Competing) => Some(5),
    };
    let status_display_type = match activity.status_display_type {
        None | Some(StatusDisplayType::Name) => None,
        Some(StatusDisplayType::State) => Some(1),
        Some(StatusDisplayType::Details) => Some(2),
    };
    // Discord shows a party on a Playing activity only, and wants an id for it.
    let party = activity
        .party
        .filter(|_| kind.is_none())
        .map(|party| Party {
            id: activity.id.chars().take(MAX_PARTY_ID).collect(),
            size: [party.size, party.max],
        });
    let timestamps = activity.timestamps.map(|timestamps| Timestamps {
        start: time(timestamps.start),
        end: time(timestamps.end),
    });
    DiscordActivity {
        kind,
        name: text(Some(&activity.name), MAX_TEXT),
        details: text(activity.details.as_deref(), MAX_TEXT),
        details_url: link(activity.details_url.as_deref(), MAX_LINK),
        state: text(activity.state.as_deref(), MAX_TEXT),
        state_url: link(activity.state_url.as_deref(), MAX_LINK),
        status_display_type,
        party,
        timestamps: timestamps.filter(|t| t.start.is_some() || t.end.is_some()),
        assets: assets.filter(|a| {
            a.large_image.is_some()
                || a.large_text.is_some()
                || a.small_image.is_some()
                || a.small_text.is_some()
        }),
        buttons: activity
            .buttons
            .iter()
            .filter_map(|button| {
                Some(Button {
                    label: cut(button.label.trim(), 1, MAX_BUTTON_LABEL)?,
                    url: link(Some(&button.url), MAX_BUTTON_URL)?,
                })
            })
            .take(MAX_BUTTONS)
            .collect(),
        instance: true,
    }
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn text(value: Option<&str>, max: usize) -> Option<String> {
    cut(value?.trim(), MIN_TEXT, max)
}

/// `value` if it's `min..=max` UTF-16 units; longer, the first `max - 1`
/// (never half a surrogate pair) and "…".
fn cut(value: &str, min: usize, max: usize) -> Option<String> {
    let len = utf16_len(value);
    if len < min {
        return None;
    }
    if len <= max {
        return Some(value.to_string());
    }
    let mut used = 0;
    let head: String = value
        .chars()
        .take_while(|c| {
            used += c.len_utf16();
            used < max
        })
        .collect();
    Some(format!("{}…", head.trim_end()))
}

fn image(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    (!value.is_empty() && utf16_len(value) <= MAX_IMAGE).then(|| value.to_string())
}

fn link(value: Option<&str>, max: usize) -> Option<String> {
    let value = value?;
    ((value.starts_with("https://") || value.starts_with("http://")) && utf16_len(value) <= max)
        .then(|| value.to_string())
}

fn time(value: Option<i64>) -> Option<i64> {
    value.filter(|t| (1..=MAX_TIME).contains(t))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::presence::Presence;
    use crate::link::protocol::PresenceWire;

    /// The cases the browser's mapping is also tested against.
    const CASES: &str = include_str!("../../../../adapters/discord/activity-mapping.json");

    #[test]
    fn matches_the_shared_cases() {
        let cases: serde_json::Value = serde_json::from_str(CASES).unwrap();
        let cases = cases["cases"].as_array().unwrap();
        assert!(cases.len() >= 5);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let wire: PresenceWire = serde_json::from_value(serde_json::json!({
                "activity": case["activity"],
                "updatedAt": 1,
            }))
            .unwrap_or_else(|err| panic!("{name}: {err}"));
            let presence = Presence::try_from(wire).unwrap_or_else(|err| panic!("{name}: {err}"));
            let mapped =
                serde_json::to_value(to_discord_activity(presence.activity.as_ref().unwrap()))
                    .unwrap();
            assert_eq!(mapped, case["discord"], "{name}");
        }
    }

    fn mapped(json: serde_json::Value) -> serde_json::Value {
        let wire: PresenceWire = serde_json::from_value(serde_json::json!({
            "activity": json,
            "updatedAt": 1,
        }))
        .unwrap();
        let presence = Presence::try_from(wire).unwrap();
        serde_json::to_value(to_discord_activity(presence.activity.as_ref().unwrap())).unwrap()
    }

    #[test]
    fn the_type_status_line_and_party_go_as_discord_takes_them() {
        let watching = mapped(serde_json::json!({
            "id": "premid:Netflix", "name": "Netflix", "type": "watching",
            "statusDisplayType": "details", "party": {"size": 1, "max": 2},
        }));
        assert_eq!(watching["type"], 3);
        assert_eq!(watching["status_display_type"], 2);
        // A party shows on a Playing activity only.
        assert!(watching.get("party").is_none());

        for (kind, number) in [("listening", 2), ("competing", 5)] {
            assert_eq!(
                mapped(serde_json::json!({"id": "a", "name": "A", "type": kind}))["type"],
                number
            );
        }
        let state = mapped(serde_json::json!({
            "id": "a", "name": "A", "statusDisplayType": "state"
        }));
        assert_eq!(state["status_display_type"], 1);

        // Playing and "show the name" are Discord's defaults: sent as nothing.
        let plain = mapped(serde_json::json!({
            "id": "a", "name": "A", "type": "playing", "statusDisplayType": "name",
        }));
        assert!(plain.get("type").is_none());
        assert!(plain.get("status_display_type").is_none());

        let playing = mapped(serde_json::json!({
            "id": "premid:Game", "name": "Game", "party": {"size": 2, "max": 5},
        }));
        assert_eq!(
            playing["party"],
            serde_json::json!({"id": "premid:Game", "size": [2, 5]})
        );
    }

    #[test]
    fn an_images_link_goes_only_with_its_image() {
        let both = mapped(serde_json::json!({
            "id": "a", "name": "A",
            "assets": {
                "largeImage": "https://example.com/l.png", "largeUrl": "https://example.com/album",
                "smallUrl": "https://example.com/artist",
            },
        }));
        assert_eq!(both["assets"]["large_url"], "https://example.com/album");
        assert!(both["assets"].get("small_url").is_none());
        let long = format!("https://example.com/{}", "a".repeat(300));
        let too_long = mapped(serde_json::json!({
            "id": "a", "name": "A",
            "assets": {"largeImage": "logo", "largeUrl": long},
        }));
        assert!(too_long["assets"].get("large_url").is_none());
    }

    #[test]
    fn cutting_never_splits_a_character() {
        assert_eq!(cut("ab", 2, 128).as_deref(), Some("ab"));
        assert_eq!(cut("a", 2, 128), None);
        assert_eq!(cut("abcdef", 1, 4).as_deref(), Some("abc…"));
        // "😀" is two UTF-16 units: it can't fit in the 3 left before "…".
        assert_eq!(cut("ab😀cd", 1, 4).as_deref(), Some("ab…"));
        assert_eq!(cut("a😀cd", 1, 4).as_deref(), Some("a😀…"));
    }
}
