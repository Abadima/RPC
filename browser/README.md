# browser

Parousia's browser extension, built with [Bun](https://bun.com) + strict TypeScript.

## Setup

```bash
bun install
bun run activities:fetch   # the Activity sources, at the newest commit on each one's main
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

bun run activities:fetch   # move each Activity source to the newest commit on its main now (every build does this itself; a failed fetch keeps the copy it has)
bun run activities:check   # check and compile every Activity; list PreMiD ones left out, and why

bun run firefox:setup   # one-time: fetch an isolated automation Firefox build
bun run firefox:lint    # web-ext lint against dist/firefox
bun run firefox:verify  # lint + actually install & run dist/firefox in real Firefox
bun run chromium:setup  # one-time: fetch an isolated automation Chromium build
bun run desktop:verify  # the Browser <-> Desktop link, end to end, in automation Chromium (Linux, Windows)
bun run real:verify     # the same against installed browsers: Firefox, Flatpak Chromium, Violentmonkey
bun run discord:verify  # a real Activity on a real Discord (opt-in, see below)
bun run activities:verify # Activities, the popup, and the dashboard, end to end (Linux, Windows)
bun run activities:firefox # the same features in installed Firefox Developer Edition
bun run languages:verify # every language in the popup and dashboard, Automatic, and a change reaching an open view (automation Chromium)
bun run bench          # sizes, memory, CPU, and latency, as JSON
bun run contrast       # WCAG 2.2 AA contrast of every theme's tokens, as a table
bun run themes:verify  # the themes on every popup and dashboard view, in automation Chromium
```

## Build Targets

`bun run build` produces one folder per target under `dist/`, each a self-contained, minified bundle plus its `manifest.json`:

| Target       | Output             | Distribution                                                                                                                            |
| ------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `chromium`   | `dist/chromium/`   | Chrome Web Store. The same Manifest V3 package runs in other Chromium browsers; there's no separate Edge build or Edge Add-ons listing. |
| `firefox`    | `dist/firefox/`    | Firefox Add-ons (inspectable).                                                                                                          |
| `userscript` | `dist/userscript/` | `parousia.user.js`, installed through a userscript manager (Violentmonkey, Tampermonkey, ScriptCat)                                     |

`dist/chromium.zip` and `dist/firefox.zip` are the same files zipped at the archive root, ready to upload to a store or attach to a release. `dist/userscript/parousia.user.js.gz` is the userscript compressed for mirrors that serve it precompressed; a manager installs the plain `.user.js`.

There is no Safari target. The code sticks to standard WebExtension APIs (`chrome.*`), so one stays possible, but nothing builds or releases it (see `project/architecture.md`, Recognized Builds).

Manifests live in `manifests/` and are validated (must declare `"manifest_version": 3`) as part of the build. `dist/` is fully cleaned before every build, so the zips are always rebuilt from scratch, never patched.

JS is minified via Bun's own `--minify`, with no separate minifier dependency: it takes `chromium.js` from 27.9 KB to 13.4 KB raw (7.2 KB to 4.8 KB gzipped). Layering `uglify-js` on top shaved off only about 3.5% more gzipped in earlier testing, not enough to justify the dependency. `DesktopConnection` uses `#private` members because Bun shortens those and not ordinary property names.

The zips are written by a small dependency-free zip writer (`scripts/zip.ts`, using only `node:zlib`): `Bun.Archive` only produces tar/gzip, and a real `.zip` is what the stores need. It sorts entries and fixes timestamps, so the same files always give the same archive.

The userscript is the same Bun minification (11.9 KB raw, 4.7 KB gzipped, 4.2 KB with brotli) with its `==UserScript==` header on top. Dropping `console` calls would save 27 bytes and silence the logger, so they stay.

## Firefox Verification

`bun run firefox:verify` (after `bun run firefox:setup` once) actually installs `dist/firefox` as a temporary add-on in a real, isolated Firefox engine and confirms it loads, not just that the build succeeded. It never touches a system-installed Firefox; `firefox:setup` downloads a dedicated automation build via `playwright-core` specifically so this can't ever interact with someone's actual browser session.

This check can't watch the background page's own console (web-ext's RDP client doesn't expose it, and WebDriver BiDi's `log.entryAdded` never fires for the background context). What the background actually does in Firefox is covered by `bun run real:verify`, which drives an installed Firefox over WebDriver BiDi, opens the extension's popup and dashboard pages, and connects to Desktop.

## Permissions

The extension requests `tabs`, which exposes a tab's `url`/`title` for Activity matching without granting page-content access, and `storage`. Reaching Desktop needs no permission: it's a WebSocket to `127.0.0.1`, allowed by the extension's CSP below. `storage` holds only the user's own settings (Privacy, Platforms, Language, which Activities are on with their settings, and the Default Activity) in `chrome.storage.local`, readable only by the extension's own pages (`setAccessLevel` in Chromium; in every browser, PreMiD's runtime takes the storage API out of the world PreMiD code runs in); nothing about browsing is stored, and there's no `alarms` permission. No `host_permissions` or static content scripts are declared: native Activities read the URL and title only.

Reading a page itself takes site access, which is always explicit: turning on an Activity that reads pages asks the browser for its sites, from the same click. Declined, the Activity stays off and says why; taken back later, it's unavailable on that site until access is granted again ("Allow access" in the popup or on its page). Settings > Site access has "Access your data for all websites", off by default and asked for only by its own switch. Individual sites aren't listed or revoked there: the browser owns those grants (its prompt, then its extension settings), and it doesn't let an extension take back every kind of grant, so a list here could disagree with the browser's own. Both are optional permissions (`optional_host_permissions: ["*://*/*"]` covers any site that can be asked for, plus `scripting`), so nothing is granted at install. Turning an Activity off gives back the sites no other Activity that's on needs, and `scripting` once nothing does. What Activities may read (what's playing, thumbnails, creator icons) is one choice for all of them, in Settings > Privacy.

Without Parousia Desktop, Discord still works through Discord-RPC-Extension's app (`discord_rpc_ext`) if it's running: the extension connects to `ws://127.0.0.1:6969` and sends only Rich Presence (see `src/compat/discord-rpc-server.ts` and `project/architecture.md`). It's on by default and switched in Settings > Platforms, and it yields while Parousia Desktop is connected or still being tried, which then shows Discord itself: it never connects or probes port 6969 until Desktop has failed to answer, and lets go the moment Desktop connects. The end-to-end scripts turn it off in their test browsers, so they never touch a real app someone's Discord status depends on.

Extension pages carry an explicit Content Security Policy, `script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:57179 ws://127.0.0.1:6969`. Firefox's default MV3 policy includes `upgrade-insecure-requests`, which silently turns `ws://` into `wss://`; `connect-src` also limits extension pages to Desktop and Discord-RPC-Extension's app.

The Chromium manifest also declares `externally_connectable.ids` scoped to Discord-RPC-Extension's own published id (see Compatibility below), Chrome-only; Firefox has never implemented that manifest key at all, so the real, cross-browser restriction lives in code, not the manifest.

The userscript grants itself only `GM_registerMenuCommand` (its "Parousia Desktop status" command), and runs in the manager's isolated world (`@inject-into content`, `@sandbox DOM`) so the page can't patch the WebSocket it uses. Greasemonkey 4 has no menu commands, so it isn't supported.

## Communication

The background script owns the one connection to Parousia Desktop (`src/core/desktop-connection.ts`), a WebSocket to `ws://127.0.0.1:57179/ws` (`src/core/channel.ts`) carrying a small protocol (`src/core/desktop-protocol.ts`): `hello`, Desktop's `welcome` or `reject`, then Presence, each with the platforms it may be shown on (Settings > Platforms). Desktop decides who it talks to from the WebSocket `Origin`, which the browser sets; there's nothing to pair. `project/architecture.md` (Communication Protocol) has the details and `project/threat-model.md` the reasoning.

It only connects while something needs Desktop: an Activity is being reported, or the popup or dashboard is open. It lets go 30 seconds later. While an Activity is shared, the background calls `runtime.getPlatformInfo()` every 20 seconds so MV3 doesn't stop it (Firefox stops an event page even with a busy WebSocket open). Retries come every 10 seconds on in-memory timers and stop entirely when nothing needs Desktop. The popup and dashboard never open a connection of their own; they hold a port to the background script (`src/core/ui-port.ts`), which keeps the connection up while they're open and carries its state, Desktop's status report, and settings changes.

Getting connected:

- **The Chrome Web Store build** of the Chromium extension will be recognized out of the box once its listing is up.
- **Development builds and every Firefox install** (its `moz-extension://` origin is random per install) reach Desktop by an origin it has to be told about, once. The popup shows "Not allowed by Parousia Desktop" with the exact command (`Parousia-Desktop allow chrome-extension://…`), and the tray's Diagnostics → Refused menu has a one-click "Allow". `bun run dev` gives the Chromium build a stable id (from a per-machine key in `.dev-key.json`) and prints it.
- **The userscript** connects only after "Allow userscripts" is turned on in Desktop (tray, the extension's Settings, or `Parousia-Desktop set userscripts on`). Its manager menu's "Parousia Desktop status" says whether it's connected and how to allow it.

`bun run desktop:verify` checks the whole link with playwright-core's isolated Chromium and the Desktop debug build (`cargo build` in `desktop/` first), in a throwaway data directory: Desktop absent and starting later, an unrecognized build refused and then allowed, two browsers at once, an abadima.dev page (served by the test) reaching Discord and following Settings > Platforms, disallowing connected browsers, userscripts off and then allowed, hostile input, a second launch, Desktop stopping, and letting go when idle. `bun run real:verify` covers installed browsers on this machine (Firefox Developer Edition over WebDriver BiDi, the Flatpak Ungoogled Chromium over CDP, the userscript in Violentmonkey), runs Desktop with its tray, opens the real jena.systems in both browsers, and holds that for `HOLD_MINUTES` (3 by default) with no extension page open, which checks the MV3 background keepalive. Both need port 57179 free, and both give Desktop a fake Discord (`scripts/e2e/fake-discord.mjs`), never a real one. Jena Hub comes from parousia-project/activities, so the build they check needs those sources (`bun run activities:fetch`, or `PAROUSIA_ACTIVITIES_DIR`).

`bun run youtube:verify` watches PreMiD's real YouTube and YouTube Music Activities on the real sites (it needs the network and port 57179, and gives Desktop a fake Discord): a video loading and playing, paused and resumed, a navigation that doesn't reload, a full reload, and YouTube Music. `bun run fallback:verify` checks that Discord-RPC-Extension's app (port 6969) is only a fallback: with a dashboard open it is never contacted while Desktop is connected, takes over when Desktop stops, and lets go when Desktop returns. It runs in a private network namespace (`unshare -rn`), so neither port needs to be free and a real app is never touched. `bun run malsync:firefox` checks MAL-Sync support in Firefox with a stand-in extension under MAL-Sync's own Firefox id (its background is the shipped build's relay, its content script answers like MAL-Sync's on an episode): the reply reaching Discord through Desktop under MAL-Sync's own Application with nothing of the page's address, the switch, a page it has nothing for being asked four times and then left alone, and MAL-Sync not being installed. It runs in a private network namespace too. `bun run real-extensions:fetch` (needs the network, once) caches the store builds of the real MAL-Sync and Discord-RPC-Extension and Discord-RPC-Extension's app, and `bun run malsync:real` runs them in Chromium and Firefox beside Parousia and Desktop (`MALSYNC_BROWSER=chromium` or `firefox` for one), in three sessions: beside Discord-RPC-Extension (what MAL-Sync does alone, next to Parousia's Activity, with MAL-Sync support on, under Share Media Details, and with MAL-Sync's own Discord setting off), without Discord-RPC-Extension, and without Parousia Desktop (Parousia's link and MAL-Sync taking the app's one slot from each other).

`bun run activities:verify` builds its own copy (PreMiD's Activities, the native test ones in `scripts/activities/fixtures/parousia`, and a native DiscordJS Guide written by the check, so one website is in both sources) and checks, in playwright-core's isolated Chromium with Desktop and a fake Discord: the website in both sources listed once, the native one running until PreMiD's is chosen, then only PreMiD's, as its own Discord Application; a real, unmodified PreMiD Activity (DiscordJS Guide, which reads the page's `<h1>`) following a change on the page; that PreMiD code in a content script can't reach the extension's storage or use the dashboard's port; Settings > Privacy withholding what's playing for every Activity; an Activity that's on without its site unavailable, with the popup, its card, and its page saying why; a native Activity that reads pages turned on from the popup, and Parousia's collector reading the page's Media Session; "Configure activity" in the popup; the Default Activity from its dashboard tab; Settings > Site access showing only the all-websites switch; and the layout from 360 to 2560 pixels wide. `ACTIVITIES_BROWSER=flatpak bun run activities:verify` runs the same checks in the Flatpak Ungoogled Chromium installed on this machine. `bun run activities:firefox` checks the same features in the installed Firefox Developer Edition: a PreMiD Activity reaching Discord, the storage API gone from PreMiD's world, the popup for an Activity without its site, and the Default Activity. A browser grants a site only through a prompt automation can't answer, so these builds' manifests already hold the sites they test.

`bun run bench` measures what Parousia costs on this machine (package sizes; Desktop's startup, memory, threads, CPU, and wakeups idle, with three clients, and publishing; the extension background's heap and its process's memory and CPU idle and while sharing; how long a detected Activity takes to reach Discord; how long the popup and dashboard take to show) and prints JSON; `BENCH_DIST` and `PAROUSIA_DESKTOP_BIN` point it at other builds to compare.

`bun run discord:verify` is the one check against a real Discord: the extension on the real jena.systems, through Desktop, on the Discord account signed in on this machine, for `HOLD_SECONDS` (20 by default), then cleared. It refuses to run unless Discord's socket directory is named: `PAROUSIA_REAL_DISCORD_IPC_DIR="$XDG_RUNTIME_DIR" bun run discord:verify` (for the Flatpak Discord, `"$XDG_RUNTIME_DIR/app/com.discordapp.Discord"`).

**On Windows**, the checks use the same scripts. Desktop's own folders can't be moved by an environment variable there, so they set `PAROUSIA_DATA_DIR`, and the fake Discord is a named pipe (`PAROUSIA_DISCORD_IPC_PIPE`) instead of a directory. Point them at a Desktop build with `PAROUSIA_DESKTOP_BIN` (the `.exe` is the default under `desktop/target/debug`), and at a build of the extension made outside a synced folder with `PAROUSIA_BUILD_DIR`. `discord:verify` takes Discord's pipe up to its number: `$env:PAROUSIA_REAL_DISCORD_IPC_DIR = '\\.\pipe\discord-ipc-'; bun run discord:verify`. Desktop's tray, `Start at login`, single instance, CLI pipe, and port are checked with the real release build and the real Windows tray by `desktop/scripts/verify-windows.ps1` (see `desktop/README.md`).

## Themes

The popup and dashboard come in three themes, chosen in Settings > Appearance: Atelier (the default, Parousia's own palette), Botanique, and Monolith. All of them live in `src/shared/theme.css` as CSS custom properties, in two layers. Each theme block sets the same full set of primitives (backgrounds, text, accent, status colors, focus, control outlines, radii), and a shared block derives washes and lines from them with `color-mix()`. Components use tokens only; `scripts/contrast.test.ts` fails on a color written anywhere else. A theme applies through `data-theme` on `<html>`, or on any element inside it, which is how each theme's preview is drawn in its own colors.

The choice is stored under its own `theme` key in `chrome.storage.local`, apart from Preferences, so changing it doesn't wake the background's presence work. `theme.js`, a classic script in each page's `<head>`, applies a copy cached in `localStorage` before the first paint, then storage's answer, then every change from other views. The cache is only a cache: when a browser clears it, storage restores it on the next open.

`bun run contrast` resolves every theme's tokens the way the cascade does and measures each text and non-text pair the views draw (text, badges and pills, buttons and their hover, focus rings, field outlines, selected states, switch knobs, status dots) against WCAG 2.2 AA; the same check runs in `bun test`. `bun run themes:verify` checks the built extension in automation Chromium: keyboard choice, persistence, the first paint, other views following, previews staying in their own theme, the contrast of every text actually rendered on 11 dashboard pages and 3 popup views in each theme, a focus ring on every Tab stop, and `prefers-reduced-motion`. `THEME_SHOTS=<dir>` also saves screenshots.

## Activities

Activities come from two repositories, each followed at its `main` branch (`activity-sources.json` names the repository and branch) and checked out under `.cache/activities/` by `bun run activities:fetch` (and every build and `activities:check`, first, so an extension is always made from each repository's newest commit; `PAROUSIA_ACTIVITIES_OFFLINE=1` skips the network and uses what's fetched), which records the revision it reached and never replaces a working copy with a failed fetch: Parousia's own ([parousia-project/activities](https://github.com/parousia-project/activities)) and PreMiD's ([PreMiD/Activities](https://github.com/PreMiD/Activities)). Both file one folder per website, `websites/<letter>/<Name>/`, and both go through one pipeline (`scripts/activities/`): the same walk, an adapter per source that maps a folder onto one draft, one module (`metadata.ts`) that turns it into the same manifest (`src/activities/manifest.ts`), one catalog, one matcher, one settings model, and one site-access model. A website in both sources (the same folder name) is listed once, and only the implementation chosen on its page runs, the native one until PreMiD's is picked. Nothing is downloaded at runtime.

- **Native** Activities export `detect(page, settings)` and see the URL and title, plus the page data they declare (`media`, `thumbnails`), read by Parousia's own collector (`src/activities/collector.ts`) on sites the user granted; one that declares page data is off until turned on, which asks for its sites. They're bundled in through a generated module, `parousia:activities`. A problem with one stops the build, and `activities:check` type-checks each against `src/core/api.ts`.
- **PreMiD's** are compiled unchanged into `activities/premid/<name>.js` and run on Parousia's `Presence`/`iFrame` (`src/premid/page.ts`). Their `regExp` is the matcher, every `clientId` in their source is kept, their settings map into Parousia's, and their language picker is fixed to English (their strings are translated on PreMiD's own service, which Parousia doesn't call; only their `metadata.json` descriptions are, in the views' languages, as `activities/descriptions/<language>.json`). Ones that need their own npm packages, name no client id, target API version 2, are on PreMiD's DMCA list, or assign page text to `innerHTML` (VLC, TLX Toki, Weverse: `UNSAFE_MARKUP` in `scripts/activities/premid.ts`) are left out, and `activities:check` lists each with its reason. They're only in the extensions, not the userscript.
- **Packaged** as one `catalog.json` (what the dashboard lists and searches), manifests in a file per first letter of the Activity's name (`activities/manifests/<letter>.json`, found from an id alone, and without the description and keywords the catalog already holds), and a text host index (`hosts.txt`, searched as text so the popup never builds an object for every site). `src/activities/manifest.ts` has the formats and their readers.

`src/activities/host.ts` runs what both kinds need in the active tab's page, and turns what comes back into the page the runtime hands the Activity (see `project/architecture.md`, Activity System Architecture). To build with a local checkout instead of the fetched one, set `PAROUSIA_ACTIVITIES_DIR` or `PREMID_ACTIVITIES_DIR`.

## Languages

The popup and dashboard are in English, German, French, Japanese, Romanian, Russian, Swedish, and Simplified Chinese; Settings > General chooses one, and "Automatic" follows the browser's. `src/core/i18n.ts` holds the mechanism: English is the string written in the code (`t("Show {name}", { name })`, `tn(n, "{n} Activity", "{n} Activities")` for plurals, `msg("…")` where a string is defined away from where it shows), so English costs nothing to load, and every other language is `src/locales/<code>.json`, mapping each English string to its translation, which a view fetches once when it opens (`src/shared/language.ts`). The fixed text of `popup.html` and `fullscreen.html` is translated the same way, by its words, with no markup. A change of language reloads the other open views. Activity names and descriptions come from the Activities themselves, except PreMiD's descriptions (see Activities). `scripts/i18n.test.ts` finds every marked string and every line of fixed page text, and fails when a language lacks one, keeps one the code no longer uses, changes a `{name}` a string fills, or lacks a plural form its language has. To add a language, add its code to `LANGUAGES` (`src/core/i18n.ts`) and its name to `LANGUAGE_NAMES`, then write its file; the test says what's missing.

**Why not the browsers' own `i18n` (`_locales`)?** It was weighed against this and not adopted (measured on the current strings):

- It follows the browser's interface language and nothing else, so Settings > General's choice of a language (and `<html lang>`) couldn't exist, and Automatic would be the only mode. It has no plurals (a message per form, picked in code anyway), names every message by an id of letters, digits, and `_` (so the 260 strings and the 225 places that use them would need ids, and `t("Retry Connection")` stops reading as what it shows), and can't translate a page's HTML, so `translateTree` would stay.
- It needs a complete `en` file as the default locale, and the browser keeps the whole active locale and the default in memory for the extension. The same strings in its format are 149 KB across English and the five other languages against 96 KB here (about 25 KB a language, plus 26 KB for English), and the packed size is no better: a zip compresses both alike.
- PreMiD's 1,400 translated descriptions can't go in it at all: they would all be held in memory for as long as the extension runs. They stay in `activities/descriptions/<language>.json`, fetched when a view needs them.
- `_locales` can't be compressed, deduplicated, or shared between languages, since each locale file must hold its own messages, and the browser reads it as it is. What it can get is what the build already does for these files with no runtime cost: `scripts/locales.ts` minifies each locale and leaves out strings that are their own translation, which takes the six files from 118 KB to 110 KB.
- What native `i18n` would add is a translated extension description in the browser's extension list. It's one sentence, and it would need a `default_locale`, placeholders in both manifests, and a special case for the userscript's header, so it isn't done.

## Compatibility

`src/compat/discord-rpc-extension.ts` implements Discord-RPC-Extension's presence protocol (Chromium and Firefox only), so Parousia's Activity detection can drive Discord Rich Presence through that project's existing Desktop bridge without needing Parousia Desktop. It's fully wired but inert until `DISCORD_RPC_EXTENSION_CLIENT_ID` is chosen (see `project/roadmap.md`, Compatibility). The same file maps an Activity to Discord's fields (`toDiscordPresence`) with the rules Desktop's Discord adapter uses, both tested against `adapters/discord/activity-mapping.json`. See `project/architecture.md`'s Compatibility Layer section for the full protocol writeup and how Parousia coexists with Discord-RPC-Extension's own server.

`src/compat/malsync.ts` takes what the MAL-Sync extension recognizes on a page (title, episode, cover, progress) as the Activity, when it's turned on in Settings > Platforms (it's off by default). MAL-Sync doesn't use Discord-RPC-Extension's app: it answers that extension's browser extension when asked, so Parousia asks the same way (`runtime.sendMessage(<MAL-Sync's id>, { tab, info })`) for the shared tab, and the reply, parsed and bounded like a PreMiD Activity's report, goes into the runtime through `RuntimeOptions.external`. Only a tab number is sent, nothing new is listened for, and no permission or `externally_connectable` entry is added. It asks when the shared tab's address changes (four times, over 25 seconds, where MAL-Sync has nothing) and every 15 seconds while MAL-Sync has something to show; with it off, or nothing to share, nothing runs. It's tested in `src/compat/malsync.test.ts` and `src/platforms/background.test.ts` against the shape of MAL-Sync's reply (from its source and shipped build), not against a live MAL-Sync (see `project/compatibility.md` and `project/roadmap.md`).

## Popup

`src/popup/` is the toolbar popup shown via the `action` key in each extension manifest. It shows the Activity the background script is sharing, which the background pushes over the popup's port with every change, so it's exactly what reaches Desktop (a PreMiD Activity's report included) after Privacy settings. Its footer shows the Desktop connection, and when something's wrong, what to do about it (start Desktop, allow this build with the exact origin, or update a mismatched version). The userscript target has no popup, since it has no browser action to attach one to; its manager's menu has the status command instead.

## Fullscreen

`src/fullscreen/` is a larger, standalone presence view opened as its own tab via the popup's expand control (`chrome.tabs.create` to `fullscreen.html`, not a popup). It renders the Activity the same way the popup does, through `src/shared/presence-view.ts`; see `project/architecture.md`'s "Full-Screen Presence View" section.

It's split into pages, one rendered at a time and addressed by the URL hash: **Overview** (`#overview`: the current activity and Parousia Desktop's status and version), **Activities** (`#activities?q=…&filter=…&page=…`: the Activity catalog, searched, filtered, and paged so only one page of cards is ever in the DOM, sized for PreMiD's 1,400+; `#activities/<id>` is one Activity's page, with its switch and settings), and **Settings** (`#settings/<category>`, the same pages as the popup's Settings). On the Activities page, enabled Activities come first and disabled ones after, each by name. The Filter button beside the search offers Enabled, Disabled, Parousia Activities, and PreMiD Activities (choices within a group add up, the two groups narrow each other). "Enable or disable all…" under the search applies to everything the search and filters match, asks a second time, and for enabling warns that the browser will ask for that many sites in one prompt; a decline leaves those Activities off. The logic is in `src/shared/activity-list.ts` and `src/shared/activity-catalog.ts` (`bulkPlan`, `enableAll`, `disableAll`), tested without a DOM, and `bun run activities:verify` drives the page in a real browser. Overview mentions Discord-RPC-Extension's app only until Parousia Desktop is connected; its status stays in Settings > Platforms. Diagnostics aren't in the extension at all; they're Desktop's (its tray and `Parousia-Desktop status`). Desktop only accepts setting changes from a connection it knows is this OS user's; otherwise Settings points to `Parousia-Desktop set` or Desktop's console.
