---
'@arki/auth': minor
---

`@arki/auth/orpc` (new): ownership checks for oRPC procedures (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, phase 1c). `assertFound(row, label)` throws oRPC `NOT_FOUND` for a missing row. `assertOwnedOrNotFound(row, actorId, label)` (reads) also answers `NOT_FOUND` for another user's row, so a stranger cannot tell the two apart. `assertOwnedOrForbidden(row, actorId, label)` (mutations) answers `NOT_FOUND` for a missing row and `FORBIDDEN` for another user's row, since the caller already had the id. All three narrow the row's type. `@orpc/server` is an optional peer dependency.
