# @arki/offline

## 0.1.0

### Minor Changes

- a88dcdb: Security: a queued offline write no longer replays under whoever is signed in when the browser reconnects. `createOfflineMutationQueue` and the `'queue'` tier of `createOfflineRuntime` now require `actorId: () => string | null`. Each entry stores the actor signed in at enqueue. At replay the entry is sent only while that same actor is signed in. Nobody signed in: it stays queued and the queue emits `'auth-required'`. Another actor signed in: it is dead-lettered unsent with `lastError.code === 'ACTOR_MISMATCH'`. `deadLetter.retry` keeps the original actor. New exported type `QueueErrorCode`.
- 48313a3: Return exact canonical enqueue failures and preserve typed queue/token identities with the existing secure 21-character representation. `queue.enqueue` and `useOfflineMutation().mutate` now return a receipt or an exact failure; receipt status distinguishes queued, sent and dead-lettered writes. The hook exposes pending and failure state.

  Unconfirmed persistence carries the original identity for reconciliation. Corrupt persisted data is preserved instead of silently discarded; replay does not repeat an already accepted RPC after local cleanup fails in the same runtime. Enqueue tracing inherits application context and cannot alter execution, including when reporters reject asynchronously.

  Drain, queue/dead-letter storage and retry/discard now return exact canonical failures instead of rejecting operationally. Consumers must narrow these results with `isFailure`. Queue status and hooks expose background failures; devtools displays returned failures. Unknown RPC adapter defects halt instead of blindly retrying; known transport outages use `QueueTransportUnavailable`. Explicit drains resume authentication halts. Storage, actor, dead-letter and drain operations are instrumented by default.

- 7a01cc9: `@tanstack/db` moves to the workspace catalog at `^0.15.0` (from `^0.12.3`), with `@tanstack/react-db` `^0.5.10` and `@tanstack/query-db-collection` `^1.4.5` on the same version. `createLocalCollection` needed no change.
- 2c57c1c: Declare custom secure ID alphabets and lengths through `defineId`, retaining exact generation failures and canonical nominal types.

  Offline response-cache record IDs now use `idempotencyKeyId` and preserve their `idk_` plus 21-character URL-safe format. `IdempotencyRepository.store()` returns canonical failures and emits a default OpenTelemetry span. Its middleware reports cache failures without changing a completed handler response.

  Breaking: direct inserts into `idempotencyKeys` or a namespaced idempotency table must supply an ID. Generate and narrow `idempotencyKeyId.create()` before inserting; the table no longer hides fallible entropy in a Drizzle default. See the Offline cache-write upgrade guide.

- c6b4949: The jobs packages return failures and stop failing silently. Breaking in 0.x.

  - **`@arki/queue`.** A queue worker that fails to start in the background is logged at error level, and `stop()` and `app.dispose()` return the new `QueueWorkerStartFailed` failure (`queue.worker_start_failed`). Before, it was logged at debug level only. `outbox.schedule` returns `InvalidInput` for args that are not plain JSON or are over `maxArgsBytes`; before, it threw `OUTBOX_E003`, which is removed from `OUTBOX_ERROR_CODES`. `CronPatterns.everySeconds`, `everyMinutes`, `everyHours`, `everyDays` and `monthly` refuse `NaN` and fractions. The internal shape checks use `@arki/schema`.
  - **`@arki/offline`.** `createOfflineMutationQueue` takes `retry` (an `@arki/resilience` `Backoff`, default exponential from 1 s to 30 s, at most 5 retries) in place of `maxRetries` and `backoff`. `stop()` now cancels the wait of a running drain. `offline.dispose()` is new and removes the queue's window listeners. `persistNow()` resolves the new `QueryCachePersistFailed` failure (`offline.query_cache_persist_failed`) when IndexedDB refuses the write; before, it rejected with the raw browser error. A stored query cache that does not match its shape is dropped and refetched, not restored. New dependency: `@arki/resilience`.
  - **`@arki/content-build`.** `compileMarkdown` sanitizes raw HTML by default (GitHub rules: no `<script>`, no event handlers, no `javascript:` links). Pass `trustedHtml: true` to keep it as written. Remote cover images time out after 15 s and stop at 20 MiB (`timeoutMs`, `maxBytes`). New dependency: `rehype-sanitize`.

- c461805: `createOfflineRuntime` no longer shares one QueryClient across server requests. On the server (SSR), `offline.Provider` now makes a fresh, unpersisted QueryClient for each request (`gcTime: Infinity`, TanStack Query's server default), so one user's cached data never reaches another user's server-rendered page. In the browser nothing changes: one persisted client for the app's lifetime.

  Breaking: `offline.queryClient` and `offline.persistNow()` are browser only. On the server, reading `offline.queryClient` throws and `persistNow()` rejects. Read the client with `useQueryClient()` inside `offline.Provider`.

- 133187a: Replays send `Offline-Actor` (the user who queued the write), and the `idempotency()` middleware refuses a replay with 403 FORBIDDEN unless it matches the session user. A missing header while signed in is refused. This closes the gap the browser cannot: a session cookie that changes between the queue's own check and the request leaving.
- 3ff5258: The oRPC idempotency table now runs on SQLite (libSQL) as well as Postgres. `createIdempotencyTable` takes a column kit instead of a `PgSchema`, and `SqliteIdempotencyRepository` is the SQLite twin of `IdempotencyRepository` (it works with `idempotency(...)` the same way). The Postgres table is unchanged: drizzle-kit sees no difference. `@arki/db` is a new optional peer, needed for the column kits.

  Breaking: the first argument changed. Migrate `createIdempotencyTable(schema)` to `createIdempotencyTable(pgColumns(schema))`, with `pgColumns` from `@arki/db/pg`. `idempotencyKeys` (default schema) is unchanged.

  SQLite limits: timestamps keep milliseconds, and `varchar` limits become `CHECK` constraints.

- 12aec96: `actorId()` now tells "signed out" (`null`) from "not known yet" (`undefined`). Only `undefined` falls back to the device's last actor; `null` forgets it. Before, a write queued after a sign-out on a shared device was bound to the user who had left and replayed as them when they signed in again. Return `undefined` while the session loads.

### Patch Changes

- e132ad3: Document actionable fixes and verification commands for canonical error definitions.

  Journal command/workflow failures and Embeddings failures also expose the missing runtime remediation guidance. Existing failure codes, data and inferred unions are unchanged.

- 11c5bc2: Complete public error summaries and remediation metadata. The source error index now follows canonical factory aliases, checks duplicate original codes across packages, and enforces documentation for private libraries too. Runtime behavior and failure data are unchanged.

  No demo impact: this changes error documentation and repository checks only.

- 66d1f3e: `createOfflineRuntime` and `createPersistedQueryClient` now return `persistNow()`. It writes the persisted query cache to IndexedDB at once and resolves when it is stored. The automatic writes are throttled to one a second and never say when they finish, so a page that reloaded right after a delete could restore the item from the older snapshot. Await `persistNow()` after removing a query that must not come back. `createIdbPersister` returns an `IdbPersister` (a `Persister` plus `persistClientNow`). `createOfflineRuntime` now passes the resolved build buster to the provider too, so the stored cache and the restore check use the same string.
- 4cd2727: A write queued while the session is unknown (an offline reload, `actorId()` answers `null`) is now bound to the last actor signed in on this device, kept under `<storageKey>:last-actor`. Before, it was bound to `null`, and once the user signed back in it was dead-lettered as `ACTOR_MISMATCH` and could only be discarded. Replay rules are unchanged: it is sent only while that same user is signed in, and is dead-lettered for any other account.

  The replay also reads `actorId()` right before every send attempt (each entry and each retry), not once per drain pass, so an account switch in the middle of a replay dead-letters the remaining writes as `ACTOR_MISMATCH` instead of sending them under the new session.
