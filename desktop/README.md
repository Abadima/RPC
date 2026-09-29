# desktop

Parousia Desktop: the native app browsers publish Presence to. Rust, no async runtime. See `project/architecture.md` (Communication Protocol, Desktop Tray) for how it works and `project/threat-model.md` for what it defends against.

## Build and Run

```bash
cargo build               # target/debug/Parousia-Desktop
cargo build --release     # target/release/Parousia-Desktop (LTO, stripped)
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check

./target/debug/Parousia-Desktop              # with the tray (Linux)
./target/debug/Parousia-Desktop --headless   # without it
```

Only one Desktop runs per user; launching it again shows a notification that it's running (and the status, in a terminal) and exits. If something else holds port 57179, Desktop exits with an error saying so.

## How Browsers Connect

Every browser client (Chromium, Edge, and Firefox extensions, Flatpak and Snap builds included, and the userscript) connects to one WebSocket, `ws://127.0.0.1:57179/ws`. Desktop has no pairing: it accepts Parousia builds it recognizes by the `Origin` the browser sets.

- **Chromium store builds:** built in once listings exist.
- **Everything else** (development builds, and every Firefox install, whose origin is random per install): allow its exact origin once. Its popup shows the command, `Parousia-Desktop allow chrome-extension://<id>` (or `moz-extension://<uuid>`), and the tray's Diagnostics → Refused menu has an "Allow" item for each extension Desktop turned away.
- **Userscripts:** only with "Allow userscripts" on (off by default), since that lets any web page publish presence. A userscript can't read Desktop's status or change settings.

On Linux, connections from other OS users are refused before anything is read.

## Commands

These talk to the running Desktop (over its local socket, so Linux and macOS for now; on Windows, type `status`, `allow`, `disallow`, `userscripts on|off`, `debug on|off` into Desktop's own window). Add `--json` for machine-readable output.

| Command | Does |
| --- | --- |
| `Parousia-Desktop status` | Connected browsers, settings, refused extensions, recent events |
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
  "allowUserscripts": false
}
```

Every key is optional. Anything other than an exact extension origin in `allowedOrigins`, or an unknown key, stops Desktop at startup, so a typo can't silently change what's accepted.

The local socket for commands is `$XDG_RUNTIME_DIR/parousia/desktop.sock` on Linux, and in the data directory where there's no runtime directory. Browsers never use it.

## Tray

The tray is optional. On Linux, Desktop shows a StatusNotifierItem: KDE Plasma shows it out of the box, and GNOME with the AppIndicator extension (Ubuntu ships it enabled). Its menu has the status, connected browsers, Diagnostics (the WebSocket, refused extensions with "Allow", recent events), Settings (userscripts and debug logging toggles), and Quit. Without a tray host (stock GNOME), Desktop keeps working, still sends notifications, and the icon appears if one starts; the commands above and the extension's dashboard cover everything the menu does. Windows and macOS have no tray yet.

`assets/tray-{32,48}.rgba` are generated from `browser/icons/icon-{32,48}.png` with `magick icon-N.png -depth 8 RGBA:tray-N.rgba`.
