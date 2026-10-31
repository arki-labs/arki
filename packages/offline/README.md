# @arki/offline

Offline-first toolkit for @arki apps. Modular subpath exports — install what you need, tree-shake the rest.

```text
@arki/offline/query       — persisted TanStack QueryClient (Tier 1)
@arki/offline/mutations   — mutation queue with IDB storage and replay loop (Tier 2)
@arki/offline/collections — localStorage & in-memory TanStack DB collections
@arki/offline/pwa         — Workbox fetch strategy helpers (service worker)
@arki/offline/status      — online status hooks + headless OfflineBanner
@arki/offline/orpc        — offline-safe procedure marker + idempotency interceptor
@arki/offline/devtools    — floating debug panel (dev-only, zero production cost)
@arki/offline/preset      — one-liner createOfflineRuntime() that wires everything
```

---

## Three tiers

### Tier 1 — Resilient reads (all apps)

The TanStack Query cache is persisted to IndexedDB. Reads survive page reloads, PWA cold-launches, and short network outages. No backend changes required.

```ts
// src/lib/offline.ts
import { createIdbPersister } from '@arki/offline/query';

export const idbPersister = createIdbPersister({ storageKey: 'myapp-query' });
```

```tsx
// src/lib/orpc/client.tsx
import { PersistedQueryClientProvider } from '@arki/offline/query';
import { idbPersister } from '~/lib/offline';

export function ORPCReactProvider({ children }) {
  return (
    <PersistedQueryClientProvider client={queryClient} persister={idbPersister}>
      {children}
    </PersistedQueryClientProvider>
  );
}
```

```ts
// src/service-worker.ts
import '@arki/tanstack-start/pwa/sw';
import { registerOfflineRoutes } from '@arki/offline/pwa';

registerOfflineRoutes({
  appShell: { strategy: 'staleWhileRevalidate', cacheName: 'myapp-shell' },
  apiRoutes: [{ urlPattern: /\/api\//, strategy: 'networkFirst', cacheName: 'myapp-api' }],
});
```

New apps generated from `turbo gen` get Tier 1 out of the box.

---

### Tier 2 — Queued offline writes (apps that need write durability)

On top of Tier 1, mutations made while offline are serialized to IndexedDB and replayed in FIFO order when connectivity returns. Each mutation carries an idempotency key; the server deduplicates replays.

```ts
import { createOfflineRuntime } from '@arki/offline/preset';

// src/lib/offline.ts
export const offline = createOfflineRuntime({
  tier: 'queue',
  appId: 'myapp',
  rpc: rpcClient,    // structural AnyRpcClient interface — see below
  actorId: () => signedInUserId, // who is signed in now; `null` signed out; `undefined` not known yet
  devtools: true,    // OfflineDevPanel in development
});
```

#### Account switch: a queued write replays only under the account that made it

The replay request carries the session signed in *at replay*, not the one that queued the write. So each queued entry stores `actorId()` from the moment it was queued. Right before every send attempt (each entry, and each retry after a backoff) the queue reads `actorId()` again and compares, so an account switch in the middle of a replay cannot carry the rest of the queue into the new session:

| Signed in at replay | What happens to the entry |
| --- | --- |
| The same actor | Sent. |
| Nobody (`null`) | Not sent. It stays queued, the pass stops, and the queue emits `'auth-required'`. Call `queue.drain()` after sign-in to resume. |
| A different actor | Not sent. It moves to the dead-letter list with `lastError.code === 'ACTOR_MISMATCH'` and fires `'dead-letter'` / `onDeadLetter`. |

`deadLetter.retry(id)` keeps the original `actorId`, so a retry sends the write only once its own actor is signed in again. Nothing ever rebinds a write to the current account. An entry queued while signed out (`actorId: null`) is sent only while nobody is signed in.

`actorId` must answer synchronously from local state (it runs offline). Feed it from your session store, and call `queue.drain()` when the user signs in.

**The server checks too.** The browser's check cannot see a session cookie that changes after it, right before the request leaves. So every replay also sends `Offline-Actor` (the user who queued it) next to `Idempotency-Key`. The `idempotency()` middleware from `@arki/offline/orpc` refuses a replay with 403 when `Offline-Actor` differs from the session user, when it is missing while someone is signed in, or when it is present with no session. The queue dead-letters a 403. Calls without `Idempotency-Key` are not replays and pass unchecked. If your RPC adapter maps headers into per-call context (as Avocabo's does), forward `Offline-Actor` too.

**Unknown session (offline reload).** After a reload without network the app often cannot tell who is signed in yet. Then `actorId()` answers `undefined`, which is different from `null` (the session says signed out). The queue remembers every id `actorId()` returns on the device (key `<storageKey>:last-actor`). A write queued while `actorId()` is `undefined` is bound to that last actor; if no actor was ever seen on the device it stays `null`. The replay rules above do not change, so such a write is sent only once that last user is signed in again, and is dead-lettered as `ACTOR_MISMATCH` for anyone else.

**Sign-out forgets the last actor.** When `actorId()` answers `null`, the remembered id is deleted. On a shared device this matters: after Ada signs out, a write queued by whoever uses the device next is bound to nobody, never to Ada, so it can never replay under her account. Feed `undefined` only while your session is still loading (for better-auth: `isPending`), never as a stand-in for signed out.

```tsx
// src/root-provider.tsx — components read the client with useQueryClient()
<offline.Provider>{children}</offline.Provider>
```

**Server rendering.** In the browser, `offline.Provider` uses one persisted QueryClient for the app's lifetime (`offline.queryClient`). On the server the module that holds `offline` serves every request, so one client there would be one cache for every user. So on the server `offline.Provider` makes a fresh, unpersisted QueryClient for each request, and `offline.queryClient` and `offline.persistNow()` throw. Read the client with `useQueryClient()` inside the provider. In the browser, `offline.persistNow()` resolves `offline.query_cache_persist_failed` when IndexedDB refuses the write (storage full, private mode), and `offline.dispose()` stops the queue's replay loop and removes its window listeners (tests, hot reload).

#### The strict idempotency contract

Every procedure queued by Tier 2 **must** be safe to execute twice with the same result. Declare it **once, on the contract**, with `offlineSafe(p)`:

```ts
// features/posts/entrypoints/rpc.ts — the browser-safe contract
import { oc } from '@orpc/contract';
import { offlineSafe } from '@arki/offline/orpc';

export const postsRpcContract = {
  create: offlineSafe(oc.input(createPostInput).output(post)),   // meta: { offlineSafe: true }, in value AND type
  list: oc.input(pageInput(postOrder)).output(page(post)),
};
```

`offlineSafe(p)` is the only way to get `offlineSafe: true` into the meta *type*: `.meta({ offlineSafe: true })` keeps the type the builder declared, so the compiler could never see it.

Install the `idempotency(repo)` middleware **once**, where the app builds its implementer:

```ts
// core/orpc.ts (server)
import { IdempotencyRepository, idempotency } from '@arki/offline/orpc';

export const implementer = implement(rpcContract)
  .$context<RequestContext>()
  .use(idempotency(new IdempotencyRepository(db, idempotencyKeys)));
```

It acts only on procedures whose contract meta says `offlineSafe: true`; every other procedure passes straight through. For a marked one:

1. Reads `Idempotency-Key` from the request header (the replay loop sends it). No key or no signed-in user → runs the handler as usual.
2. Looks up `(idempotency_key, procedure_path, user_id)` in `offline_idempotency_keys`.
3. Found within the 7-day TTL → returns the stored response **without re-running the handler**.
4. Not found → runs the handler and stores its output on success.
5. A handler exception stores nothing. A cache-write failure is reported while the completed handler response is preserved; it never authorizes repeating that operation.

`IdempotencyRepository.store()` returns exact canonical failures. Direct table inserts now require an explicit `idempotencyKeyId.create()` result, narrowed with `isFailure` before SQL. Stored IDs keep their `idk_` prefix and 21-character URL-safe body. Cache writes emit an `offline.idempotency.store` OTel span under the active application context. See [typed cache-write migration](docs/upgrades/idempotency-writes.md).

On the client, pass the procedure's utils leaf — built from the contract with `createOrpcUtils` (`@arki/tanstack-start/orpc/client`), so it carries the procedure's identity:

```tsx
// lib/orpc/client.tsx
export const orpc = createOrpcUtils(rpcContract, rpcClient);

// Inside a component
import { useOfflineMutation } from '@arki/offline/mutations';
import { isFailure } from '@arki/failure';

const { mutate, isQueued, isPending, failure } = useOfflineMutation(orpc.posts.create);   // input typed from the contract
const outcome = await mutate({ title: 'Hello' });
if (isFailure(outcome)) return outcome;
// outcome: { idempotencyKey, status: 'queued' | 'sent' | 'dead-letter' }
// Replay sends the same key as the Idempotency-Key header.
```

**TypeScript enforcement:** `useOfflineMutation(orpc.posts.create)` and `queue.enqueue(orpc.posts.create, input)` only compile when the contract marked the procedure with `offlineSafe(p)`. An unmarked procedure, an optional `offlineSafe?: true`, `offlineSafe: false`, or a raw `createTanstackQueryUtils` leaf (no identity) is a compile-time error. `enqueue` checks the mark at run time too, for plain JavaScript callers.

**Not promised:**

- **That the handler is idempotent.** The mark is a declaration. A replay that misses the cache (a different key, an expired row) runs the handler again, side effects included. Making the handler safe to repeat is the author's job.
- **That two concurrent replays run once.** The middleware is best-effort: lookup, run and store are separate steps, so two replays of one key arriving together can both run the handler.

Add the idempotency table to each app's Drizzle schema:

```ts
// src/db/schema/idempotency.ts
import { idempotencyKeys } from '@arki/offline/orpc';
export { idempotencyKeys };
```

Run `turbo db:migrations:generate --filter=@myapp/backend` after adding the table.

#### SQLite

The table is written once. `idempotencyKeys` is the Postgres table in the default schema. For another Postgres schema or for SQLite, build it from a column kit; the SQLite repository is its own class, because Drizzle's Postgres and SQLite query builders are different classes.

```ts
// Postgres, in a schema
import { createIdempotencyTable } from '@arki/offline/orpc';
import { pgColumns } from '@arki/db/pg';

export const idempotencyKeys = createIdempotencyTable(pgColumns(appSchema));
```

```ts
// SQLite (libSQL)
import { SqliteIdempotencyRepository, createIdempotencyTable, idempotency } from '@arki/offline/orpc';
import { sqliteColumns } from '@arki/db/sqlite';

export const idempotencyKeys = createIdempotencyTable(sqliteColumns());
// db is a libSQL Drizzle database, for example from `createLibsqlDb` in `@arki/db/libsql`.
const repo = new SqliteIdempotencyRepository(db, idempotencyKeys);
```

SQLite limits that apply here:

- Timestamps keep milliseconds, not microseconds. This does not matter for a 7-day window.
- `varchar` limits become `CHECK (length(col) <= n)` constraints. An over-long key is refused and `store()` returns `IdempotencyStoreUnconfirmed`, as on Postgres.
- Tables are not `STRICT`: raw SQL can store a wrongly typed value. Drizzle-typed writes are unaffected.

---

### Tier 3 — True local-first sync (deferred)

Electric SQL / PowerSync / Zero integration is out of scope for V1. The `@arki/db/client` package namespace is reserved for future use.

---

## Collections

```ts
import { createLocalCollection, createMemoryCollection } from '@arki/offline/collections';
import { z } from 'zod';

const itemSchema = z.object({ id: z.string(), name: z.string() });

// localStorage-backed, cross-tab sync on by default
const items = createLocalCollection({
  storageKey: 'myapp:items',   // prefix with app name to prevent subdomain collisions
  schema: itemSchema,
  getKey: (item) => item.id,
});

// In-memory, resets on page reload — useful for ephemeral reactive UI state
const draft = createMemoryCollection({
  schema: itemSchema,
  getKey: (item) => item.id,
  initialData: [{ id: 'tmp', name: 'Draft item' }],
});
```

Schema validation is mandatory — items that don't conform throw `"Insert validation failed"` at the storage layer, catching corruption early.

`createLocalCollection` accepts any `StandardSchemaV1`-compatible schema (Zod v3+, Valibot, ArkType).

---

## Status primitives

```tsx
import { useOnlineStatus, useQueueDepth, OfflineBanner } from '@arki/offline/status';

// Online status with last-change timestamp
const { online, lastChange } = useOnlineStatus();

// Number of queued offline mutations (shortcut for useQueueStatus().queued)
const depth = useQueueDepth();

// Headless render-prop — you own the visual, the lib owns the data
<OfflineBanner>
  {({ online, queued, deadLettered }) =>
    !online
      ? <Toast>You are offline — {queued} pending changes</Toast>
      : null
  }
</OfflineBanner>
```

`OfflineBanner` works with or without `OfflineQueueProvider` in the tree. When no queue is present, `queued` and `deadLettered` default to 0.

---

## Dev panel

```tsx
import { OfflineDevPanel } from '@arki/offline/devtools';

// Mount alongside your root provider:
<offline.Provider>
  {children}
  <OfflineDevPanel />   {/* hidden in production — import.meta.env.DEV gate */}
</offline.Provider>
```

Or use `devtools: true` in `createOfflineRuntime` to wire it automatically.

The panel shows: online/offline status, queue depth, sending indicator, dead-letter list with retry/discard controls.

---

## Troubleshooting

### Service worker not updating after a deploy

The `cacheName` strings in `registerOfflineRoutes` control cache versioning. Include a build ID in cache names to force a fresh cache on deploy:

```ts
registerOfflineRoutes({
  apiRoutes: [{ cacheName: `myapp-api-${import.meta.env.VITE_BUILD_ID ?? 'dev'}` }],
});
```

### Query cache persisting stale data

Pass a `buster` to `createIdbPersister` or `createPersistedQueryClient`. The buster invalidates the entire IDB cache when it changes — useful for schema-breaking API changes:

```ts
createIdbPersister({ storageKey: 'myapp-query', buster: import.meta.env.VITE_BUILD_ID });
```

### Queue stuck — mutations not replaying

Check the dead-letter list: `queue.deadLetter.list()`. Dead-lettered mutations are moved here when the `retry` schedule ends (default: exponential from 1 s to 30 s, at most 5 retries; pass any `@arki/resilience` `Backoff` as `retry`). Common causes:

- **4xx errors**: the mutation data is invalid server-side — discard and fix the input.
- **401 errors**: the queue halts and emits `'auth-required'` — user must re-authenticate.
- **`ACTOR_MISMATCH`**: the write was queued under another account. Retry it after that account signs back in, or discard it.
- **5xx errors**: exponential backoff (max 30s) applies — the queue will keep retrying.

Use `OfflineDevPanel` in development to inspect dead-letter entries in real time.

### Dead-letter recovery in production

```ts
const entries = await queue.deadLetter.list();
// Retry a specific entry after fixing the underlying issue:
await queue.deadLetter.retry(entries[0].id);
// Or discard it:
await queue.deadLetter.discard(entries[0].id);
```

### Idempotency key collision

Each queued mutation gets a securely generated 21-character URL-safe ID with the existing Nano ID representation. `queuedMutationId` and `mutationIdempotencyKey` give its queue identity and transport token separate nominal types; validated persistence restores both without changing stored strings. Cache records have a separate nominal `idempotencyKeyId`, with the same random-body format and an `idk_` prefix. Cache lookup is scoped by `(userId, procedurePath, idempotencyKey)`; tokens from different users or procedures address different records.

### How to write an idempotent handler

A handler is idempotent when running it twice produces the same observable state. Common patterns:

```ts
// ✅ Upsert — safe to replay
.handler(async ({ input, context }) => {
  await db.insert(posts).values({ id: input.id, ...input })
    .onConflictDoUpdate({ target: posts.id, set: input });
})

// ✅ Conditional insert — skip if already exists
.handler(async ({ input, context }) => {
  const existing = await db.query.posts.findFirst({ where: eq(posts.id, input.id) });
  if (existing) return existing;  // idempotency: same result as first call
  return db.insert(posts).values(input).returning().then(r => r[0]);
})

// ❌ Append-only without dedup — replay creates duplicates
.handler(async ({ input }) => {
  await db.insert(events).values(input); // WRONG — no dedup
})
```

---

## Design doc

Full architecture, implementation phases, and decisions at:
[`docs/2026-05-16-arki-offline-design.md`](./docs/2026-05-16-arki-offline-design.md)

### Enqueue outcomes

`queue.enqueue()` and `useOfflineMutation().mutate()` return `EnqueueReceipt | EnqueueFailure`. Check `isFailure` before reading receipt fields. The hook exposes `isPending` and the original `failure` for rendering. `ENQUEUE_FAILURES` is the canonical failure list. Entropy refusals retain their original identity and occur before persistence or RPC.

`QueueStorageUnavailable` means existing local state could not be read. Corrupt or incompatible stored queue/dead-letter bytes are preserved and rejected; they no longer look like an empty queue. `QueueAcceptanceUnconfirmed` carries the original queue ID and idempotency token: a local write or remote effect may already have succeeded. Reconcile using that identity before retrying. A dead-letter receipt is never reported as sent.

The enqueue boundary emits `offline.queue.enqueue` under the active OTel context, without requiring an SDK. Only canonical failure codes are exported; IDs, inputs, actors and causes stay out of spans. Reporting faults cannot suppress or repeat execution. After an accepted RPC, a local removal failure does not repeat the RPC on another drain of the same runtime. Across reloads, the server idempotency middleware remains required.

`queue.drain()` and `ReplayLoop.drainNow()` return `void | DrainFailure`. `queue.deadLetter.retry()` preserves that same result; list/discard and the storage primitives return `QueueStorageFailure` alongside their normal values. Check every returned result with `isFailure`. `DRAIN_FAILURES` and `QUEUE_STORAGE_FAILURES` are the canonical definition tuples.

`QueueStorageCorrupt` preserves invalid stored bytes. `QueuePersistenceUnconfirmed` requires reading local state before repeating a local write. `QueueEffectUnconfirmed` carries the identity of a remotely accepted effect whose cleanup needs reconciliation. Unknown adapter defects stop replay as `UnexpectedDefect`; mark a known network outage with `QueueTransportUnavailable()` so the queue can own its retries. HTTP status refusals retain auth/4xx/5xx policy. An explicit drain resumes an authentication halt.

Background failures reach queue events and `queue.status().failure`; hooks and devtools preserve/display them. Storage, actor persistence, dead-letter operations and drain have default spans under the active context. Query persistence, collections, PWA and runtime capabilities remain separate T08 export audits. This is not package-wide completion.
