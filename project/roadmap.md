# Parousia Roadmap

This roadmap tracks remaining milestones. See `project/architecture.md` for architecture and `project/vision.md` for project goals.

## Current Work

### Activity Ecosystem

- [ ] Check the Netflix, HBO Max, and U-NEXT Activities on signed-in playback pages: they show a title only where the tab's title or Media Session holds one, which couldn't be seen without an account
- [ ] Support PreMiD Activity API v2 when available
- [ ] Verify Activity site-access prompts on installed Firefox and Chromium builds

### Desktop

- [ ] Windows, with a second Windows account: the other-user refusals (a loopback connection, the control pipe, a `discord-ipc` pipe) are built and tested against this user's own processes, the System process, and the real access list, but not against a real second account, which needs one to sign in as (and administrator rights to create one)
- [ ] Windows: restart the real Discord app while Desktop shows an Activity (a restart is checked against real named pipes and a stand-in Discord, and `discord:verify` against the real app, but quitting the real app wasn't forced on a machine in use)
- [ ] Windows: check the balloon notifications (a blocked extension, a second launch) by script; they're built, but Windows 11 shows them as toasts that UI Automation can't read reliably
- [ ] Windows on ARM64: built and linted for `aarch64-pc-windows-msvc`, never run (no ARM device)
- [ ] macOS tray and OS-user connection checks
- [ ] Start at login on Linux (an autostart entry) and macOS (a login item), and extension installation assistance (Windows has Start at login in the tray menu)
- [ ] macOS: run the native-system checks on a Mac. The control socket and its lock, and Discord's socket with the kernel's check of who listens on it (`getpeereid`), are Linux's code, reviewed and tested there (`project/threat-model.md`), and build and lint for `aarch64-apple-darwin`, but have never run on one

### Compatibility

- [x] Integrate MAL-Sync presence if practical (asks MAL-Sync for the shared tab's presence; see `project/compatibility.md`)
- [ ] Check MAL-Sync support on real anime sites: `malsync:real` runs the real MAL-Sync and Discord-RPC-Extension in Chromium and Firefox on a served page MAL-Sync shows as a Local entry, but not a series it found on MyAnimeList (cover, button) or a playing video (progress, pause)
- [ ] Optional PWA ↔ extension bridge. Deferred: it would make a remote origin the root of trust for reading what you're doing (a compromised site or deploy could read and send it anywhere, which Parousia otherwise never allows), needs a new always-on permission in Firefox, and the extension's own dashboard already opens full screen offline. See `project/threat-model.md`, Remote PWA bridge.
- [ ] Revisit Firefox `data_collection_permissions` when the compatibility backend is activated

### Presence Without Desktop

- [ ] Cloud authorization flow for showing presence without Parousia Desktop

### Website & Documentation

- [ ] Verify download links and filenames against the first published release

### Release

- [ ] Run release workflows manually and verify the resulting artifacts/releases
- [ ] Complete Firefox per-install origin handling
- [ ] Complete Chrome Web Store and AMO store listings/reviews
- [ ] Code-sign Windows binaries
- [ ] Add macOS builds
- [ ] Complete final security, privacy, permission, dependency, performance, and cross-platform compatibility audits

### Additional Platforms

- [ ] Fluxer adapter (waiting on Fluxer: it has no local Rich Presence integration yet; see `adapters/fluxer/README.md`)
- [ ] Stoat adapter

## Standing Goals

- Lightweight runtime and minimal browser permissions
- Privacy-first and secure by default
- Compatibility with existing Rich Presence integrations
- Broad Activity ecosystem
- Shared Activity model across Discord, Fluxer, and Stoat
- Maintainable codebase
