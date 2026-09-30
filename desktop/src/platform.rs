//! Platforms Desktop can show presence on, and the adapters that do it.
//!
//! The Hub (`hub.rs`) decides what each platform should show: of the
//! connections that allow that platform, the one whose Activity changed most
//! recently wins. An adapter only turns that one Activity (or nothing) into
//! what its platform understands. Discord is the only adapter so far.

use serde::{Deserialize, Serialize};

use crate::presence::Activity;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Platform {
    Discord,
    Fluxer,
    Stoat,
}

impl Platform {
    pub fn name(self) -> &'static str {
        match self {
            Self::Discord => "Discord",
            Self::Fluxer => "Fluxer",
            Self::Stoat => "Stoat",
        }
    }

    fn bit(self) -> u8 {
        match self {
            Self::Discord => 1,
            Self::Fluxer => 2,
            Self::Stoat => 4,
        }
    }
}

/// The platforms one connection's Presence may be shown on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Platforms(u8);

impl Platforms {
    pub const ALL: Self = Self(1 | 2 | 4);

    /// `None` (a client that doesn't choose) means every platform.
    pub fn from_wire(list: Option<&[Platform]>) -> Self {
        list.map_or(Self::ALL, |list| {
            Self(list.iter().fold(0, |bits, platform| bits | platform.bit()))
        })
    }

    pub fn contains(self, platform: Platform) -> bool {
        self.0 & platform.bit() != 0
    }
}

/// How an adapter is doing, for `status`, the tray, and the dashboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterStatus {
    pub platform: Platform,
    pub state: AdapterState,
    /// The name of the Activity being shown, while `state` is `showing`.
    pub activity: Option<String>,
    /// What the platform last said went wrong, if anything.
    pub error: Option<String>,
}

impl AdapterStatus {
    /// One line for the CLI, the tray, and the event log.
    pub fn describe(&self) -> String {
        let name = self.platform.name();
        match (self.state, &self.activity, &self.error) {
            (AdapterState::Idle, ..) => format!("{name}: nothing to show"),
            (AdapterState::Connecting, ..) => format!("{name}: connecting"),
            (AdapterState::Connected, ..) => format!("{name}: connected, nothing shown"),
            (AdapterState::Showing, Some(activity), _) => format!("{name}: showing {activity}"),
            (AdapterState::Showing, None, _) => format!("{name}: showing an activity"),
            (AdapterState::NotRunning, _, None) => format!("{name}: not running, trying again"),
            (AdapterState::NotRunning, _, Some(error)) => {
                format!("{name}: {error}, trying again")
            }
            (AdapterState::Refused, _, Some(error)) => format!("{name} refused it: {error}"),
            (AdapterState::Refused, _, None) => format!("{name} refused it"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterState {
    /// Nothing to show, and not connected.
    Idle,
    Connecting,
    /// Connected; `activity` says whether something is shown.
    Connected,
    Showing,
    /// Something to show, but the platform's app isn't reachable. Retrying.
    NotRunning,
    /// The platform turned the connection or the Activity down (`error`).
    Refused,
}

pub trait PlatformAdapter: Send + Sync {
    fn platform(&self) -> Platform;

    /// What to show now, or nothing. Must return at once and never call back
    /// into the Hub: it's called with the Hub's lock held, so updates reach
    /// the adapter in the order they happened.
    fn show(&self, activity: Option<Activity>);

    fn status(&self) -> AdapterStatus;
}

/// Hands an adapter's notable moments ("Discord: connected") to the Hub,
/// which logs them in debug mode and refreshes the tray.
pub type Reporter = Box<dyn Fn(String) + Send + Sync>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_client_that_doesnt_choose_gets_every_platform() {
        let all = Platforms::from_wire(None);
        assert!(all.contains(Platform::Discord) && all.contains(Platform::Stoat));
        let some = Platforms::from_wire(Some(&[Platform::Fluxer]));
        assert!(some.contains(Platform::Fluxer) && !some.contains(Platform::Discord));
        assert!(!Platforms::from_wire(Some(&[])).contains(Platform::Discord));
    }
}
