# @arki/offline API reference

Every exported value, grouped by import path. Types are not listed. For the design, read `2026-05-16-arki-offline-design.md` and the README.

## @arki/offline/query

- `createPersistedQueryClient`: creates a TanStack QueryClient paired with an IndexedDB backed persister.
- `createIdbPersister`: creates an async storage persister backed by IndexedDB through idb-keyval. One storage key holds the whole cache.
- `PersistedQueryClientProvider`: a thin wrapper around `PersistQueryClientProvider` that takes the client and persister pair.
- `QueryCachePersistFailed`: the failure for a cache write to IndexedDB that did not work. The in-memory cache stays usable.
- `useIsRestoring`: tells whether the persisted cache is still being restored.

## @arki/offline/mutations

- `createOfflineMutationQueue`: creates the queue of mutations made while offline and replays them when the connection returns.
- `OfflineQueueProvider`: React provider that gives components access to the queue.
- `useOfflineQueue`: reads the queue from the provider. It throws if no provider is present.
- `useOfflineMutation`: queues calls to an offline-safe procedure. Pass the procedure leaf of the oRPC utils.
- `useQueueStatus`: subscribes to queue events and returns a live status snapshot.
- `createQueueStorage`: creates the queue storage (read, write, clear) kept under one storage key.
- `createDeadLetterStore`: creates the store for mutations that were given up on (list, add, remove, subscribe).
- `createReplayLoop`: creates the loop that sends queued mutations to the server (start, stop, drainNow). It retries transient failures and dead-letters the rest.
- `queuedMutationId`: schema and maker for the queue identity of a mutation.
- `mutationIdempotencyKey`: schema and maker for the key the server uses to drop replays. It is distinct from the queue id.
- `OFFLINE_QUEUE_FAILURES`: every failure the queue can return.
- `ENQUEUE_FAILURES`: the failures adding a mutation can return.
- `DRAIN_FAILURES`: the failures replaying the queue can return.
- `QUEUE_STORAGE_FAILURES`: the failures reading or writing queue storage can return.
- `QueueAcceptanceUnconfirmed`: the queued mutation outcome could not be confirmed.
- `QueueEffectUnconfirmed`: the server accepted the mutation, but local cleanup was not confirmed.
- `QueueEncodingFailure`: offline state could not be serialized.
- `QueuePersistenceUnconfirmed`: a local offline state write was not confirmed.
- `QueueStorageCorrupt`: stored offline data does not match its contract.
- `QueueStorageUnavailable`: the existing queue could not be read.
- `QueueTransportUnavailable`: the RPC transport is temporarily unavailable.

## @arki/offline/collections

- `createLocalCollection`: creates a localStorage backed TanStack DB collection. A schema is required, so wrong shaped items are refused.
- `createMemoryCollection`: creates an in-memory TanStack DB collection. Data survives re-renders, not page reloads.

## @arki/offline/pwa

- `registerOfflineRoutes`: registers Workbox fetch strategies for the app shell, API routes and static assets. Call it in the service worker file.
- `createStrategy`: creates a Workbox strategy handler from a named strategy and its config.

## @arki/offline/status

- `useOnlineStatus`: returns whether the browser is online and when that last changed.
- `useQueueDepth`: returns how many mutations are in the queue.
- `OfflineBanner`: a headless render-prop component that hands offline and queue state to the caller, who draws the banner.

## @arki/offline/orpc

- `offlineSafe`: marks a contract procedure as safe to queue offline, in the meta type.
- `idempotency`: oRPC middleware that deduplicates replayed offline mutations. Install it once where the app builds its implementer.
- `createIdempotencyTable`: builds the idempotency table for any database dialect.
- `idempotencyKeys`: the idempotency table in the default Postgres schema.
- `idempotencyKeyId`: the stored identity of a cache record, distinct from the client token.
- `IdempotencyRepository`: the Postgres repository for the response cache.
- `SqliteIdempotencyRepository`: the SQLite twin of `IdempotencyRepository`.
- `IDEMPOTENCY_STORE_FAILURES`: the failures returned by response cache writes.
- `IdempotencyStoreUnconfirmed`: the database did not confirm that the response was cached. It may have been saved.

## @arki/offline/devtools

- `OfflineDevPanel`: a floating debug panel that shows the offline queue. It renders only in development builds.

## @arki/offline/preset

- `createOfflineRuntime`: creates a fully wired offline runtime in one call. The tier picks cache only, or cache plus queue.
