# Parousia Architecture Overview

Parousia consists of four modular components: **Browser Extension**, **Parousia Desktop**, **Platform Adapters**, and **Activities**.

---

## 1. Core Architecture

```mermaid
flowchart LR
    A["<b>Browser Extension</b><br/>(Detects Page)"] <-->|"WebSocket (127.0.0.1:57179)<br/><i>Origin Check / Auth</i>"| B["<b>Parousia Desktop</b><br/>(Core Hub)"]
    B -->|"IPC Socket / Pipe"| C["<b>Platform Adapters</b><br/>(Discord, etc.)"]

```

- **Browser Extension**: Observes tabs, executes matchers, and produces platform-agnostic `Activity`/`Presence` payloads (`browser/src/core/`).
- **Parousia Desktop**: Native Rust application serving as the local hub. Validates, bounds, and routes generic `Presence` updates to platform adapters.
- **Platform Adapters**: Translate generic `Presence` objects into native platform Rich Presence protocols (`desktop/src/adapters/`).
- **Activities**: Detection logic (URL matchers + page parsers). Supports native Activities and PreMiD ecosystem compatibility.

---

## 2. Activity System

Activities are compiled at build time from two external repositories, each pinned to a reviewed revision (`browser/activity-sources.json`); no remote code is loaded at runtime (MV3 compliant). A build refuses a checkout at any other revision; `main` advancing past a pin is reported, and the pin is advanced deliberately, by editing the file.

- **Native Activities** (`parousia-project/activities`): Read URLs/titles or use Parousia's built-in `collector.ts` to poll Media Session (`<video>`/`<audio>`) data without injecting script code into pages.
- **PreMiD Activities** (`PreMiD/Activities`): Compiled with Bun into content scripts that run on Parousia's PreMiD runtime (`src/premid/page.ts`); each is wrapped in one call that binds it to the parts of the API it uses. The runtime strips `chrome.storage` APIs (`withholdStorage`), bounds what it reports, and scrubs non-permitted fields (`limitPageData`). A content script shares the page's DOM, so review and the pins are what keep its code honest (`project/threat-model.md`). An Activity whose `regExp` can take long to fail is left out (`scripts/activities/redos.ts`), and its build reads nothing outside its own folder and PreMiD's helper package.
- **Switches**: An Activity that is off runs no code and gets nothing injected; what that covers, and what it doesn't, is in `project/threat-model.md` (Disabled Activities). When the background starts, it reads Settings, the switches, and the Default Activity in one call, applies them in that order, and only then refreshes.
- **Media presence**: With Settings > Privacy > Show media presence on (on by default), music or video playing in a tab that was shared stays shared while the tab being shared has no Activity of its own (`browser/src/core/media-presence.ts`, `PresenceRuntime`'s `media` hook, `background.ts`). The order is the tab's own Activity, then kept music or video, then the Default Activity. A tab counts when its Activity is on, presents as listening or watching or has an end time, and the browser says sound is playing in it. Of several, the one shared most recently wins. A tab being kept reads even while it isn't shown (the `background` message to its scripts), and the tabs kept are written to `storage.session`, so a song skipped in the background reaches Discord and the presence survives the MV3 background restarting. The popup shows what is shared and, beside it, the current site's own Activity (`UiActivity.kept`). Desktop sees an ordinary presence and needs nothing new.
- **Display fields**: An Activity can carry a type (playing, listening, watching, competing), the status line Discord shows, a party size, and links on its images; PreMiD Activities and native ones (`type`, `statusDisplayType`) set them, and Desktop's Discord adapter sends them.
- **Languages**: The popup and dashboard are translated into Amharic, Arabic, Catalan, Dutch, Estonian, German, Greek, Spanish (Spain and Latin America), Persian, French, Japanese, Korean, Latvian, Lithuanian, Polish, Portuguese (Brazil and Portugal), Romanian, Russian, Slovenian, Swedish, Swahili, Turkish, and Simplified Chinese (`browser/src/core/i18n.ts`, `browser/src/locales/`; the browsers' own `_locales` were weighed and not adopted, see `browser/README.md`, Languages). Every language is complete; Arabic and Persian have no right-to-left layout yet. Activities' own text is not translated, except PreMiD's descriptions, which come in the languages PreMiD's metadata has.
- **Site access**: A PreMiD Activity runs where its `regExp` matches, so the sites it asks access for come from the `regExp` too (`originsFor` in `scripts/activities/premid.ts`): `*://*.host/*` where it takes any subdomain, `www.` where it takes that, the host as named otherwise.
- **Pipeline & Matching**: Shared discovery (`websites/<letter>/<Name>/`), single manifest format (`manifest.ts`), unified settings framework, and deterministic ordering (`activities/catalog.json`).

---

## 3. Communication Protocol

- **Transport**: WebSocket server on `ws://127.0.0.1:57179/ws`. Max frame size: 16 KiB. Desktop reads each request head once and does the RFC 6455 upgrade itself (`desktop/src/link/http.rs`); tungstenite runs the WebSocket after that.
- **Authentication & Access Control**:
- **Chromium Extensions**: Verified via hardcoded Chrome Web Store ID or explicit `allowedOrigins`.
- **Firefox Extensions**: `moz-extension://<uuid>` verified against `allowedOrigins` (prompted on first run).
- **Userscripts**: Disabled by default. Checked via `Origin` verification.
- **Linux Security**: Asks the kernel who owns the client's end of each loopback connection (netlink socket diagnostics, a lookup of that one socket; `/proc/net/tcp` where netlink can't answer) to drop connections from other OS users.

- **Versions**: `hello` carries the client's release version and a protocol number, and `welcome` carries Desktop's release version. Only a different major version, or a different protocol number, stops the link (`unsupported_version`; the popup says "Versions don't match"). Minor, patch, and beta differences keep working: the wire only gains optional fields within a protocol, and a Presence ignores fields it doesn't know. The extension compares the numbers and, when one side is behind, shows a "newer version available" notice (with the download for Desktop, and a "Not now" that's remembered for that pair of versions) instead of blocking. Desktop and the extension version on their own, so "update Desktop" is only said when GitHub's latest release names a newer Desktop than the connected one (`browser/src/shared/latest-desktop.ts`: one unauthenticated request to `api.github.com`, cached for a day, made only when the notice would otherwise show). The release is named for the extension's version, and its notes carry Desktop's in a hidden `<!-- parousia-desktop: x.y.z -->` line. The protocol number is raised only when an older peer could no longer read the wire, which also means a new major release.
- **Lifecycle**: The browser disconnects 30 seconds after activity clears. Event pages stay alive via `runtime.getPlatformInfo()` every 20s during active sharing.
- **Pace**: Desktop closes a connection that sends more than 5 messages a second after a burst of 20, so the extension sends at most one Presence every 250 ms, the latest winning (`browser/src/core/desktop-connection.ts`). The first change after a quiet spell goes at once; within one Activity, Desktop forwards one change per 2 s anyway (`desktop/src/adapters/coalesce.rs`).

---

## 4. Platform Adapters

Adapters implement the `PlatformAdapter` Rust trait:

```rust
pub trait PlatformAdapter: Send + Sync {
    fn platform(&self) -> Platform;
    fn show(&self, activity: Option<Activity>);
    fn status(&self) -> AdapterStatus;
}

```

- **Discord Adapter**: Talks directly to local Discord IPC sockets/pipes (`discord-ipc-0..9`).
- **Coalescing**: The Hub wraps every adapter in `adapters/coalesce.rs`, so all platforms share it. Another Activity (or Discord Application), or clearing, goes through at once and discards anything waiting, so a platform never shows an Activity the Hub has moved on from. An update within the Activity already showing (same `id` and Discord Application) also goes through at once, unless the adapter was told something less than 2 seconds ago; then the newest such update waits for that time to end, and a newer one replaces it without moving the time. The first change after a calm spell is never delayed, a burst shows its first and its last, and a continuous stream is at most 2 seconds behind (a trailing debounce would starve it). One short-lived thread exists only while an update waits; there is no polling. It does not model any platform's rate limit.
- **Rate Limiting**: The Discord adapter also keeps to Discord's 5 requests per 20 seconds, sending only the latest once the window allows.
- **Validation**: Truncates text fields (2–127 chars), limits asset URLs (256 chars), and enforces button bounds.
- **Dynamic Applications**: Reconnects dynamically per-activity `discordClientId`.
- **Transports**: A Unix socket on Linux and macOS, an overlapped named pipe on Windows. Both are checked to belong to this OS user, and a reader notices Discord quitting at once.
- **Large image**: Without a large image Discord shows the Application's own icon, which for most Activities is Parousia's logo. So the runtime (`browser/src/core/site-image.ts`) makes sure every detected Activity has one Discord can show: its own (an `https` address within 256 characters, or an asset key), otherwise the website's logo (the Activity's `icon`), otherwise the tab's favicon (`https`, no query string, not `.ico` or `.svg`), and only then none, so Parousia's logo appears only where the site has no usable image. The Default Activity is a person's own choice and isn't given one.

---

## 5. Security Model

- **Zero-Trust Boundaries**: Content scripts and third-party PreMiD scripts are fully untrusted. Background pages reject unexpected origins and non-extension ports.
- **Granular Site Access**: Page-reading Activities require explicit runtime site permissions (`optional_host_permissions`). Users can toggle shared telemetry tiers (`media`, `thumbnails`, `creatorIcons`) in Settings.
- **Minimal Privileges**: No remote code execution. Dependencies are continuously audited via Dependabot, CodeQL, and `cargo audit`.

---

## 6. Compatibility & Alternative Routes

- **Discord-RPC-Extension**: Parousia's extension can communicate directly with `Discord-RPC-Extension` via `chrome.runtime.sendMessage` or its direct desktop fallback (`127.0.0.1:6969`), enabling Rich Presence without Parousia Desktop installed.
- **MAL-Sync**: MAL-Sync recognizes anime and manga pages and answers Discord-RPC-Extension's cross-extension presence requests. With it turned on (Settings > Platforms, off by default), Parousia sends the same request, with only a tab number, for the tab it shares (`browser/src/compat/malsync.ts`), parses the reply like a PreMiD Activity's, and offers it to the runtime as an external Activity that takes the page over (`RuntimeOptions.external`). From there it follows the usual path: Settings > Privacy limits, then Parousia Desktop, or Discord-RPC-Extension's app when Desktop isn't connected. Nothing is asked while it's off or there's no http(s) tab to share, and on a page MAL-Sync has nothing for it's asked three more times and then left alone. See `project/compatibility.md`.
- **Headless / No-Tray**: Desktop can operate entirely headless (`--headless`) or through CLI commands (`Parousia-Desktop status|set|allow|disallow`). Native OS trays exist for Linux (custom D-Bus SNI, on a session bus only if this user runs it) and Windows (Win32, with Start at login). A tray is told of a presence only when what it shows changes (an Activity's name, or whether there is one), so the next song doesn't wake the desktop shell. The CLI uses a socket in a private directory on Linux and macOS, with a lock beside it as the single-instance check, and on Windows a named pipe only this user can open, which is also its single-instance check.
