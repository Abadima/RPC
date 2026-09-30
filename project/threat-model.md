# Threat Model

This covers the two links Parousia runs on one machine: between its browser clients (the extension and the userscript) and Parousia Desktop, a WebSocket on `127.0.0.1:57179` (see `project/architecture.md`, Communication Protocol); and between Desktop and the Discord app, Discord's local RPC socket (see Platform Adapter Architecture there). It gets revisited whenever either link changes, and again during release hardening.

## What's Being Protected

- **The user's presence.** Only what the user's own Parousia builds report should reach a platform like Discord, and it should disappear when the browser stops reporting it.
- **Desktop's settings**: the allowlist of extension builds and the userscript switch. Changing them changes who can publish.
- **Desktop itself**: memory, threads, and CPU. It should stay small and idle whatever a client sends.
- **What Desktop knows**: connected browsers, their activity names, refused extensions. That's diagnostic information about the user.

There are no secrets on this link. Nothing is issued, paired, or stored per client.

## Trust Boundaries

| Party | Trusted? | Why |
| --- | --- | --- |
| A recognized Parousia extension build | Yes, to publish Presence and read status; to change settings only where the OS confirms the connection is this user's (Linux) | The browser sets its `Origin`, and nothing else in the browser can claim it |
| A web page | No | Any site the user visits can open a WebSocket to `127.0.0.1` |
| Another extension | No | Extensions can open WebSockets too, with their own origin |
| The userscript | Only to publish Presence, only when allowed | It runs as the page, so it has the page's origin and can't be told apart from the page |
| Another OS user on the same machine | No | Loopback is shared by every user |
| A process running as the same OS user | Out of scope | It can read Desktop's config, talk to its IPC socket, and send any `Origin`. That's true of every local app, and no scheme on this link could change it without an OS-level secret store and signed builds |

## Threats and Defenses

**A web page connects to Desktop.** Browsers attach the page's `Origin` to every WebSocket handshake and pages can't change it. Desktop decides on the `Origin` before completing the upgrade: a web origin (or `null`) gets a bare `403` with no body while userscripts are off, the default. Browsers report a refused upgrade and a closed port as the same failure, so the handshake itself tells a page nothing. DNS rebinding changes nothing either: the page's `Origin` is still its own. There's no HTTP API to reach instead: `GET /health` returns a fixed body with no CORS headers, so a page can't read it. It can still tell whether something answers on the port (a `no-cors` request completes where a closed port fails), so whether Desktop is running is observable to any page; nothing else is.

**Another extension connects.** Its `Origin` is its own `chrome-extension://` or `moz-extension://` origin. Desktop matches allowed origins exactly, never by scheme. An unrecognized extension origin gets one `reject {reason: "origin_not_allowed"}` and a close, and nothing it sends is read. It's listed as refused so the user can allow it if it's really a Parousia build, which only the tray, CLI, or console can do. A browser can't allow anything.

**A page publishes presence while userscripts are allowed.** Accepted risk, and why the switch is off by default and says so ("any web page can connect while this is on"). A userscript connection can only publish Presence: `status` and `set` are refused, so a page can't read the allowlist, see other clients, or turn the switch back on for later.

**Another OS user connects.** On Linux, Desktop looks up the connecting socket's owner in `/proc/net/tcp` before reading anything, and drops connections from other users (and ones it can't find). On macOS and Windows that check isn't implemented yet: another local user could send any `Origin` and publish presence into this user's Desktop, or read its status. They still can't change settings, because `set` requires a connection the OS confirmed is this user's. Windows' `GetExtendedTcpTable` and macOS's `libproc` can close this gap; see the roadmap.

**Something else is squatting port 57179.** Desktop refuses to start if the port is already bound, so it never runs believing it's reachable when a different process actually holds the port. If a malicious local program holds the port while Desktop isn't running, what the extension sends reaches it instead: a display name ("Firefox on Linux") and Presence (Activity names and what they show, such as a video's title; since protocol 6, never the page's address). The same is true of port 6969, where the extension talks to Discord-RPC-Extension's app while Desktop isn't connected: it sends that app only Rich Presence (`{clientId, presence, extId}`) and reads back only a version. The extension validates everything it receives strictly (`parseServerMessage`), caps messages at 16 KiB, and treats anything that isn't Desktop as "nothing there". That program would have to run as the same user or as another user on the same machine; the first is out of scope, the second is the gap above.

**Malformed or hostile input.** Every message is parsed into strict types (unknown fields and unknown message types are errors), every frame in either direction is capped at 16 KiB, Presence fields are length-limited, every link (the details and state lines, buttons) must be `http(s)`, a `discordClientId` must be a Discord id, there are at most two buttons, and client names are stripped of control and bidirectional-override characters before appearing in menus or logs. A malformed frame gets a non-fatal `reject {reason: "malformed"}`.

**A client picks the Discord Application.** An Activity may name its own Discord Application (`discordClientId`), so a client can make Discord show "Playing <any Application>". That's no more than a client can already do by publishing any text it likes, and it's limited to what clients may publish at all: recognized builds, and web pages only while userscripts are allowed.

**Resource exhaustion.** Accepts are rate limited (burst of 32, 16 per second) before any parsing, at most 64 connections are open, handshakes and request heads time out after 5 seconds, and each connection may send a burst of 20 messages refilling at 5 per second before it's closed with `rate_limited`. Refused connections are drained for at most a second (256 KiB) so a `reject` isn't lost to a TCP reset.

**Presence outliving the browser.** Desktop keeps the latest Presence per connection and drops it when that connection closes. The extension keeps its MV3 background alive only while it's sharing an Activity (see Connection Lifetime in the architecture doc), so a suspended background can't leave a stale presence behind, and a closed browser can't either.

**Downgrade to an older protocol.** The version is checked in `hello`; any other version gets `unsupported_version` and a close. Protocol v6 has no optional security features to strip.

**More leaving the browser than anything needs.** Up to protocol 5 every Presence carried the address of the page it was about, which nothing on Desktop's side used; since protocol 6 it stays in the browser, and the extension builds each Presence it sends field by field (`presenceWire`), so a field it keeps for itself can't leave by accident. Desktop's schema refuses anything else.

**Information disclosure through `status`.** Only recognized extension builds can ask for it. It lists connected clients, the allowlist, refused origins, and (in debug mode only) recent events. It never includes Presence contents beyond an Activity's name.

## Desktop ↔ Discord

Desktop shows Presence on Discord through the Discord app's local RPC: a Unix socket on Linux and macOS, a named pipe on Windows. Discord runs as the same user and is trusted to display what it's given.

**What leaves the machine.** Whatever Desktop hands Discord is shown to the user's Discord friends: the Activity's name, details, state, images, links, and buttons, as the extension's Privacy settings allow (Share Media Details off keeps only the name, link, and images; private windows share nothing by default). Activities build their links from what they need (Jena Hub keeps only the path, so a query string or fragment, which can hold a token, never leaves the browser). Discord fetches image URLs through its own proxy, not from the user's machine.

**Something else poses as Discord.** Desktop looks for the socket in `$XDG_RUNTIME_DIR` (private to the user) and, failing that, in temporary directories, where `/tmp` is shared by every user. So on Linux and macOS it uses a socket only if this OS user owns it; another user's socket is skipped. A process running as the same user could still pose as Discord, like it could read Desktop's config: out of scope, as on the browser link. So is `PAROUSIA_DISCORD_IPC_DIR`, which points Desktop at one directory and can only be set by whoever starts Desktop. Windows named pipes are one namespace for all users, and checking a pipe's owner isn't implemented yet: another user could create `discord-ipc-0` before Discord starts and receive the presence (see Known Gaps).

**What Discord sends back.** Frames are capped at 64 KiB and read into the few fields Desktop uses (the event, an error code and message); anything else is ignored. The signed-in user, which Discord sends on connecting, isn't kept. An error message is cut to 120 characters before it appears in `status`, the tray, or the extension.

**Flooding Discord.** Discord allows 5 activity updates per 20 seconds. Desktop coalesces faster changes and sends only the latest when the window allows, so a client changing its Presence quickly (itself limited to 5 messages a second) can't get the user rate-limited. Reconnecting backs off from 1 to 30 seconds, and nothing is tried while there's nothing to show.

## Activities That Read Pages

Most Activities read only a page's URL and title. Two kinds read more, and both go through one host in the background (`browser/src/activities/host.ts`):

**Third-party code in pages.** A PreMiD Activity is PreMiD's code, compiled unchanged from PreMiD's `main` at build time, running as a content script with this extension's id. It runs only where the user turned it on and granted its site, and only in the active tab. Defenses: every message from a page script is parsed into strict shapes and bounded (16 KiB); a port is served only from this extension's content script, in a tab, for an Activity that's on, whose site is granted, and that matches the page the port came from; the Discord Application it picks must be one its source names; iframe data reaches only the same Activity in the same tab; the UI port answers only extension pages (a content script shares the extension's id, not its URL); and where the browser allows it, content scripts can't read or write the extension's storage (`setAccessLevel`, checked in Chromium by `activities:verify`). What it could still do on a granted site is what any content script can: read and change that page, and make requests as that page. That's the grant the user gave, shown by the browser in those words.

**Settings and storage.** Where the browser allows it (Chromium), content scripts can't reach the extension's storage at all (`setAccessLevel`, checked by `activities:verify`). Firefox can't restrict it, and there a content script can read and write it: a PreMiD Activity's code could change settings, turn Activities on, or set a Default Activity whose buttons Discord shows the user's friends. So PreMiD's runtime, injected before any Activity's code, takes the storage API out of that world (`withholdStorage`); `activities:firefox` checks in a real Firefox that PreMiD's world has no storage API and that a write from it doesn't arrive (without this, it did).

**Reaching into the page's own world.** `getPageVariable` and `execInPage`'s declarative form run a fixed function in the page's own world with the paths an Activity names. Paths never go through `__proto__`, `constructor`, or `prototype`, so `pick` and `omit` can't write into a prototype of the page's (which a content script couldn't otherwise touch), and the function never calls anything that runs text as code (`eval`, `Function`, `setTimeout`, `setInterval`, `document.write`, and the like, by identity, however the page names them), so page reads don't become a way to run code in the page's world. A content script can still add elements to the page, as any content script can, and an inline handler on one runs where the page's Content Security Policy allows it; that's within what the site's grant already covers (see Third-party code in pages, above).

**What leaves the browser.** Page data kinds switched off in Settings > Privacy are never collected (native Activities, whose page data comes from Parousia's own collector) or never shown (PreMiD's, held back before the Activity leaves the background; that includes a name the Activity set from the page, such as a song's title). With Share Media Details off, an Activity's own name is shared, not one it read from the page. An Activity that reads pages doesn't run at all where its site isn't granted: nothing is injected, and nothing is shown for it there.

**Access asked for, and taken back.** Turning on an Activity that reads pages asks for exactly its own sites, from the click; declining leaves it off. "Access your data for all websites" is off by default and requested only by its own switch. The one other thing that asks for more than one Activity's sites is "Enable all" on the Activities page: it sits behind a link and a second confirmation that says how many Activities and sites are involved, applies only to what matches the search and filters, and makes one request from the confirming click, exactly the union of those Activities' own sites. The browser's prompt is all or nothing. A decline leaves those Activities off (the ones that need nothing new are still turned on), and after an answer the grants are read back, so an Activity is never marked on for a site the browser didn't grant. Taking a site back (from Settings or the browser's own settings) stops what runs there at once and makes the Activity unavailable there until access is granted again.

**Two implementations of one website.** When both sources have a website, only the implementation chosen runs: the other's script is never loaded or injected, even if it's marked as on. The native one is chosen until someone picks PreMiD's, so a website runs third-party code only by choice.

**The Default Activity.** It's written by the user and shown to their Discord friends whenever no Activity is detected. Its images must be `https` links or asset names, its buttons `http(s)` links, and it's checked again by Desktop like any Presence. It's kept in the extension's storage, which PreMiD's code can't reach (above).

**The wrong tab.** What's shared is the active tab of the focused window. A tab activated in another window (one opening in the background, or the one next to a closed tab) doesn't change it; focusing a window does, and when the focused window closes without saying where focus went, the browser is asked.

**PreMiD servers.** Parousia contacts none. Some PreMiD Activities were written to call PreMiD's image service (`pd.premid.app`), which would tell PreMiD an image address or a picture; the runtime answers those requests itself in the world PreMiD's code runs in (`answerImageService` in `browser/src/premid/page.ts`), so nothing is sent. Pictures an Activity makes inline (YouTube's thumbnail, drawn on a canvas) are replaced by the address of the picture they came from, which the page already loaded and Discord then fetches through its own proxy, so no image data leaves the browser either. An Activity can still call its own site's services, as that site's pages do, and the dashboard loads each Activity's icon from its own site with no referrer.

**Supply chain.** PreMiD Activities that need their own npm packages are left out rather than installed; everything else is compiled from the fetched checkout with no dependency beyond PreMiD's own helper package in the same commit. The sources follow `main`, not a reviewed commit, so a malicious or broken upstream commit reaches the next build. What limits that: the compiled scripts run only where the user turned the Activity on and granted its site, each build records the revision it used (catalog, `SOURCE.txt`, release notes), a native Activity that fails `activities:check` stops the build, a fetch that brings an unusable tree is undone, and a release is reviewed by each store before users get it.

## Designs Considered and Dropped

Both were built and tested during development and dropped before release. Desktop still answers their `hello` with `unsupported_version`.

- **Pairing codes and HMAC credentials.** They defended against same-user processes, which can read any stored credential anyway. The `Origin` check covers pages and other extensions without any stored secret.
- **A Native Messaging channel.** It identified Firefox by add-on id and kept its traffic off the network. Neither property is needed for the threats above: the `Origin` check already rejects pages and other extensions, and the loopback listener has to exist for the userscript and sandboxed browsers regardless. Leaving it out also leaves out the `nativeMessaging` permission, per-browser host manifests, and a relay process per connection.

## Known Gaps

- Other-OS-user connections are only refused on Linux.
- On Windows, a Discord pipe created by another OS user isn't detected, and Discord quitting is noticed only at the next update.
- Any web page can observe whether Desktop is running (see above).
- Firefox installs have to be allowed once, since their `moz-extension://` origin is random per install. A store build of the Chromium extension will be recognized with no setup once its id is built in.
- Firefox doesn't let the extension restrict content scripts' access to its storage. PreMiD's runtime removes the API from the world PreMiD code runs in, which holds as long as the runtime runs first there, as it's injected to; the browser itself doesn't enforce it.
