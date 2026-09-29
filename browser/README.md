# browser

Parousia's browser extension, built with [Bun](https://bun.com) + strict TypeScript.

## Setup

```bash
bun install
```

## Commands

```bash
bun run build         # build all targets into dist/
bun run dev           # build, then rebuild on change
bun run typecheck      # tsc --noEmit
bun run lint           # oxlint
bun run format         # oxfmt
bun run format:check   # oxfmt --check
bun test               # bun test

bun run firefox:setup   # one-time: fetch an isolated automation Firefox build
bun run firefox:lint    # web-ext lint against dist/firefox
bun run firefox:verify  # lint + actually install & run dist/firefox in real Firefox
bun run chromium:setup  # one-time: fetch an isolated automation Chromium build
bun run desktop:verify  # the Browser <-> Desktop link, end to end, in automation Chromium (Linux)
bun run real:verify     # the same against installed browsers: Firefox, Flatpak Chromium, Violentmonkey
```

## Build Targets

`bun run build` produces one folder per target under `dist/`, each a self-contained, minified bundle plus its `manifest.json`:

| Target       | Output             | Distribution                                                                                                                     |
| ------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `chromium`   | `dist/chromium/`   | Chrome Web Store and Microsoft Edge Add-ons. Both consume the same Manifest V3 Chromium package; there's no separate Edge build. |
| `firefox`    | `dist/firefox/`    | Firefox Add-ons (inspectable); `dist/firefox.zip` is the same files zipped at the archive root, ready to upload to AMO.          |
| `safari`     | `dist/safari/`     | Safari Web Extension (via Xcode conversion)                                                                                      |
| `userscript` | `dist/userscript/` | `parousia.user.js`, installed through a userscript manager (Violentmonkey, Tampermonkey, ScriptCat)                              |

Manifests live in `manifests/` and are validated (must declare `"manifest_version": 3`) as part of the build. `dist/` is fully cleaned before every build, so `firefox.zip` is always rebuilt from scratch, never patched.

JS is minified via Bun's own `--minify`, with no separate minifier dependency: it takes `chromium.js` from 27.9 KB to 13.4 KB raw (7.2 KB to 4.8 KB gzipped). Layering `uglify-js` on top shaved off only about 3.5% more gzipped in earlier testing, not enough to justify the dependency. `DesktopConnection` uses `#private` members because Bun shortens those and not ordinary property names.

`dist/firefox.zip` is written by a small dependency-free zip writer (`scripts/zip.ts`, using only `node:zlib`): `Bun.Archive` only produces tar/gzip, and a real `.zip` is what AMO needs.

## Firefox Verification

`bun run firefox:verify` (after `bun run firefox:setup` once) actually installs `dist/firefox` as a temporary add-on in a real, isolated Firefox engine and confirms it loads, not just that the build succeeded. It never touches a system-installed Firefox; `firefox:setup` downloads a dedicated automation build via `playwright-core` specifically so this can't ever interact with someone's actual browser session.

This check can't watch the background page's own console (web-ext's RDP client doesn't expose it, and WebDriver BiDi's `log.entryAdded` never fires for the background context). What the background actually does in Firefox is covered by `bun run real:verify`, which drives an installed Firefox over WebDriver BiDi, opens the extension's popup and dashboard pages, and connects to Desktop.

## Permissions

The extension requests `tabs`, which exposes a tab's `url`/`title` for Activity matching without granting page-content access, and `storage`. Reaching Desktop needs no permission: it's a WebSocket to `127.0.0.1`, allowed by the extension's CSP below. `storage` holds only the user's own settings (Privacy, Platforms, Language) in `chrome.storage.local`; nothing about browsing is stored, and there's no `alarms` permission. No `host_permissions` or content scripts are declared yet: no Activity currently needs DOM access. Site-specific Activities will request access scoped to just their own sites (see `project/roadmap.md`).

Without Parousia Desktop, Discord still works through Discord-RPC-Extension's app (`discord_rpc_ext`) if it's running: the extension connects to `ws://127.0.0.1:6969` and sends only Rich Presence (see `src/compat/discord-rpc-server.ts` and `project/architecture.md`). It's on by default and switched in Settings > Platforms. The end-to-end scripts turn it off in their test browsers, so they never touch a real app someone's Discord status depends on.

Extension pages carry an explicit Content Security Policy, `script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:57179 ws://127.0.0.1:6969`. Firefox's default MV3 policy includes `upgrade-insecure-requests`, which silently turns `ws://` into `wss://`; `connect-src` also limits extension pages to Desktop and Discord-RPC-Extension's app.

The Chromium manifest also declares `externally_connectable.ids` scoped to Discord-RPC-Extension's own published id (see Compatibility below), Chrome-only; Firefox has never implemented that manifest key at all, so the real, cross-browser restriction lives in code, not the manifest.

The userscript grants itself only `GM_registerMenuCommand` (its "Parousia Desktop status" command), and runs in the manager's isolated world (`@inject-into content`, `@sandbox DOM`) so the page can't patch the WebSocket it uses. Greasemonkey 4 has no menu commands, so it isn't supported.

## Communication

The background script owns the one connection to Parousia Desktop (`src/core/desktop-connection.ts`), a WebSocket to `ws://127.0.0.1:57179/ws` (`src/core/channel.ts`) carrying a small protocol (`src/core/desktop-protocol.ts`): `hello`, Desktop's `welcome` or `reject`, then Presence. Desktop decides who it talks to from the WebSocket `Origin`, which the browser sets; there's nothing to pair. `project/architecture.md` (Communication Protocol) has the details and `project/threat-model.md` the reasoning.

It only connects while something needs Desktop: an Activity is being reported, or the popup or dashboard is open. It lets go 30 seconds later. While an Activity is shared, the background calls `runtime.getPlatformInfo()` every 20 seconds so MV3 doesn't stop it (Firefox stops an event page even with a busy WebSocket open). Retries come every 10 seconds on in-memory timers and stop entirely when nothing needs Desktop. The popup and dashboard never open a connection of their own; they hold a port to the background script (`src/core/ui-port.ts`), which keeps the connection up while they're open and carries its state, Desktop's status report, and settings changes.

Getting connected:

- **Store builds** of the Chromium extension will be recognized out of the box once listings exist.
- **Development builds and every Firefox install** (its `moz-extension://` origin is random per install) reach Desktop by an origin it has to be told about, once. The popup shows "Not allowed by Parousia Desktop" with the exact command (`Parousia-Desktop allow chrome-extension://…`), and the tray's Diagnostics → Refused menu has a one-click "Allow". `bun run dev` gives the Chromium build a stable id (from a per-machine key in `.dev-key.json`) and prints it.
- **The userscript** connects only after "Allow userscripts" is turned on in Desktop (tray, the extension's Settings, or `Parousia-Desktop set userscripts on`). Its manager menu's "Parousia Desktop status" says whether it's connected and how to allow it.

`bun run desktop:verify` checks the whole link with playwright-core's isolated Chromium and the Desktop debug build (`cargo build` in `desktop/` first), in a throwaway data directory: Desktop absent and starting later, an unrecognized build refused and then allowed, two browsers at once, disallowing connected browsers, userscripts off and then allowed, hostile input, a second launch, Desktop stopping, and letting go when idle. `bun run real:verify` covers installed browsers on this machine (Firefox Developer Edition over WebDriver BiDi, the Flatpak Ungoogled Chromium over CDP, the userscript in Violentmonkey) and runs Desktop with its tray. Both need port 57179 free.

## Compatibility

`src/compat/discord-rpc-extension.ts` implements Discord-RPC-Extension's presence protocol (Chromium and Firefox only), so Parousia's Activity detection can drive Discord Rich Presence through that project's existing Desktop bridge without needing Parousia Desktop. It's fully wired but currently inert: the protocol needs a real Discord Application `clientId` to render anything, and choosing one is a Phase 4 decision, not a browser-layer one. See `project/architecture.md`'s Compatibility Layer section for the full protocol writeup, what's still Desktop-dependent, and how Parousia coexists with Discord-RPC-Extension's own server.

## Popup

`src/popup/` is the toolbar popup shown via the `action` key in each extension manifest. It independently resolves the active tab's URL through the same `ActivityRegistry`/`PresenceRuntime` the background script uses, so it always reflects genuine detection state rather than a cached or simulated one. Its footer shows the Desktop connection, and when something's wrong, what to do about it (start Desktop, allow this build with the exact origin, or update a mismatched version). The userscript target has no popup, since it has no browser action to attach one to; its manager's menu has the status command instead.

## Fullscreen

`src/fullscreen/` is a larger, standalone presence view opened as its own tab via the popup's expand control (`chrome.tabs.create` to `fullscreen.html`, not a popup). It shares its rendering and state logic with the standalone PWA at `website/src/pages/pwa/` through `packages/presence-view/`; see `project/architecture.md`'s "Full-Screen Presence View" section for how that split works and why the PWA can't (yet) show live data.

It's split into pages, one rendered at a time and addressed by the URL hash: **Overview** (`#overview`: the current activity and Parousia Desktop's status and version), **Activities** (`#activities?q=…&page=…`: the Activity catalog, searched and paged so only one page of cards is ever in the DOM, sized for PreMiD's 1,400+), and **Settings** (`#settings/<category>`, the same pages as the popup's Settings). Diagnostics aren't in the extension at all; they're Desktop's (its tray and `Parousia-Desktop status`). Desktop only accepts setting changes from a connection it knows is this OS user's; otherwise Settings points to `Parousia-Desktop set` or Desktop's console.
