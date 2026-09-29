# Parousia Architecture

This document describes how Parousia's pieces fit together. See `project/vision.md` for why they exist and `project/roadmap.md` for when each part gets built.

## Overview

Parousia is four cooperating pieces: the browser extension, Parousia Desktop, platform adapters, and Activities.

The browser extension watches tabs and detects activity on supported sites, producing generic `Activity`/`Presence` values (see `browser/src/core/`). It doesn't know or care which platform will eventually display that presence.

That `Presence` travels across a transport (see Communication Protocol) to whatever owns publishing to real platforms. Normally that's Parousia Desktop, a native Rust application, but the extension is also meant to work with compatible third-party backends (see Compatibility Layer) so people aren't forced to run Parousia Desktop.

Parousia Desktop hosts platform adapters (see Platform Adapter Architecture). Each adapter translates a generic `Presence` into whatever a specific platform's Rich Presence integration expects. Discord is the first one.

Activities are the detection layer: a matcher (usually a URL pattern) plus logic that turns a page into an `Activity`. Parousia Activities sit alongside compatibility support for the existing PreMiD Activities ecosystem, so the project isn't stuck reimplementing site support that already exists elsewhere (see Compatibility Layer).

This split keeps every piece replaceable on its own: a new platform is a new adapter, a new site is a new Activity (native or via PreMiD), a new browser is a new target under `browser/src/platforms/`. None of them need to touch the others.

## Security Model

Every boundary between components is untrusted until proven otherwise:

- **Browser extension.** Content scripts, and anything that touches page content, are the least trusted part of the system. They read only what's needed to detect activity (URL, title, and minimal DOM data for a specific Activity) and never handle credentials or user data beyond that.
- **Browser ↔ Desktop channel.** Desktop only talks to recognized Parousia builds, identified by what the browser itself vouches for: the WebSocket `Origin` header, which pages and other extensions can't forge. There are no pairing codes or shared secrets. The WebSocket listens on `127.0.0.1` only, and on Linux Desktop refuses connections from other OS users. A process running as the same user can claim any identity; that's out of scope for this channel, as for any local app. `project/threat-model.md` has the full threat model.
- **Parousia Desktop.** The trusted core. It validates and bounds anything coming from the browser (size limits, expected shape) before handing it to an adapter, and doesn't assume an adapter's output is safe to log or display without care.
- **Platform adapters.** Talk to a specific platform's local integration (Discord's local RPC socket, for example). They receive only the generic `Presence` the runtime built, never raw page content.
- **Dependencies.** Kept minimal by policy. CI runs CodeQL, Dependabot, `bun audit`/`cargo audit`, and PR-time dependency review so a known-vulnerable dependency doesn't quietly creep in (see `.github/workflows/`).
- **Secrets.** Never committed. There currently aren't any: Discord's local RPC is keyed by a public application ID, not a secret.

This is a model, not a guarantee. It should be revisited whenever a new component or transport is added, and it gets a dedicated pass during release hardening (see `project/roadmap.md`).

## Activity System Architecture

An **Activity** describes one thing a user might be doing on a specific site: an id, a display name, optional details/state text, the URL it was detected on, and optional assets/timestamps (`browser/src/core/activity.ts`).

Activities are found through an **ActivityRegistry**: each registered entry pairs a `matcher` (given a URL, is this Activity relevant?) with a `detect` function that builds the actual `Activity` from that URL. The registry doesn't care where an entry came from: native Parousia code and a future PreMiD-compatibility shim (see Compatibility Layer) register the same way (`browser/src/core/registry.ts`).

A **PresenceRuntime** resolves the registry against the current tab and wraps the result (or nothing, if no Activity matches) into a **Presence** with a timestamp (`browser/src/core/runtime.ts`, `presence.ts`). `Presence` is the unit that actually leaves the browser. It's deliberately platform-agnostic; turning it into something Discord, Fluxer, or Stoat understands is the adapter's job, not the runtime's.

Lifecycle: a tab's `Presence` updates on navigation, and clears (a `Presence` with no activity) when the tab closes, hides, or navigates somewhere unmatched. The runtime always sends an explicit "nothing" rather than going quiet, so a stale presence doesn't linger on a platform after someone's moved on. Detection is URL-only today. Updates driven by the page itself (a video site reporting paused/playing, for example) need page access through content scripts or scripting permissions, a permission change that comes with the first Activities that need it. Privacy settings (`browser/src/core/preferences.ts`, set from the extension's Settings) shape what's published: with Share Media Details off, only the Activity's name, link, and images leave the browser; private windows share nothing unless Incognito Behaviour is set to share; and Idle Timeout keeps presence for up to that many minutes after the browser loses focus instead of clearing it at once.

## Platform Adapter Architecture

An adapter is anything that can take a `Presence` and make some platform show it. On the desktop side, that's a small Rust trait, roughly:

```rust
trait PlatformAdapter {
    fn name(&self) -> &'static str;
    fn update(&mut self, presence: &Presence) -> Result<(), AdapterError>;
    fn clear(&mut self) -> Result<(), AdapterError>;
}
```

The exact shape will firm up once Discord's implementation lands (roadmap Phase 4); this is the contract, not the final API. Parousia Desktop holds a small set of active adapters and forwards every `Presence` update to each of them. An adapter that isn't configured, or whose platform isn't running, reports itself unavailable rather than erroring.

Discord is the first adapter (Phase 4). Fluxer and Stoat are planned but intentionally not started yet. Because every adapter speaks the same `Presence` type, adding one later means writing a new adapter, not touching the runtime, the registry, or any existing adapter.

Concrete platform adapters are Desktop code and live under `desktop/`. The top-level `adapters/` directory is kept only for shared, platform-level definitions, if any turn out to be useful; today it holds placeholder READMEs. The browser and Desktop each keep their own `Presence` types with the wire format as the shared contract (see Communication Protocol), so the top-level `core/` placeholder has no role.

## Communication Protocol

The browser and Desktop speak one small protocol over one channel: a WebSocket on the loopback interface.

### Channel

`ws://127.0.0.1:57179/ws`, a fixed port in the IANA dynamic range, away from common development ports and Discord's own `6463-6472`, bound to `127.0.0.1` only. Every client uses it: Chromium, Edge, and Firefox extensions (sandboxed Flatpak and Snap builds included), the userscript, and on every OS. No extension permission is needed for it (the extension's CSP `connect-src` names it), so the extension asks for nothing beyond `tabs` and `storage`.

Desktop also has a user-private IPC socket (`$XDG_RUNTIME_DIR/parousia/desktop.sock`, 0600 in a 0700 directory; the data directory where there's no runtime directory). Browsers never use it: it carries the CLI's control requests and is the single-instance check.

**Why only a WebSocket.** The userscript and sandboxed Flatpak and Snap browsers can only reach Desktop over the network, so a loopback listener has to exist regardless. A Native Messaging channel was built next to it during Phase 3 and dropped before release, because a second channel didn't earn its cost:

- It needs the `nativeMessaging` permission, which browsers show as a separate install warning ("Exchange messages with programs other than Firefox").
- It needs a host manifest per browser and per OS (a directory per Chromium fork on Linux and macOS, the registry on Windows), a relay process per connection, and a second connection path in the extension that doubles the test matrix.
- It doesn't reach the clients that most need an alternative: Flatpak and Snap browsers, the userscript, Safari.
- Its one technical advantage, keeping Firefox's MV3 event page alive, has a simpler answer. Measured with Firefox 150 (idle timeout shortened to 6 s): an open WebSocket with messages every 4 s doesn't keep an event page alive and an open Native Messaging port does, but so does calling `runtime.getPlatformInfo()`. On Chromium 152 (default 30 s timeout, no DevTools attached) that call alone kept a service worker alive for 95 s. One background keepalive covers both engines (see Connection Lifetime).
- Identity is the remaining difference: Native Messaging names a Firefox caller by its stable add-on id, while its WebSocket `Origin` is random per install, so each Firefox install is allowed once (see below), the same one-time step registering a host would be.

### Recognized Builds

Desktop accepts a connection only from an identity it recognizes:

| Client | Identity (the WebSocket `Origin`) | Recognized when |
| --- | --- | --- |
| Chromium extension | `chrome-extension://<id>` | It's a store build (built in once listings exist), or listed in `allowedOrigins` |
| Firefox extension | `moz-extension://<uuid>`, random per install | It's listed in `allowedOrigins`: allowed once per install, from the tray, the CLI, or the console |
| Userscript | The page's origin; Firefox reports a content script's WebSocket as `Origin: null` | Only while "Allow userscripts" is on (off by default) |
| Safari extension | `safari-web-extension://…`, which changes every launch | Never, for now: there's nothing stable to recognize |

`allowedOrigins` holds exact `chrome-extension://<32-letter id>` and `moz-extension://<uuid>` origins, nothing broader. A malformed entry stops Desktop at startup rather than being skipped.

The WebSocket upgrade is decided before it completes. A recognized extension origin, or a web origin while userscripts are allowed, gets through. An extension origin Desktop doesn't recognize gets exactly one `reject {reason: "origin_not_allowed"}` and a close: a browser can't tell a refused upgrade from nothing listening, and "allow this build" has to be something its popup can say. Nothing it sends is read, and Desktop lists it (with a notification) so the person can allow it in one step. Web origins while userscripts are off, a `null` or missing origin, and anything malformed get a bare `403` with no body, so a page learns nothing beyond the refusal.

### Messages

Every message is a small JSON object parsed into strict types (unknown fields are an error); every frame, in both directions, is capped at 16 KiB.

1. The client sends `hello {protocolVersion: 4, name}` within 5 seconds. `name` ("Firefox on Linux") is display-only and untrusted.
2. Desktop answers `welcome {protocolVersion}`, or `reject {reason}` and closes.
3. Then `presence {presence}`, `ping {}` (answered with `pong`), `status {}` (answered with `status {status}`, Desktop's report), and `set {setting, value}` (answered with the new report), until either side closes. A malformed frame gets a non-fatal `reject`; more than a burst of 20 messages, refilling at 5 per second, gets `rate_limited` and a close.

`status` and `set` are for extensions only: a userscript is any web page, so it can publish Presence and nothing else. `set` also needs a connection Desktop knows comes from this OS user (on Linux, where the loopback peer's owner can be looked up; elsewhere, settings change from the tray, CLI, or console). The only setting is `allowUserscripts`. The extension doesn't send `ping`; it's there for liveness checks and tests. Reject reasons: `unsupported_version`, `malformed`, `timeout`, `origin_not_allowed`, `rate_limited`, `not_permitted`.

When Desktop gives up on a connection it stops sending, then reads and discards what the client still sends for up to a second before closing. Closing a socket with unread input makes the kernel reset the connection, and a reset can destroy the `reject` just sent before the client reads it.

### Presence

Desktop keeps the latest Presence per connection and drops it when that connection closes, so a browser that goes away stops showing as doing something. Presence fields are length-limited, URLs must be `http(s)`, and times must be non-negative, before anything else sees them. Disallowing an origin, or turning userscripts off, closes the connections that relied on it immediately.

### Connection Lifetime

The browser connects only while something needs Desktop: an Activity is being reported, or a popup or dashboard is open (their port to the background script). Otherwise it lets go 30 seconds after the last need, so an idle browser holds no socket, sends no traffic, and lets its MV3 background be suspended. While an Activity is being shared, the background script calls `runtime.getPlatformInfo()` every 20 seconds (`backgroundKeepalive` in `browser/src/platforms/background.ts`), which resets both Chromium's and Firefox's idle timer; nothing goes over the socket for it. Without it, Firefox stops the event page about 30 seconds after the last tab event, which closes the WebSocket and makes Desktop (and Discord-RPC-Extension's app) drop the presence while someone is still on the page. When Desktop is unreachable while needed, retries come every 10 seconds on in-memory timers. When nothing needs Desktop, nothing retries, and a suspended background simply starts over the next time it's needed, so there's no persisted schedule and no `chrome.alarms`. After `origin_not_allowed` or `unsupported_version` the extension stops retrying until a popup or dashboard opens, since retrying can't change the answer. The userscript lets go immediately when its page is left (`pagehide`), since a page in the back/forward cache has its timers frozen.

Extension pages carry an explicit Content Security Policy: `script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:57179 ws://127.0.0.1:6969`. Firefox's default MV3 policy includes `upgrade-insecure-requests`, which silently turns `ws://127.0.0.1` into `wss://` (a TLS handshake neither server can answer). The `connect-src` also limits extension pages to exactly two endpoints: Desktop, and Discord-RPC-Extension's app (see Compatibility Layer).

### Desktop Internals

No async runtime: the workload is a handful of long-lived, mostly idle connections. One thread accepts TCP connections, one accepts CLI connections on the IPC socket, each connection runs its own blocking thread, and the tray (Linux) owns the main thread. Idle, nothing wakes up: no timers, no polling. Accepting is rate limited (a burst of 32, refilling at 16 per second, checked when a connection arrives), at most 64 connections are open at once, and request heads time out after 5 seconds. On Linux, each TCP connection's owner is looked up in `/proc/net/tcp` before anything is parsed: another user's connection is dropped, and one that can't be found is treated as another user's. The WebSocket side is `tungstenite` plus `httparse` over plain `std::net`; `GET /health` is the one plain-HTTP route.

Settings live in `config.json` in the data directory (`allowedOrigins`, `allowUserscripts`; 0600, written through a temp file, fsync, and rename). An unknown key or a malformed origin stops Desktop at startup rather than being skipped.

The IPC socket also serves as the single-instance check (a socket that answers means Desktop is running; a dead one is replaced; launching again asks the running Desktop to show itself), and carries control requests from the CLI: `status`, `set userscripts on|off`, `debug on|off`, `allow <origin>`, and `disallow <origin>`, each with `--json`. If the TCP port is taken by something else, Desktop exits with an error saying so: without the port no browser can reach it. Where there's no IPC socket yet (Windows), that failed bind is also what stops a second Desktop.

## Settings and Status Without a Tray

Nothing requires a tray. The same status and settings are reachable four ways:

- **The extension's Settings** (popup and dashboard): the userscript setting, fetched from Desktop over the extension's own connection, and changeable from any connection Desktop knows is this OS user's. The extension shows Desktop's status and version but no diagnostics; those (browsers, refused extensions, events) are Desktop's alone.
- **The popup**, which shows the connection and, when something's wrong, what to do about it (including the exact `allow` command for an unrecognized build).
- **The CLI** (`Parousia-Desktop status`, `set`, `allow`, `disallow`), and the same commands typed into the terminal Desktop runs in.
- **Notifications**, sent over the session bus whether or not a tray is showing: an unrecognized extension being blocked, and "Parousia Desktop is running" when it's launched a second time (so starting it from an app launcher always answers, even where there's no tray icon to click).

Desktop logs nothing by default: no output and no event history, until debug logging is turned on for the run (`--debug`, the tray's "Debug logging (this run)", `Parousia-Desktop debug on`, or the console). The switch is per process and never saved, so a normal run never pays for logging. Refused extensions are still tracked, since the tray's "Allow" and the popup's guidance rely on them.

## Desktop Tray

On Linux, Desktop is also a StatusNotifierItem (shown by KDE Plasma, and by GNOME with the AppIndicator extension, which Ubuntu enables by default). Its menu: a status line, connected browsers with their identity, Diagnostics (the WebSocket's address and whether other OS users are refused, refused extensions each with an "Allow" action, recent events), Settings (checkmark toggles for userscripts and debug logging), and Quit. With no tray host running (stock GNOME), Desktop says so once and keeps working, sends its notifications anyway, and registers the icon if a tray host starts later.

The D-Bus side is written directly against the D-Bus specification (`desktop/src/tray/dbus.rs`: EXTERNAL authentication, message marshalling, both byte orders) rather than using `ksni`. Measured, a minimal `ksni` tray is a 1.59 MB stripped binary with 3.8 MB RSS and 5 threads, built from about 65 crates including `zbus` and an async executor. The hand-written client adds no crates and runs on the main thread blocked on the bus socket. Menu item ids are derived from content (connection ids for browsers, a hash of the origin for "Allow" items), so a click on a menu the panel rendered earlier can only ever act on what it showed, or on nothing. Verified against Plasma 6: it registers with the watcher, re-registers if the panel restarts, and Plasma fetches the layout and properties on every change.

Windows and macOS have no tray yet. There, Desktop's console (`status`, `allow`, `disallow`, `userscripts on|off`, `debug on|off`, `quit` typed into its terminal) and the extension's Settings cover the same ground, and on macOS the CLI too.

## Compatibility Layer

Two separate compatibility targets, from `project/compatibility.md`:

- **PreMiD Activities.** Confirmed against PreMiD's own docs: an Activity is a `presence.ts` script (plus an optional `iframe.ts` for sites that need to read an embedded iframe) that constructs a `Presence` instance with its own Discord `clientId` and, on a recurring `UpdateData` tick fired by the PreMiD extension, calls `setActivity(presenceData)` with a `PresenceData` object. The shim Parousia needs is an implementation of that same `Presence`/`iFrame` API surface, so an unmodified Activity's `presence.ts` runs unchanged and its `setActivity` calls feed Parousia's `ActivityRegistry`/`PresenceRuntime` instead. Two details this rules out doing naively: `PresenceData` is richer than Parousia's current `Activity` type (it carries buttons, party info, and separate details/state URLs that `Activity` doesn't have yet), and each Activity supplies its own `clientId` rather than sharing one Parousia-wide id, so both need to survive the translation. This stays a shim, not a rewrite; PreMiD Activities never talk to Parousia's core directly.
- **Discord-RPC-Extension.** Lets Parousia's browser extension feed its detected `Presence` to Discord-RPC-Extension instead of Parousia Desktop, so someone can use Parousia's Activity detection without installing Parousia Desktop at all. Implemented, browser-side, in `browser/src/compat/discord-rpc-extension.ts` (Chromium and Firefox only; not Safari or the userscript, since Discord-RPC-Extension isn't published there). Confirmed against its actual source, not just `docs/api.md`: it isn't a network protocol, it's the browser's own cross-extension messaging. A compatible extension registers once with `chrome.runtime.sendMessage(<Discord-RPC-Extension's id>, { mode: 'active' | 'passive' })`; registering from a background script rather than a content script (exactly Parousia's shape, with no content script at all) always becomes their "background" presence type regardless of `mode`, per their own registration logic. It then answers periodic (~15s) presence requests, delivered via `chrome.runtime.onMessageExternal` (not `onMessage`, which is only for their separate content-script relay pattern), with `{ clientId, presence }` in Discord's Rich Presence payload shape. The `Presence` → Discord payload translation this needs is the same shape our own Discord adapter (Phase 4) will need. The two can't share code (TypeScript here, Rust in Desktop), so the mapping is isolated in one function per side: the TypeScript one exists and is tested, and the Rust one lands with the Discord adapter under the same rules. It does not feed back into Parousia's own canonical `Presence`/`Activity` types. Any extension can reach `onMessageExternal` by default; declaring `externally_connectable.ids` narrows that to just this one id, but only on Chrome (Firefox has never implemented `externally_connectable` at all, open since 2016, bugzilla.mozilla.org/1319168), so the actual cross-browser restriction is a `sender.id` check in code, not the manifest. **Remaining:** the protocol requires a Discord Application `clientId` to render anything in Discord at all, so the compatibility layer stays fully wired but inert (registers with nothing, answers nothing) until one is configured. Which id it uses is decided when the layer is switched on; it doesn't wait on Phase 4. Once it is, `browser_specific_settings.gecko.data_collection_permissions` in `browser/manifests/firefox.json` also needs revisiting: it currently declares `"none"`, accurate today since the layer does nothing, but sharing activity data with a third-party extension is exactly the kind of thing that disclosure exists to cover.

  **Its app, used directly.** Discord-RPC-Extension's own desktop half (`discord_rpc_ext` on Linux, its Node `server.js` elsewhere) is a WebSocket server on port 6969 with no authentication and no `Origin` check, listening on every interface. The extension sends it `{clientId, presence, extId}`, `{action: "disconnect"}` (on tab changes, even with nothing registered), `{action: "party"}`, and `{action: "reply"}`; the server sends `{version}` and forwards Discord's `join`/`joinRequest`/`spectate`. Parousia's extension now talks to that app itself (`browser/src/compat/discord-rpc-server.ts`), so Discord works without Parousia Desktop and without Discord-RPC-Extension's browser extension, locked down to plain Rich Presence: it only ever sends `{clientId, presence, extId}` (`extId` is required; without it the app throws on a new client id and exits) and `{action: "disconnect"}`, only after it showed something itself, so it never clears presence another tool set; of what comes back it reads only `{version}`; it resends a shown presence every 15 seconds, since the app clears one silent for 30; and it uses `127.0.0.1` only. It connects on the same terms as the Desktop link (while a popup or dashboard is open, or while there's an Activity with a Discord client id to show, retrying every 10 seconds, letting go 30 seconds after the last need), and it's on by default, switched by Settings > Platforms (Discord, and "Discord-RPC-Extension"). Each Activity shows as its own Discord Application (`ActivityInfo.discordClientId`, like PreMiD's), falling back to Parousia's own id, which is still unset, so today it connects and reports the app's version but has nothing to show. One side effect of the app's design: each new connection becomes the one its `join` events go to, so while Parousia is connected, Discord-RPC-Extension's browser extension misses party joins until it reconnects. Checked end to end against a stand-in server in a private network namespace (never a real running app). Parousia Desktop still deliberately does not answer on port 6969 as a drop-in for that server: doing so means accepting presence from any page or extension, the opposite of its link's security model.

## Website

Built with **Astro + Svelte 5**: Astro handles static pages, routing, and content (the landing page and the documentation section) in one project (`website/`), matching the "single consolidated project" goal in `project/vision.md`; Svelte is used selectively for interactive components where a static page isn't enough. The site stays statically generated and deployable to GitHub Pages. The scaffold exists and builds; writing the actual documentation content is later work in `project/roadmap.md`.

## Full-Screen Presence View

Beyond the popup, Parousia has a larger presence view in two places that intentionally share almost everything: an extension page (`browser/src/fullscreen/`), opened from a control in the popup, and a standalone PWA (`website/src/pages/pwa/`, `website/public/pwa/`) at `/pwa/`, installable and usable without the extension at all.

Both are thin hosts around one shared module, `packages/presence-view/`: plain TypeScript with no build step of its own, consumed by relative import from both `browser/` and `website/`, which each bundle it themselves. The shared piece is a `PresenceSource` adapter (`() => Promise<{ available, activity }>`) plus the DOM rendering that turns a snapshot into one of exactly three states: no source available, available with nothing detected, or available with an activity. `available` is what actually separates the two hosts: the popup and the extension's fullscreen page always report `true` (resolving the active tab through the same `ActivityRegistry`/`PresenceRuntime` as the background script), while the PWA has no bridge to the extension yet and always reports `false`, rendering an honest "install the extension" state rather than a fake or empty-looking dashboard. `packages/` is otherwise unrelated to any Rust/Desktop package boundary; it exists purely for this kind of TypeScript sharing between `browser/` and `website/`.

The PWA is deliberately static and self-contained: its own manifest, a minimal cache-first service worker for the app shell, and no server. A live bridge from the PWA to a running extension (so `available` could become `true` there too) would need web-page-to-extension messaging (`externally_connectable.matches` plus `chrome.runtime.connect`), which Firefox doesn't support at all (see the Discord-RPC-Extension note above), so that bridge could only ever be Chrome-only unless Firefox implements it. That's a real trust boundary and a real cross-browser gap to design around deliberately, not a byproduct of this view, so it's left for when that's actually needed rather than built speculatively here.
