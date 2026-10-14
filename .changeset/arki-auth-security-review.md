---
'@arki/auth': patch
---

Security review fixes (W1-09). Magic-link tokens are now stored hashed, so a read of the verification table no longer yields working sign-in links. `createE2EHandler` without `allowEmail` now accepts only reserved `.test` addresses instead of every address. `reassignScope` now requires `current` (the row's stored owner and scope) and refuses to move a row the actor cannot see, so callers must pass it; the matching check is exported as `canSeeRow`, with the `RowScope` type. `ensureRateLimitNotExceeded` now lets exactly `limit` attempts through, always rejects with `RateLimitExceededError`, and keeps one limiter per limit and window instead of one per key. The full checklist is in `packages/auth/docs/security-review.md`.
