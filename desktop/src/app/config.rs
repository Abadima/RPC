//! Where Desktop keeps its files, and its settings (`config.json`).

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::app::presence::is_discord_id;
use crate::link::identity;
use crate::platform;

pub struct AppPaths {
    /// `~/.local/share/parousia` on Linux, `%APPDATA%\parousia` on Windows,
    /// `~/Library/Application Support/parousia` on macOS.
    pub data_dir: PathBuf,
    /// Holds the IPC socket: `$XDG_RUNTIME_DIR/parousia` on Linux (per-user,
    /// cleared at logout), otherwise the data directory.
    pub runtime_dir: PathBuf,
}

impl AppPaths {
    /// Creates nothing: the CLI only ever talks to a running Desktop and
    /// shouldn't leave directories behind when there isn't one.
    ///
    /// `PAROUSIA_DATA_DIR` replaces the platform data directory: so
    /// end-to-end checks can run against a throwaway one and never touch a
    /// real config (Windows has no environment variable that moves its own).
    pub fn locate() -> io::Result<Self> {
        let data_dir = match std::env::var_os("PAROUSIA_DATA_DIR").filter(|dir| !dir.is_empty()) {
            Some(dir) => PathBuf::from(dir),
            None => dirs::data_dir()
                .ok_or_else(|| io::Error::other("no platform data directory available"))?
                .join("parousia"),
        };
        let runtime_dir = dirs::runtime_dir()
            .map(|dir| dir.join("parousia"))
            .unwrap_or_else(|| data_dir.clone());
        Ok(Self {
            data_dir,
            runtime_dir,
        })
    }

    /// `locate`, then creates both directories readable by this user only:
    /// the private directory is what keeps other OS users off the socket.
    pub fn resolve() -> io::Result<Self> {
        let paths = Self::locate()?;
        create_private_dir(&paths.data_dir)?;
        create_private_dir(&paths.runtime_dir)?;
        Ok(paths)
    }

    pub fn config_path(&self) -> PathBuf {
        self.data_dir.join("config.json")
    }
}

/// Also tightens a directory that already exists with looser permissions.
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    platform::fs::restrict_dir(path)
}

/// Hand-editable; Desktop rewrites it only when a setting changes from one of
/// its own UIs or Parousia's dashboard.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    /// Exact extension origins trusted on top of the built-in store listings:
    /// `chrome-extension://<id>` or `moz-extension://<uuid>` (Firefox's is
    /// random per install).
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    /// Userscripts connect with the origin of whatever page they run on, so
    /// allowing them lets any web page publish presence. Off by default.
    #[serde(default)]
    pub allow_userscripts: bool,
    /// The Discord Application to show Activities as when they don't name
    /// their own; Parousia's when unset. Public, not a secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discord_client_id: Option<String>,
}

impl Settings {
    /// A missing file means defaults. An invalid one (bad JSON, unknown keys,
    /// or an origin that isn't an exact extension origin) is an error rather
    /// than skipped, so a typo can't silently widen what's trusted.
    pub fn load(path: &Path) -> io::Result<Self> {
        let settings: Self = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other)?,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(err) => return Err(err),
        };
        for origin in &settings.allowed_origins {
            identity::validate_allowed_origin(origin).map_err(io::Error::other)?;
        }
        if let Some(id) = &settings.discord_client_id
            && !is_discord_id(id)
        {
            return Err(io::Error::other(format!(
                "discordClientId {id:?} isn't a Discord Application id"
            )));
        }
        Ok(settings)
    }

    /// Temp file, fsync, rename: a crash mid-write can't leave a truncated file.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        let mut json = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        json.push(b'\n');
        let tmp_path = path.with_extension("json.tmp");
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        platform::fs::owner_only(&mut options);
        let mut file = options.open(&tmp_path)?;
        file.write_all(&json)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp_path, path)
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    pub fn temp_dir(name: &str) -> PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "parousia-desktop-test-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const CHROMIUM: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

    #[test]
    fn a_missing_file_means_defaults() {
        let dir = temp_dir("settings-missing");
        let settings = Settings::load(&dir.join("config.json")).unwrap();
        fs::remove_dir_all(dir).ok();
        assert_eq!(settings, Settings::default());
        assert!(!settings.allow_userscripts);
    }

    #[test]
    fn settings_round_trip_through_the_file() {
        let dir = temp_dir("settings-roundtrip");
        let path = dir.join("config.json");
        let settings = Settings {
            allowed_origins: vec![CHROMIUM.to_string()],
            allow_userscripts: true,
            discord_client_id: Some("1553980756731363428".to_string()),
        };
        settings.save(&path).unwrap();
        let loaded = Settings::load(&path).unwrap();
        fs::remove_dir_all(dir).ok();
        assert_eq!(loaded, settings);
    }

    #[test]
    fn hand_edited_files_are_read_with_defaults_for_missing_keys() {
        let dir = temp_dir("settings-partial");
        let path = dir.join("config.json");
        fs::write(&path, format!(r#"{{"allowedOrigins":["{CHROMIUM}"]}}"#)).unwrap();
        let settings = Settings::load(&path).unwrap();
        fs::remove_dir_all(dir).ok();
        assert_eq!(settings.allowed_origins, [CHROMIUM]);
        assert!(!settings.allow_userscripts);
    }

    #[test]
    fn invalid_files_are_errors_not_silently_skipped() {
        for bad in [
            r#"{"allowedOrigins":"not-a-list"}"#,
            r#"{"allowedOrigins":["https://example.com"]}"#,
            r#"{"allowedOrigins":["chrome-extension://*"]}"#,
            r#"{"allowUserScripts":true}"#,
            r#"{"webSocket":false}"#,
            r#"{"discordClientId":"parousia"}"#,
            r#"{"discordClientId":1553980756731363428}"#,
            "not json",
        ] {
            let dir = temp_dir("settings-bad");
            let path = dir.join("config.json");
            fs::write(&path, bad).unwrap();
            let result = Settings::load(&path);
            fs::remove_dir_all(dir).ok();
            assert!(result.is_err(), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn private_dirs_and_the_settings_file_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("private");
        let target = dir.join("parousia");
        fs::create_dir_all(&target).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        create_private_dir(&target).unwrap();
        Settings::default()
            .save(&target.join("config.json"))
            .unwrap();

        let dir_mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        let file_mode = fs::metadata(target.join("config.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        fs::remove_dir_all(dir).ok();
        assert_eq!((dir_mode, file_mode), (0o700, 0o600));
    }
}
