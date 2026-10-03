# adapters/discord

Discord Rich Presence platform adapter. Discord is the first supported platform (see `project/vision.md`).

The adapter itself is Desktop code, in `desktop/src/adapters/discord/`. This directory holds what Desktop and the browser extension share:

- `activity-mapping.json`: how a Parousia Activity becomes a Discord activity, as cases that both `desktop/src/adapters/discord/activity.rs` and `browser/src/compat/discord-rpc-extension.ts` are tested against, so the two mappings can't drift apart. Change a rule in both files and add a case here. The activity type, the status line, the party, and the links on images are Desktop's alone: Discord-RPC-Extension's app passes fields to an RPC library whose version isn't known to take them, so the bridge leaves them out. Their cases are in `activity.rs`.
