# Parousia Roadmap

This roadmap tracks milestones, not individual tasks. See `project/architecture.md` for how the pieces fit together and `project/vision.md` for why they exist.

## How to Read This

Parousia only works end to end when every link in this chain works:

**Browser ↔ Desktop → Platform adapter (Discord) → Activities → end-to-end Rich Presence**

- **Complete** phases are done and stay listed so the record is accurate.
- **Active** phases (at most two) are what gets worked on now. Each has an exit check that says when it's done.
- **Later** work is listed in dependency order but has no phase number yet. It gets one when it becomes active, so the numbered list never runs far ahead of the code.

## Status

| Link in the chain             | State                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser extension             | Builds for Chromium, Firefox, and a userscript, all publishing to Desktop. Includes every native Activity and 1,410 of PreMiD's.                            |
| Browser ↔ Desktop             | Works: one loopback WebSocket (protocol v6), recognized builds only, no extra extension permission; a page's address never leaves the browser.              |
| Desktop → Discord             | Works through Discord's local RPC. Checked against a real Discord on Linux; the Windows and macOS paths are only compile-checked.                           |
| Activities                    | One pipeline for native and PreMiD Activities, a website in both listed once; turning one on asks for its sites; a Default Activity where none is detected. |
| Discord-RPC-Extension backend | Its app is used directly while Parousia Desktop isn't connected, on by default. Its extension's protocol is wired but inert until a client id is chosen.    |

---

## Phase 1: Foundation (complete)

- [x] Core architecture, security model, Activity system, and platform adapter design (`project/architecture.md`)
- [x] Browser ↔ Desktop protocol design (fixed-port local WebSocket, origin check plus pairing credential; simplified to the origin check alone in Phase 3)
- [x] Compatibility layer design (PreMiD Activities, Discord-RPC-Extension), verified against both projects' sources
- [x] Testing, build, lint, formatting, and security checks in CI (browser, desktop, CodeQL, dependency review, Dependabot; the website has its own in its repository)
- [x] Website scaffold (Astro + Svelte 5) with a GitHub Pages deploy workflow (since moved to its own repository, see Website and Documentation)

## Phase 2: Browser and Desktop Building Blocks (complete)

Each side works and is tested on its own. Nothing here connects them.

**Browser** (`browser/`)

- [x] Chromium (Chrome and Edge) and Firefox MV3 builds plus a userscript, from one codebase
- [x] Activity registry, Presence runtime, and a lifecycle controller that only publishes changes and sends an explicit "nothing" on tab close, blur, or unmatched navigation
- [x] Minimal permissions: `tabs` and `storage` only, no host permissions or content scripts
- [x] WebSocket transport to Desktop, connecting on demand, keeping only the latest Presence while disconnected
- [x] Discord-RPC-Extension compatibility (cross-extension messaging, Chromium and Firefox), inert until a Discord Application id exists
- [x] Popup and fullscreen presence views, sharing one renderer (`browser/src/shared/presence-view.ts`)
- [x] Real-Firefox load check (`firefox:verify`) and a bundled-output test for the Chromium service worker

**Desktop** (`desktop/`)

- [x] Single `127.0.0.1:57179` server for HTTP (`GET /health`) and WebSocket, without an async runtime
- [x] Exact origin allowlist, persisted in the platform data directory
- [x] `hello`/`welcome`/`reject` handshake, protocol versioning, and size-bounded Presence validation

---

## Phase 3: Browser ↔ Desktop Link (complete)

A real extension build connects to a real Desktop build and streams Presence to it over a loopback WebSocket. Desktop only accepts Parousia builds it recognizes. See `project/architecture.md` (Communication Protocol, Settings and Status Without a Tray, Desktop Tray) and `project/threat-model.md`.

- [x] One transport for every client and OS: a `127.0.0.1` WebSocket, protocol v4. Pairing credentials and a Native Messaging channel were both built, measured, and dropped (`project/architecture.md`, Why only a WebSocket), so the extension needs no permission beyond `tabs` and `storage`
- [x] Recognized builds only: exact `chrome-extension://` and `moz-extension://` origins from the built-in store list or `allowedOrigins`; unrecognized extensions refused with `origin_not_allowed`, listed, and allowable in one step; web origins get a bare 403
- [x] Userscripts opt-in (off by default); a userscript can only publish Presence, never read status or change settings
- [x] WebSocket defenses: strict schemas, 16 KiB frames, 5-second handshake and request timeouts, connection and per-connection message rate limits, 64-connection cap, clean close so a `reject` survives unread input, and on Linux other OS users' connections dropped by uid
- [x] Desktop keeps the latest Presence per connection and drops it when that connection closes; disallowing an origin or turning userscripts off closes affected connections at once
- [x] MV3 background lifetime: connect only while an Activity is reported or a UI is open, let go 30 seconds later, keep the background alive with `runtime.getPlatformInfo()` every 20 s only while an Activity is shared (measured on Firefox 150 and Chromium 152, where WebSocket traffic alone doesn't hold Firefox), retries on in-memory timers and none while idle (no `alarms` permission)
- [x] Status and settings without a tray: the extension dashboard's Desktop panel, popup guidance, CLI (`status`, `set`, `allow`, `disallow`), console, and notifications (including on a second launch); verified on a session bus with no tray host
- [x] Linux tray, optional: hand-written D-Bus StatusNotifierItem and menu (status, browsers, diagnostics with "Allow" for refused builds, settings toggles, Quit); verified on KDE Plasma
- [x] Single-instance check and CLI control over a user-private IPC socket
- [x] Explicit extension Content Security Policy (Firefox's MV3 default silently turns `ws://` into `wss://`)
- [x] Threat model (`project/threat-model.md`)
- [x] Exit check: `bun run desktop:verify` (Playwright Chromium, also in CI: Desktop absent then started, refused then allowed, two browsers, disallowing, userscripts, hostile input, second launch, Desktop stopping, idle let-go) and `bun run real:verify` (Firefox Developer Edition 150, Flatpak Ungoogled Chromium 152, the userscript in Violentmonkey 2.49, three clients at once, allowing from the tray, settings from the dashboard)

---

## Phase 4: Discord Adapter (complete)

A Presence that reaches Desktop shows up in the real Discord client. See `project/architecture.md` (Platform Adapter Architecture) and `project/threat-model.md` (Desktop ↔ Discord).

- [x] Client id: Parousia's own Discord Application built in, and `discordClientId` in Desktop's `config.json` to replace it (public, not a secret)
- [x] `PlatformAdapter` trait; Desktop routes each platform the Activity that changed most recently, among the connections that allow that platform, and the next still-current one when it ends
- [x] Discord local IPC client with no new dependency: socket discovery (`$XDG_RUNTIME_DIR`, `$TMPDIR`, `$TMP`, `$TEMP`, `/tmp`, each with Discord's Flatpak and Snap directories; named pipes on Windows), only sockets this OS user owns, framing, handshake, `SET_ACTIVITY`, clearing, pings
- [x] Discord not running, starting late, or restarting: tries again after 1 second, doubling to 30, and right away when the Activity changes; no tries while there's nothing to show. A restart is noticed at once on Linux and macOS, and at the next update on Windows
- [x] Coalescing under Discord's limit of 5 activity updates per 20 seconds: only the latest is sent when the window allows
- [x] Presence → Discord mapping with the same rules on both sides (`desktop/src/discord/activity.rs`, `browser/src/compat/discord-rpc-extension.ts`), both tested against `adapters/discord/activity-mapping.json`; the text limits (2 to 128 characters) confirmed against a real Discord
- [x] Settings > Platforms reaches Desktop: every Presence says which platforms it may be shown on (protocol v5)
- [x] Tests against a fake Discord: the adapter over a real Unix socket (Rust), and `desktop:verify` end to end
- [x] Exit check: `discord:verify` (opt-in): the real extension build on the real jena.systems shows up in a real Discord through Desktop, and clears when the browser disconnects (Flatpak Discord on Linux)

## Phase 5: First Activity, End to End (complete)

A site Parousia detects shows up in Discord, with nothing hand-written in between.

- [x] One Activity registry definition shared by the background script, popup, dashboard, and userscript (`browser/src/core/activities.ts`), with catalog entries for the dashboard's searchable, paged Activities page
- [x] First native Activity: **Jena Hub** (`jena.systems`; since Phase 6 in parousia-project/activities, `websites/J/Jena/`). It needs no host access: the page's URL and title, which `tabs` already exposes, say which game is open ("Chess - Jena V3")
- [x] Decided how Activities read page state beyond the URL and title: optional host access for the Activity's own sites plus `scripting`, granted when someone turns that Activity on. Built with the first Activity that needs it (see Later)
- [x] `Activity` extended for what Discord supports and Activities need: buttons, links for the details and state lines, and a per-Activity Discord Application, on the wire (protocol v5) and in Desktop
- [x] MV3 lifetime with a real Activity: `real:verify` holds Jena Hub for 3 minutes (`HOLD_MINUTES`) in Firefox 150 and Chromium 152 with no extension page open and no tab events; both backgrounds keep sharing
- [x] Exit check: a detected Activity is visible in Discord (`discord:verify`)

---

## Phase 6: Activity Ecosystem (complete)

Activities live outside this repository, native and PreMiD's go through one pipeline, and reading a page is always something the user granted. See `project/architecture.md` (Activity System Architecture) and `project/threat-model.md` (Activities That Read Pages).

- [x] Native Activities in their own repository, [parousia-project/activities](https://github.com/parousia-project/activities), filed as `websites/<letter>/<Name>/` like PreMiD's; Jena Hub moved there, and this repository keeps only the Activity API and runtime
- [x] Both sources followed at their `main` branch (`browser/activity-sources.json`), fetched by `activities:fetch` (which keeps a working copy when a fetch fails and records the revision used), included at build time, never downloaded at runtime
- [x] One pipeline for both: the same discovery, one manifest (catalog entry, matcher, settings, page data, sites), one catalog, one matcher compiler, one settings model, one site-access model, and one host running what each needs in pages; PreMiD-specific code only where its API differs
- [x] PreMiD Activities shim: PreMiD's `Presence`/`iFrame`/`Slideshow` API over Parousia's runtime, each Activity compiled unchanged from its sources, with every client id its source names kept (the first is its default), its settings mapped, and page reads (`getPageVariable`, declarative `execInPage`) answered from the page's own world by a fixed function
- [x] Page data for Activities that need it: declared kinds (what's playing, thumbnails, creator icons), each switchable per Activity; native Activities get only their granted kinds from Parousia's own collector (Media Session, media elements, `og:image`), PreMiD's have switched-off kinds held back
- [x] Site access, always explicit: optional host access plus `scripting`, one site at a time ("Access your data for example.com"), or for all websites through its own switch, off by default and never requested automatically; taken back access stops what runs there at once, and Activities without it fall back to URLs and titles (native) or their name (PreMiD)
- [x] Dashboard: a switch on each Activity's card, icons with a letter fallback, a responsive grid from phone to ultrawide, a page per Activity (on/off, site access, page data, settings), and Settings > Site access
- [x] Activity format, validation, and testing tooling: `metadata.json` schema, `tools/validate.ts`, `tools/testing.ts` (`checkActivity`, `page`, `matches`), and CI in the activities repository; `activities:check` here (both sources, left-out PreMiD Activities with reasons, native type-check against `browser/src/core/api.ts`)
- [x] Security requirements: the rules every native Activity follows, and this side's defenses for page scripts (sender checks, bounded messages, storage and UI port out of their reach)
- [x] Activity development documentation (the activities repository's README and `.github/CONTRIBUTING.md`)
- [x] Exit check: `activities:verify` (real PreMiD and native Activities reading pages, degrading without access, page data switched off, and the dashboard, in Chromium through Desktop), `desktop:verify` with Jena Hub from the activities repository

---

## Phase 7: Activity Permissions, Default Activity, and Audit (complete)

Site access comes with turning an Activity on, the popup says what's going on with the tab, a website both sources have runs once, and the whole system was audited and measured. See `project/architecture.md` (Page Data and Site Access, Default Activity, One Pipeline) and `project/threat-model.md` (Activities That Read Pages).

- [x] Site access asked for when an Activity is turned on, from the same click: declined, it stays off and says why; taken back, it's unavailable there (nothing runs, nothing is shown) and offers to ask again. No per-site switches on Activity pages; Settings > Site access has only the "all websites" switch (individual sites are the browser's to grant and revoke), off by default
- [x] What Activities may read (what's playing, thumbnails, creator icons) is one choice for all of them, in Settings > Privacy
- [x] An Activity that reads pages is off until turned on, native or PreMiD's; one that reads only URLs and titles is on until turned off
- [x] Popup: "Current activity" only while something is shared, with "Configure activity" for an Activity with settings (the same settings code as the dashboard); an Activity for the tab that's off or missing access shown with one button to fix it; one quiet line otherwise
- [x] Default Activity: its own dashboard tab, a presence written by hand and shared where no Activity is, through the same runtime, privacy settings, and platforms as any Activity
- [x] PreMiD alignment: both sources' adapters map onto one draft, and one module decides limits, settings rules, sites, and search words; a website in both sources (the same folder name) is listed once, and only the implementation chosen runs (native until PreMiD's is picked)
- [x] Leaner packaged files: the dashboard's catalog without settings, page data, or Discord Applications (898 KB to 612 KB), a manifest per Activity, and a host index for the popup
- [x] Protocol v6: a Presence no longer carries the page's address, and the extension sends Desktop only the fields it takes
- [x] Security audit with fixes and regression tests: storage out of reach of PreMiD's code in Firefox; no prototype paths or code-running functions in page reads; a name an Activity read from the page withheld with media; the focused window's tab shared, not one in another window; an `https`-only grant no longer counted as "all websites"
- [x] Faster to show: a PreMiD Activity's first update at once instead of after a second, and a page's first report without waiting out the 200 ms throttle
- [x] `bun run bench`: sizes, Desktop's and the extension's memory, CPU, and wakeups idle and busy, and latency, before and after
- [x] Activities page: enabled Activities first, then disabled, each by name; a Filter button (Enabled, Disabled, Parousia Activities, PreMiD Activities) whose choices combine and stay in the address; "Enable or disable all…", quiet until asked for, applying to what the search and filters match, asking a second time, and warning that enabling asks the browser for many sites in one prompt (a decline leaves those off, nothing is marked on for a site the browser didn't grant)
- [x] One website across sources is decided by the folder name with punctuation and spacing ignored (never the display name or shared sites); Parousia's implementation runs unless PreMiD's is picked, and never both
- [x] Overview mentions Discord-RPC-Extension's app only until Parousia Desktop is connected; its status stays in Settings > Platforms
- [x] Exit check: `activities:verify` in playwright-core's Chromium and in the Flatpak Ungoogled Chromium (`ACTIVITIES_BROWSER=flatpak`), `activities:firefox` in Firefox Developer Edition 150, `desktop:verify`, and `real:verify`

---

## Later

In dependency order. Each section becomes a numbered phase when it's picked up. No phase is active right now: Phase 8 is whichever is picked up next.

### Activity Ecosystem, Next

Each needs something from a later section, or from outside Parousia.

- [x] The activities repository's first Activity (Jena Hub) is on `main`, which builds follow, so CI and releases include it
- [x] Media Session as one shared capability: the page-data collector reads title, artist, album, artwork, and the page's own playing state for any native Activity that declares `media` and `thumbnails`, only in tabs where one runs, and hands over ready-made `start` and `end` timestamps that hold still while a song plays through. YouTube Music is the first native Activity on it, with the URL and tab title as its fallback. PreMiD's YouTube Music stays selectable; it reads the player bar's markup and stops when YouTube changes that
- [x] Activity lifecycle fixes found testing YouTube Music in Firefox and Chromium: an Activity that goes silent has its stale report dropped; a stopped Activity runs again when turned back on instead of staying dead until a reload; away from the browser, presence keeps following the tab and stays while sound plays
- [ ] PreMiD Activities left out for needing npm packages that have no native replacement yet: Netflix, HBO Max, U-NEXT, Emby, iFixit (Claude now has a native Activity). They read the page itself, which a native Activity can't; a native one needs the media page data to be enough for each site
- [ ] Carry what PreMiD Activities set that Parousia's Activity can't yet: activity type (Listening, Watching), `statusDisplayType`, party size, and links on images (a protocol change to Desktop)
- [ ] PreMiD's strings in languages other than English, with the extension's own languages (PreMiD serves its translations from its API)
- [ ] Images PreMiD Activities hand over as Blobs, which need an image host (see Presence Without Desktop)
- [ ] PreMiD Activities that need their own npm packages (7 when last checked), once there's a reviewed way to include those packages
- [ ] PreMiD's Activity API version 2, once PreMiD ships Activities for it
- [ ] Answering the site-access prompt by hand in installed Firefox and Chromium (`activities:firefox` and `ACTIVITIES_BROWSER=flatpak activities:verify` run PreMiD Activities there with their sites granted in the manifest)

### Desktop App

- [x] Windows tray: a notification-area icon with the Linux tray's menu and balloon notifications for blocked extensions (`desktop/src/wintray.rs`)
- [ ] Windows: CLI control over a named pipe restricted to the user, and refusing other OS users' loopback connections (`GetExtendedTcpTable` plus the owning process's token)
- [ ] Windows Discord: notice Discord quitting at once (overlapped pipe I/O) and refuse a `discord-ipc` pipe another OS user created; run `discord:verify` there
- [ ] macOS: tray, refusing other OS users' loopback connections (`libproc`), and checking the IPC socket (written, untested)
- [ ] Start at login, and extension installation help (including allowing a Firefox install in one step)
- [x] Silent by default: no output or event history until debug logging is turned on for the run (`--debug`, tray, `Parousia-Desktop debug on`)
- [x] Idle resource review (`bun run bench`: 3.1 MB and no wakeups idle, none with three clients connected)
- [ ] A full security review of native system interaction: the IPC socket, the D-Bus tray, Discord's socket (Phase 7 checked how their input is bounded)

### Compatibility

- [x] Discord through Discord-RPC-Extension's app (`discord_rpc_ext`, port 6969) directly, without Parousia Desktop, locked down to Rich Presence; on by default, switchable in Settings > Platforms
- [ ] Activate the Discord-RPC-Extension backend by choosing its client id, and revisit Firefox's `data_collection_permissions` when it does
- [ ] MAL-Sync: its detection stays in MAL-Sync, and Parousia duplicates none of it. If it's practical, MAL-Sync's presence reaches Parousia Desktop over the existing transport. MAL-Sync doesn't push presence: it registers with Discord-RPC-Extension's id and answers that extension's requests with `{clientId, presence}` under its own Discord Applications (checked against its source, not yet against a running MAL-Sync). So the route to try reuses the messaging Parousia already speaks to Discord-RPC-Extension: ask MAL-Sync for the active tab's presence, translate the Discord payload into a Presence, publish it like any Activity's. If that turns out impractical or invasive (changes to MAL-Sync, a broader permission, or another way into Desktop), drop it: MAL-Sync keeps its own Discord presence, shown beside Parousia's
- [ ] PWA ↔ extension bridge, if wanted (Chromium only; Firefox doesn't support `externally_connectable`)
- [ ] Receive presence from Discord-RPC-Extension as a recognized extension (its store id is fixed), instead of its unauthenticated port 6969 server

### Presence Without Desktop

- [ ] Cloud (Jena) authorization flow for showing presence without Parousia Desktop, separate from the native adapter

### Website and Documentation

- [x] Its own repository, [parousia-project/website](https://github.com/parousia-project/website): Astro + Svelte 5, its own CI and GitHub Pages workflow, `public/CNAME` kept, deployable without anything from this repository. The standalone `/pwa/` page is static markup now, so nothing is shared with `browser/`
- [x] Landing page, Download (the Desktop build for the visitor's system suggested, every build listed, the extensions, the userscript, checksum and attestation checks), and documentation: installation, configuration, Activities (how they run, writing one, the tooling), compatibility, privacy and security, development
- [ ] Check the site's download links and file names against the first published release

### Release

- [x] Release workflow (`.github/workflows/release.yml`, building through the shared `build.yml`): a `vX.Y.Z` tag on `main` tests, builds, and publishes the GitHub release with its `CHANGELOG.md` section as the notes; running it by hand does everything except publish. A tag has to match the versions in `desktop/Cargo.toml` and both extension manifests (`scripts/release-check.mjs`) and have a changelog section (`scripts/changelog.mjs`), both tested
- [x] Nightly workflow (`.github/workflows/nightly.yml`): a push to `main` that changes what ships builds the same files and publishes a pre-release tagged `dev-<commit>`, keeping the newest 5 and deleting older ones with their tags (only `dev-` pre-releases, never a version)
- [x] `CHANGELOG.md` in the style of simply-xp's, one section per version
- [x] Desktop binaries for Windows and Linux, x86_64 and aarch64 each: static musl on Linux and a statically linked C runtime on Windows, so they need no library beyond Windows' own, built with LTO, `opt-level = "z"`, and symbols stripped (about 1 MB). CI checks each is standalone and smoke-tests it wherever the runner can run it (Windows ARM64 is cross-built, not run)
- [x] Extension packages for Chromium and Firefox, and the userscript minified and gzipped, with `SHA256SUMS` and a build provenance attestation for every file
- [x] Version 1.0.0 in Desktop, both extension manifests, and the userscript header (one test checks the browser side agrees, `node scripts/release-check.mjs v1.0.0` the rest)
- [ ] Run the release workflow by hand once before tagging `v1.0.0`, and push to `main` once to see a `dev-` pre-release and the pruning (neither workflow has run on GitHub yet)
- [x] The Chrome Web Store id (`achhedhokopfgfnigkfchklhbebbhebd`) is in Desktop's `PRODUCTION_CHROMIUM_ORIGINS`
- [ ] Firefox's extension origin is random per install, so each Firefox install is allowed once from Desktop. Stores: Chrome Web Store and AMO only; no Edge Add-ons listing
- [x] Third-party notices for Desktop's statically linked Rust crates: `scripts/rust-notices.mjs` writes `parousia-desktop-notices.txt` into every release (the extensions carry their own `THIRD-PARTY-NOTICES.txt`)
- [x] `.github/SECURITY.md` rewritten for 1.0: supported versions, scope across Desktop, the extensions, the Activity runtime, other repositories, and what's out of scope
- [ ] Store listings (Chrome Web Store, AMO), which give Desktop real origins to allowlist
- [x] Firefox `data_collection_permissions` is `browsingActivity` and `websiteContent` (required), not `"none"`: Mozilla counts data sent outside the browser, and the extension sends Desktop an Activity's name and text, which Desktop passes to Discord; a test keeps it from going back to `"none"`
- [ ] AMO review of PreMiD's scripts: `web-ext lint` flags `innerHTML` in 3 of them (third-party code); decide whether to leave those out of the AMO build
- [ ] Code signing for the Windows executables, and macOS builds (none are released yet)
- [ ] Hardening: full security, permission, privacy, and dependency audits; performance and resource benchmarks; cross-platform, browser, RPC, and Activity compatibility testing

### Additional Platforms

Not part of the initial Discord-focused work. Each one is a new Desktop adapter and nothing else.

- [ ] Fluxer adapter
- [ ] Stoat adapter

---

## Standing Goals

These never get checked off:

- Lightweight runtime and minimal browser permissions
- Privacy-first and secure by default
- Compatibility with existing Rich Presence integrations
- A broad Activity ecosystem without a Parousia-specific implementation for every site
- Discord, Fluxer, and Stoat through one shared Activity model
- A codebase that stays maintainable as the ecosystem grows
