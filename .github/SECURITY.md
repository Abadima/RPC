# Security Policy

## Supported versions

The latest release and the current `main` branch get security fixes. Older releases don't. Builds from `main` are published as `dev-<commit>` pre-releases, and they can be broken.

## Reporting a vulnerability

Please don't open a public issue for a vulnerability. Report it privately with [GitHub's private reporting](https://github.com/Abadima/RPC/security/advisories/new) on this repository.

Include what you found, how to reproduce it (or a proof of concept), which part it affects, and the version and operating system. If you're unsure whether something counts, report it anyway.

Parousia is maintained by one person, so replies aren't instant. You'll get an acknowledgement, and a fix is scheduled by severity. Please keep the details private until a fixed release is out. Reporters are credited in the release notes unless they ask not to be.

## What's in scope

This repository holds three things, and all of them are in scope:

- **Parousia Desktop.** The local WebSocket on `127.0.0.1:57179`, the origin allowlist, the IPC socket, the tray, and the connection to Discord. Anything that lets a web page, another extension, or another user on the machine publish presence, read status, or change settings.
- **The browser extensions and the userscript.** The permissions they ask for, how they handle messages from pages and from Activities, and what they send to Desktop.
- **The Activity runtime.** The code that runs Activities and PreMiD's compatibility layer: how page scripts are isolated, and what they can reach in the extension.

[`project/threat-model.md`](../project/threat-model.md) lists what Parousia defends against and what it doesn't. Read it before reporting a gap: a process running as the same user as Desktop, for example, is out of scope by design.

## Other repositories

- **Native Activities** live in [parousia-project/activities](https://github.com/parousia-project/activities). A bug in an Activity itself goes there. A way for any Activity to get more access than its metadata declares is a runtime bug and belongs here.
- **The website** is [parousia-project/website](https://github.com/parousia-project/website), a static site. Report problems with it through that repository's private reporting.
- **PreMiD's Activities** are PreMiD's code, included unchanged. A vulnerability in one of them should go to [PreMiD/Activities](https://github.com/PreMiD/Activities). If it can reach beyond the page it runs on because of how Parousia runs it, that part is ours: report it here.

## What's out of scope

- Vulnerabilities in Discord, browsers, or operating systems.
- Attacks that need code already running as the same user as Desktop, or physical access to the machine.
- Anyone who turned on the userscript setting and then had a web page publish presence. The setting says that's what it allows.
- That a web page can tell whether Desktop is running. This is a known gap, and it can't read anything from it.
- Reports from automated scanners with no demonstrated impact.

## What to expect from the project

The extension asks for `tabs` and `storage`, and everything else only when you turn an Activity on. Nothing secret is committed to the repository. CodeQL, Dependabot, and dependency review run on every change, and Desktop and the extension treat everything they receive from each other, from pages, and from Activities as untrusted.
