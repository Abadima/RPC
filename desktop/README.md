# desktop

Parousia Desktop: the native app browsers publish Presence to, and that shows it on Discord. Rust, no async runtime. See `project/architecture.md` (Platform Adapter Architecture, Communication Protocol, Desktop Tray) for how it works and `project/threat-model.md` for what it defends against.

## Build and Run

```bash
cargo build               # target/debug/Parousia-Desktop
cargo build --release     # target/release/Parousia-Desktop (LTO, stripped)
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check

./target/debug/Parousia-Desktop              # with the tray (Linux, Windows)
./target/debug/Parousia-Desktop --headless   # without it
```

**Release builds** come from the "Release" workflow (push a `vX.Y.Z` tag on `main`, see `.github/CONTRIBUTING.md`) as standalone executables, size-optimized and stripped (`opt-level = "z"`, LTO, about 1 MB):

- **Linux** (x86_64, aarch64): built for `*-unknown-linux-musl`, so they are static and need no glibc or other library. `cargo build --release --target x86_64-unknown-linux-musl` after `rustup target add x86_64-unknown-linux-musl`.
- **Windows** (x86_64, aarch64): built for `*-pc-windows-msvc` with the C runtime linked in (`.cargo/config.toml`) and no console window. They only need Windows 10/11 and import only DLLs that ship with Windows. Windows builds are made on Windows because the MSVC linker and SDK aren't available for cross-compiling; `cargo clippy --target x86_64-pc-windows-msvc` (or `aarch64-pc-windows-msvc`) works from Linux for checking.

There are no macOS binaries yet.

Only one Desktop runs per user; launching it again shows a notification that it's running (and the status, in a terminal) and exits. If something else holds port 57179, Desktop exits with an error saying so.

## How Browsers Connect

Every browser client (Chromium, Edge, and Firefox extensions, Flatpak and Snap builds included, and the userscript) connects to one WebSocket, `ws://127.0.0.1:57179/ws`. Desktop has no pairing: it accepts Parousia builds it recognizes by the `Origin` the browser sets.

- **Chromium store builds:** built in once listings exist.
- **Everything else** (development builds, and every Firefox install, whose origin is random per install): allow its exact origin once. Its popup shows the command, `Parousia-Desktop allow chrome-extension://<id>` (or `moz-extension://<uuid>`), and the tray's Diagnostics → Refused menu has an "Allow" item for each extension Desktop turned away.
- **Userscripts:** only with "Allow userscripts" on (off by default), since that lets any web page publish presence. A userscript can't read Desktop's status or change settings.

On Linux, connections from other OS users are refused before anything is read.

## Discord

Desktop shows what the browsers report on Discord, through the Discord app running on the same computer. Nothing to set up: it finds Discord's local socket in `$XDG_RUNTIME_DIR` or the temporary directories, including where the Flatpak and Snap packages put it (a named pipe on Windows), and uses it only if this user owns it.

- With more than one browser connected, the one whose Activity changed most recently is shown; when it's done, the next one still sharing takes over. The extension's Settings > Platforms decides whether a browser's Activities go to Discord at all.
- It connects only while there's something to show and lets go 30 seconds after clearing it. If Discord isn't running it tries again after 1 second, doubling to 30, and whenever the Activity changes. Discord allows 5 updates per 20 seconds; faster changes are coalesced into the latest.
- Activities show as their own Discord Application where they have one, otherwise as Parousia's. `discordClientId` in `config.json` replaces Parousia's.
- `status`, the tray, and the extension's Settings > Platforms say what it's doing: "Discord: showing Jena Hub", "not running, trying again", or what Discord refused.

`PAROUSIA_DISCORD_IPC_DIR` makes Desktop look for `discord-ipc-0` to `9` in that one directory instead (Linux and macOS), for an unusual install. The browser's end-to-end checks use it so a test run never reaches a real Discord.

On Windows, Discord quitting is noticed at the next update rather than at once, and another OS user's `discord-ipc` pipe isn't detected yet (see `project/roadmap.md`).

## Commands

These talk to the running Desktop (over its local socket, so Linux and macOS for now; on Windows, use the tray menu; the commands there only print `--help` and `--version` for now, since the release exe has no window of its own). Add `--json` for machine-readable output.

| Command | Does |
| --- | --- |
| `Parousia-Desktop status` | Connected browsers, Discord, settings, refused extensions, recent events |
| `Parousia-Desktop allow <origin>` | Accepts an extension build by its exact origin |
| `Parousia-Desktop disallow <origin>` | Stops accepting it and closes its connections |
| `Parousia-Desktop set userscripts on\|off` | Allows userscripts (any web page can connect; off by default) |
| `Parousia-Desktop debug on\|off` | Debug logging and event history, for this run only |

The Parousia extension's Settings (General) have the userscripts toggle; diagnostics stay here, in the tray and `status`.

## Logging

Desktop is silent by default: it prints nothing and keeps no event history, so an ordinary run costs nothing for logging. Turn debug logging on for the current run only (it's never saved) with `--debug` at launch, the tray's Settings > "Debug logging (this run)", `Parousia-Desktop debug on`, or `debug on` in its console. `status` then also lists recent events; turning it off forgets them. Startup errors still print.

## Files

In the platform data directory (`~/.local/share/parousia` on Linux, `~/Library/Application Support/parousia` on macOS, `%APPDATA%\parousia` on Windows), which Desktop keeps readable by this user only, `config.json` holds the settings. Desktop writes it when settings change; it can also be edited by hand while Desktop is stopped.

```json
{
  "allowedOrigins": ["chrome-extension://<32-letter id>", "moz-extension://<uuid>"],
  "allowUserscripts": false,
  "discordClientId": "<Discord Application id>"
}
```

Every key is optional; without `discordClientId`, Activities without their own Application show as Parousia's. Anything other than an exact extension origin in `allowedOrigins`, a `discordClientId` that isn't a Discord id, or an unknown key stops Desktop at startup, so a typo can't silently change what's accepted.

The local socket for commands is `$XDG_RUNTIME_DIR/parousia/desktop.sock` on Linux, and in the data directory where there's no runtime directory. Browsers never use it.

## Tray

The tray is optional. On Linux, Desktop shows a StatusNotifierItem: KDE Plasma shows it out of the box, and GNOME with the AppIndicator extension (Ubuntu ships it enabled). Its menu has the status, what Discord is showing, connected browsers, Diagnostics (the WebSocket, refused extensions with "Allow", recent events), Settings (userscripts and debug logging toggles), and Quit. Without a tray host (stock GNOME), Desktop keeps working, still sends notifications, and the icon appears if one starts; the commands above and the extension's dashboard cover everything the menu does. On Windows it's a notification-area icon (it may sit under the `^` overflow arrow) with the same menu and balloon notifications for blocked extensions; `--headless` runs without it and is then stopped from Task Manager. macOS has no tray yet.

`assets/tray-{32,48}.rgba` are generated from `browser/icons/icon-{32,48}.png` with `magick icon-N.png -depth 8 RGBA:tray-N.rgba`.
