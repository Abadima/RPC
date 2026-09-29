# core

Unused placeholder from the project skeleton. The browser and Desktop each keep their own Activity/Presence types, and the WebSocket wire format is the contract between them (see `project/architecture.md`, Communication Protocol), so there is no shared code package to put here.

Candidate for removal: concrete adapters live in `desktop/`, and nothing else needs a shared code package.
