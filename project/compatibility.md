# Compatible Extensions

Parousia aims to provide compatibility with existing browser extensions and integrations that use Rich Presence bridges.

Compatibility is an ongoing goal. If an integration works with Parousia, it can be added here.

## MAL-Sync

Integrates MyAnimeList with various websites, including automatic episode tracking and Rich Presence support.

**Status:** Under evaluation. MAL-Sync keeps its own detection and Parousia adds none of its own for it. It doesn't push presence: it registers with Discord-RPC-Extension and answers that extension's presence requests with a Discord `{clientId, presence}` payload, so today it shows on Discord through Discord-RPC-Extension, beside whatever Parousia shows. Where practical, Parousia's extension asks MAL-Sync for the active tab's presence the same way and publishes it to Parousia Desktop over the usual transport, so it's one presence with one Discord connection. If that needs anything invasive on either side, MAL-Sync stays as it is: its own Discord presence, running beside Parousia's.

[Chrome](https://chrome.google.com/webstore/detail/mal-sync/kekjfbackdeiabghhcdklcdoekaanoel) | [Firefox](https://addons.mozilla.org/en-US/firefox/addon/mal-sync/) | [GitHub](https://github.com/MALSync/MALSync)

## Discord-RPC-Extension

For users who prefer to use an established third-party application instead of the Parousia Desktop application, Parousia aims to remain compatible with Discord-RPC-Extension.

This allows users to use the Parousia browser extension with Discord-RPC-Extension as an alternative backend, without requiring the Parousia native application.

**Status:** Implemented. The extension talks to its app (`discord_rpc_ext`, port 6969) directly while Parousia Desktop isn't connected, on by default and switched in Settings > Platforms. Its cross-extension protocol is wired but inert until a Discord Application id is chosen for it.

[GitHub](https://github.com/lolamtisch/Discord-RPC-Extension)

## PreMiD Activities

Parousia supports the existing [PreMiD Activities](https://github.com/PreMiD/Activities) ecosystem rather than requiring every supported website to be reimplemented independently.

**Status:** Implemented. Parousia's build compiles PreMiD's Activities unchanged (1,411 of 1,417 when last built) and runs them on its own implementation of PreMiD's `Presence`/`iFrame` API, each as its own Discord Application. One is off until someone turns it on, which asks for access to its sites, and without them it doesn't run; what Activities may show from pages (what's playing, thumbnails, creator icons) is one choice in Settings > Privacy. Left out: Activities that need their own npm packages, target PreMiD's API version 2, or are on PreMiD's DMCA list. PreMiD's image service (`pd.premid.app`, which about a dozen Activities call to shorten a long image address or host a picture) is answered inside the extension and never contacted: a shortening gives the address back and an upload gives nothing, so the Activity shows without that image. An inline image (a `data:` address or a Blob, which PreMiD would host on that service) goes as the address of the picture it was made from when that's known: an `https` image drawn onto a canvas that's then exported, or a fetched image's Blob, like YouTube's thumbnail (`browser/src/premid/image-origin.ts`). One with no such address is left out, and the presence still shows. Not provided: `execInPage` with a function, `onRequest`, log reading, uploaded images, translations beyond English, and the activity type (Listening, Watching). See `project/architecture.md`, PreMiD Activities.

[GitHub](https://github.com/PreMiD/Activities)

Parousia's own native Activities live in [parousia-project/activities](https://github.com/parousia-project/activities), filed the same way (`websites/<letter>/<Name>/`) and built through the same pipeline. A website with an Activity in both, under the same folder name, is listed once: the native one runs until someone picks PreMiD's on the Activity's page, and only the one chosen ever runs.
