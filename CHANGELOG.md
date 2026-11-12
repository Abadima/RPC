# VERSION 1

## V1.3.0 - IN DEVELOPMENT

This release carries the browser extension and userscript **1.3.0** and Parousia Desktop **1.0.3**.

### ✨ New Features

- **More Languages:** The popup and dashboard are now available in 24 languages: **Amharic**, **Arabic**, **Catalan**, **Dutch**, **Estonian**, **Greek**, **Korean**, **Latvian**, **Lithuanian**, **Persian**, **Polish**, **Slovenian**, **Swahili**, and **Turkish**, plus **Spanish** (Spain and Latin America) and **Portuguese** (Brazil and Portugal), alongside German, French, Japanese, Romanian, Russian, Swedish, and Simplified Chinese. Every language is complete and has been revised for accuracy and consistency. The Polish translation is by [t07bon](https://github.com/t07bon). **Automatic** follows your browser's language and region: a Brazilian browser gets Brazilian Portuguese, and a Latin American one gets Latin American Spanish. Activity descriptions PreMiD has translated show in your language too.
- **Store Listing Text in 25 Languages:** The summary and description for the Chrome Web Store and Firefox Add-ons are written for every language the extension has, in `browser/store/`, with the steps to enter them in each dashboard. The Chromium package now carries the translated summary (5.5 KB), which the Web Store needs before it offers a language for the listing. The listings themselves change only when they are entered in the dashboards.
- **Right-to-Left Layout (Known Limitation):** Arabic and Persian are translated, but the layout isn't mirrored for right-to-left reading yet.

### 🛡️ Stability & Privacy

- **Your Settings Load First:** When the extension started, it could share a presence once with the default settings before yours had loaded, including media details or page data you had turned off. It now reads your settings before anything is shared.
- **Presence Stays Up on Busy Pages:** A page that changes constantly (a ticking title, for example) could make Desktop close the connection and drop your presence for about 10 seconds at a time. The extension now paces its updates to stay within Desktop's limits.
- **The Userscript Follows Page Titles:** On sites whose Activity reads the tab title, such as GAM.ONL and Fluxer, the userscript now picks up the title once the page has loaded and follows it as it changes.
- **Safer Activity Builds:** Activities are built only from reviewed, pinned revisions of their sources, and an Activity's build can't read files outside its own folder. PreMiD Activities whose URL patterns could stall on a crafted address are refused; none of today's are affected.
- **Tighter Page Access:** A PreMiD Activity's requests for page data can't be used to run text as code in the page, and a page script that floods the extension with messages has the excess dropped.
- **Sturdier Desktop (Desktop 1.0.3):** Desktop keeps serving if the system refuses to start a thread for one connection, and text a page chooses (such as an Activity's name) can no longer break lines or slip invisible direction marks into Desktop's terminal output, tray, and notifications.
- **Dashboard Fixes:** The elapsed-time clock stops when you leave a dashboard page, the Activities page draws at its final size straight away, and the filter count uses your language's number format.

### ⚡ Performance

- **Lighter Extension:** A smaller download and background, less work on image-heavy pages, fewer repeated reads of Activity data in the dashboard, and less work when many tab events arrive at once.
- **Lighter Desktop (Desktop 1.0.3):** On Linux, Desktop checks which user a connection belongs to much faster, and the download is smaller. The tray on Linux and Windows no longer updates for every new song or video within the same Activity, and Desktop does less work for each update it sends to Discord.

## [V1.2.0](https://github.com/Abadima/RPC/releases/tag/v1.2.0) - RELEASED

This release carries the browser extension and userscript **1.2.0** and Parousia Desktop **1.0.2**.

### ✨ New Features

- **Activity Versions:** Every Activity's page in the dashboard shows its version.
- **Site Activity Beside the Default Activity:** While the Default Activity is shared, the popup still shows the tab's own Activity when its site has one, so you can turn it on there or see why it can't run.
- **Show Media Presence:** A new switch in `Settings > Privacy`, on by default. With it on, music or video you were playing stays on your profile when you move to a site without an Activity, until the sound stops, its tab closes, or its Activity is turned off. An Activity on the current tab comes first; with several players, the one you looked at last is shown; private windows follow their own setting.
- **Plainer Wording:** Shorter, more direct text across the popup, dashboard, settings, every translation, and Desktop's messages, with consistent terms: "Activity" for a site's integration, "presence" for what Discord shows.

### 🛡️ Stability & Privacy

- **Discord Connection (Linux and macOS, Desktop 1.0.2):** A Discord that stops reading its socket no longer holds Desktop's connection forever: after 5 seconds Desktop reconnects, as it already did on Windows. Update Desktop with the extension if you use Show media presence, which keeps that connection open for hours.
- **Switches Are Read Before Anything Runs:** An Activity you had turned off could run once on the first tab after the extension started. The extension now waits for your switches before running or injecting anything.
- **Paused Private Tabs Run Nothing:** With `Settings > Privacy > Private windows` on "Pause activity", no Activity runs in a private tab at all, and scripts already running there stop when you change the setting.

## [V1.1.0](https://github.com/Abadima/RPC/releases/tag/v1.1.0) - V1 FIRST STABLE RELEASE

This release carries the browser extension and userscript **1.1.0** (the Firefox build is **1.1.0.1**) and Parousia Desktop **1.0.1**. It is the first stable release, with everything since the first public beta.

### ✨ New Features

- **MAL-Sync Support:** Enable under `Settings > Platforms`. Automatically detects recognized anime/manga tabs, requesting tab presence to display title, episode, cover, and progress in Discord via Parousia Desktop.

- **Multilingual UI:** Dashboard and popup now support English, German, French, Japanese, Romanian, Russian, Swedish, and Simplified Chinese (`Settings > General`). Set to **Automatic** by default to follow your browser.

- **PreMiD Translated Descriptions:** Activity descriptions now display in your chosen language if PreMiD provides a localized listing.

- **Expanded Activity Info:** PreMiD and native activities now send activity types (_Listening to, Watching, Competing in_), status lines, party sizes ("2 of 5"), and image links to Discord.

- **Version Update Notices:** Extension and Desktop minor and patch versions stay compatible, and a notice appears only when an update is actually needed, with a "Not now" option. To tell whether a newer Desktop exists, the extension checks GitHub's latest release at most once a day, unauthenticated and without any user or page data.

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

- **Desktop Optimization:** A smaller Linux release binary, lower memory use, and faster presence parsing.

- **Browser Optimization:** Reduced browser bundle sizes and popup/dashboard memory usage through smaller wrappers, optimized assets, and reduced duplicated runtime data.

- **Windows First-Class Support:**
  - Fully functional CLI tools (`status`, `set`, `allow`, `disallow`, `debug`) via secure named pipes.
  - Instant detection of Discord starting or closing.
  - Added "Start at login" toggle in Tray Settings.
  - Multi-user safety checks prevent unauthorized connections and conflicting local instances.

### ⚠️ Changes & Deprecations

- **Firefox Add-ons:** Parousia is now on [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/parousia/). Desktop still asks you to allow a Firefox install once, since Firefox gives every install its own identity. The Chrome Web Store listing is in review; until it is up, the Chromium extension loads from `parousia-chromium.zip`.

- **Separate Versions:** Parousia Desktop and the extension now have their own version numbers (Desktop **1.0.1**, extension and userscript **1.1.0**). A release is named for the extension's version, and its notes name the Desktop it contains. Firefox's build is **1.1.0.1**, the same release under the revision number Mozilla required.

- **Cross-Version Compatibility:** Extension and Desktop remain connected across different minor/patch/beta versions; only major version differences force a disconnection.

- **Removed Activities:** _VLC_, _TLX Toki_, and _Weverse_ PreMiD activities were removed due to extension safety compliance (`innerHTML` restrictions).

## [V1.0.0-beta.1](https://github.com/Abadima/RPC/releases/tag/v1.0.0-beta.1) - V1 FIRST PUBLIC BETA

### ✨ New Features

- **Parousia Desktop Client:** Lightweight, native application for Windows (x86_64, ARM64) and Linux (x86_64, ARM64) that connects browser activity directly to Discord's local RPC.

- **Browser Extension & Userscript Support:** Available for Chromium browsers, Firefox, and userscript managers (Violentmonkey, Tampermonkey, ScriptCat) via local WebSocket connections (`127.0.0.1:57179`).

- **Activity Library:** Supports both native activities and over 1,400 PreMiD activities running natively without requiring third-party servers.

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
