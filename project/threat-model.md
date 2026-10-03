# Threat Model

Parousia has two local communication links:

1. **Browser ↔ Desktop:** WebSocket on `127.0.0.1:57179`
2. **Desktop ↔ Discord:** Discord's local RPC socket

See `project/architecture.md` for protocol and platform details. This document is revisited whenever either link changes and during release hardening.

## What's Protected

- **Presence:** only accepted Parousia clients may publish it, and it disappears when the client disconnects.
- **Settings:** extension allowlist and userscript access.
- **Desktop resources:** CPU, memory, threads, connections, and message handling.
- **Diagnostic data:** connected clients, Activity names, refused origins, and debug events.

There are no client secrets, pairing credentials, or per-client stored state.

## Trust Boundaries

| Source                        | Trust                                                            |
| ----------------------------- | ---------------------------------------------------------------- |
| Recognized Parousia extension | May publish Presence and use allowed commands                    |
| Web page                      | Untrusted                                                        |
| Other extension               | Untrusted                                                        |
| Userscript                    | May publish Presence only when explicitly enabled                |
| Other OS user                 | Untrusted                                                        |
| Same OS user                  | Out of scope; local processes can access local files and sockets |

Extension identity is determined by the browser-provided `Origin`, which Desktop matches exactly.

## Browser ↔ Desktop

### Origin checks

Desktop validates the WebSocket `Origin` before accepting a connection.

- Web pages and unknown extensions are rejected.
- Allowed extension origins must match exactly.
- Userscripts are disabled by default and cannot read status or change settings.
- A page can observe whether port `57179` is reachable, but cannot use the protocol without an accepted origin.
- Linux rejects connections belonging to another OS user.

### Input validation

Both sides use strict message schemas.

- The upgrade request is read once and checked by Desktop itself (RFC 6455: `GET` over HTTP/1.1, version 13, a 16-byte key, exactly one `Origin`); its head must fit in 8 KiB and arrive within 5 seconds in all, so a trickle of bytes can't hold a connection's thread longer. tungstenite runs the WebSocket after that.
- Frames are limited to 16 KiB.
- Presence fields and client names are bounded and sanitized.
- URLs must use `http` or `https`.
- Discord application IDs are validated.
- Only two buttons are allowed.
- An Activity's type and status line are fixed sets of names, a party is whole numbers up to 10,000 with its size at most its maximum, and links on images are `http` or `https` like every other link.
- Unknown message types, unknown fields in control messages, a field another message type has (even `null`), and other protocol or major versions are rejected. A Presence's own fields are the exception: ones Desktop doesn't know are skipped, so a newer extension's additions don't break an older Desktop, and every field it does know is still bounded in full.

Malformed input never becomes an application error or crash.

### Resource limits

Desktop limits:

- 32-connection accept burst / 16 accepts per second
- 64 simultaneous connections
- 5-second handshake/request timeouts
- Per-connection message rate limits
- Bounded refused-connection draining

These limits prevent a client from consuming unbounded CPU, memory, threads, or sockets.

### Presence lifetime

Presence belongs to its connection and is discarded when that connection closes. A disconnected or suspended browser therefore cannot leave stale Presence behind.

### Protocol versions

The `hello` message contains the protocol number and the client's release version. Another protocol, another major version, or a version that isn't a release is rejected rather than silently downgraded. The versions are untrusted text like the client's name: Desktop only reads the major number from it and never stores it.

### Port squatting

Desktop refuses to start if port `57179` is already occupied.

If Desktop is not running, a malicious local process can still receive anything the extension sends to that port: the OS-user checks screen who connects to Desktop, and a browser has no way to ask who it connected to. Same-user processes are out of scope. Another user's program on the port is the case that matters on a shared machine, and the extension can't detect it. On Linux, Desktop can: when the port is taken, it looks up the listener's owner in `/proc/net/tcp`, and if it's another user it says that program may be receiving what the browser sends, instead of the usual "close the other copy of Desktop".

On Windows, a program can share a port that's in use by setting `SO_REUSEADDR` on its own socket, and the newest socket then gets the connections. This was measured rather than assumed (`desktop/src/platform/windows/port.rs`): the standard library's listener refuses a program that asks to share its exact address, and a wildcard listener on the same port doesn't get connections to `127.0.0.1`, so a plain bind is enough.

### Control socket and pipe

The CLI talks to the running Desktop over a Unix socket in a private directory (Linux and macOS) or a named pipe (Windows).

On Linux and macOS the socket is `desktop.sock` in a directory made `0700` at every start (`$XDG_RUNTIME_DIR/parousia`, or the data directory), and the socket itself is `0600`, so no other user can open it. Requests are one 16 KiB frame within 5 seconds, at most 8 connections are served at once, and only control requests are understood. The single-instance check is a lock on `desktop.lock` beside it, held for as long as Desktop runs (the kernel releases it however the process ends). Checking the socket alone let two Desktops started together both find nothing and the second replace the first's socket (17 of 20 rounds of 8 simultaneous starts in a test); with the lock exactly one starts. A socket file nobody answers on is left from a crash and replaced; one that answers belongs to a Desktop from before the lock and is left alone.

A pipe lives in a machine-wide namespace, so what keeps it private is its access list and a second check on the process behind every connection:

- The pipe's security descriptor has one entry, this user, nothing inherited, and it rejects remote clients. The default would give every other account read access.
- Desktop serves only a client process that runs as this user, and the CLI sends only to a Desktop that does. Another account that creates the name first can stop Desktop from starting (it says why), but nothing is sent to it.
- Clients are opened anonymously (the server can't act as the caller), requests are limited to one 16 KiB frame within 5 seconds, replies are bounded the same way, and at most 8 connections are served at once. Only the control requests are understood: the session protocol never runs here.
- The pipe is also the single-instance check: its first instance can only be created once.

## Desktop ↔ Discord

Desktop connects only to Discord's local RPC socket and uses only the fields needed for Presence.

- RPC frames are size-limited.
- Only required response fields are retained.
- Discord errors are bounded before being exposed to the browser or UI.
- Presence changes within one Activity are spaced at least 2 seconds apart for every platform (the first goes through at once, the newest of a burst follows), and the Discord adapter also keeps to Discord's update limit.
- Connections retry with backoff and stop when there is nothing to display.

On Linux and macOS, `discord-ipc-N` is a socket in Discord's runtime or temporary directory, or its Flatpak or Snap package's, and some of those can be made by anyone (`/tmp/snap.discord`). Desktop tries only a socket this user owns, and once connected asks the kernel who listens on it (`SO_PEERCRED` on Linux, `getpeereid` elsewhere): a symbolic link in a directory another user controls can point at this user's socket for the first check and at their own for the connect. Before the second check, a test that swaps such a link between this user's socket and one another account runs (the system bus's) had Desktop connected to the other account's in every run; now never. On Windows, `discord-ipc-N` is a named pipe in a machine-wide namespace, so any account could create one and pose as Discord. Desktop connects only to a pipe whose server process (`GetNamedPipeServerProcessId`) runs as this user, by the user SID in its token, and opens it as an anonymous client so even a pipe that is not Discord cannot act as this user. A process Desktop cannot inspect counts as another user's. Discord quitting or restarting is noticed at once (overlapped pipe I/O: a reader waits on the pipe while the adapter writes), and every write to Discord has a deadline.

`PAROUSIA_DISCORD_IPC_PIPE` is trusted the same way as `PAROUSIA_DISCORD_IPC_DIR`.

`PAROUSIA_DISCORD_IPC_DIR` is trusted as local process configuration and is therefore subject to the same same-user threat model.

## Linux Desktop Integration

### Session bus (tray and notifications)

The tray and notifications use the session bus (`platform/linux/tray/`). Desktop uses a bus only if the kernel says this user runs it: an address can name an abstract socket (`unix:abstract=`, common without systemd), which has no file permissions, so if the real bus is gone another user can listen on the same name and would get the tray's menu clicks to answer and its notifications to read. Messages are bounded (1 MiB, 64 levels of nesting) and parsed without panicking. A tray host restarting is believed only from the bus itself.

Everything on the session bus runs as this user and is out of scope. One consequence worth knowing: a Flatpak app allowed to own `org.kde.*` (many with their own tray icon are) can call Desktop's tray object, which is `org.kde.StatusNotifierItem-<pid>-1`, and so click its menu: allow an extension origin already on the refused list, switch userscripts or debug logging, or quit. With network access the same app could already reach `127.0.0.1:57179` as this user.

### Text Desktop shows

Activity names (a page can pick one), client names, and Discord's error text reach the terminal (`Parousia-Desktop status`, debug output), the tray, and notifications. Control characters are removed from all of it, since in a terminal they are commands (escape sequences can retitle the window or write to the clipboard), and so are invisible direction overrides and zero-width characters. Notification bodies and the tray's tooltip are markup to the desktop shell (KDE turns `<img src>` into a fetch), so `<` and `>` in them are shown as `‹` and `›`.

## What Reaches Discord

Desktop sends only the Presence produced by the selected Activity and permitted by the extension's Privacy settings.

With media details disabled, page-derived media information is not included. Activities are responsible for constructing their own links; for example, page query strings and fragments are not automatically forwarded.

Discord receives whatever Presence Desktop sends and may expose it to the user's Discord friends according to Discord's own behavior.

## Activities and Page Access

Activities fall into two categories:

- **Native Activities:** use Parousia's own page-data collectors.
- **PreMiD Activities:** third-party code compiled into the extension.

PreMiD Activities only run when enabled and when their required site access has been granted.

### Third-party Activity isolation

Activity messages are strictly parsed and bounded. Activity ports are tied to the correct extension, tab, Activity, and granted site.

Where supported, content scripts cannot access extension storage. Firefox cannot enforce this directly, so Parousia's PreMiD runtime removes the storage API from the world where PreMiD code executes.

Activities can still do what their granted content-script access permits on the target site.

### Page-world access

Page-world helpers only expose explicitly requested paths and reject prototype-related paths such as:

```text
__proto__
constructor
prototype
```

Declarative page execution uses fixed functions rather than evaluating arbitrary code.

### Data leaving the browser

Privacy settings determine which page data may reach an Activity's Presence. Disabled data is not collected for native Activities or is withheld from PreMiD Activities before publication.

Activities do not run on sites for which they lack permission.

### The update check

The extension makes one request to anyone but the computer it runs on: `GET https://api.github.com/repos/Abadima/RPC/releases/latest`, from a popup or dashboard that is about to say "update Desktop". It is the only address besides Desktop and Discord-RPC-Extension's app that the extension's Content Security Policy allows. It carries no cookies, credentials, referrer, or identifier, and nothing about the user's browsing; GitHub sees an IP address and the browser's user agent, as for any request. The response is untrusted: it is size-limited, parsed as JSON, and only a `x.y.z` number inside the exact `<!-- parousia-desktop: … -->` comment is read from it. A forged answer can show or hide an "update Desktop" notice, and nothing else; the link it offers is a fixed address. It is made at most once a day, and only when a connected Desktop and the extension differ in minor or patch version.

### Permissions

Activities request only their required sites.

- Site access is requested from an explicit user action.
- **All websites** is off by default.
- **Enable all** requires a separate confirmation and requests the union of the selected Activities' sites.
- Removing access immediately stops the Activity on that site.

When native and PreMiD implementations exist for the same site, only the selected implementation runs.

### MAL-Sync

With MAL-Sync turned on (off by default), Parousia asks the MAL-Sync extension, by its published id, for the shared tab's presence (`browser/src/compat/malsync.ts`), the way Discord-RPC-Extension does.

- **What goes out.** A tab number. Not the page's address, title, or anything of the page. The browser delivers a reply to the extension that asked only from the extension asked, so no sender check applies, and Parousia adds no inbound surface: no `onMessageExternal` listener, no `externally_connectable` entry, no permission.
- **What comes in is untrusted.** MAL-Sync builds its reply from a page it runs on (the title it read, the episode), and any extension that is installed under MAL-Sync's id is MAL-Sync. The reply is size-limited, parsed field by field, and bounded the way a PreMiD Activity's report is, then limited by Settings > Privacy. A reply naming a Discord Application other than the three MAL-Sync uses is turned down whole, so a reply can't make Desktop connect Discord as an arbitrary Application. A link to the site being watched is dropped, since a page's address stays in the browser.
- **What MAL-Sync can see.** It learns that Parousia asked about a tab, which it already knows is open. It isn't told what Parousia shows.
- **Who must be trusted.** MAL-Sync, for what it shows: its settings and its reading of the page decide the title, episode, cover, and button Parousia then publishes, so someone who turns this on accepts that. Its background answers any extension that asks, which is MAL-Sync's own choice, and is how Discord-RPC-Extension already reaches it.
- **Waking it.** Each question wakes MAL-Sync's background if it's asleep. Asking is limited to the shared tab, four times per page where it answers nothing and every 15 seconds where it answers something, and nothing at all with the switch off.

### Default Activity

The user-created Default Activity is stored locally and validated like any other Presence. Images and buttons are restricted to permitted URL schemes or bundled assets.

## PreMiD Supply Chain

PreMiD Activities are compiled from their upstream source during the build.

- Activities requiring additional npm packages are excluded.
- The upstream revision used by a build is recorded.
- Failed Activity validation fails the build.
- Broken fetches are rolled back.
- Store releases receive normal platform review.

The upstream `main` branch is trusted only to the extent that the next build is reviewed before release; a malicious upstream change can therefore enter a future build.

Parousia itself contacts no PreMiD servers. Known PreMiD image-service requests are handled locally.

## Designs Rejected

### Pairing codes / HMAC

Rejected because same-user processes can access locally stored credentials. Browser `Origin` validation already protects against pages and other extensions.

### Native Messaging

Rejected because it provides no required security property beyond the existing origin checks and would add the `nativeMessaging` permission, browser-specific manifests, and connection relays.

## Known Gaps

- Other-OS-user WebSocket connections are rejected on Linux (`/proc/net/tcp`) and Windows (`GetExtendedTcpTable` and the owning process's token), not yet on macOS. On Linux, a system where `/proc/net/tcp` can't be read makes every connection's owner unknown: such a connection may publish Presence but not change settings.
- macOS shares Linux's control socket and Discord socket code, including the kernel check on Discord's socket (`getpeereid`); it's built and linted for `aarch64-apple-darwin`, never run on a Mac.
- Another user's program listening on `57179` before Desktop starts gets whatever the extension sends there; the extension can't tell, and Desktop can only say so when it can't start (Linux).
- On Windows an elevated process of this same user whose token can't be read counts as another user's, so an extension in a browser running as administrator is refused.
- The Windows checks for other OS users were run against this user's own processes and the System process; a second Windows account was not available to try them against.
- Any web page can determine whether Desktop is listening on port `57179`.
- Firefox extension origins must be manually allowed because they are random per installation.
- Firefox cannot enforce content-script storage isolation at the browser level; the PreMiD runtime provides the current mitigation.
- Same-OS-user processes are out of scope and can access local configuration and IPC.
- MAL-Sync can't be asked only about tabs it recognizes: Parousia can't see which sites MAL-Sync runs on (including a person's own custom domains), so a tab it has nothing for is asked a few times per page, which wakes MAL-Sync's background that often. A list of its sites built from its source would cut that, and miss custom domains.

### Remote PWA bridge (considered, deferred)

A page on `parousia.abadima.dev/pwa/` showing the extension's popup, the way MAL-Sync opens its own site, was evaluated and not built.

- **What would carry it.** Chromium: `externally_connectable` with the exact origin, which the browser enforces. Firefox has no such thing for web pages, so a content script on that origin would relay `postMessage`, which is a new always-on host permission (and an AMO review question) for a feature most people won't use. A web page can't request permissions for the extension (that needs an extension page and a click), so it couldn't widen site access by itself.
- **What it exposes.** Any bridge worth building shows the current Activity (its details and state come from the pages you visit), and one that could change settings could also set a Default Activity (text on your Discord profile) or, through the extension's connection, Desktop's own settings. Reads alone put browsing-derived text in a remote page's JavaScript, which can send it to its server: the one thing the rest of the project guarantees never happens (a page's address stays in the browser; Desktop and Discord only get what an Activity chose to show).
- **Who must be trusted.** Whoever controls that origin: the website repository, its deploy, GitHub Pages, the domain's DNS. Origin checks bind the bridge to the origin, not to the code served from it, and there is nothing to authenticate with: no secret survives being served by the same page that would use it. A takeover of any of those is a takeover of the bridge, silently, for everyone who turned it on.
- **What it buys.** The extension's dashboard already opens as a full tab, offline, in the user's language and theme. A PWA adds installability and a standalone window, and on a phone it has no extension to talk to.
- **If it's revisited.** Opt-in per session with a code shown in the extension and typed into the page (so a page can't read anything on its own), read-only, exact origin, one snapshot of what the popup shows and no history, rate limited, and a page with no third-party scripts and a strict CSP. Even so, the trust in the origin above stays.
