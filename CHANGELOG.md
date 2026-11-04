# VERSION 1

## V1.2.0 - IN DEVELOPMENT

This release carries the browser extension and userscript **1.2.0** and Parousia Desktop **1.0.2**. Versions are set in the manifests, `package.json`, and `desktop/Cargo.toml`; `scripts/release-check.mjs` checks they agree with the tag.

### ✨ New Features

- **Activity Versions:** Every Activity's page in the dashboard shows its version, taken from its own `metadata.json`: Parousia's native Activities and the bundled PreMiD ones alike. Only each Activity's manifest carries it, so the catalog the dashboard lists and searches doesn't grow.
- **Site Activity Beside the Default Activity:** While the Default Activity is shared, the popup still shows the tab's own Activity when its site has one. Turn it on there, or see why it can't run (access not granted, or nothing to share yet).
- **Show Media Presence:** A new switch in `Settings > Privacy`, off by default. With it on, music or video you were playing stays on your profile when you move to a site that has no Activity (or a browser page), until the sound stops, its tab closes, or its Activity is turned off. Only an Activity that presents as listening or watching, or that has an end time, counts, and only while the tab is making sound. An Activity on the tab you're looking at comes first, and the Default Activity only shows when no music or video is kept. With several players, the one you looked at last is shown. Private windows follow their own setting. Nothing is injected into the tab it comes from. A song skipped in a tab you left reaches Discord, the music stays when the extension's background restarts, and the popup still offers the current site's own Activity beside it, so you can turn it on or allow it without turning this off.
- **Plainer Wording:** Shorter, more direct text across the popup, dashboard, settings, and every translation. Terms are consistent: "Activity" for a site's integration, "presence" for what's shown on Discord. Parousia Desktop's port, pipe, and tray messages are shorter too (Desktop 1.0.2).

### 🛡️ Stability & Privacy

- **Discord Connection (Linux and macOS):** A Discord that stops reading its socket no longer holds Desktop's Discord connection forever. A write it doesn't take within 5 seconds ends the connection, and Desktop retries as it does after a Discord restart. Windows already did this. This is a Desktop change, so it ships in Parousia Desktop **1.0.2**. Update Desktop with the extension: with Show media presence on, the connection to Discord stays open for hours, so on Desktop 1.0.1 a Discord that stops listening is much easier to hit.
- **Switches Are Read Before Anything Runs:** When the extension started, an Activity ran on its default until its stored switch loaded, so one you had turned off could run once on the first tab. The extension now waits for the stored switches before any Activity is run or injected.
- **Paused Private Tabs Run Nothing:** With `Settings > Privacy > Private windows` on "Pause activity", no Activity runs for a private tab: its code isn't called and its page scripts aren't injected. Before, they ran and the result was dropped.
- **What a Switch Guarantees:** `project/threat-model.md` (Disabled Activities) lists exactly what stops when an Activity is off, and what doesn't.

## [V1.1.0](https://github.com/Abadima/RPC/releases/tag/v1.1.0) - V1 FIRST STABLE RELEASE

This release carries the browser extension and userscript **1.1.0** (the Firefox build is **1.1.0.1**) and Parousia Desktop **1.0.1**. It is the first stable release, with everything since the first public beta.

### ✨ New Features

- **MAL-Sync Support:** Enable under `Settings > Platforms`. Automatically detects recognized anime/manga tabs, requesting tab presence to display title, episode, cover, and progress in Discord via Parousia Desktop.

- **Multilingual UI:** Dashboard and popup now support English, German, French, Japanese, Romanian, Russian, Swedish, and Simplified Chinese (`Settings > General`). Set to **Automatic** by default to follow your browser.

- **PreMiD Translated Descriptions:** Activity descriptions now display in your chosen language if PreMiD provides a localized listing.

- **Expanded Activity Info:** PreMiD and native activities now send activity types (_Listening to, Watching, Competing in_), status lines, party sizes ("2 of 5"), and image links to Discord.

- **Version Update Notices:** Extension and Desktop minor/patch versions remain compatible. Update notices only appear when an update is actually needed. The extension checks GitHub's latest release at most once per day to determine whether a newer Desktop version is available. The request is unauthenticated, sends no user or page data, and failed checks show nothing. Both notices include a "Not now" option.

### ⚡ Performance & Usability Improvements

- **Smart Presence Throttling:** Rapid changes (e.g., scrubbing through videos) are rate-limited to update at most once every 2 seconds. Activity switching and clearing still happen instantly.

- **Improved Image Fallbacks:** When a site lacks a custom image, Parousia uses the site logo or tab favicon before defaulting to the Parousia logo. An image that isn't a real `https` address (such as a bare `https://`) counts as no image, so the fallback applies to it too.

- **YouTube Thumbnail Control:** Added a simplified "Show video thumbnail" toggle. When disabled, the YouTube logo is used instead.

- **Extended Site Matching:** PreMiD activities now cover subdomains automatically (e.g., Arch Linux activity now covers `wiki.archlinux.org` and `bbs.archlinux.org`).

- **Expanded Native Support:** Native activity support added for **Emby, HBO Max, iFixit, Netflix, U-NEXT, and YouTube**. Emby covers are hidden locally to protect privacy.

- **Dashboard Optimization:** Faster search indexing and dynamic UI adjustments on the dashboard.

### 🛡️ Security & Desktop Improvements

- **Linux Native Security:** Hardened Discord socket and D-Bus ownership checks against cross-user hijacking, added atomic single-instance locking, and hardened port ownership handling.

- **Output Sanitization:** Terminal control characters and raw markup are stripped from Desktop output, tray tooltips, and notifications.

- **WebSocket Hardening:** Desktop now validates the WebSocket upgrade itself before handing the connection to the WebSocket implementation, while rejecting malformed or ambiguous requests.

- **Desktop Optimization:** Reduced the Linux release binary by approximately 13%, reduced runtime memory usage, and improved presence message parsing performance by approximately 28%.

- **Browser Optimization:** Reduced browser bundle sizes and popup/dashboard memory usage through smaller wrappers, optimized assets, and reduced duplicated runtime data.

- **Windows First-Class Support:**
  - Fully functional CLI tools (`status`, `set`, `allow`, `disallow`, `debug`) via secure named pipes.
  - Instant detection of Discord starting or closing.
  - Added "Start at login" toggle in Tray Settings.
  - Multi-user safety checks prevent unauthorized connections and conflicting local instances.

### ⚠️ Changes & Deprecations

- **Firefox Add-ons:** Parousia is now on [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/parousia/). Desktop still asks you to allow a Firefox install once, since Firefox gives every install its own identity. The Chrome Web Store listing is in review; until it is up, the Chromium extension loads from `parousia-chromium.zip`.

- **Separate Versions:** Parousia Desktop and the extension now have their own version numbers (Desktop **1.0.1**, extension and userscript **1.1.0**). A release is named for the extension's, which Chromium's manifest, `package.json`, and the userscript carry, and its notes name the Desktop it contains. Firefox's build is **1.1.0.1**: Mozilla takes each version only once and already has a 1.1.0 from before the update-notice change, so this one goes out as a revision of it. It is the same release as 1.1.0 everywhere else.

- **Cross-Version Compatibility:** Extension and Desktop remain connected across different minor/patch/beta versions; only major version differences force a disconnection.

- **Removed Activities:** _VLC_, _TLX Toki_, and _Weverse_ PreMiD activities were removed due to extension safety compliance (`innerHTML` restrictions).

## [V1.0.0-beta.1](https://github.com/Abadima/RPC/releases/tag/v1.0.0-beta.1) - V1 FIRST PUBLIC BETA

### ✨ New Features

- **Parousia Desktop Client:** Lightweight, native application for Windows (x86_64, ARM64) and Linux (x86_64, ARM64) that connects browser activity directly to Discord's local RPC.

- **Browser Extension & Userscript Support:** Available for Chromium browsers, Firefox, and userscript managers (Violentmonkey, Tampermonkey, ScriptCat) via local WebSocket connections (`127.0.0.1:57179`).

- **Comprehensive Activity Library:** Supports both native activities and over 1,400 PreMiD activities running natively without requiring third-party servers.

- **Granular Privacy & Site Controls:**
  - Site reading permissions are opt-in per site with optional global access.
  - Specific page metadata toggles under `Settings > Privacy`.
  - Page URLs are processed locally and are never sent to Parousia servers.

- **Customizable Default Activity:** Set a custom presence to display whenever no specific activity is detected.

- **Dashboard & Popup Management:** Searchable activity hub with theme choices (Atelier, Botanique, Monolith) meeting WCAG 2.2 AA accessibility standards.

- **Discord-RPC-Extension Integration:** Works directly with Discord-RPC-Extension when Parousia Desktop is offline.

- **Strict Extension Security:** Desktop restricts WebSocket connections exclusively to recognized Parousia builds and requires manual approval for userscripts or external sources.

### ⚡ Performance & Usability Improvements

- **Resource Efficient:** Parousia Desktop idles at approximately 3 MB RAM, and extensions automatically disconnect WebSocket sessions after 30 seconds of inactivity.

- **Expanded Native Support:** Dedicated native presence integration for **Claude, Google Play, LA Times, NY Times, and YouTube Music**, with optional chat/article title hiding for privacy.

- **Universal Media Session Reader:** Automatically reads playback details (track, artist, album, artwork) from browser Media Sessions for native activities like YouTube Music.

- **Automatic Stale Activity Cleanup:** Drops inactive PreMiD activities automatically after 30 seconds (or 6 seconds post-navigation) to prevent frozen statuses.

- **Dynamic Permission Updates:** Toggling activities or site permissions updates open tabs immediately without requiring a page reload.

- **Background Playback Preservation:** Keeps active presences alive during background playback or media streaming past idle timeouts without being cleared by popup interactions.

- **Local PreMiD Assets:** PreMiD image requests are handled locally by the extension rather than routing through PreMiD's image servers.

### ⚠️ Changes & Deprecations

- **Architecture Overhaul:** Replaces the legacy Node.js Discord RPC bot (archived on the `v1.0` branch).

- **License Change:** Project re-licensed under the **Apache License 2.0** (formerly MIT).

- **Browser & Store Availability:** Supported on Chrome Web Store and AMO (Firefox). **Safari and Edge Add-ons Store are not supported.**
