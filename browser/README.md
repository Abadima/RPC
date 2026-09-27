# browser

PAROUSIA's browser extension, built with [Bun](https://bun.com) + strict TypeScript.

## Setup

```bash
bun install
```

## Commands

```bash
bun run build         # build all targets into dist/
bun run dev           # build, then rebuild on change
bun run typecheck      # tsc --noEmit
bun run lint           # oxlint
bun run format         # oxfmt
bun run format:check   # oxfmt --check
bun test               # bun test
```

## Build Targets

`bun run build` produces one folder per target under `dist/`, each a self-contained bundle plus its `manifest.json`:

| Target       | Output             | Distribution                                                                                                                     |
| ------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `chromium`   | `dist/chromium/`   | Chrome Web Store and Microsoft Edge Add-ons. Both consume the same Manifest V3 Chromium package; there's no separate Edge build. |
| `firefox`    | `dist/firefox/`    | Firefox Add-ons                                                                                                                  |
| `safari`     | `dist/safari/`     | Safari Web Extension (via Xcode conversion)                                                                                      |
| `userscript` | `dist/userscript/` | Manual install via a userscript manager (Tampermonkey, etc.)                                                                     |

Manifests live in `manifests/` and are validated (must declare `"manifest_version": 3`) as part of the build.
