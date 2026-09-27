# Security Policy

## Supported Versions

PAROUSIA is in early development (pre-2.0). There are no stable releases yet, and no compatibility or security-patch guarantees are made for any specific version.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/Abadima/RPC/security/advisories/new) for this repository, so we can assess and fix the issue before it's public.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof of concept
- The affected component (browser extension, desktop application, an adapter, etc.) and platform/version

We aim to acknowledge new reports within a timely manner. Timelines for a fix depend on severity and complexity; we'll keep you updated as we work on it.

## Disclosure

We follow coordinated disclosure: please give us a reasonable opportunity to investigate and ship a fix before any public disclosure. We'll credit reporters (unless anonymity is requested) once a fix is released.

## Security Expectations

Security is a top priority for PAROUSIA:

- The browser extension requests only the permissions it strictly needs.
- Secrets (API keys, tokens) are never committed to this repository.
- Dependencies are kept minimal and are expected to have zero known vulnerabilities; CodeQL, Dependabot, and PR-time dependency review all run automatically (see `.github/workflows/`).
- Cross-component communication (browser ↔ desktop, and platform adapters) is expected to validate untrusted input rather than assume trust between components.

If you're not sure whether something counts as a security issue, report it privately anyway.
