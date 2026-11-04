# desktop

Parousia Desktop is the native app that receives presence from the browser and publishes it to Discord. It's written in Rust, with no async runtime.

See `project/architecture.md` for the Platform Adapter Architecture, the Communication Protocol, and the Desktop Tray. See `project/threat-model.md` for security details.

## Build and Run

```bash
cargo build
cargo build --release
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check

./target/debug/Parousia-Desktop
./target/debug/Parousia-Desktop --headless
```

On Windows, `cargo test` runs against the real thing: named pipes (the control pipe, and a fake Discord that quits and restarts), the loopback owner check against the TCP table, the registry, and the process tokens of the running machine. `scripts/verify-windows.ps1` then runs the release build and drives the real notification-area icon and its menu. It covers a second launch, the CLI from a terminal, the control pipe's access list, the port, Settings > Start at login against the real `Run` key, Quit, and a port held by something else. It never touches your own config, your Discord, or port 57179, so stop your own Desktop first. The browser-to-Desktop link on Windows is checked by `bun run desktop:verify` in `browser/`.

Release builds come from the `Release` workflow, which runs when a `vX.Y.Z` tag is pushed to `main`. They're standalone, stripped, and size-optimized (`opt-level = "z"`, LTO), at about 1 MB.

- **Linux:** x86_64 and aarch64, built for `*-unknown-linux-musl`
- **Windows:** x86_64 and aarch64, built with MSVC, with no console window
- **macOS:** not available yet

Only one Desktop runs per user. A second launch says so and exits. Port `57179` must be free. If something else holds it, Desktop says so and exits.

## Browser Connection

Browsers connect to:

```text
ws://127.0.0.1:57179/ws
```

Desktop identifies browser clients by their `Origin`.

- The Chrome Web Store build is recognized automatically.
- Development builds and every Firefox install must be allowed once with `Parousia-Desktop allow <origin>`. Firefox gives each install its own origin, the Add-ons listing included.
- Refused extensions can also be allowed from the tray's Diagnostics menu.
- Userscripts are off by default. Turn them on with **Allow userscripts**.
- On Linux and Windows, connections from other OS users are refused before anything is read.

Browser extensions have no pairing step.

## Discord

Desktop publishes the active browser presence through the Discord app on the same computer.

It works with Discord installed normally, through its local IPC socket (a named pipe on Windows), including Flatpak and Snap installs. Only IPC owned by the current user is used. A socket owned by another user, or a pipe whose server runs as another user, is never connected to.

When several browsers are connected, the most recently changed Activity is shown. When it clears, another connected browser can take over.

Desktop connects to Discord only while there's something to show. Changes within one Activity (the next video, a new track) show at once, unless something was shown less than 2 seconds earlier. Then only the newest change waits for those 2 seconds to pass. A burst shows its first and last changes, and a steady stream is never more than 2 seconds behind. Moving to another Activity, or clearing, always shows at once. Discord's own update limit still applies on top of this.

`PAROUSIA_DISCORD_IPC_DIR` overrides the directory of Discord's IPC socket on Linux and macOS. `PAROUSIA_DISCORD_IPC_PIPE` overrides the pipe name on Windows (up to its number, default `\\.\pipe\discord-ipc-`). Discord quitting or restarting is noticed at once on every platform.

## Commands

These commands talk to the running Desktop:

| Command                                    | Description                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `Parousia-Desktop status`                  | Show connected browsers, Discord, settings, refused extensions, and recent events |
| `Parousia-Desktop allow <origin>`          | Allow an extension origin                                                         |
| `Parousia-Desktop disallow <origin>`       | Remove an allowed origin                                                          |
| `Parousia-Desktop set userscripts on\|off` | Allow or block userscripts                                                        |
| `Parousia-Desktop debug on\|off`           | Enable or disable debug logging for this run                                      |

Add `--json` for machine-readable output.

On Windows, the commands talk to the running Desktop over a named pipe that only this user can open. They print into the terminal they were typed in, since the release exe has no console window of its own. The tray menu has the same controls.

## Logging

Desktop is silent by default and keeps no event history.

Debug logging can be turned on for the current run with `Parousia-Desktop --debug`, or from the tray, the `status` interface, or the console. Startup errors are always reported.

## Files

Configuration is stored in:

- Linux: `~/.local/share/parousia/config.json`
- macOS: `~/Library/Application Support/parousia/config.json`
- Windows: `%APPDATA%\parousia\config.json`

Example:

```json
{
  "allowedOrigins": ["chrome-extension://<id>", "moz-extension://<uuid>"],
  "allowUserscripts": false,
  "discordClientId": "<Discord Application id>"
}
```

All keys are optional. Unknown keys and invalid values stop Desktop at startup, so a bad configuration is never applied silently.

The command socket is `$XDG_RUNTIME_DIR/parousia/desktop.sock` on Linux, or in the data directory when no runtime directory exists. `desktop.lock` sits beside it, and whichever Desktop holds the lock is the one that runs. On Windows, the socket is the named pipe `\\.\pipe\parousia-desktop-<your SID>`, whose access list names only you. Browsers never use it.

`PAROUSIA_DATA_DIR` replaces the data directory. The end-to-end checks use it, so a test run never touches a real config.

## Tray

The tray is optional.

- **Linux:** StatusNotifierItem
- **Windows:** notification-area icon. Settings > **Start at login** adds an entry under your own `Run` key, the one Task Manager's Startup tab lists. Windows then starts Desktop with the tray, and nothing else is installed.
- **macOS:** not available yet

The tray shows status, Discord presence, connected browsers, diagnostics, settings, and notifications, and it has a quit control.

Desktop works without a tray host. The command interface and the browser dashboard offer the same functions. `--headless` turns the tray off.

Tray icons are generated from `assets/brand/parousia-rounded.webp` into `assets/tray-{32,48}.rgba`.
