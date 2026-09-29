//! Desktop's own Presence, converted from the wire shape in `protocol.rs`.
//! Conversion bounds every field, so an adapter never receives unbounded
//! text from a browser.

use std::fmt;

use crate::protocol::{ActivityAssetsWire, ActivityTimestampsWire, ActivityWire, PresenceWire};

/// Generous enough for any real activity/details/state/url string, small
/// enough that a malicious or buggy sender can't hand adapters unbounded text.
const MAX_FIELD_LEN: usize = 512;

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
    pub url: String,
    pub assets: Option<ActivityAssets>,
    pub timestamps: Option<ActivityTimestamps>,
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
        validate_len("url", &wire.url)?;
        // Activities are detected on web pages; anything else isn't one.
        if !(wire.url.starts_with("https://") || wire.url.starts_with("http://")) {
            return Err(PresenceError { field: "url" });
        }
        Ok(Self {
            id: wire.id,
            name: wire.name,
            details: wire.details,
            state: wire.state,
            url: wire.url,
            assets: wire.assets.map(TryInto::try_into).transpose()?,
            timestamps: wire.timestamps.map(TryInto::try_into).transpose()?,
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
            url: "https://example.com".to_string(),
            assets: None,
            timestamps: None,
        }
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
        activity.url = "javascript:alert(1)".to_string();
        let wire = PresenceWire {
            activity: Some(activity),
            updated_at: 1,
        };
        assert_eq!(Presence::try_from(wire).unwrap_err().field, "url");

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
