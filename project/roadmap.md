# Parousia Roadmap

This roadmap tracks milestones, not individual tasks. See `project/architecture.md` for how the pieces fit together and `project/vision.md` for why they exist.

## How to Read This

Parousia only works end to end when every link in this chain works:

**Browser ↔ Desktop → Platform adapter (Discord) → Activities → end-to-end Rich Presence**

- **Complete** phases are done and stay listed so the record is accurate.
- **Active** phases (at most two) are what gets worked on now. Each has an exit check that says when it's done.
- **Later** work is listed in dependency order but has no phase number yet. It gets one when it becomes active, so the numbered list never runs far ahead of the code.

## Status

| Link in the chain             | State                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Browser extension             | Builds for Chromium, Firefox, Safari, and a userscript. Publishes to Desktop (Safari not yet). Nothing is detected yet.                  |
| Browser ↔ Desktop             | Works: one loopback WebSocket, recognized builds only, no extra extension permission.                                                    |
| Desktop → Discord             | Not started.                                                                                                                             |
| Activities                    | Registry and runtime exist. No Activity is registered anywhere.                                                                         |
| Discord-RPC-Extension backend | Its app is used directly, on by default. Its extension's protocol is wired but inert until a client id is chosen. Nothing to show yet.  |

---

## Phase 1: Foundation (complete)

- [x] Core architecture, security model, Activity system, and platform adapter design (`project/architecture.md`)
- [x] Browser ↔ Desktop protocol design (fixed-port local WebSocket, origin check plus pairing credential; simplified to the origin check alone in Phase 3)
- [x] Compatibility layer design (PreMiD Activities, Discord-RPC-Extension), verified against both projects' sources
- [x] Testing, build, lint, formatting, and security checks in CI (browser, desktop, website, packages, CodeQL, dependency review, Dependabot)
- [x] Website scaffold (Astro + Svelte 5) with a GitHub Pages deploy workflow

## Phase 2: Browser and Desktop Building Blocks (complete)

Each side works and is tested on its own. Nothing here connects them.

**Browser** (`browser/`)

- [x] Chromium (Chrome and Edge), Firefox, and Safari MV3 builds plus a userscript, from one codebase
- [x] Activity registry, Presence runtime, and a lifecycle controller that only publishes changes and sends an explicit "nothing" on tab close, blur, or unmatched navigation
- [x] Minimal permissions: `tabs` and `storage` only, no host permissions or content scripts
- [x] WebSocket transport to Desktop, connecting on demand, keeping only the latest Presence while disconnected
- [x] Discord-RPC-Extension compatibility (cross-extension messaging, Chromium and Firefox), inert until a Discord Application id exists
- [x] Popup and fullscreen presence views, shared with the standalone PWA through `packages/presence-view/`
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

## Phase 4: Discord Adapter (active)

Goal: a Presence that reaches Desktop shows up in the real Discord client.

This comes before Activities because it can be built and tested with hand-written Presence values, while an Activity can't be checked end to end until something displays it.

The concrete adapter lives under `desktop/` (decided). No particular client id blocks this phase: Parousia's own Discord Application exists for the native adapter, and real client ids from the PreMiD Activities repository work for testing and demos.

- [ ] Client id in Desktop's `config.json` (public, not a secret, so not in the client store)
- [ ] `PlatformAdapter` trait, with Desktop forwarding Presence changes to it
- [ ] Discord local IPC client: socket discovery (Unix sockets on Linux and macOS including Flatpak and Snap paths, named pipes on Windows), framing, handshake, `SET_ACTIVITY`, and clear. Recommended without a new dependency, since the framing is an 8-byte header plus JSON.
- [ ] Handle Discord not running, starting late, or restarting, with backoff and no busy polling
- [ ] Coalesce updates to stay under Discord's activity update rate limit
- [ ] When more than one browser is connected, the most recent update wins (Desktop already keeps each connection's latest Presence)
- [ ] Map `Presence` to Discord's activity payload with the same rules as `browser/src/compat/discord-rpc-extension.ts`, tested on both sides
- [ ] Honor the extension's per-platform choice (Settings > Platforms, saved in the extension today and read by nothing yet), which needs it sent to Desktop
- [ ] Tests against a fake IPC server
- [ ] Exit check: a Presence sent over either channel appears in Discord, and clears when the browser disconnects

## Phase 5: First Activity, End to End (active, after Phase 4)

Goal: a site Parousia detects shows up in Discord, with nothing hand-written in between.

- [x] One Activity registry definition shared by the background script, popup, dashboard, and userscript (`browser/src/core/activities.ts`), with catalog entries for the dashboard's searchable, paged Activities page
- [ ] First native Activity: **Jena** (`jena.systems`), requesting host access for its own site only
- [ ] Decide how Activities report page state beyond the URL (playing, paused, progress). This needs content scripts or scripting access and is a permission change.
- [ ] Extend `Activity` for what Discord supports and Activities need (buttons, separate URLs), on both the wire format and Desktop
- [ ] Check the MV3 lifetime policy with a real Activity end to end: the background keepalive holding a shared presence on Chromium and Firefox for several minutes with no tab events (the mechanism itself is measured, see Phase 3)
- [ ] Exit check: a detected Activity is visible in Discord

---

## Later

In dependency order. Each section becomes a numbered phase when it's picked up.

### Activity Ecosystem

- [ ] PreMiD Activities shim (`Presence`/`iFrame` API surface feeding the registry), including per-Activity client ids
- [ ] Activity format, validation and testing tooling, and security requirements
- [ ] Activity development documentation

### Desktop App

- [ ] Windows: CLI control over a named pipe restricted to the user, refusing other OS users' loopback connections (`GetExtendedTcpTable` plus the owning process's token), and a tray
- [ ] macOS: tray, refusing other OS users' loopback connections (`libproc`), and checking the IPC socket (written, untested)
- [ ] Safari: relay through the containing macOS app (Safari's `runtime.sendNativeMessage` reaches only that app), since its extension origin changes every launch and can't be recognized (needs Xcode)
- [ ] Start at login, and extension installation help (including allowing a Firefox install in one step)
- [x] Silent by default: no output or event history until debug logging is turned on for the run (`--debug`, tray, `Parousia-Desktop debug on`)
- [ ] Idle resource review, and a security review of native system interaction

### Compatibility

- [x] Discord through Discord-RPC-Extension's app (`discord_rpc_ext`, port 6969) directly, without Parousia Desktop, locked down to Rich Presence; on by default, switchable in Settings > Platforms
- [ ] Activate the Discord-RPC-Extension backend by choosing its client id, and revisit Firefox's `data_collection_permissions` when it does
- [ ] Define what MAL-Sync compatibility means (coexisting with it through Discord-RPC-Extension, or receiving its presence) and verify it
- [ ] PreWrap coexistence
- [ ] PWA ↔ extension bridge, if wanted (Chromium only; Firefox doesn't support `externally_connectable`)
- [ ] Receive presence from Discord-RPC-Extension as a recognized extension (its store id is fixed), instead of its unauthenticated port 6969 server

### Presence Without Desktop

- [ ] Cloud (Jena) authorization flow for showing presence without Parousia Desktop, separate from the native adapter

### Website and Documentation

- [ ] Landing page and documentation content (installation, configuration, extension, Desktop, Activities, compatibility, privacy and security, development setup)
- [ ] `parousia.js.org` domain setup (js.org registration and `CNAME`)

### Release

- [ ] Store listings (Chrome Web Store, Edge Add-ons, AMO, Safari), which give Desktop real origins to allowlist
- [ ] Desktop packaging and signing for Linux, Windows, and macOS
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
