# Threat Model

Two local links: **Browser ↔ Desktop** (WebSocket on `127.0.0.1:57179`) and **Desktop ↔ Discord** (Discord's local RPC socket or pipe). Protocol and platform details are in `project/architecture.md`. Revisit this file whenever either link changes and at every release.

## What's Protected

- **Presence:** only accepted Parousia clients may publish it, and it goes when its connection closes.
- **Settings:** the extension allowlist and userscript access.
- **Desktop resources:** CPU, memory, threads, connections, message handling.
- **Diagnostics:** connected clients, Activity names, refused origins, debug events.
- **Browsing:** a page's address stays in the browser; only what an Activity chose to show, under Privacy settings, leaves it.

There are no client secrets, pairing credentials, or per-client stored state.

## Trust Boundaries

| Source | Trust |
| --- | --- |
| Recognized Parousia extension | May publish Presence and use allowed commands |
| Userscript | May publish Presence, only when explicitly enabled |
| Web page, other extension | Untrusted |
| Other OS user | Untrusted |
| Same OS user | Out of scope: its processes can read local files and sockets |

Extension identity is the browser-set `Origin`, matched exactly.

## Browser ↔ Desktop

### Origin and owner checks

- Web pages and unknown extensions are refused; allowed extension origins must match exactly. An unknown extension origin gets one `origin_not_allowed`, anything else a plain 403.
- Userscripts are off by default, and can't read status or change settings.
- A page can tell whether `57179` is reachable, but can't use the protocol.
- Another OS user's connection is closed before anything is read: on Linux the kernel's socket diagnostics (netlink) look up the client socket's owner, with `/proc/net/tcp` as the fallback; on Windows, `GetExtendedTcpTable` names the client process and its token names the user. Only a connection confirmed as this user's may change settings.

### Input validation

- Desktop checks the upgrade itself (RFC 6455: `GET` over HTTP/1.1, version 13, a 16-byte key, exactly one `Origin`, no `Transfer-Encoding`); the head must fit 8 KiB and arrive within 5 s in all, so a trickle can't hold a thread.
- Frames are at most 16 KiB. Presence fields and client names are bounded and sanitized; links are `http(s)`; Discord ids are checked; two buttons at most; type and status line are fixed sets; a party is at most 10,000.
- Unknown message types, unknown fields in control messages, another message type's field (even `null`), and other protocols or major versions are refused. A Presence's unknown fields are skipped, so a newer extension doesn't break an older Desktop; known ones are still bounded.
- Malformed input never becomes a crash. Versions and names are untrusted text; only the major version is read.

### Resource limits

| Limit | Value |
| --- | --- |
| Accepts | burst 32, then 16 a second |
| Connections | 64 (8 on the control socket or pipe), one thread each |
| Handshake and request head | 5 s |
| Messages per connection | burst 20, then 5 a second; past that, `rate_limited` and a close |
| Refused connections | drained within a bound |

A connection whose thread the system won't start is closed, and a panicking thread gives its slot back (`desktop/src/app/slots.rs`), so no failure stops a listener. The extension sends at most one Presence every 250 ms (`browser/src/core/desktop-connection.ts`), so a fast-changing page can't get its link closed.

### Presence lifetime

Presence belongs to its connection and is dropped when the connection closes, so a gone browser leaves nothing stale.

### Port squatting

Desktop refuses to start if `57179` is taken. If Desktop isn't running, any local process on that port receives what the extension sends; the extension can't tell who it reached. Same-user processes are out of scope; for another user's, Desktop on Linux names the listener's owner when it can't start. On Windows, `SO_REUSEADDR` can share a port in use, but measured (`desktop/src/platform/windows/port.rs`), std's listener refuses an exact-address share and a wildcard bind doesn't get `127.0.0.1` connections, so a plain bind is enough.

### Control socket and pipe

The CLI reaches Desktop over a Unix socket (Linux, macOS) or a named pipe (Windows); browsers never use it. Requests are one 16 KiB frame within 5 s, at most 8 connections, and only control requests are understood.

- **Unix:** `desktop.sock` (`0600`) in a directory made `0700` at every start. A lock on `desktop.lock` beside it, held for the process's life, is the single-instance check: checking the socket alone let two simultaneous starts both win (17 of 20 rounds in a test). A dead socket is replaced; one that answers is left alone.
- **Windows:** pipe names are machine-wide, so the pipe has a protected DACL with this user alone and refuses remote clients, and each end checks the other process's token user. Clients open it anonymously (no impersonation). Its first instance is the single-instance check, so another account that creates `\\.\pipe\parousia-desktop-<SID>` first can stop Desktop from starting (it says why); nothing is sent to it.

## Desktop ↔ Discord

- RPC frames are capped at 64 KiB; only the reply fields needed are kept; Discord's error text is bounded before it's shown.
- Changes within one Activity are spaced at least 2 s for every platform (the first at once, the newest of a burst after), and the Discord adapter also keeps to Discord's 5 updates per 20 s.
- Retries back off, and stop when there's nothing to show. Every write has a deadline.
- **Linux and macOS:** some candidate directories can be made by anyone (`/tmp/snap.discord`), so only a socket this user owns is tried, and the kernel must confirm its listener is this user (`SO_PEERCRED`, `getpeereid`); a symlink swapped between two sockets otherwise fooled the first check in every test run.
- **Windows:** any account can create `discord-ipc-N`, so Desktop connects only to a pipe whose server process runs as this user, as an anonymous client. A process it can't inspect counts as another user's.
- `PAROUSIA_DISCORD_IPC_DIR` and `PAROUSIA_DISCORD_IPC_PIPE` are same-user configuration.

## Linux Desktop Integration

- **Session bus:** used only if the kernel says this user runs it: an abstract-socket address has no file permissions, so another user could take over a vanished bus's name. Messages are bounded (1 MiB, 64 levels) and parsed without panics; a tray host restart is believed only from the bus. Everything on the bus is this user's, but a Flatpak app allowed to own `org.kde.*` can click Desktop's tray menu (allow an already-refused origin, toggle userscripts or debug, quit); with network access it could reach `57179` anyway.
- **Text Desktop shows:** Activity names (a page can pick one), client names, and Discord's errors reach the terminal, tray, and notifications. Control characters, line and paragraph separators, direction marks and overrides, and invisible characters are removed; in notification bodies and tooltips, which shells render as markup, `<` and `>` become `‹` and `›`.

## What Reaches Discord

Only the Presence the selected Activity produced, under the extension's Privacy settings. Without media details, page-derived media text isn't sent. Activities build their own links; a page's query string and fragment aren't forwarded. Discord shows what it receives to friends by its own rules.

## Activities and Page Access

Native Activities use Parousia's collector; PreMiD Activities are third-party code compiled into the extension. Both run only when on, and where they read pages, only on granted sites.

- **Isolation:** Activity messages are parsed and bounded; a port is tied to this extension, a tab, an Activity that's on, and a granted site; at most 64 messages wait per port (an unanswered page read gives up after 5 s). Content scripts can't reach extension storage where the browser allows restricting it; on Firefox the PreMiD runtime removes the API from its world.
- **Page-world access:** helpers read only requested paths and refuse `__proto__`, `constructor`, and `prototype`. `readPage` refuses the page's evaluators (`eval`, `Function`, string timers, `document.write`) and anything reached through them (`eval.call`). This keeps the bridge from evaluating text; it is not a wall between an Activity and the page, since a content script shares the DOM (inline handlers, script elements, `javascript:` links, `insertAdjacentHTML`), limited only by the page's CSP. The controls are review and pinned sources, and the build leaves out scripts that assign page text to `innerHTML`.
- **Permissions:** sites are asked for from a user action; **All websites** is off by default; **Enable all** needs a second confirmation and asks for the union of sites; taking access back stops the Activity there at once. Where both sources implement a site, only the chosen one runs.
- **Default Activity:** stored locally and validated like any Presence; images and buttons are limited to allowed schemes or the Application's assets.

### Disabled Activities

An Activity that's off runs nothing (Chromium and Firefox extensions):

- **No code runs:** a native `detect` is reached only through the registry, after the Activity is on and its site granted; matching reads manifest data, not Activity code.
- **Nothing is injected:** page scripts, iframe scripts, and the collector go only into a tab whose Activity is on, matches, and has its site. The extension declares no content scripts.
- **Nothing runs before settings are read:** the page host answers nothing until the stored switches are in, and the background reads switches, Settings, and the Default Activity in one call, Settings first, before the first refresh.
- **Off stops what runs:** every script and collector of it is stopped and disconnected, its reports dropped; the same when its site is taken back, or its page data switched off. A script connecting later is refused at its first message.
- **Paused private tabs run nothing:** no Activity code, no injection, no MAL-Sync question; running scripts stop when the setting changes.
- **Media presence adds no exception:** a kept tab counts only if its Activity was on and shared, is checked again before every showing, and gets nothing injected; kept tabs are written to `storage.session` as tab numbers only.

Not guaranteed:

- Native modules load with the background (their top-level code is declarations, reviewed in the Activities repository, not enforced).
- A PreMiD script already running keeps the timers, listeners, and requests it started itself until the tab reloads; one being injected as it's turned off runs its top level once.
- After an update or reload, orphaned content scripts run on in open tabs, unable to reach the extension.
- Unreadable switches mean defaults, as on a new install.
- The userscript has no switches: every built-in Activity runs on address and title only, with no page data.
- After in-tab navigation to a page it doesn't match, an Activity's script runs on until reload; its reports are ignored.

### Data leaving the browser

- **Privacy settings** decide which page data may reach a Presence: native Activities don't collect what's off, PreMiD reports have it withheld.
- **The update check** is the one request to anyone but this computer (besides the dashboard's Activity icons, loaded without a referrer): `GET api.github.com/repos/Abadima/RPC/releases/latest`, from a view about to say "update Desktop", at most once a day, with no cookies, credentials, referrer, identifier, or browsing data. It's the only remote address the CSP allows besides Desktop and Discord-RPC-Extension's app. The answer is size-limited, parsed as JSON, and only an `x.y.z` in `<!-- parousia-desktop: … -->` is read, so a forged answer can only show or hide that notice.
- **MAL-Sync** (off by default) is asked, by its published id, about the shared tab: a tab number goes out, nothing of the page. Parousia adds no inbound surface (no `onMessageExternal`, no `externally_connectable`). The reply is untrusted page text: size-limited, parsed and bounded like a PreMiD report, limited by Privacy, and refused whole if it names a Discord Application MAL-Sync doesn't use; a link to the watched site is dropped. Turning it on trusts MAL-Sync's reading of the page. Questions are limited to the shared tab (four per page with no answer, every 15 s with one).

## Activity Supply Chain

- Each source is pinned to a reviewed commit (`browser/activity-sources.json`); builds and `activities:check` refuse any other checkout, and a pin moves only by editing the file. The revision used is recorded; a broken fetch is rolled back.
- A PreMiD Activity's build reads only its own folder and PreMiD's helper package (`confined` in `scripts/activities/premid.ts`), so no build-machine file can be bundled into a shipped script.
- Excluded at build: Activities needing npm packages, those on PreMiD's DMCA list, those assigning page text to `innerHTML`, and any `regExp`/`iFrameRegExp` that can split text ambiguously (`(a+)+`, `a+a+`, in a group or lookaround) or that the check can't read (`scripts/activities/redos.ts`). Matchers test at most 2,048 characters.
- A failed validation fails the build; store releases get platform review. Parousia contacts no PreMiD server; known image-service requests are answered locally.

A malicious upstream change enters only when someone advances a pin past it, so that review is the control. Native Activities execute at build time (`activities:check` imports them), so their pin is also a code-execution trust root for the build machine.

## Designs Rejected

- **Pairing codes or HMAC:** same-user processes can read any stored credential, and `Origin` already stops pages and other extensions.
- **Native Messaging:** no security property beyond the origin checks, for a new permission, per-browser manifests, and relays.
- **Remote PWA bridge** (`parousia.abadima.dev/pwa/`, considered and deferred): it would put browsing-derived text into a remote page's JavaScript, the one thing the project guarantees never happens; it would trust whoever controls that origin (repository, deploy, Pages, DNS) with no secret to authenticate; Firefox would need an always-on content script on the origin; and the dashboard already opens as a full, offline tab. If revisited: opt-in per session with a code typed into the page, read-only, exact origin, one snapshot, rate limited, strict CSP and no third-party scripts.

## Known Gaps

- **macOS:** other-OS-user connections aren't detected yet, so they may publish Presence but not change settings. The socket code shared with Linux (including `getpeereid` on Discord's socket) is built and linted for `aarch64-apple-darwin`, never run on a Mac.
- **Linux without netlink or `/proc/net/tcp`:** every connection's owner is unknown, with the same limits as macOS.
- **Port held before Desktop starts:** another user's program on `57179` gets what the extension sends; Desktop can only say so when it can't start (Linux).
- **Cross-user flood:** connections are rate limited before their owner is checked, so another user's sustained flood can crowd out this user's browsers (presence stops; nothing is read or changed). On Linux the check now costs about 2 µs and could come first; on Windows it copies the TCP table and opens a process, so it must stay behind the limit. Not changed yet: it reorders two security checks.
- **Windows:** an elevated process whose token this user can't read counts as another user's, so a browser run as administrator is refused. The other-user checks were run against this user's processes and System only; no second account was available.
- **Firefox:** extension origins are random per install and must be allowed by hand; content-script storage isolation is the PreMiD runtime's, not the browser's.
- **Switches:** see Disabled Activities for what a switch doesn't stop.
- **Several browsers:** Desktop shows the most recent change, so one browser's kept music changing track can replace another's presence.
- **MAL-Sync:** Parousia can't see which sites MAL-Sync covers, so a tab it has nothing for is asked a few times per page, waking its background.
- **CI actions:** workflows reference actions by major-version tag (`actions/checkout@v7`), so a moved tag changes what builds a release. Pin them to a commit when the release calms down.
- **Same OS user:** out of scope; its processes can read local configuration and IPC.
