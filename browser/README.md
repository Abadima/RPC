# browser

Parousia's browser extension and userscript, built with [Bun](https://bun.com) and strict TypeScript.

## Setup

```bash
bun install
bun run activities:fetch   # Activity sources, at each pinned revision
```

## Commands

```bash
bun run build         # build every target into dist/
bun run dev           # build, then rebuild on change
bun run typecheck     # tsc --noEmit
bun run lint          # oxlint
bun run format        # oxfmt
bun run format:check  # oxfmt --check
bun test              # unit tests

bun run activities:fetch   # move each Activity source to its pinned revision (builds do this too; a failed fetch keeps the copy it has)
bun run activities:check   # check and compile every Activity; list the PreMiD ones left out, and why

bun run firefox:setup      # once: fetch an isolated automation Firefox
bun run firefox:lint       # web-ext lint of dist/firefox
bun run firefox:verify     # lint, then install and run dist/firefox in real Firefox
bun run chromium:setup     # once: fetch an isolated automation Chromium
bun run desktop:verify     # the browser-to-Desktop link, end to end, in automation Chromium (Linux, Windows)
bun run real:verify        # the same against installed browsers: Firefox, Flatpak Chromium, Violentmonkey
bun run discord:verify     # one Activity on a real Discord (opt-in, see below)
bun run activities:verify  # Activities, the popup, and the dashboard, end to end (Linux, Windows)
bun run activities:firefox # the same features in an installed Firefox Developer Edition
bun run languages:verify   # every language in the popup and dashboard, and a change reaching an open view
bun run store check        # the Web Store and Add-ons listing text: limits, leftover English, the screens' terms
bun run store export       # write what the two dashboards take to dist/store/ (see store/README.md)
bun run bench              # sizes, memory, CPU, and latency, as JSON
bun run contrast           # WCAG 2.2 AA contrast of each theme's tokens, as a table
bun run themes:verify      # each theme on every popup and dashboard view
```

## Build Targets

`bun run build` writes one folder per target under `dist/`. Each is a self-contained, minified bundle with its `manifest.json`:

| Target       | Output             | Distribution                                                                                                                            |
| ------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `chromium`   | `dist/chromium/`   | Chrome Web Store. The same Manifest V3 package runs in other Chromium browsers; there's no separate Edge build or Edge Add-ons listing. |
| `firefox`    | `dist/firefox/`    | Firefox Add-ons (inspectable).                                                                                                          |
| `userscript` | `dist/userscript/` | `parousia.user.js`, installed through a userscript manager (Violentmonkey, Tampermonkey, ScriptCat)                                     |

`dist/chromium.zip` and `dist/firefox.zip` hold the same files, zipped at the root and ready for a store or a release. `dist/userscript/parousia.user.js.gz` is the userscript, precompressed for mirrors. Managers install the plain `.user.js`.

There's no Safari target. The code uses standard `chrome.*` APIs, so one is possible later, but nothing builds or releases it.

Manifests live in `manifests/` and must declare `"manifest_version": 3`, which the build checks. `dist/` is cleared before every build, so the zips are always rebuilt, never patched.

JS is minified with Bun's own `--minify`, with no minifier dependency: `chromium.js` goes from 197 KB to 114 KB (44 KB to 34 KB gzipped), most of it the 22 native Activities. Adding `uglify-js` saved only about 3.5% more gzipped in earlier tests, which isn't worth a dependency. `DesktopConnection` uses `#private` members because Bun shortens those but not ordinary property names.

The zips come from a small writer with no dependencies (`scripts/zip.ts`, using `node:zlib`), because `Bun.Archive` writes only tar and gzip and stores need a real `.zip`. It sorts entries and fixes timestamps, so the same files always give the same archive.

The userscript is minified the same way (127 KB to 78 KB, 22 KB gzipped) and keeps its `==UserScript==` header. The native Activities' manifests inside the background and the userscript leave out the words only the views show (descriptions, versions, setting titles), which the views read from the packaged catalog and manifests instead. Dropping `console` calls would save 27 bytes but silence the logger, so they stay.

## Firefox Verification

`bun run firefox:verify` (run `firefox:setup` once first) installs `dist/firefox` as a temporary add-on in an isolated Firefox and checks that it loads. It never touches a system Firefox. `firefox:setup` downloads a separate automation build, so nothing can interact with a real browser session.

web-ext's RDP client can't read the background page's console, and WebDriver BiDi never logs its entries. `bun run real:verify` covers what the background does in Firefox: it drives an installed Firefox over WebDriver BiDi, opens the popup and dashboard, and connects to Desktop.

## Permissions

The extension requests `tabs`, which gives the `url` and `title` that Activities match on without page-content access, and `storage`. Reaching Desktop needs no permission. It's a WebSocket to `127.0.0.1`, allowed by the CSP below.

`storage` holds only the user's settings in `chrome.storage.local`: Privacy, Platforms, Language, each Activity's on/off and settings, and the Default Activity. Chromium's `setAccessLevel` keeps content scripts out of it, and PreMiD's runtime removes the storage API from the world its code runs in, in every browser. Nothing about browsing is stored, and there's no `alarms` permission. No `host_permissions` or static content scripts are declared: native Activities read only the URL and title.

Reading a page takes site access, and it's always explicit. Turning on an Activity that reads pages asks the browser for its sites, from the same click. If declined, the Activity stays off and says why. If access is taken back later, the Activity is unavailable on that site until access is granted again ("Allow access" in the popup or on its page).

Settings > Site access has "Access your data for all websites": off by default, and asked for only by its own switch. Individual sites aren't listed there, because the browser owns those grants, and a list in Parousia could disagree with the browser's own. Both kinds are optional permissions (`optional_host_permissions: ["*://*/*"]`, plus `scripting`), so nothing is granted at install. Turning an Activity off gives back the sites no other Activity that's on needs, and `scripting` once none does. What Activities may read (what's playing, thumbnails, creator icons) is one choice for all of them, in Settings > Privacy.

Without Parousia Desktop, Discord still works through Discord-RPC-Extension's app (`discord_rpc_ext`), if it's running. The extension connects to `ws://127.0.0.1:6969` and sends only Rich Presence (`src/compat/discord-rpc-server.ts`, `project/architecture.md`). It's on by default and switched in Settings > Platforms. It yields while Parousia Desktop is connected or being tried, so Discord shows Desktop's presence. It doesn't connect to or probe port 6969 until Desktop has failed to answer, and it lets go as soon as Desktop connects. The end-to-end scripts turn it off in their test browsers, so they never touch a real app.

Extension pages carry an explicit CSP: `script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:57179 ws://127.0.0.1:6969 https://api.github.com`. Firefox's default MV3 policy adds `upgrade-insecure-requests`, which silently turns `ws://` into `wss://`, so the policy is set explicitly. `connect-src` limits extension pages to Desktop, the Discord-RPC-Extension app, and the GitHub request below.

Apart from the dashboard's Activity icons (remote logos, loaded lazily with no referrer, with a letter as the fallback), the only request to anyone other than the local computer is the update check (`src/shared/latest-desktop.ts`). Desktop and the extension are versioned separately, so a newer extension beside an older Desktop is the normal result of a release, not a reason to say "update Desktop". When a popup or dashboard needs it, it asks `api.github.com/repos/Abadima/RPC/releases/latest` for the Desktop version named in the release notes (`<!-- parousia-desktop: 1.0.3 -->`, written by the release workflow), and says so only if that version is newer than the connected one. The request is unauthenticated and sends no cookies, referrer, or identifier. It runs at most once a day, or an hour after a failure, and the answer is cached in `chrome.storage.local`. If the request fails or the notes name no version, nothing is shown.

The Chromium manifest also scopes `externally_connectable.ids` to Discord-RPC-Extension's own id (see Compatibility). That's Chrome only. Firefox has never implemented the key, so the real cross-browser check is in code.

The userscript requests only `GM_registerMenuCommand` (its "Parousia Desktop status" command). It runs in the manager's isolated world (`@inject-into content`, `@sandbox DOM`), so the page can't patch the WebSocket it uses. Greasemonkey 4 has no menu commands, so it isn't supported.

## Communication

The background script owns the one connection to Parousia Desktop (`src/core/desktop-connection.ts`): a WebSocket to `ws://127.0.0.1:57179/ws` (`src/core/channel.ts`). It carries a small protocol (`src/core/desktop-protocol.ts`): `hello`, then Desktop's `welcome` or `reject`, then presence, each with the platforms it may be shown on (Settings > Platforms). Desktop decides who it talks to from the WebSocket `Origin`, which the browser sets. There's nothing to pair. `project/architecture.md` (Communication Protocol) has the details, and `project/threat-model.md` the reasoning.

The connection opens only while something needs Desktop: an Activity is being reported, or the popup or dashboard is open. It closes 30 seconds after that stops. While an Activity is shared, the background calls `runtime.getPlatformInfo()` every 20 seconds so MV3 doesn't stop it, since Firefox stops an event page even with a busy WebSocket open. Retries come every 10 seconds on in-memory timers and stop when nothing needs Desktop. The popup and dashboard never open a connection of their own. They hold a port to the background (`src/core/ui-port.ts`), which keeps the connection up while they're open and sends back its state, Desktop's status report, and settings changes.

Getting connected:

- **The Chrome Web Store build** of the Chromium extension is recognized out of the box.
- **Development builds and every Firefox install** reach Desktop through an origin Desktop has to be told about, once. Firefox's `moz-extension://` origin is random per install. The popup shows "Not allowed by Parousia Desktop" with the exact command (`Parousia-Desktop allow chrome-extension://…`), and the tray's Diagnostics → Refused menu has a one-click "Allow". `bun run dev` gives the Chromium build a stable id (from a per-machine key in `.dev-key.json`) and prints it.
- **The userscript** connects only after "Allow userscripts" is on in Desktop (tray, the extension's Settings, or `Parousia-Desktop set userscripts on`). Its manager menu's "Parousia Desktop status" says whether it's connected and how to allow it.

`bun run desktop:verify` checks the whole link in playwright-core's isolated Chromium, using the Desktop debug build (run `cargo build` in `desktop/` first) and a throwaway data directory. It covers Desktop absent and then starting, an unrecognized build refused and then allowed, two browsers at once, a test page on abadima.dev (served by the test) reaching Discord and following Settings > Platforms, disallowing connected browsers, userscripts off and then on, hostile input, a second launch, Desktop stopping, and the link letting go when idle.

`bun run real:verify` runs the same kind of checks against installed browsers: Firefox Developer Edition over WebDriver BiDi, Flatpak Ungoogled Chromium over CDP, and the userscript in Violentmonkey. It runs Desktop with its tray, opens the real jena.systems in both browsers, and holds for `HOLD_MINUTES` (3 by default) with no extension page open, which tests the MV3 keepalive. Both need port 57179 free, and both give Desktop a fake Discord (`scripts/e2e/fake-discord.mjs`), never a real one. Jena Hub comes from parousia-project/activities, so these builds need those sources (`bun run activities:fetch`, or `PAROUSIA_ACTIVITIES_DIR`).

More checks:

- `bun run youtube:verify` watches PreMiD's real YouTube and YouTube Music Activities on the real sites. It needs the network and port 57179, and gives Desktop a fake Discord. It checks loading, play, pause and resume, a navigation without a reload, a full reload, and YouTube Music.
- `bun run fallback:verify` checks that Discord-RPC-Extension's app (port 6969) is only a fallback. With a dashboard open, it's never contacted while Desktop is connected. It takes over when Desktop stops and lets go when Desktop returns. It runs in a private network namespace (`unshare -rn`), so neither port needs to be free and no real app is touched.
- `bun run malsync:firefox` checks MAL-Sync support in Firefox, with a stand-in extension under MAL-Sync's Firefox id. Its background is the shipped build's relay, and its content script answers like MAL-Sync's on an episode. It checks that the reply reaches Discord through Desktop under MAL-Sync's own Application without the page's address, the switch, a page with nothing to show that's asked four times and then left alone, and MAL-Sync not being installed. It also runs in a private network namespace.
- `bun run real-extensions:fetch` (needs the network, once) caches the store builds of MAL-Sync, Discord-RPC-Extension, and its app. `bun run malsync:real` runs them in Chromium and Firefox beside Parousia and Desktop (`MALSYNC_BROWSER=chromium` or `firefox` for one), in three sessions: beside Discord-RPC-Extension (MAL-Sync alone, next to Parousia's Activity, with MAL-Sync support on, under Share media details, and with MAL-Sync's own Discord setting off); without Discord-RPC-Extension; and without Parousia Desktop, where Parousia's link and MAL-Sync take turns with the app's one slot.
- `bun run activities:verify` builds its own copy: PreMiD's Activities, the native test ones in `scripts/activities/fixtures/parousia`, and a native DiscordJS Guide that the check writes, so one website is in both sources. It runs in playwright-core's isolated Chromium with Desktop and a fake Discord, and checks:
  - the website in both sources listed once; the native Activity running until PreMiD's is chosen, then only PreMiD's, under its own Discord Application
  - a real, unmodified PreMiD Activity (DiscordJS Guide, which reads the page's `<h1>`) following a change on the page
  - PreMiD's code in a content script can't reach the extension's storage or the dashboard's port
  - Settings > Privacy withholding what's playing from every Activity
  - an Activity that's on without access is unavailable, and the popup, its card, and its page say why
  - a native Activity that reads pages, turned on from the popup, and the collector reading the page's Media Session
  - "Configure Activity" in the popup, and the Default Activity from its dashboard tab
  - Settings > Site access showing only the all-websites switch
  - the layout from 360 to 2560 pixels wide

  `ACTIVITIES_BROWSER=flatpak bun run activities:verify` runs the same checks in the installed Flatpak Ungoogled Chromium. `bun run activities:firefox` checks the same features in the installed Firefox Developer Edition: a PreMiD Activity reaching Discord, the storage API gone from PreMiD's world, the popup for an Activity without its site, and the Default Activity. A browser grants a site only through a prompt automation can't answer, so these builds' manifests already list the sites they test.

- `bun run activities:verify` also covers Show media presence with a tab that really makes sound: the song staying on a site without an Activity, a song skipped in a hidden tab, two players, the background restarting, and the popup beside kept music and beside the Default Activity.
- `bun run bench` measures the cost: package sizes; Desktop's startup, memory, threads, CPU, and wakeups, idle, with three clients, and while publishing; the background's heap, and its process's memory and CPU, idle and while sharing; how long a detected Activity takes to reach Discord; and how long the popup and dashboard take to show. It prints JSON. `BENCH_DIST` and `PAROUSIA_DESKTOP_BIN` point it at other builds to compare.

`bun run discord:verify` is the one check against a real Discord. It runs the extension on the real jena.systems, through Desktop, on the Discord account signed in here, for `HOLD_SECONDS` (20 by default), then clears the status. It won't run unless Discord's socket directory is named: `PAROUSIA_REAL_DISCORD_IPC_DIR="$XDG_RUNTIME_DIR" bun run discord:verify`. For the Flatpak Discord, use `"$XDG_RUNTIME_DIR/app/com.discordapp.Discord"`.

**On Windows**, the checks use the same scripts. Desktop's folders can't be moved by an environment variable there, so the checks set `PAROUSIA_DATA_DIR` instead. The fake Discord is a named pipe (`PAROUSIA_DISCORD_IPC_PIPE`), not a directory. Set `PAROUSIA_DESKTOP_BIN` to a Desktop build (the `.exe` under `desktop/target/debug` is the default), and `PAROUSIA_BUILD_DIR` to an extension build made outside a synced folder. `discord:verify` takes Discord's pipe up to its number: `$env:PAROUSIA_REAL_DISCORD_IPC_DIR = '\\.\pipe\discord-ipc-'; bun run discord:verify`. `desktop/scripts/verify-windows.ps1` checks Desktop's tray, start at login, single instance, CLI pipe, and port, using the real release build and the real Windows tray (see `desktop/README.md`).

## Themes

The popup and dashboard come in three themes, chosen in Settings > Appearance: Atelier (the default, Parousia's own palette), Botanique, and Monolith. They live in `src/shared/theme.css` as CSS custom properties, in two layers. Each theme block sets the same primitives (backgrounds, text, accent, status colors, focus, control outlines, radii), and a shared block derives washes and lines from them with `color-mix()`. Components use tokens only: `scripts/contrast.test.ts` fails on a color written anywhere else. A theme applies through `data-theme` on `<html>` or on any element inside it, which is how each theme's preview is drawn in its own colors.

The choice is stored under its own `theme` key in `chrome.storage.local`, apart from Preferences, so changing it doesn't wake the background. `theme.js`, a classic script in each page's `<head>`, applies a copy cached in `localStorage` before the first paint, then storage's value, then every later change from other views. The cache is only a cache. When a browser clears it, storage restores it on the next open.

`bun run contrast` resolves each theme's tokens the way the cascade does, and measures every text and non-text pair the views draw (text, badges, buttons and their hover state, focus rings, field outlines, selected states, switch knobs, status dots) against WCAG 2.2 AA. `bun test` runs the same check. `bun run themes:verify` checks the built extension in automation Chromium: keyboard choice, persistence, first paint, other views following a change, previews staying in their own theme, the contrast of text rendered on 11 dashboard pages and 3 popup views in each theme, a focus ring on every Tab stop, and `prefers-reduced-motion`. `THEME_SHOTS=<dir>` also saves screenshots.

## Activities

Activities come from two repositories, each pinned to the revision its build was reviewed against (`activity-sources.json` names each repository, branch, and pinned revision):

- Parousia's own: [parousia-project/activities](https://github.com/parousia-project/activities)
- PreMiD's: [PreMiD/Activities](https://github.com/PreMiD/Activities)

`bun run activities:fetch` checks them out under `.cache/activities/`, at their pins. Every build and `activities:check` runs it first and refuses anything else: code not reviewed at the pin doesn't enter an extension. The fetch says when a repository's `main` has moved past a pin. A pin moves only when someone edits `activity-sources.json` to a revision they reviewed, never with the next fetch. `PAROUSIA_ACTIVITIES_OFFLINE=1` skips the network and uses what's already fetched (which stays at its pin). A fetch records the revision it reached and never replaces a working copy with a failed one. Both repositories keep one folder per website at `websites/<letter>/<Name>/`, and both go through one pipeline (`scripts/activities/`): one walk, an adapter per source that maps a folder onto a draft, one module (`metadata.ts`) that turns it into the shared manifest (`src/activities/manifest.ts`), then one catalog, one matcher, one settings model, and one site-access model. A website in both sources (same folder name) is listed once, and only the implementation chosen on its page runs. That's the native one until PreMiD's is picked. Nothing is downloaded at runtime.

- **Native** Activities export `detect(page, settings)`. They see the URL and title, plus the page data they declare (`media`, `thumbnails`), which Parousia's collector (`src/activities/collector.ts`) reads on sites the user granted. An Activity that declares page data stays off until it's turned on, which asks for its sites. They're bundled through a generated module, `parousia:activities`. A problem with one stops the build, and `activities:check` type-checks each against `src/core/api.ts`.
- **PreMiD's** Activities compile unchanged into `activities/premid/<name>.js` and run on Parousia's `Presence` and `iFrame` (`src/premid/page.ts`). Their `regExp` is the matcher, every `clientId` in their source is kept, and their settings map to Parousia's. Their language picker is fixed to English, since PreMiD translates its strings on its own service, which Parousia doesn't call. Only the `metadata.json` descriptions are translated, in the views' languages, as `activities/descriptions/<language>.json`. Activities that need their own npm packages, name no client id, target API version 2, are on PreMiD's DMCA list, assign page text to `innerHTML` (VLC, TLX Toki, Weverse, flagged `UNSAFE_MARKUP` in `scripts/activities/premid.ts`), or have a `regExp` that can take seconds to fail on a crafted address (`scripts/activities/redos.ts`) are left out, and so is one whose build would read a file outside its own folder or PreMiD's helper package (a path that climbs out, an absolute path, a package, or a symlink). `activities:check` lists each one with its reason. They're in the extensions only, not the userscript.
- **Packaged** as one `catalog.json`, which the dashboard lists and searches. Manifests are one file per first letter (`activities/manifests/<letter>.json`), found from an id alone, without the description and keywords the catalog holds. Each carries its Activity's version from `metadata.json`, which only that Activity's page shows. A text host index (`hosts.txt`) is searched as text, so the popup never builds an object per site. `src/activities/manifest.ts` has the formats and their readers.

`src/activities/host.ts` runs what both kinds need in the active tab's page, and turns the result into the page the runtime hands the Activity (see `project/architecture.md`, Activity System Architecture). To build from a local checkout instead of the fetched one, set `PAROUSIA_ACTIVITIES_DIR` or `PREMID_ACTIVITIES_DIR`.

## Media Presence

Settings > Privacy has "Show media presence" (`showMediaPresence` in the preferences), on by default. With it on, music or video that was playing in a tab that was shared stays shared while the tab being shared has no Activity of its own: a site without one, one whose Activity has nothing to show, or a browser page.

- **The order** is the tab's own Activity, then kept music or video, then the Default Activity (`PresenceRuntime`, its `media` hook).
- **What counts** is a tab whose Activity is on, presents as listening or watching or has an end time (`isMediaActivity`), and has sound playing, which the browser reports as `tab.audible`. A page can't claim it. A muted video or a video with no sound doesn't count. A paused tab stays remembered and counts again when it plays.
- **Which tab** is the one shared most recently (`MediaTabs`, `src/core/media-presence.ts`), not the one that changed last, so two players never trade places. Tabs are remembered only while they are the one shared, so a page's music is never shown without having been looked at. Closing the tab, stopping the sound, turning the Activity off, or turning the setting off ends it.
- **How it is read** is the same way as for the tab shared: `PresenceRuntime.detect` after the same switches, and `PageHost.peek` for what the tab's scripts last reported. Nothing is injected into a tab nobody is looking at, and an Activity that is off is never run (see `project/threat-model.md`, Disabled Activities).
- **A tab that is not shown** reads nothing, by default: the collector and the PreMiD runtime both pause while `document.hidden`, so a song skipped there would never reach Discord. The scripts of a remembered tab are told to keep reading (`PageHost.keepReading`, the `background` message), once a second as ever, and told to stop when the tab is forgotten. A script is told where it stands whenever it connects, so none stays stuck reading after the background restarts.
- **When the background restarts** (MV3 stops and starts it), the remembered tabs are written to `storage.session` (`mediaTabs`: tab numbers and nothing else, which last as long as the browser is open) as they change, and put back before they are first needed. Tabs that closed meanwhile are dropped when looked at. Off, nothing is written or brought back.
- **The popup** shows what is being shared, and beside it whether the current site has an Activity of its own, so it can be turned on or allowed without turning Show media presence off. `UiActivity.kept` says the music or video comes from another tab; `src/shared/site-offer.ts` decides what the popup says about the site.
- **Private tabs** follow Settings > Privacy > Private windows by their own flag. A kept tab that is private and paused keeps nothing.
- **Away from the browser**, sound in the kept tab keeps presence going, like sound in the tab shared.
- **Several browsers**: each sends an ordinary presence, and Desktop shows the one that changed most recently. Desktop is unchanged.

The tests are `src/core/media-presence.test.ts` (selection, order, restore), `src/core/runtime.test.ts` (order), `src/activities/host.test.ts` (`peek`, `keepReading`, startup, turn-off), `src/activities/collector.test.ts` and `src/premid/page.test.ts` (reading in a tab that is not shown), and the "Show media presence" tests in `src/platforms/background.test.ts` (transitions, several tabs, restarts, Activities that are off, private tabs, being away). `bun run activities:verify` runs the whole path in a real browser with a tab that really makes sound; headless Chromium never hides a tab, so the tab switch is played back into the extension's own world (`setHidden` in the script) and nothing else is simulated.

## Languages

The popup and dashboard are in English, Amharic, Arabic, Catalan, Dutch, Estonian, German, Greek, Spanish (Spain and Latin America), Persian, French, Japanese, Korean, Latvian, Lithuanian, Polish, Portuguese (Brazil and Portugal), Romanian, Russian, Slovenian, Swedish, Swahili, Turkish, and Simplified Chinese, the regional variants named the way the stores use them. Every language is complete. Arabic and Persian read right to left, but no view sets a text direction yet, so their layout isn't mirrored. Contributors are credited in `CONTRIBUTORS.md`. Settings > General chooses one, and Automatic follows the browser's region before its language (`pt-BR` on a `pt-BR` browser; Brazilian for other Portuguese regions, Latin American for the Latin American regions). `src/core/i18n.ts` holds the mechanism. English is the string written in the code: `t("Show {name}", { name })`, `tn(n, "{n} Activity", "{n} Activities")` for plurals, and `msg("…")` for a string defined away from where it's shown. English costs nothing to load. Every other language is `src/locales/<code>.json`, which maps each English string to its translation. A view fetches it once when it opens (`src/shared/language.ts`). The fixed text of `popup.html` and `fullscreen.html` is translated the same way, by its words. A language change reloads the other open views. Activity names come from the Activities themselves, except PreMiD's descriptions (see Activities).

`scripts/i18n.test.ts` finds every marked string and every line of fixed page text. It fails when a language lacks one, keeps one the code no longer uses, changes a `{name}` that a string fills, or lacks a plural form its language has. To add a language, add its code to `LANGUAGES` and its name to `LANGUAGE_NAMES` (both in `src/core/i18n.ts`), then write its file. The test lists what's missing. A language that's started but not finished can hold the English text as its values: it shows English and packs to almost nothing, since `scripts/locales.ts` drops entries equal to their key.

**Why not the browsers' own `i18n` (`_locales`)?** It was measured against this and not adopted:

- It follows the browser's language only, so Settings > General's choice (and `<html lang>`) couldn't exist. It has no plurals, and it needs an id made of letters, digits, and `_` for every message. The 260 strings and their 225 uses would all need ids, and `t("Retry connection")` would stop reading as what it shows. It also can't translate a page's HTML, so `translateTree` would stay.
- It needs a complete `en` file as the default, and the browser keeps the active locale and the default in memory. The same strings in its format are 149 KB across English and five other languages, against 96 KB here. The packed size is no better, because a zip compresses both alike.
- PreMiD's 1,400 translated descriptions would all stay in memory for as long as the extension runs. They stay in `activities/descriptions/<language>.json` and are fetched when a view needs them.
- Locale files can't be compressed, deduplicated, or shared between languages, since each must hold its own messages. `scripts/locales.ts` already minifies them and leaves out strings that are their own translation, which takes the locale files from 118 KB to 110 KB.
- Native `i18n` would add only a translated extension description in the browser's list. That's one sentence, so the screens don't use it. The Chromium package does carry it for the Web Store (see Store Listings): the dashboard lists a language for the listing only if the package has its `_locales/<code>/`.

## Store Listings

`store/listings/<code>.json` is the Chrome Web Store and Firefox Add-ons text (a summary and a description) in each language, kept apart from `src/locales/`, which the stores don't read. The Chromium build writes each summary to `_locales/<code>/messages.json` and points the manifest's `description` at it (`default_locale` is `en`); the Firefox package, the source manifests, and the userscript header are unchanged. Nothing reaches a store until its text is entered in the dashboard. `store/README.md` has the limits of each store, the language codes, and the steps; `store/keywords.md` the wording chosen.

## Compatibility

`src/compat/discord-rpc-extension.ts` implements Discord-RPC-Extension's presence protocol (Chromium and Firefox only). It lets Parousia's Activity detection drive Discord Rich Presence through that project's existing Desktop bridge, without Parousia Desktop. It's wired up but inert until `DISCORD_RPC_EXTENSION_CLIENT_ID` is chosen (see `project/roadmap.md`, Compatibility). The same file maps an Activity to Discord's fields (`toDiscordPresence`) with the rules Desktop's Discord adapter uses. Both are tested against `adapters/discord/activity-mapping.json`. `project/architecture.md`'s Compatibility Layer section has the protocol and how Parousia coexists with Discord-RPC-Extension's own server.

`src/compat/malsync.ts` takes what the MAL-Sync extension recognizes on a page (title, episode, cover, progress) as the Activity, when it's turned on in Settings > Platforms. It's off by default. MAL-Sync doesn't use Discord-RPC-Extension's app. It answers that extension's browser extension when asked, so Parousia asks the same way (`runtime.sendMessage(<MAL-Sync's id>, { tab, info })`) for the shared tab. The reply is parsed and bounded like a PreMiD Activity's report, then goes into the runtime through `RuntimeOptions.external`. Only a tab number is sent, nothing new is listened for, and no permission or `externally_connectable` entry is added. Parousia asks when the shared tab's address changes (four times over 25 seconds, where MAL-Sync has nothing) and every 15 seconds while MAL-Sync has something to show. With it off, or nothing to share, nothing runs. It's tested in `src/compat/malsync.test.ts` and `src/platforms/background.test.ts` against the shape of MAL-Sync's reply (from its source and shipped build), not a live MAL-Sync. See `project/compatibility.md` and `project/roadmap.md`.

## Popup

`src/popup/` is the toolbar popup, shown through the `action` key in each extension manifest. It shows the Activity the background script is sharing. The background pushes that over the popup's port with every change, so the popup shows exactly what reaches Desktop (a PreMiD Activity's report included) after Privacy settings. Its footer shows the Desktop connection and, when something's wrong, what to do about it: start Desktop, allow this build with the exact origin, or update a mismatched version. The userscript has no popup, since it has no browser action to attach one to. Its manager's menu has the status command instead.

When the Default Activity is what's shared, the popup still shows the tab's site Activity below it, if the site has one. It's offered when it's off or can't run here, and noted when it's on with nothing to share yet. The decision is in `src/shared/site-offer.ts`, and `src/popup/popup.ts` renders it.

## Fullscreen

`src/fullscreen/` is a larger, standalone presence view. It opens as its own tab from the popup's expand control (`chrome.tabs.create` to `fullscreen.html`, not a popup). It renders the Activity the same way the popup does, through `src/shared/presence-view.ts`. See `project/architecture.md`'s "Full-Screen Presence View" section.

It's split into pages, one rendered at a time and addressed by the URL hash:

- **Overview** (`#overview`): the current Activity, Parousia Desktop's status, and its version.
- **Activities** (`#activities?q=…&filter=…&page=…`): the catalog, searched, filtered, and paged, so only one page of cards is in the DOM. It's sized for PreMiD's 1,400+. `#activities/<id>` is one Activity's page, with its switch, version, and settings. Enabled Activities come first, each group by name.
- **Settings** (`#settings/<category>`): the same pages as the popup's Settings.

The Filter button beside the search offers Enabled, Disabled, Parousia Activities, and PreMiD Activities. Choices within a group add up, and the two groups narrow each other. "Enable or disable all…" applies to everything the search and filters match. It asks a second time, and for enabling it warns that the browser will ask for that many sites in one prompt. A decline leaves those Activities off. The logic is in `src/shared/activity-list.ts` and `src/shared/activity-catalog.ts` (`bulkPlan`, `enableAll`, `disableAll`), tested without a DOM. `bun run activities:verify` drives the page in a real browser.

Overview mentions Discord-RPC-Extension's app only until Parousia Desktop is connected. Its status stays in Settings > Platforms. Diagnostics aren't in the extension at all. They're Desktop's, in its tray and `Parousia-Desktop status`. Desktop accepts setting changes only from a connection it knows belongs to this OS user. Otherwise, Settings points to `Parousia-Desktop set` or Desktop's console.
