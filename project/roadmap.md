# PAROUSIA Roadmap

This roadmap tracks major project milestones. Individual implementation tasks may change as development progresses.

## Phase 1: Foundation

- [ ] Establish core PAROUSIA architecture
- [ ] Establish project-wide security model
- [ ] Establish activity system architecture
- [ ] Establish browser ↔ native communication protocol
- [ ] Establish platform adapter architecture
- [ ] Establish compatibility layer architecture
- [ ] Set up project-wide testing infrastructure
- [ ] Set up build, lint, formatting, and security checks
- [ ] Establish documentation website

---

## Phase 2: Browser Extension

- [ ] Build Chromium extension
- [ ] Build Firefox extension
- [ ] Evaluate Safari support
- [ ] Implement activity detection/runtime
- [ ] Implement activity lifecycle management
- [ ] Implement minimal-permission model
- [ ] Implement browser ↔ PAROUSIA Desktop communication
- [ ] Implement compatible communication with `Discord-RPC-Extension`
- [ ] Verify compatibility with existing integrations such as MAL-Sync
- [ ] Minimize extension resource usage
- [ ] Security review of extension permissions and APIs

---

## Phase 3: PAROUSIA Desktop

- [ ] Build native Rust desktop application
- [ ] Implement native browser communication
- [ ] Implement Discord Rich Presence integration
- [ ] Implement activity management
- [ ] Implement configuration/state management
- [ ] Implement system tray integration
- [ ] Implement extension installation/update assistance
- [ ] Minimize idle resource usage
- [ ] Security review of native system interaction

---

## Phase 4: Discord

Discord is the first supported platform and the initial target for the production implementation.

- [ ] Complete Discord platform adapter
- [ ] Implement Rich Presence lifecycle
- [ ] Implement presence updates
- [ ] Implement activity assets
- [ ] Implement buttons and metadata
- [ ] Implement platform-specific capability detection
- [ ] Validate compatibility with existing Discord RPC integrations
- [ ] Validate compatibility with MAL-Sync and similar integrations
- [ ] Complete Discord security review
- [ ] Complete Discord performance review

---

## Phase 5: Activity Ecosystem

PAROUSIA should avoid requiring every supported website to be implemented independently.

- [ ] Integrate the `PreMiD/Activities` ecosystem
- [ ] Establish a PAROUSIA-compatible Activity format/runtime
- [ ] Define compatibility requirements for external Activities
- [ ] Build Activity validation/testing tooling
- [ ] Support PAROUSIA-native Activities
- [ ] Add the first native Activity: **Jena**
- [ ] Add `jena.systems` Rich Presence
- [ ] Document Activity development
- [ ] Establish Activity security requirements

---

## Phase 6: Website & Documentation

The PAROUSIA website will be hosted through GitHub Pages at:

**https://parousia.js.org**

- [ ] Build PAROUSIA landing page
- [ ] Build documentation site
- [ ] Document installation
- [ ] Document configuration
- [ ] Document browser extension
- [ ] Document PAROUSIA Desktop
- [ ] Document Activities
- [ ] Document compatibility APIs
- [ ] Document security/privacy model
- [ ] Document development setup
- [ ] Document Activity development
- [ ] Configure GitHub Pages deployment
- [ ] Configure `parousia.js.org`

---

## Phase 7: Additional Platforms

The architecture should support additional presence platforms from the beginning, but these are **not part of the initial implementation**.

### Fluxer

- [ ] Design Fluxer adapter
- [ ] Implement Fluxer platform support
- [ ] Validate Activity compatibility
- [ ] Validate platform-specific capabilities
- [ ] Add Fluxer documentation

### Stroat

- [ ] Design Stroat adapter
- [ ] Implement Stroat platform support
- [ ] Validate Activity compatibility
- [ ] Validate platform-specific capabilities
- [ ] Add Stroat documentation

---

## Phase 8: Hardening

- [ ] Full security audit
- [ ] Dependency vulnerability audit
- [ ] Permission audit
- [ ] Privacy audit
- [ ] Performance benchmarking
- [ ] Resource usage benchmarking
- [ ] Cross-platform testing
- [ ] Browser compatibility testing
- [ ] RPC compatibility testing
- [ ] Activity compatibility testing
- [ ] Documentation review
- [ ] Release readiness review

---

## Long-Term Goals

- [ ] Maintain a lightweight runtime
- [ ] Maintain minimal browser permissions
- [ ] Maintain strong compatibility with existing Rich Presence integrations
- [ ] Support a broad Activity ecosystem without requiring PAROUSIA-specific implementations for every website
- [ ] Support Discord, Fluxer, and Stroat through a shared Activity architecture
- [ ] Keep the platform privacy-first
- [ ] Keep the platform secure by default
- [ ] Keep the codebase maintainable as the ecosystem grows
