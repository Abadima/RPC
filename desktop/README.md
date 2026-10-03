**# desktop**

Parousia Desktop is the native app that receives Presence from the browser and publishes it to Discord. It is written in Rust with no async runtime.

See `project/architecture.md` for the Platform Adapter Architecture, Communication Protocol, and Desktop Tray, and `project/threat-model.md` for security details.

**## Build and Run**

```bash
cargo build
cargo build --release
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check

./target/debug/Parousia-Desktop
./target/debug/Parousia-Desktop --headless
```

On Windows, `cargo test` runs against the real thing: named pipes (the control pipe and a fake Discord, including Discord quitting and restarting), the loopback owner check against the TCP table, the registry, and the process tokens of the running machine. `scripts/verify-windows.ps1` then runs the release build (`cargo build --release`) and drives the real notification-area icon and its menu: a second launch, the CLI from a terminal, the control pipe's access list, the port, Settings > Start at login against the real `Run` key, Quit, and a port something else holds. It never touches your own config, Discord, or port 57179 (stop your own Desktop first); the Browser <-> Desktop link on Windows is `bun run desktop:verify` in `browser/`.

Release builds are produced by the `Release` workflow when a `vX.Y.Z` tag is pushed to `main`. They are standalone, stripped, and size-optimized (`opt-level = "z"`, LTO), at about 1 MB.

- **Linux:** x86_64 and aarch64, built for `*-unknown-linux-musl`
- **Windows:** x86_64 and aarch64, built with MSVC, no console window
- **macOS:** not available yet

Only one Desktop instance runs per user (a second launch says so and exits). Port `57179` must be available; if something else holds it, Desktop says so and exits.

**## Browser Connection**

Browsers connect to:

```text
ws://127.0.0.1:57179/ws
```

Desktop identifies browser clients by their `Origin`.

- Store builds are recognized automatically once their listings exist.
- Development and Firefox builds must be allowed once with `Parousia-Desktop allow <origin>`.
- Refused extensions can also be allowed from the tray's Diagnostics menu.
- Userscripts are disabled by default and require **Allow userscripts**.
- On Linux and Windows, connections from other OS users are refused before anything is read.

There is no pairing step for browser extensions.

**## Discord**

Desktop publishes the active browser Presence through the Discord app running on the same computer.

It supports Discord installed normally through its local IPC socket (a named pipe on Windows), including Flatpak and Snap installations. Only IPC owned by the current user is used: a socket owned by another user, or a pipe whose server process runs as another user, is never connected to.

When multiple browsers are connected, the most recently changed Activity is shown. When it clears, another connected browser can take over.

Desktop only connects to Discord while there is something to show. Changes within one Activity (the next video, a new track) show at once, unless something was shown less than 2 seconds before: then only the newest waits for those 2 seconds to pass, so a burst shows its first and its last, and a steady stream is never more than 2 seconds behind. Moving to another Activity, or clearing, always shows at once. Discord's own update limit is kept to on top of that.

`PAROUSIA_DISCORD_IPC_DIR` can override the directory used to find Discord's IPC socket on Linux and macOS, and `PAROUSIA_DISCORD_IPC_PIPE` the pipe name (up to its number, default `\\.\pipe\discord-ipc-`) on Windows. Discord quitting or restarting is noticed at once on every platform.

**## Commands**

These commands communicate with the running Desktop:

| Command                                    | Description                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `Parousia-Desktop status`                  | Show connected browsers, Discord, settings, refused extensions, and recent events |
| `Parousia-Desktop allow <origin>`          | Allow an extension origin                                                         |
| `Parousia-Desktop disallow <origin>`       | Remove an allowed origin                                                          |
| `Parousia-Desktop set userscripts on\|off` | Allow or block userscripts                                                        |
| `Parousia-Desktop debug on\|off`           | Enable or disable debug logging for this run                                      |

Add `--json` for machine-readable output.

On Windows the commands talk to the running Desktop over a named pipe that only this user can open, and print into the terminal they were typed in (the release exe has no console window of its own). The tray menu has the same controls.

**## Logging**

Desktop is silent by default and keeps no event history.

Debug logging can be enabled for the current run with:

```bash
Parousia-Desktop --debug
```

or through the tray, `status` interface, or console.

Startup errors are always reported.

**## Files**

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

All keys are optional. Unknown keys or invalid values cause Desktop to stop at startup rather than silently applying a bad configuration.

The command socket is stored under `$XDG_RUNTIME_DIR/parousia/desktop.sock` on Linux, or in the data directory when no runtime directory is available, with `desktop.lock` beside it: whichever Desktop holds the lock is the one that runs. On Windows it is the named pipe `\\.\pipe\parousia-desktop-<your SID>`, whose access list names only you. Browsers never use it.

`PAROUSIA_DATA_DIR` replaces the data directory (the end-to-end checks use it so a test run never touches a real config).

**## Tray**

The tray is optional.

- **Linux:** StatusNotifierItem
- **Windows:** notification-area icon, with Settings > **Start at login** (an entry under your own `Run` key, the one Task Manager's Startup tab lists; Windows starts it with the tray, and nothing else is installed)
- **macOS:** not available yet

The tray provides status, Discord Presence, connected browsers, diagnostics, settings, notifications, and quit controls.

Desktop continues working without a tray host. The command interface and browser dashboard provide the same functionality.

`--headless` disables the tray.

Tray icons are generated from `assets/brand/parousia-rounded.webp` into `assets/tray-{32,48}.rgba`.
