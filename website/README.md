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

## Status

`astro check` doesn't support TypeScript 7 yet (it errors out and points at the still-experimental `@astrojs/ts-content-mapper` instead), so `typecheck` uses plain `tsc --noEmit` against `astro sync`'s generated types. That's enough for now since there are no complex `.astro` components yet; revisit once there are, or once Astro's own tooling catches up to TS 7.
