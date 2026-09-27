# PAROUSIA Architecture

This document describes how PAROUSIA's pieces fit together. See `project/vision.md` for why they exist and `project/roadmap.md` for when each part gets built.

## Overview

PAROUSIA is four cooperating pieces: the browser extension, PAROUSIA Desktop, platform adapters, and Activities.

The browser extension watches tabs and detects activity on supported sites, producing generic `Activity`/`Presence` values (see `browser/src/core/`). It doesn't know or care which platform will eventually display that presence.

That `Presence` travels across a transport (see Communication Protocol) to whatever owns publishing to real platforms. Normally that's PAROUSIA Desktop, a native Rust application, but the extension is also meant to work with compatible third-party backends (see Compatibility Layer) so people aren't forced to run PAROUSIA Desktop.

PAROUSIA Desktop hosts platform adapters (see Platform Adapter Architecture). Each adapter translates a generic `Presence` into whatever a specific platform's Rich Presence integration expects. Discord is the first one.

Activities are the detection layer: a matcher (usually a URL pattern) plus logic that turns a page into an `Activity`. PAROUSIA Activities sit alongside compatibility support for the existing PreMiD Activities ecosystem, so the project isn't stuck reimplementing site support that already exists elsewhere (see Compatibility Layer).

This split keeps every piece replaceable on its own: a new platform is a new adapter, a new site is a new Activity (native or via PreMiD), a new browser is a new target under `browser/src/platforms/`. None of them need to touch the others.

## Security Model

Every boundary between components is untrusted until proven otherwise:

- **Browser extension.** Content scripts, and anything that touches page content, are the least trusted part of the system. They read only what's needed to detect activity (URL, title, and minimal DOM data for a specific Activity) and never handle credentials or user data beyond that.
- **Browser ↔ Desktop channel.** Whatever transport is chosen has to authenticate that a message actually came from the PAROUSIA extension, not another local process or a malicious page, and PAROUSIA Desktop shouldn't expose it any wider than necessary. See Communication Protocol.
- **PAROUSIA Desktop.** The trusted core. It validates and bounds anything coming from the browser (size limits, expected shape) before handing it to an adapter, and doesn't assume an adapter's output is safe to log or display without care.
- **Platform adapters.** Talk to a specific platform's local integration (Discord's local RPC socket, for example). They receive only the generic `Presence` the runtime built, never raw page content.
- **Dependencies.** Kept minimal by policy (see `CLAUDE.md`). CI runs CodeQL, Dependabot, `bun audit`/`cargo audit`, and PR-time dependency review so a known-vulnerable dependency doesn't quietly creep in (see `.github/workflows/`).
- **Secrets.** Never committed. There currently aren't any: Discord's local RPC is keyed by a public application ID, not a secret.

This is a model, not a guarantee. It should be revisited whenever a new component or transport is added, and it gets a dedicated pass in Phase 8 (Hardening).

## Activity System Architecture

An **Activity** describes one thing a user might be doing on a specific site: an id, a display name, optional details/state text, the URL it was detected on, and optional assets/timestamps (`browser/src/core/activity.ts`).

Activities are found through an **ActivityRegistry**: each registered entry pairs a `matcher` (given a URL, is this Activity relevant?) with a `detect` function that builds the actual `Activity` from that URL. The registry doesn't care where an entry came from: native PAROUSIA code and a future PreMiD-compatibility shim (see Compatibility Layer) register the same way (`browser/src/core/registry.ts`).

A **PresenceRuntime** resolves the registry against the current tab and wraps the result (or nothing, if no Activity matches) into a **Presence** with a timestamp (`browser/src/core/runtime.ts`, `presence.ts`). `Presence` is the unit that actually leaves the browser. It's deliberately platform-agnostic; turning it into something Discord, Fluxer, or Stroat understands is the adapter's job, not the runtime's.

Lifecycle (implemented in Phase 2): a tab's `Presence` updates on navigation and on signals from the detected Activity itself (a video site reporting paused/playing, for example), and clears (a `Presence` with no activity) when the tab closes, hides, or navigates somewhere unmatched. The runtime always sends an explicit "nothing" rather than going quiet, so a stale presence doesn't linger on a platform after someone's moved on.

## Platform Adapter Architecture

An adapter is anything that can take a `Presence` and make some platform show it. On the desktop side, that's a small Rust trait, roughly:

```rust
trait PlatformAdapter {
    fn name(&self) -> &'static str;
    fn update(&mut self, presence: &Presence) -> Result<(), AdapterError>;
    fn clear(&mut self) -> Result<(), AdapterError>;
}
```

The exact shape will firm up once Discord's implementation lands in Phase 4; this is the contract, not the final API. PAROUSIA Desktop holds a small set of active adapters and forwards every `Presence` update to each of them. An adapter that isn't configured, or whose platform isn't running, reports itself unavailable rather than erroring.

Discord is the first adapter (Phase 4). Fluxer and Stroat are planned (Phase 7) but intentionally not started yet. Because every adapter speaks the same `Presence` type, adding one later means writing a new adapter, not touching the runtime, the registry, or any existing adapter.

## Communication Protocol

PAROUSIA Desktop runs a single local server (HTTP for setup, WebSocket for the live connection) on `127.0.0.1`. It's the one transport for every browser target, including Safari and the userscript, so there's no separate Native Messaging path to maintain.

**Discovery.** Neither the extension nor the userscript has filesystem access (that's exactly the capability Native Messaging exists to grant, and we're deliberately not using it), so Desktop can't hand out a dynamic port through a status file the way a native-messaging host could. Instead it listens on a **fixed, documented port** (exact number TBD at implementation time, picked to avoid common local-dev collisions), and both the extension and the userscript connect to it directly. A fixed port is a known tradeoff (something else on the machine could already be using it) but it needs no discovery step, and it's the same pattern several comparable local-bridge tools already use.

**Authentication.** A fixed port with no auth would let any local process, or any webpage's JavaScript, open a WebSocket to it and pretend to be PAROUSIA. The WebSocket handshake's `Origin` header is checked in both cases below, but only as defense-in-depth: it identifies which extension is asking, not that the connection is authorized, so it's never the only check. Two cases, two answers:

- **The browser extension:** its origin (`chrome-extension://<id>`, `moz-extension://<id>`, etc.) is fixed once published, but Chrome Web Store and Microsoft Edge Add-ons builds of the same Chromium extension get different extension IDs even though they share the same build artifact, so Desktop's allowlist treats each published identity (Chrome, Edge, Firefox, Safari) as its own entry. Alongside the origin check, the extension authenticates with the same kind of **pairing credential** as the userscript below: a per-installation secret issued once and stored by the extension, sent with every connection. Origin narrows down who's asking; the pairing credential is what actually proves it.
- **The userscript (and anything else without a stable origin):** it runs inside whatever arbitrary site the user is browsing, so its "origin" is that site's origin, not something Desktop can trust at all. It authenticates purely with a **pairing code**: a short secret PAROUSIA Desktop generates and displays once, which the user pastes into the userscript's settings a single time. The userscript stores it and sends it with every connection.

Desktop stays bound to `127.0.0.1` either way; none of this is meant to expose the server beyond the local machine.

**Messages.** JSON over the WebSocket, one small envelope: `{ "type": "presence", "presence": Presence }` for updates, plus a couple of control messages for the initial handshake (protocol version, pairing credential) and for Desktop acknowledging or rejecting a message. `Presence` (as defined in `browser/src/core/presence.ts`) is the canonical, versioned wire representation, not a type both sides must implement identically: Desktop deserializes it into whatever Rust representation is idiomatic on its side, rather than mirroring the TypeScript shape field-for-field.

The exact port number, pairing-credential storage, and Rust crate for the HTTP/WS server are implementation details for Phase 2 (`browser ↔ PAROUSIA Desktop communication`) and Phase 3 (`native browser communication`), not this document; picking a specific crate is a new dependency and gets its own confirmation when that work starts.

## Compatibility Layer

Two separate compatibility targets, from `project/compatibility.md`:

- **PreMiD Activities.** Confirmed against PreMiD's own docs: an Activity is a `presence.ts` script (plus an optional `iframe.ts` for sites that need to read an embedded iframe) that constructs a `Presence` instance with its own Discord `clientId` and, on a recurring `UpdateData` tick fired by the PreMiD extension, calls `setActivity(presenceData)` with a `PresenceData` object. The shim PAROUSIA needs is an implementation of that same `Presence`/`iFrame` API surface, so an unmodified Activity's `presence.ts` runs unchanged and its `setActivity` calls feed PAROUSIA's `ActivityRegistry`/`PresenceRuntime` instead. Two details this rules out doing naively: `PresenceData` is richer than PAROUSIA's current `Activity` type (it carries buttons, party info, and separate details/state URLs that `Activity` doesn't have yet), and each Activity supplies its own `clientId` rather than sharing one PAROUSIA-wide id, so both need to survive the translation. This stays a shim, not a rewrite; PreMiD Activities never talk to PAROUSIA's core directly.
- **Discord-RPC-Extension.** The goal is letting PAROUSIA's browser extension feed its detected `Presence` to Discord-RPC-Extension instead of PAROUSIA Desktop, so someone can use PAROUSIA's Activity detection without installing PAROUSIA Desktop at all. Confirmed against its own docs: this isn't a network protocol at all, it's the browser's own cross-extension messaging. A compatible extension registers once with `chrome.runtime.sendMessage(<Discord-RPC-Extension's id>, { mode: 'active' | 'passive' })`, then answers its periodic (every 15s) presence request with `{ clientId, presence }` in Discord's own Rich Presence payload shape, via `chrome.runtime.onMessage`. This has nothing to do with the Communication Protocol above; it's a separate, extension-only code path (no `chrome.runtime` cross-extension messaging exists for a userscript or for Safari, since Discord-RPC-Extension isn't published there either). The `Presence` → Discord payload translation this needs is the same shape our own Discord adapter (Phase 4) will need anyway, so that mapping is worth sharing between the two rather than writing twice.

## Website

Built with **Astro + Svelte 5**: Astro handles static pages, routing, and content (the landing page and the documentation section) in one project (`website/`), matching the "single consolidated project" goal in `project/vision.md`; Svelte is used selectively for interactive components where a static page isn't enough. The site stays statically generated and deployable to GitHub Pages. Phase 1 only needs this scaffolding to exist and build; writing the actual documentation content is Phase 6.
