# Agent guide: @arki/offline

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, the source of the entry in `src/` wins.

## The model

1. Tier 1 keeps reads: the TanStack Query cache is persisted to IndexedDB with `createIdbPersister`. No backend change is needed.
2. Tier 2 keeps writes: a mutation made offline is stored in IndexedDB and replayed in order when the connection returns. Each carries an idempotency key, and the server drops repeats.
3. `createOfflineRuntime()` from `@arki/offline/preset` wires the tiers, the provider and the dev panel.
4. `offlineSafe(procedure)` from `@arki/offline/orpc` marks a contract procedure as safe to queue. The `idempotency()` middleware stores the first answer for each `Idempotency-Key`.
5. Each queued entry stores the `actorId()` that queued it. A replay under another account is dead-lettered as `ACTOR_MISMATCH`.
6. Tier 3 (true local-first sync) is not built.
7. On React Native only `./collections` and the server side of `./orpc` apply. Use TanStack's own offline stack for the cache and the queue there.

## Task map

### Keep reads across reloads

1. `createIdbPersister({ storageKey })` from `@arki/offline/query`.
2. Wrap the app in `PersistedQueryClientProvider` with that persister.
3. Pass a `buster` to drop the whole cache when the API changes.

### Queue writes while offline

1. Mark the contract procedure with `offlineSafe`.
2. Add the `idempotency()` middleware on the server.
3. `createOfflineRuntime({ tier: 'queue', appId, rpc, actorId })` from `@arki/offline/preset`.
4. Mount `offline.Provider`. Queue with `useOfflineMutation`.
5. Check every result with `isFailure`.

### Recover a stuck queue

1. `await queue.deadLetter.list()` shows the dead-lettered writes.
2. `queue.deadLetter.retry(id)` retries one after the cause is fixed. `queue.deadLetter.discard(id)` drops it.
3. After a 401 the queue stops and emits `'auth-required'`. Sign in, then call `queue.drain()`.

### Cache the app shell

1. `registerOfflineRoutes({ appShell, apiRoutes })` from `@arki/offline/pwa` inside the service worker.
2. Put a build id in each `cacheName` to force a fresh cache on deploy.

### Use local data

1. `createLocalCollection` keeps rows in `localStorage`. `createMemoryCollection` keeps them in memory.
2. On React Native import `react-native-get-random-values` first.

## Rules that bite

- A replayed write can run twice. Write handlers as upserts or conditional inserts. An append with no dedup makes duplicates.
- `actorId()` must answer from local state, with no network. `undefined` means "not known yet". `null` means signed out. Never use `undefined` for signed out.
- On the server `offline.queryClient` and `offline.persistNow()` throw. Read the client with `useQueryClient()`.
- `queue.drain()` returns a failure value. Check it.
- Corrupt stored bytes are kept. A storage failure never looks like an empty queue.
- `./pwa` needs a service worker. `./query`, `./mutations`, `./status` and `./devtools` need a browser.
- Match on `error.code`, never on the message.

## Errors

| Code                                    | Meaning                                                              | What to do                                                                            |
| --------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `offline.query_cache_persist_failed`    | IndexedDB refused a cache write.                                     | Free storage or leave private mode.                                                   |
| `offline.queue_storage_unavailable`     | The existing queue could not be read.                                | Retry. There is no queue where there is no IndexedDB.                                 |
| `offline.queue_storage_corrupt`         | Stored queue bytes do not match their contract.                      | The bytes are kept. Inspect before you clear.                                         |
| `offline.queue_encoding_failure`        | Offline state could not be serialized.                               | Queue only JSON-safe input.                                                           |
| `offline.queue_persistence_unconfirmed` | A local write was not confirmed.                                     | Read local state before you write again.                                              |
| `offline.queue_acceptance_unconfirmed`  | The outcome of a queued write could not be confirmed.                | Reconcile with the carried id and key before you retry.                               |
| `offline.queue_effect_unconfirmed`      | The server accepted the write. Local cleanup is unconfirmed.         | Reconcile the cleanup. Do not send the write again.                                   |
| `offline.queue_transport_unavailable`   | The transport is down.                                               | Do nothing. The queue owns the retries.                                               |
| `offline.idempotency_store_unconfirmed` | The database did not confirm the answer was cached; it may be saved. | Reconcile the cache before retrying its write; never run the completed handler again. |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
