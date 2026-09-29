# Contributing to Parousia

Parousia is in early development. See `project/roadmap.md` for where things stand, and `project/vision.md`/`project/architecture.md` for the intended design before proposing larger changes.

## Project Layout

- `browser/`: the browser extension (Bun + TypeScript), targeting Chromium (Chrome/Edge), Firefox, Safari, and a userscript
- `desktop/`: Parousia Desktop (Rust), including its platform adapters (Discord first; Fluxer/Stoat are roadmap items)
- `packages/`: TypeScript shared by `browser/` and `website/` (the presence view)
- `core/`, `adapters/`: placeholders from the project skeleton
- `website/`: the `parousia.js.org` landing page and docs (Astro + Svelte 5)

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

**Website** (`website/`):

```bash
bun install
bun run typecheck
bun run lint
bun run format:check
bun run build
```

CI runs all of the above on every pull request. Make sure they pass locally first.

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

By contributing, you agree that your contributions will be licensed under this project's [MIT License](../LICENSE).
