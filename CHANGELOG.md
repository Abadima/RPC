# VERSION 1

## [V1.0.0-beta.1](https://github.com/Abadima/RPC/releases/tag/v1.0.0-beta.1) - V1 FIRST PUBLIC BETA

### ✅ Additions

- **Parousia Desktop**, a small native app for Windows (x86_64, ARM64) and Linux (x86_64, ARM64). It shows what you're doing in the browser on Discord through Discord's local RPC, with no async runtime, no output until you turn debug logging on, and nothing running while there's nothing to show. The Linux builds are static (musl); the Windows builds need only Windows' own DLLs.
- **Browser extensions** for Chromium (Chrome, Edge, and other Chromium browsers) and Firefox, plus a **userscript** for Violentmonkey, Tampermonkey, and ScriptCat. All of them send your current Activity to Parousia Desktop over one loopback WebSocket (`127.0.0.1:57179`), only while something needs it.
- **Activities**, one per website, each deciding what to show for the page you have open. Native Activities come from [parousia-project/activities](https://github.com/parousia-project/activities), starting with Jena Hub. PreMiD's Activities (about 1,400) run unchanged on Parousia's own implementation of PreMiD's `Presence` and `iFrame` API, each as its own Discord Application. A website that both sources cover is listed once, and the native one runs until you pick PreMiD's.
- **Site access you control.** An Activity that reads pages is off until you turn it on, which asks your browser for its sites in the same click. "Access your data for all websites" is off by default and only requested by its own switch. What Activities may read from pages (what's playing, thumbnails, creator icons) is one choice in Settings > Privacy.
- **Default Activity**, a presence you write yourself, shared wherever no Activity is detected.
- **Dashboard and popup** with paged, searchable Activities (enabled first, filters, enable or disable all), a page per Activity, three themes (Atelier, Botanique, Monolith) checked against WCAG 2.2 AA, and a layout that works from 360 to 2560 pixels wide.
- **Discord-RPC-Extension support**: its app is used directly while Parousia Desktop isn't connected.
- **Recognized builds only.** Desktop accepts connections only from Parousia's own extension builds (exact `chrome-extension://` and `moz-extension://` origins) and lists anything else for you to allow or refuse. Userscripts are off until you allow them.
- **Release builds** with `SHA256SUMS` and a build provenance attestation for every file, from the tag workflow (`v*`), plus a pre-release of `main` (`dev-<commit>`) on each push that changes what ships.

### ⭐ Improvements

- The extension asks for `tabs` and `storage` only. Everything else (`scripting` and site access) is optional and asked for when you turn an Activity on.
- A page's address never leaves your browser: Parousia Desktop receives the name, details, state, images, buttons, and timestamps an Activity produced, not the URL.
- The extension only connects while an Activity is being reported or the popup or dashboard is open, and lets go 30 seconds later.
- Parousia Desktop idles at about 3 MB with no wakeups, and its release binary is about 1 MB.
- Activity sources follow each repository's `main` branch at build time, record the revision they used in the build, and keep the last good copy when a fetch fails.
- PreMiD Activities no longer call PreMiD's image service: Parousia answers those requests inside the extension, so nothing is sent to PreMiD.
- Native Activities for Claude, Google Play, the Los Angeles Times, The New York Times, and YouTube Music. Claude's chat titles and news headlines stay off your profile unless you turn them on.
- What's playing comes from the page's Media Session (title, artist, album, artwork, and whether it's playing) through one shared reader, for any native Activity that asks for it. It runs only in a tab where one does, and a song playing through sends nothing until it's paused or seeked. YouTube Music uses it first, and falls back to the address and tab title where a page sets no session. PreMiD's YouTube Music still works, but reads the player bar's markup, which YouTube changes.
- A PreMiD Activity that stops updating while its page is shown no longer leaves its last status up: after 30 seconds (6 after the page's address changes) it's dropped, so "Browsing home" doesn't sit under a song that's playing.
- An Activity you turn off and on again, or whose site you take back and allow again, works in tabs that were already open instead of staying dead until a reload.
- Away from the browser, presence keeps following the active tab, and sound playing in it keeps it shared past the Idle Timeout. Looking at Discord or opening the popup no longer clears your music.
- Desktop's release includes `parousia-desktop-notices.txt`, the licenses of the crates inside it.

### 🔀 Changes

- Parousia replaces the Node.js Discord RPC bot this repository used to hold. That bot's last state is on the `v1.0` branch.
- The project is licensed under the Apache License 2.0 (it was MIT).
- Safari is not supported.
- Stores: the Chrome Web Store and AMO. There is no Edge Add-ons listing.
