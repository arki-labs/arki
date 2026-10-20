---
'@arki/offline': minor
---

Declare custom secure ID alphabets and lengths through `defineId`, retaining exact generation failures and canonical nominal types.

Offline response-cache record IDs now use `idempotencyKeyId` and preserve their `idk_` plus 21-character URL-safe format. `IdempotencyRepository.store()` returns canonical failures and emits a default OpenTelemetry span. Its middleware reports cache failures without changing a completed handler response.

Breaking: direct inserts into `idempotencyKeys` or a namespaced idempotency table must supply an ID. Generate and narrow `idempotencyKeyId.create()` before inserting; the table no longer hides fallible entropy in a Drizzle default. See the Offline cache-write upgrade guide.
