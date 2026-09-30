# Parousia

Parousia is a modern Rich Presence platform built around performance, privacy, security, and broad ecosystem compatibility.

It consists primarily of a lightweight browser extension and a native desktop application, while remaining capable of working with compatible third-party backends where appropriate.

## Goals

Parousia aims to provide a significantly more lightweight and capable experience than existing Rich Presence solutions while maintaining a strong focus on:

- Performance
- Low resource usage
- Privacy
- Security
- Minimal browser permissions
- Minimal dependencies
- Cross-platform support
- Reliable Rich Presence
- Good user experience
- Broad ecosystem compatibility

The project should avoid unnecessary complexity and overhead wherever possible. Being lightweight is a core design requirement rather than an afterthought.

## Privacy & Security

Parousia is privacy-first.

The browser extension should request only the permissions it absolutely needs and should minimize access to browser data, local resources, and network resources.

The project should avoid unnecessary collection, storage, or transmission of user data.

Security should be treated as a fundamental requirement throughout the browser extension, native application, communication protocols, and platform integrations.

## Activity Ecosystem

Parousia should not require its own implementation of every supported website.

The project will initially build on the existing PreMiD Activities ecosystem while developing its own Activity ecosystem over time.

This allows Parousia to benefit from the existing breadth of website support while maintaining the flexibility to provide native Parousia Activities where they provide a better experience or functionality.

The first planned native Activity is **Jena**, providing Rich Presence support for `jena.systems`.

## Platform Support

Discord is the initial supported Rich Presence platform.

The architecture should support multiple platforms through shared Activity concepts combined with platform-specific implementations.

The long-term platform roadmap includes:

- Discord
- Fluxer
- Stoat

Fluxer and Stoat are currently roadmap items and should not be implemented during the initial Discord-focused development unless specifically required for architectural validation.

The architecture should nevertheless avoid decisions that unnecessarily prevent future support for them.

## Compatibility

Parousia should support popular existing Rich Presence integrations where technically practical.

The browser extension should be capable of working with both:

- Parousia Desktop
- Compatible third-party Rich Presence backends

This allows users to adopt Parousia without being forced to replace an existing backend immediately.

Compatibility with existing ecosystems should be treated as a practical feature rather than requiring every external project to become Parousia-specific.

## Website

The Parousia project website will be hosted through GitHub Pages at `parousia.abadima.dev`.

The website will provide:

- The Parousia landing page
- Project documentation
- Installation information and downloads
- Developer documentation
- Activity documentation
- Compatibility information
- Privacy and security information

The website should remain consolidated into a single project rather than separating the landing page and documentation into unrelated repositories or applications. That project has its own repository, [parousia-project/website](https://github.com/parousia-project/website).

## Long-Term Direction

Parousia should grow into a lightweight Activity platform rather than becoming tightly coupled to a single Rich Presence implementation.

The core principles should remain consistent as the project grows:

> **Fast. Lightweight. Private. Secure. Compatible.**
