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
  devtools: true,    // OfflineDevPanel in development
});
```

```tsx
// src/root-provider.tsx
<offline.Provider>
  <ORPCReactProvider client={rpcClient} queryClient={offline.queryClient}>
    {children}
  </ORPCReactProvider>
</offline.Provider>
```

```tsx
// Inside a component
import { useOfflineMutation } from '@arki/offline/mutations';

const { mutate, isQueued } = useOfflineMutation(orpc.posts.createPost);
await mutate({ title: 'Hello' });
// Returns { idempotencyKey } — same key is attached to the HTTP header on replay
```

#### The strict idempotency contract

Every procedure queued by Tier 2 **must** be safe to execute twice with the same result. Mark them server-side with `offlineSafe()`:

```ts
// In your backend procedure file
import { offlineSafe } from '@arki/offline/orpc';

export const createPost = protectedProcedure
  .use(offlineSafe())      // stamps .meta.offlineSafe = true + idempotency middleware
  .input(createPostInput)
  .handler(async ({ input, context }) => {
    // handler is skipped on replay — middleware returns cached response instead
  });
```

The `offlineSafe()` middleware:

1. Reads `Idempotency-Key` from the request header (sent by the client interceptor).
2. Looks up `(idempotency_key, procedure_path, user_id)` in the `idempotency_keys` table.
3. If found within 7-day TTL → returns the cached response **without re-running the handler**.
4. If not found → wraps the handler, stores `(key, response_json)` on success.
5. On error → does NOT store (client can safely retry).

**TypeScript enforcement:** `queue.enqueue(procedure, input)` only compiles when `procedure.meta.offlineSafe` is `true`. Passing an unmarked procedure is a compile-time error — not a runtime one.

Add the idempotency table to each app's Drizzle schema:

```ts
// src/db/schema/idempotency.ts
import { idempotencyKeys } from '@arki/offline/orpc';
export { idempotencyKeys };
```

Run `turbo db:migrations:generate --filter=@myapp/backend` after adding the table.

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

Check the dead-letter list: `queue.deadLetter.list()`. Dead-lettered mutations are moved here after `maxRetries` (default 5) failures. Common causes:

- **4xx errors**: the mutation data is invalid server-side — discard and fix the input.
- **401 errors**: the queue halts and emits `'auth-required'` — user must re-authenticate.
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

Each queued mutation gets a ULID as its idempotency key. ULIDs are 128-bit random — collision probability is negligible in practice. Keys are also scoped by `(userId, procedurePath)` so cross-user collisions are impossible.

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
`docs/superpowers/specs/2026-05-16-arki-offline-design.md`
