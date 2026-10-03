//! Which clients may connect: the WebSocket's `Origin` header, which the
//! browser sets and no page or extension can forge, matched exactly against
//! an allowlist of Parousia builds.
//!
//! Nothing here is a secret, and nothing is issued or stored per client: a
//! process running as the same user could claim any identity anyway, and is
//! out of scope (see `project/threat-model.md`).

use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClientKind {
    ChromiumExtension,
    FirefoxExtension,
    /// Connects with the origin of whatever page it runs on (or `null`, from
    /// Firefox's content scripts), so it's indistinguishable from that page.
    Userscript,
}

impl ClientKind {
    pub fn describe(self) -> &'static str {
        match self {
            Self::ChromiumExtension => "Chromium extension",
            Self::FirefoxExtension => "Firefox extension",
            Self::Userscript => "userscript",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub kind: ClientKind,
    /// The origin the browser vouched for.
    pub identity: String,
    /// Whether the OS confirmed the connection comes from this user, where
    /// the loopback peer's owner can be checked (Linux, see `platform/linux/peer.rs`). Only
    /// a verified connection may change settings.
    pub same_user: bool,
}

/// The Chrome Web Store listing. Other builds (unpacked, sideloaded) are
/// listed in `allowedOrigins`.
pub const PRODUCTION_CHROMIUM_ORIGINS: &[&str] =
    &["chrome-extension://achhedhokopfgfnigkfchklhbebbhebd"];

const MAX_ORIGIN_LEN: usize = 255;

/// What a WebSocket's `Origin` header says about the client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// An exact extension origin (it may or may not be allowed).
    Extension(ClientKind),
    /// A web page, or an opaque `null` origin: where a userscript connects from.
    Web,
    /// Missing, malformed, or a scheme no Parousia client uses.
    Invalid,
}

pub fn classify_origin(origin: &str) -> Origin {
    if origin.len() > MAX_ORIGIN_LEN {
        Origin::Invalid
    } else if is_chromium_origin(origin) {
        Origin::Extension(ClientKind::ChromiumExtension)
    } else if is_firefox_origin(origin) {
        Origin::Extension(ClientKind::FirefoxExtension)
    } else if origin == "null" || is_web_origin(origin) {
        Origin::Web
    } else {
        Origin::Invalid
    }
}

/// Chromium extension ids are 32 characters from `a` to `p`.
fn is_chromium_origin(origin: &str) -> bool {
    origin
        .strip_prefix("chrome-extension://")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
}

/// Firefox's per-install extension origin is a lowercase UUID.
fn is_firefox_origin(origin: &str) -> bool {
    origin.strip_prefix("moz-extension://").is_some_and(|uuid| {
        let groups: Vec<&str> = uuid.split('-').collect();
        groups.len() == 5
            && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, len)| {
                group.len() == len
                    && group
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
    })
}

/// A serialized web origin as browsers send it: scheme and host, maybe a
/// port, nothing else.
fn is_web_origin(origin: &str) -> bool {
    let Some(host) = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
    else {
        return false;
    };
    !host.is_empty()
        && host.bytes().all(|b| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || matches!(b, b'.' | b'-' | b':' | b'[' | b']')
        })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidOrigin(pub String);

impl fmt::Display for InvalidOrigin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "'{}' is not an exact extension origin (expected chrome-extension://<32-letter id> or moz-extension://<uuid>)",
            self.0
        )
    }
}

impl std::error::Error for InvalidOrigin {}

pub fn validate_allowed_origin(origin: &str) -> Result<(), InvalidOrigin> {
    match classify_origin(origin) {
        Origin::Extension(_) => Ok(()),
        _ => Err(InvalidOrigin(origin.to_string())),
    }
}

pub fn is_allowed_origin(origin: &str, allowed: &[String]) -> bool {
    PRODUCTION_CHROMIUM_ORIGINS.contains(&origin) || allowed.iter().any(|entry| entry == origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHROMIUM: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const FIREFOX: &str = "moz-extension://2c127fa4-62c7-7e4f-90e5-472b45eecfdc";

    #[test]
    fn origins_are_classified_exactly() {
        assert_eq!(
            classify_origin(CHROMIUM),
            Origin::Extension(ClientKind::ChromiumExtension)
        );
        assert_eq!(
            classify_origin(FIREFOX),
            Origin::Extension(ClientKind::FirefoxExtension)
        );
        for web in [
            "https://example.com",
            "http://localhost:8080",
            "https://[::1]:3000",
            "null",
        ] {
            assert_eq!(classify_origin(web), Origin::Web, "{web}");
        }
        for invalid in [
            "",
            "Null",
            "*",
            "file://",
            "chrome://settings",
            "https://",
            "https://Example.com",
            "https://example.com/path",
            "chrome-extension://*",
            "chrome-extension://abcdefghijklmnopabcdefghijklmno",
            "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
            "moz-extension://not-a-uuid",
            "moz-extension://2C127FA4-62C7-7E4F-90E5-472B45EECFDC",
            "safari-web-extension://2C127FA4-62C7-7E4F-90E5-472B45EECFDC",
        ] {
            assert_eq!(classify_origin(invalid), Origin::Invalid, "{invalid:?}");
        }
        assert_eq!(
            classify_origin(&format!("https://{}", "a".repeat(300))),
            Origin::Invalid
        );
    }

    #[test]
    fn only_exact_extension_origins_can_be_allowed() {
        assert!(validate_allowed_origin(CHROMIUM).is_ok());
        assert!(validate_allowed_origin(FIREFOX).is_ok());
        for bad in ["https://example.com", "null", "chrome-extension://*"] {
            assert!(validate_allowed_origin(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_store_listing_is_allowed_without_config_and_nothing_near_it_is() {
        for origin in PRODUCTION_CHROMIUM_ORIGINS {
            assert_eq!(
                classify_origin(origin),
                Origin::Extension(ClientKind::ChromiumExtension)
            );
            assert!(is_allowed_origin(origin, &[]));
        }
        // One letter off, a different scheme, or a trailing slash is someone else.
        let store = PRODUCTION_CHROMIUM_ORIGINS[0];
        for other in [
            "chrome-extension://achhedhokopfgfnigkfchklhbebbhebe",
            "moz-extension://achhedhokopfgfnigkfchklhbebbhebd",
            "chrome-extension://achhedhokopfgfnigkfchklhbebbhebd/",
        ] {
            assert_ne!(other, store);
            assert!(!is_allowed_origin(other, &[]), "{other}");
        }
    }

    #[test]
    fn allowed_origins_match_exactly() {
        let allowed = vec![CHROMIUM.to_string()];
        assert!(is_allowed_origin(CHROMIUM, &allowed));
        assert!(!is_allowed_origin(
            "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba",
            &allowed
        ));
        assert!(!is_allowed_origin(FIREFOX, &allowed));
    }
}
