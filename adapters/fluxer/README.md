# adapters/fluxer

Reserved for [Fluxer](https://fluxer.app) platform support (see `project/vision.md` and `project/roadmap.md`).

Not implemented because Fluxer currently provides no Rich Presence integration for third-party applications.

## Current Fluxer support

Checked on 2026-10-02 against Fluxer's source (`fluxerapp/fluxer`, `main`), documentation, and the Linux desktop client (Flatpak `app.fluxer.Fluxer` 2026.922.194050).

- **No local Rich Presence:** The desktop client exposes no RPC socket or TCP endpoint for external applications. Its local IPC is limited to Electron's single-instance socket, alongside mDNS. The client source and bundled application contain no usable RPC or activity integration.
- **No activity support in the gateway:** Presence Update currently supports `status`, `afk`, `mobile`, and `custom_status`. It does not expose Rich Presence fields such as details, state, images, buttons, or timestamps.
- **Account-token tools are not suitable:** Existing community tools that show activity on Fluxer do so by logging in with the user's account token and modifying their custom status. PAROUSIA does not use account credentials with full account access, and custom status is not equivalent to Rich Presence.
- **Future Rich Presence work exists:** Fluxer previously proposed a Discord-compatible IPC server and activity support in [PR #1150](https://github.com/fluxerapp/fluxer/pull/1150). The PR was closed unmerged on 2026-09-02, while Fluxer has indicated the work may be revisited later in [issue #131](https://github.com/fluxerapp/fluxer/issues/131).

## Future implementation

When Fluxer provides a usable local Rich Presence integration, the adapter will live in `desktop/src/adapters/fluxer/` behind the same `PlatformAdapter` interface used by Discord.

If Fluxer adopts the IPC design proposed in #1150, care will be needed to prevent the Discord adapter from connecting to a Fluxer IPC socket. If both platforms expose the same `discord-ipc-N` socket naming scheme, their framing and worker logic should be shared where practical rather than duplicated, while platform-specific discovery and presence mapping remain separate.
