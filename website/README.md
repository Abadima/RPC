# website

The `parousia.js.org` landing page and documentation, built with [Astro](https://astro.build) + [Svelte 5](https://svelte.dev). Astro handles static pages, routing, and content; Svelte is used selectively for interactive components.

## Setup

```bash
bun install
```

## Commands

```bash
bun run dev         # local dev server
bun run build        # build to dist/
bun run preview      # preview the production build
bun run typecheck    # astro sync && tsc --noEmit
```

## PWA

`/pwa/` (`src/pages/pwa/`, `public/pwa/`) is a standalone, installable presence view that works without the Parousia extension: static, serverless, with a minimal cache-first service worker for the app shell. It shares its rendering/state logic with the extension's own fullscreen page through `packages/presence-view/`; see `project/architecture.md`'s "Full-Screen Presence View" section.

## Status

`astro check` doesn't support TypeScript 7 yet (it errors out and points at the still-experimental `@astrojs/ts-content-mapper` instead), so `typecheck` uses plain `tsc --noEmit` against `astro sync`'s generated types. That's enough for now since there are no complex `.astro` components yet; revisit once there are, or once Astro's own tooling catches up to TS 7.
