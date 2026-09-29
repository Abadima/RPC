# Compatible Extensions

Parousia aims to provide compatibility with existing browser extensions and integrations that use Rich Presence bridges.

Compatibility is an ongoing goal. If an integration works with Parousia, it can be added here.

## PreWrap

PreMiD presence wrapper with a large library of website Activities.

**Status:** Planned

[Chrome](https://chrome.google.com/webstore/detail/prewrap/calpcokkjmookodfpbmdbknfcjhekgaj) | [Firefox](https://addons.mozilla.org/firefox/addon/prewrap/) | [GitHub](https://github.com/lolamtisch/PreWrap)

## MAL-Sync

Integrates MyAnimeList with various websites, including automatic episode tracking and Rich Presence support.

**Status:** Planned

[Chrome](https://chrome.google.com/webstore/detail/mal-sync/kekjfbackdeiabghhcdklcdoekaanoel) | [Firefox](https://addons.mozilla.org/en-US/firefox/addon/mal-sync/) | [GitHub](https://github.com/MALSync/MALSync)

## Discord-RPC-Extension

For users who prefer to use an established third-party application instead of the Parousia Desktop application, Parousia aims to remain compatible with Discord-RPC-Extension.

This allows users to use the Parousia browser extension with Discord-RPC-Extension as an alternative backend, without requiring the Parousia native application.

**Status:** Implemented. The extension talks to its app (`discord_rpc_ext`, port 6969) directly, on by default and switched in Settings > Platforms. Its cross-extension protocol is wired but inert until a Discord Application id is chosen.

[GitHub](https://github.com/lolamtisch/Discord-RPC-Extension)

## PreMiD Activities

Parousia intends to support the existing [PreMiD Activities](https://github.com/PreMiD/Activities) ecosystem rather than requiring every supported website to be reimplemented independently.

**Status:** Planned

[GitHub](https://github.com/PreMiD/Activities)

Parousia may also provide its own native Activities where appropriate.
