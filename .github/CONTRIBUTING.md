# Contributing to Parousia

Parousia is in early development. See `project/roadmap.md` for where things stand, and `project/vision.md`/`project/architecture.md` for the intended design before proposing larger changes.

## Project Layout

- `browser/`: the browser extension (Bun + TypeScript), targeting Chromium (Chrome/Edge), Firefox, and a userscript
- `desktop/`: Parousia Desktop (Rust), including its platform adapters (Discord first; Fluxer/Stoat are roadmap items)
- `core/`, `adapters/`: placeholders from the project skeleton
- [`parousia-project/website`](https://github.com/parousia-project/website): the `parousia.abadima.dev` landing page, downloads, and docs (Astro + Svelte 5), in its own repository
- [`parousia-project/activities`](https://github.com/parousia-project/activities): Parousia's own Activities

## Getting Started

**Browser** (`browser/`):

```bash
bun install
bun run typecheck
bun run lint
bun run format:check
bun run build
bun test
```

**Desktop** (`desktop/`):

```bash
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

**End to end** (`browser/`, Linux, after building both; needs port 57179 free):

```bash
bun run desktop:verify
```

CI runs all of the above on every pull request. Make sure they pass locally first. The website has its own checks in its own repository.

## Releasing

A release is a version tag on `main`; `.github/workflows/release.yml` does the rest: it tests and builds everything, then publishes the GitHub release with its files, `SHA256SUMS`, and build provenance attestations.

1. Set the version in `desktop/Cargo.toml` (and `Cargo.lock`, by building) and in `browser/manifests/chromium.json` and `firefox.json`. Extension manifests take numbers only, so `1.2.3-rc.1` is `1.2.3` there. `node scripts/release-check.mjs v1.2.3` tells you what still disagrees.
2. Merge to `main`, then tag and push: `git tag v1.2.3 && git push origin v1.2.3`. A tag with a suffix (`v1.2.3-rc.1`) is published as a pre-release.
3. To try the whole pipeline first, run "Release" by hand from the Actions tab on any branch. It builds and checks everything, keeps the files as a workflow artifact, and publishes nothing.

| File                                                                          | What it is                                                        |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `parousia-desktop-windows-x86_64.exe`, `parousia-desktop-windows-aarch64.exe` | Parousia Desktop for Windows; only Windows' own DLLs needed       |
| `parousia-desktop-linux-x86_64`, `parousia-desktop-linux-aarch64`             | Parousia Desktop for Linux; static (musl), so no libraries needed |
| `parousia-chromium.zip`, `parousia-firefox.zip`                               | The browser extension                                             |
| `parousia.user.js`, `parousia.user.js.gz`                                     | The userscript, and the same file gzipped                         |
| `SHA256SUMS`                                                                  | Checksums of all of the above                                     |

The Windows ARM64 executable is cross-compiled on an x64 runner, so CI checks its imports but doesn't run it. There are no macOS or Safari artifacts.

## Guidelines

- **Dependencies:** Minimize. Adding a new dependency requires justification in the PR description. Prefer native functionality over pulling in a library.
- **Types:** Strict TypeScript. No `any`, no unchecked casts. Rust code should be `clippy`-clean.
- **Scope:** Keep PRs focused. Avoid unrelated refactors or premature abstractions.
- **Security:** Never commit secrets. See `SECURITY.md` to report vulnerabilities privately rather than via a public issue.
- **Commits:** Write clear, descriptive commit messages explaining _why_, not just _what_.

## Pull Requests

1. Fork the repository and create a branch off `main`.
2. Make your change, keeping it scoped to a single concern.
3. Ensure the relevant validation commands above pass.
4. Open a PR using the provided template, describing the change and how it was tested.

## Reporting Bugs / Requesting Features

Use the issue templates. For security vulnerabilities, use [private reporting](https://github.com/Abadima/RPC/security/advisories/new) instead. See `SECURITY.md`.

## License

By contributing, you agree that your contributions will be licensed under this project's [Apache License 2.0](../LICENSE).
