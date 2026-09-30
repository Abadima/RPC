//! Desktop's own Presence, converted from the wire shape in `protocol.rs`.
//! Conversion bounds every field, so an adapter never receives unbounded
//! text from a browser.

use std::fmt;

use crate::protocol::{
    ActivityAssetsWire, ActivityButtonWire, ActivityTimestampsWire, ActivityWire, PresenceWire,
};

/// Generous enough for any real activity/details/state string, small
/// enough that a malicious or buggy sender can't hand adapters unbounded text.
const MAX_FIELD_LEN: usize = 512;
/// Discord shows at most two; nothing else takes buttons.
const MAX_BUTTONS: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Presence {
    pub activity: Option<Activity>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activity {
    pub id: String,
    pub name: String,
    pub details: Option<String>,
    pub state: Option<String>,
    pub assets: Option<ActivityAssets>,
    pub timestamps: Option<ActivityTimestamps>,
    /// A Discord snowflake (see `is_discord_id`), when the Activity has its
    /// own Discord Application.
    pub discord_client_id: Option<String>,
    /// Links for the details and state lines; `http(s)` only.
    pub details_url: Option<String>,
    pub state_url: Option<String>,
    pub buttons: Vec<ActivityButton>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityButton {
    pub label: String,
    /// `http(s)` only.
    pub url: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActivityAssets {
    pub large_image: Option<String>,
    pub large_text: Option<String>,
    pub small_image: Option<String>,
    pub small_text: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ActivityTimestamps {
    pub start: Option<i64>,
    pub end: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresenceError {
    pub field: &'static str,
}

impl fmt::Display for PresenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "field '{}' is too long or out of range", self.field)
    }
}

impl std::error::Error for PresenceError {}

fn validate_len(field: &'static str, value: &str) -> Result<(), PresenceError> {
    if value.chars().count() > MAX_FIELD_LEN {
        return Err(PresenceError { field });
    }
    Ok(())
}

fn validate_opt_len(field: &'static str, value: &Option<String>) -> Result<(), PresenceError> {
    match value {
        Some(v) => validate_len(field, v),
        None => Ok(()),
    }
}

/// Activities are detected on web pages, and anything they link to is one:
/// no `javascript:`, `file:`, or custom schemes.
fn validate_web_url(field: &'static str, value: &str) -> Result<(), PresenceError> {
    validate_len(field, value)?;
    if value.starts_with("https://") || value.starts_with("http://") {
        Ok(())
    } else {
        Err(PresenceError { field })
    }
}

/// Discord ids are snowflakes: a `u64` written in decimal, 17 digits or more
/// for anything created since 2015.
pub fn is_discord_id(value: &str) -> bool {
    (17..=20).contains(&value.len())
        && value.bytes().all(|b| b.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}

impl TryFrom<ActivityButtonWire> for ActivityButton {
    type Error = PresenceError;

    fn try_from(wire: ActivityButtonWire) -> Result<Self, Self::Error> {
        validate_len("buttons.label", &wire.label)?;
        validate_web_url("buttons.url", &wire.url)?;
        Ok(Self {
            label: wire.label,
            url: wire.url,
        })
    }
}

impl TryFrom<ActivityAssetsWire> for ActivityAssets {
    type Error = PresenceError;

    fn try_from(wire: ActivityAssetsWire) -> Result<Self, Self::Error> {
        validate_opt_len("assets.largeImage", &wire.large_image)?;
        validate_opt_len("assets.largeText", &wire.large_text)?;
        validate_opt_len("assets.smallImage", &wire.small_image)?;
        validate_opt_len("assets.smallText", &wire.small_text)?;
        Ok(Self {
            large_image: wire.large_image,
            large_text: wire.large_text,
            small_image: wire.small_image,
            small_text: wire.small_text,
        })
    }
}

impl TryFrom<ActivityTimestampsWire> for ActivityTimestamps {
    type Error = PresenceError;

    /// Milliseconds since the epoch; negative values are nonsense.
    fn try_from(wire: ActivityTimestampsWire) -> Result<Self, Self::Error> {
        if wire.start.is_some_and(|t| t < 0) || wire.end.is_some_and(|t| t < 0) {
            return Err(PresenceError {
                field: "timestamps",
            });
        }
        Ok(Self {
            start: wire.start,
            end: wire.end,
        })
    }
}

impl TryFrom<ActivityWire> for Activity {
    type Error = PresenceError;

    fn try_from(wire: ActivityWire) -> Result<Self, Self::Error> {
        validate_len("id", &wire.id)?;
        validate_len("name", &wire.name)?;
        validate_opt_len("details", &wire.details)?;
        validate_opt_len("state", &wire.state)?;
        for (field, url) in [
            ("detailsUrl", &wire.details_url),
            ("stateUrl", &wire.state_url),
        ] {
            if let Some(url) = url {
                validate_web_url(field, url)?;
            }
        }
        if wire
            .discord_client_id
            .as_deref()
            .is_some_and(|id| !is_discord_id(id))
        {
            return Err(PresenceError {
                field: "discordClientId",
            });
        }
        let buttons = wire.buttons.unwrap_or_default();
        if buttons.len() > MAX_BUTTONS {
            return Err(PresenceError { field: "buttons" });
        }
        Ok(Self {
            id: wire.id,
            name: wire.name,
            details: wire.details,
            state: wire.state,
            assets: wire.assets.map(TryInto::try_into).transpose()?,
            timestamps: wire.timestamps.map(TryInto::try_into).transpose()?,
            discord_client_id: wire.discord_client_id,
            details_url: wire.details_url,
            state_url: wire.state_url,
            buttons: buttons
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
        })
    }
}

impl TryFrom<PresenceWire> for Presence {
    type Error = PresenceError;

    fn try_from(wire: PresenceWire) -> Result<Self, Self::Error> {
        if wire.updated_at < 0 {
            return Err(PresenceError { field: "updatedAt" });
        }
        Ok(Self {
            activity: wire.activity.map(TryInto::try_into).transpose()?,
            updated_at: wire.updated_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ActivityTimestampsWire;

    fn wire_activity(id: &str) -> ActivityWire {
        ActivityWire {
            id: id.to_string(),
            name: "Example".to_string(),
            details: None,
            state: None,
            assets: None,
            timestamps: None,
            discord_client_id: None,
            details_url: None,
            state_url: None,
            buttons: None,
        }
    }

    fn convert(activity: ActivityWire) -> Result<Activity, PresenceError> {
        Presence::try_from(PresenceWire {
            activity: Some(activity),
            updated_at: 1,
        })
        .map(|presence| presence.activity.unwrap())
    }

    #[test]
    fn discord_ids_are_snowflakes() {
        assert!(is_discord_id("1553980756731363428"));
        assert!(is_discord_id("81384788765712384"));
        for bad in [
            "",
            "123",
            "1553980756731363428x",
            "-553980756731363428",
            "99999999999999999999",
            " 1553980756731363428",
        ] {
            assert!(!is_discord_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn links_buttons_and_the_client_id_are_checked() {
        let mut activity = wire_activity("example");
        activity.discord_client_id = Some("1553980756731363428".into());
        activity.details_url = Some("https://example.com/details".into());
        activity.buttons = Some(vec![ActivityButtonWire {
            label: "Open".into(),
            url: "https://example.com".into(),
        }]);
        let converted = convert(activity).unwrap();
        assert_eq!(converted.buttons[0].label, "Open");
        assert_eq!(
            converted.discord_client_id.as_deref(),
            Some("1553980756731363428")
        );

        let mut activity = wire_activity("example");
        activity.discord_client_id = Some("not-an-id".into());
        assert_eq!(convert(activity).unwrap_err().field, "discordClientId");

        let mut activity = wire_activity("example");
        activity.state_url = Some("javascript:alert(1)".into());
        assert_eq!(convert(activity).unwrap_err().field, "stateUrl");

        let button = |url: &str| ActivityButtonWire {
            label: "Go".into(),
            url: url.into(),
        };
        let mut activity = wire_activity("example");
        activity.buttons = Some(vec![button("file:///etc/passwd")]);
        assert_eq!(convert(activity).unwrap_err().field, "buttons.url");

        let mut activity = wire_activity("example");
        activity.buttons = Some(vec![button("https://a.example"); 3]);
        assert_eq!(convert(activity).unwrap_err().field, "buttons");
    }

    #[test]
    fn converts_null_activity() {
        let wire = PresenceWire {
            activity: None,
            updated_at: 42,
        };
        let presence = Presence::try_from(wire).unwrap();
        assert!(presence.activity.is_none());
        assert_eq!(presence.updated_at, 42);
    }

    #[test]
    fn converts_populated_activity() {
        let mut activity = wire_activity("example");
        activity.timestamps = Some(ActivityTimestampsWire {
            start: Some(1),
            end: Some(2),
        });
        let wire = PresenceWire {
            activity: Some(activity),
            updated_at: 42,
        };
        let presence = Presence::try_from(wire).unwrap();
        let activity = presence.activity.unwrap();
        assert_eq!(activity.id, "example");
        assert_eq!(activity.timestamps.unwrap().start, Some(1));
    }

    #[test]
    fn rejects_oversized_field() {
        let mut activity = wire_activity("example");
        activity.name = "x".repeat(MAX_FIELD_LEN + 1);
        let wire = PresenceWire {
            activity: Some(activity),
            updated_at: 42,
        };
        let err = Presence::try_from(wire).unwrap_err();
        assert_eq!(err.field, "name");
    }

    #[test]
    fn rejects_oversized_nested_asset_field() {
        let mut activity = wire_activity("example");
        activity.assets = Some(ActivityAssetsWire {
            large_image: Some("x".repeat(MAX_FIELD_LEN + 1)),
            large_text: None,
            small_image: None,
            small_text: None,
        });
        let wire = PresenceWire {
            activity: Some(activity),
            updated_at: 42,
        };
        let err = Presence::try_from(wire).unwrap_err();
        assert_eq!(err.field, "assets.largeImage");
    }

    #[test]
    fn rejects_non_web_urls_and_negative_times() {
        let mut activity = wire_activity("example");
        activity.details_url = Some("javascript:alert(1)".to_string());
        let wire = PresenceWire {
            activity: Some(activity),
            updated_at: 1,
        };
        assert_eq!(Presence::try_from(wire).unwrap_err().field, "detailsUrl");

        let mut activity = wire_activity("example");
        activity.timestamps = Some(ActivityTimestampsWire {
            start: Some(-5),
            end: None,
        });
        let wire = PresenceWire {
            activity: Some(activity),
            updated_at: 1,
        };
        assert_eq!(Presence::try_from(wire).unwrap_err().field, "timestamps");

        let wire = PresenceWire {
            activity: None,
            updated_at: -1,
        };
        assert_eq!(Presence::try_from(wire).unwrap_err().field, "updatedAt");
    }
}
