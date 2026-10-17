# `@arki/offline` — Offline-first toolkit for all apps

**Date:** 2026-05-16
**Status:** Approved for implementation
**Author:** Brainstorming session — Alex + Claude (Opus 4.7)

---

## 1. Context

This repo has roughly 20 apps. Offline support today is inconsistent:

| App | Offline behavior | Mechanism |
|---|---|---|
| `games-platform/start` | Pure-client persistence | `@tanstack/react-db` + `localStorageCollectionOptions` (2 collections) |
| `avocabo/start` | Read offline + queued writes | Hand-rolled `OfflineMutationQueue` (idb-keyval) + `PersistQueryClientProvider` |
| `loonyjobs/start` | Scaffold only | Empty TanStack DB barrels |
| All other start apps | None beyond Workbox precache | `@fleet/tanstack-start/pwa` (precache only) |

Two incompatible patterns are in production (`games-platform` and `avocabo`), and the rest are empty scaffolds. The goal is to extract a shared lib, formalize the contract, and make offline-by-default at every app's wire-up layer.

## 2. Decisions made during brainstorming

| Decision | Choice |
|---|---|
| Offline scope philosophy | **Per-app blend, not one default.** Lib is a menu, apps pick what they need. |
| V1 tier scope | **Tier 1 + Tier 2 only.** Defer true local-first sync (Tier 3, Electric/PowerSync/Zero) until a product needs it. |
| Migration scope | **Lib + template + migrate avocabo + games-platform.** Other apps get the lib in catalog + a single Tier-1 wire-up in root-provider; no per-feature work yet. |
| Mutation-replay contract | **Strict idempotency required.** Every queue-able oRPC mutation must be marked `.meta.offlineSafe = true`; server-side dedupe by `Idempotency-Key`. |
| Lib architectural shape | **Modular primitives + thin preset (Approach C).** Subpath-modular exports plus a `/preset` one-liner. |
| Package boundary | **Separate `@arki/offline`** + a parallel thin **`@arki/db/client`** subpath for symmetry (types-only). |

## 3. Architecture

### 3.1 `@arki/offline` package

```
packages/offline/
├── package.json                 # exports map, sideEffects: false, catalog deps
├── tsconfig.json
├── tsup.config.ts               # multi-entry build matching exports map
├── README.md
├── src/
│   ├── query/
│   │   ├── createPersistedQueryClient.ts
│   │   ├── idb-persister.ts
│   │   ├── PersistedQueryClientProvider.tsx
│   │   └── index.ts
│   ├── mutations/
│   │   ├── queue.ts                       # OfflineMutationQueue
│   │   ├── replay.ts                      # reconnect-driven replay loop
│   │   ├── storage.ts                     # idb-keyval bucket + superjson codec
│   │   ├── dead-letter.ts                 # failed-mutation inspector store
│   │   ├── hooks.ts                       # useOfflineMutation, useQueueStatus
│   │   ├── OfflineQueueProvider.tsx
│   │   └── index.ts
│   ├── collections/
│   │   ├── createLocalCollection.ts       # localStorage-backed TanStack DB
│   │   ├── createMemoryCollection.ts      # in-memory only
│   │   └── index.ts
│   ├── pwa/
│   │   ├── strategies.ts                  # SWR / networkFirst / cacheFirst presets
│   │   ├── register-routes.ts             # Workbox wrapper
│   │   └── index.ts                       # SW-side entry
│   ├── status/
│   │   ├── useOnlineStatus.ts
│   │   ├── useQueueDepth.ts
│   │   ├── OfflineBanner.tsx              # headless slot pattern
│   │   └── index.ts
│   ├── orpc/
│   │   ├── offline-safe-marker.ts         # .meta typing + helper
│   │   ├── client-interceptor.ts          # browser: attach Idempotency-Key
│   │   ├── idempotency-middleware.ts      # node: server-side dedupe
│   │   ├── idempotency-table.ts           # Drizzle table schema fragment
│   │   ├── idempotency-repository.ts      # cache lookup/store
│   │   └── index.ts                       # split via package.json conditions
│   ├── devtools/
│   │   ├── DevPanel.tsx                   # queue inspector + dead-letter view
│   │   └── index.ts
│   └── preset/
│       ├── createOfflineRuntime.ts        # one-liner that wires everything
│       └── index.ts
└── __tests__/
    ├── query/idb-persister.test.ts
    ├── query/PersistedQueryClientProvider.test.tsx
    ├── mutations/queue.test.ts
    ├── mutations/replay.test.ts
    ├── mutations/dead-letter.test.ts
    ├── collections/createLocalCollection.test.ts
    ├── pwa/strategies.test.ts
    ├── orpc/idempotency-middleware.test.ts
    ├── orpc/client-interceptor.test.ts
    └── e2e/                               # Playwright; toggles network in browser
        ├── tier-1-resilient-online.spec.ts
        └── tier-2-queued-mutations.spec.ts
```

### 3.2 `package.json` exports map

```jsonc
{
  "name": "@arki/offline",
  "type": "module",
  "sideEffects": false,
  "exports": {
    "./query": {
      "types": "./dist/query/index.d.ts",
      "browser": "./dist/query/index.js",
      "default": "./dist/query/index.js"
    },
    "./mutations": { "types": "...", "browser": "...", "default": "..." },
    "./collections": { "types": "...", "browser": "...", "default": "..." },
    "./pwa": { "types": "...", "browser": "...", "default": "..." },
    "./status": { "types": "...", "browser": "...", "default": "..." },
    "./devtools": { "types": "...", "browser": "...", "default": "..." },
    "./preset": { "types": "...", "browser": "...", "default": "..." },
    "./orpc": {
      "types": "./dist/orpc/index.d.ts",
      "node": "./dist/orpc/index.node.js",       // server-side (middleware + repo + table)
      "browser": "./dist/orpc/index.browser.js", // client interceptor + marker only
      "default": "./dist/orpc/index.browser.js"
    }
  }
}
```

`/orpc` is the only subpath with a server side because the idempotency middleware runs in Node. Everything else is browser-only.

### 3.3 `@arki/db/client` companion subpath

```
packages/db/src/client/
├── index.ts                     # types-only re-exports
├── ids.ts                       # branded IDs re-exported from @arki/contracts
└── README.md                    # "Reserved for future Drizzle-on-client / Tier-3 sync"
```

V1 contains only type-level re-exports. Zero runtime cost. Establishes the namespace for future Electric / PowerSync work without committing to it now.

`packages/db/package.json` gains:

```jsonc
{
  "exports": {
    ".": { /* existing server-only */ },
    "./init": { /* existing */ },
    "./client": {
      "types": "./dist/client/index.d.ts",
      "default": "./dist/client/index.js"        // emits empty {} at runtime; safe everywhere
    }
  }
}
```

## 4. Primitives in detail

### 4.1 `@arki/offline/query` — Persisted QueryClient

```ts
export function createPersistedQueryClient(options?: {
  storageKey?: string;
  maxAge?: number;
  buster?: string;
  defaultOptions?: DefaultOptions;
}): {
  queryClient: QueryClient;
  persister: AsyncStoragePersister;
};

export const PersistedQueryClientProvider: React.FC<{
  client: QueryClient;
  persister: AsyncStoragePersister;
  children: ReactNode;
}>;
```

**Backed by** `@tanstack/query-async-storage-persister` over `idb-keyval`. `buster` defaults to `import.meta.env.VITE_BUILD_ID` so a deploy invalidates stale caches.

### 4.2 `@arki/offline/mutations` — OfflineMutationQueue

```ts
type QueuedMutation = {
  id: string;                    // ULID
  idempotencyKey: string;        // same as id; sent in header
  procedurePath: string[];
  input: unknown;                // serialized via superjson
  enqueuedAt: number;
  attempts: number;
  lastError?: { code: string; message: string };
};

export function createOfflineMutationQueue(options: {
  storageKey?: string;
  rpc: ORPCClient<AnyContract>;
  onDeadLetter?: (entry: QueuedMutation, error: Error) => void;
  maxRetries?: number;           // default 5
  backoff?: (attempt: number) => number; // default exponential, capped 30s
}): OfflineMutationQueue;

interface OfflineMutationQueue {
  enqueue<TProc extends OfflineSafeProcedure>(
    procedure: TProc,
    input: InferInput<TProc>
  ): Promise<{ idempotencyKey: string; status: 'queued' | 'sent' }>;
  status(): { queued: number; sending: boolean; deadLettered: number };
  drain(): Promise<void>;
  deadLetter: {
    list(): readonly QueuedMutation[];
    retry(id: string): Promise<void>;
    discard(id: string): void;
  };
  subscribe(listener: (event: QueueEvent) => void): () => void;
}

export const OfflineQueueProvider: React.FC<{
  queue: OfflineMutationQueue;
  children: ReactNode;
}>;

export function useOfflineMutation<TProc extends OfflineSafeProcedure>(
  procedure: TProc
): {
  mutate: (input: InferInput<TProc>) => Promise<{ idempotencyKey: string }>;
  isQueued: boolean;
};

export function useQueueStatus(): {
  queued: number;
  sending: boolean;
  deadLettered: number;
};
```

**Replay loop:**
1. `navigator.onLine` flips → emit `'online'`, attempt drain.
2. Optionally (feature-detected): register Background Sync API tag so SW replays even with tab closed.
3. Per queued mutation: attach `Idempotency-Key` header, call procedure.
4. 401 → halt; emit `'auth-required'`.
5. 4xx non-auth → dead-letter; emit `'dead-letter'`.
6. 5xx / network → exponential backoff up to `maxRetries`, then dead-letter.

**Type-safety:** `OfflineSafeProcedure` brand applied by `@arki/offline/orpc`. `enqueue` only accepts procedures whose `.meta.offlineSafe` is true. TS compile-time enforcement of the strict-idempotency contract.

### 4.3 `@arki/offline/collections` — Local TanStack DB primitives

```ts
export function createLocalCollection<TSchema extends z.ZodSchema>(config: {
  storageKey: string;            // automatically prefixed with app id from @arki/env
  schema: TSchema;
  getKey: (item: z.infer<TSchema>) => string;
  syncBetweenTabs?: boolean;     // default true
}): Collection<z.infer<TSchema>>;

export function createMemoryCollection<TSchema extends z.ZodSchema>(config: {
  schema: TSchema;
  getKey: (item: z.infer<TSchema>) => string;
}): Collection<z.infer<TSchema>>;
```

Thin wrappers over `localStorageCollectionOptions` / `localOnlyCollectionOptions` from `@tanstack/react-db`. Forces a `schema` parameter (prevents shape drift). Namespaces `storageKey` with the app id (prevents collision on shared subdomains).

### 4.4 `@arki/offline/pwa` — Runtime fetch strategies

```ts
export function registerOfflineRoutes(options: {
  appShell?: { strategy: 'networkFirst' | 'staleWhileRevalidate'; maxAgeSeconds?: number };
  apiRoutes?: Array<{
    urlPattern: RegExp;
    strategy: 'networkFirst' | 'staleWhileRevalidate';
    maxAgeSeconds?: number;
    cacheName?: string;
  }>;
  staticAssets?: Array<{ urlPattern: RegExp; cacheName?: string }>;
}): void;
```

Wraps Workbox `registerRoute`. Two invariants enforced by the lib:

1. **API responses are never cached while the mutation queue is non-empty.** Prevents the SW from serving a "stale truth" that contradicts queued writes.
2. **Cache busted on `buster` change** (same `VITE_BUILD_ID` mechanism).

### 4.5 `@arki/offline/status` — Online + queue surface

```ts
export function useOnlineStatus(): { online: boolean; lastChange: number };
export function useQueueDepth(): number;

export const OfflineBanner: React.FC<{
  // headless: caller controls rendering
  children: (state: {
    online: boolean;
    queued: number;
    deadLettered: number;
    authRequired: boolean;
  }) => ReactNode;
}>;
```

`OfflineBanner` is render-prop only — no opinion about styling. Apps wrap it with their own design-system components.

### 4.6 `@arki/offline/devtools` — Debug panel

```tsx
<OfflineDevPanel /> // mounts a floating panel in dev; reads from queue context
```

Lists queued mutations, dead-letter entries, last replay attempt, current online state. Dev-only — gated by `import.meta.env.DEV`.

### 4.7 `@arki/offline/preset` — One-liner runtime

```ts
export function createOfflineRuntime(config: {
  tier: 'cache-only' | 'queue';
  appId: string;                 // for storage namespacing
  rpc?: ORPCClient<AnyContract>; // required when tier === 'queue'
  buster?: string;
  precache?: { apiRoutes?: RegExp[] };
  devtools?: boolean;
}): {
  queryClient: QueryClient;
  queue?: OfflineMutationQueue;
  Provider: React.FC<{ children: ReactNode }>;
};
```

Template uses this. Migrated apps use primitives directly.

## 5. oRPC idempotency contract

### 5.1 Marking a procedure as offline-safe

```ts
// In an app's backend procedure file
import { offlineSafe } from '@arki/offline/orpc';

export const createPost = protectedProcedure
  .use(offlineSafe())                   // applies .meta.offlineSafe = true + idempotency middleware
  .input(createPostInput)
  .handler(async ({ input, context }) => { /* ... */ });
```

`offlineSafe()` returns an oRPC middleware that:
1. Reads `Idempotency-Key` from the incoming request headers.
2. Looks up `(idempotency_key, procedure_path, user_id)` in the dedupe table.
3. If found within TTL → returns the cached response without re-executing the handler.
4. If not found → wraps the handler in a transaction, on success stores `(key, response_json)`, returns the response.
5. On error → does NOT store (so the client retry can succeed).

Also stamps `.meta.offlineSafe = true` so the client-side TS contract works.

### 5.2 Dedupe table schema

```ts
// @arki/offline/orpc — server-side
export const idempotencyKeys = pgTable('idempotency_keys', {
  id: createPrefixedId('idem').primaryKey(),
  key: text('key').notNull(),                       // client-provided ULID
  procedurePath: text('procedure_path').notNull(),  // 'posts.create'
  userId: text('user_id').notNull(),                // scoped per user — keys are not global
  responseJson: jsonb('response_json').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  uniq: uniqueIndex('idempotency_keys_uniq').on(t.key, t.procedurePath, t.userId),
  createdAtIdx: index('idempotency_keys_created_at_idx').on(t.createdAt),
}));
```

Each app's backend imports the table schema fragment into its own Drizzle schema. Single shared definition, per-app database.

**TTL cleanup:** a daily job (registered via `@arki/queue` or Coolify cron, app's choice) deletes rows older than 7 days.

### 5.3 Client interceptor

```ts
// @arki/offline/orpc — browser-side
export function createIdempotencyInterceptor(): RPCLink['interceptors'][number];
```

Wires into the oRPC client. For any procedure marked offline-safe, attaches `Idempotency-Key` header from the queue entry id.

## 6. Template integration

### 6.1 Frontend template — `turbo/generators/templates/application/start/`

**`package.json`** — add to deps (via catalog):
```jsonc
"dependencies": {
  "@arki/offline": "workspace:*"
}
```

**`src/lib/offline.ts`** (new file replacing the empty `src/lib/db/` scaffold):
```ts
import { createOfflineRuntime } from '@arki/offline/preset';
import { rpcClient } from './orpc/client';

export const offline = createOfflineRuntime({
  tier: 'cache-only',              // template default = Tier 1
  appId: '{{ APP_ID }}',           // handlebars-replaced at generate time
  rpc: rpcClient,
  devtools: true,
});
```

**`src/root-provider.tsx`** — wire the provider chain:
```tsx
import { offline } from '~/lib/offline';

export function RootProvider({ children }: { children: ReactNode }) {
  return (
    <offline.Provider>
      <ORPCReactProvider client={rpcClient} queryClient={offline.queryClient}>
        {children}
      </ORPCReactProvider>
    </offline.Provider>
  );
}
```

**`src/service-worker.ts`** — extend the existing Workbox SW:
```ts
import { registerOfflineRoutes } from '@arki/offline/pwa';

registerOfflineRoutes({
  appShell: { strategy: 'staleWhileRevalidate' },
  apiRoutes: [
    { urlPattern: /\/api\/.*$/, strategy: 'networkFirst', maxAgeSeconds: 60 },
  ],
});
```

**Delete:** the empty `src/lib/db/collections/index.ts`, `src/lib/db/hooks/index.ts`, `src/lib/db/provider.tsx` files. They're superseded by `src/lib/offline.ts`. The template's `src/lib/db/` directory itself can be removed.

### 6.2 Backend template — `turbo/generators/templates/application/backend/`

Add idempotency table to schema and wire the middleware-availability:

**`src/db/schema/idempotency.ts`** (new):
```ts
import { idempotencyKeys } from '@arki/offline/orpc';
export { idempotencyKeys };
// Drizzle picks this up when imported by the schema barrel
```

**`src/db/schema/index.ts`** — append `export * from './idempotency';`

**`src/core/orpc.ts`** — no change required; the `offlineSafe()` middleware is opt-in per procedure.

## 7. Migration plan

### 7.1 `avocabo/start`

**Files to delete:**
- `apps/avocabo/start/src/lib/offline-mutation-queue.ts` (~300 lines, hand-rolled)
- Any custom `PersistQueryClientProvider` setup file

**Files to update:**
- `src/root-provider.tsx` — replace direct `PersistQueryClientProvider` + queue plumbing with primitives:
  ```tsx
  import { createPersistedQueryClient, PersistedQueryClientProvider } from '@arki/offline/query';
  import { createOfflineMutationQueue, OfflineQueueProvider } from '@arki/offline/mutations';
  ```
- All call sites of the old queue → switch to `useOfflineMutation(procedure)` from `@arki/offline/mutations`.

**Backend changes:**
- Add `idempotency_keys` table to avocabo's Drizzle schema.
- Mark every mutation that the client could queue with `.use(offlineSafe())`.
- Run migration: `turbo db:migrations:generate --filter=@avocabo/backend`.

### 7.2 `games-platform/start`

**Files to update:**
- `apps/games-platform/start/src/lib/db/collections/games.ts` — replace `createCollection(localStorageCollectionOptions({...}))` with `createLocalCollection({...})` from `@arki/offline/collections`.
- `apps/games-platform/start/src/lib/db/collections/settings.ts` — same.
- Verify `useGameHistory` and `useSettings` hooks still type-check.

**Backend changes:** none. These are local-only collections; no server round-trip.

### 7.3 Every other start app (Tier-1 only)

For each of: `loonyjobs/start`, `sudoku/start`, `ekuation/start`, `manuscribed/start`, `domodoro/start`, `brandability/start`, `typeroom/start`, `novelette/start`, `structurize/start`, `hyphenate/start`, `toolsforwords/start`, `ucssr/start`, `diffdigg/start`, `kapodopera/start`, `evervest/start` (where applicable):

1. Add `@arki/offline` to `package.json` deps.
2. Wire `createOfflineRuntime({ tier: 'cache-only', appId, rpc, devtools: true })` in `src/lib/offline.ts` and `src/root-provider.tsx` (mirrors template).
3. Add `registerOfflineRoutes(...)` to existing `src/service-worker.ts`.

No backend changes for Tier-1 apps. No procedure-level changes. App still works exactly the same; reads now survive flaky network.

**Calculator-only apps (e.g. ekuation):** Tier 1 is still useful — PWA shell + persisted Query for the documentation pages. Lib install cost ≈ 30 KB gz after tree-shake.

## 8. Testing strategy

### 8.1 Per-primitive unit tests (Vitest)

| Module | Coverage target |
|---|---|
| `query/idb-persister` | Round-trip serialize, buster invalidation, maxAge eviction |
| `query/PersistedQueryClientProvider` | Renders, restores cache on mount, hydrates queries |
| `mutations/queue` | Enqueue persists to IDB, status reflects state, FIFO ordering |
| `mutations/replay` | Online → drain order, 401 → halt + auth event, 5xx → backoff + retry, 4xx → dead-letter |
| `mutations/dead-letter` | Retry succeeds and removes; discard removes; list is reactive |
| `collections/createLocalCollection` | Storage key namespacing, schema validation rejects bad shape, cross-tab sync |
| `pwa/strategies` | networkFirst/SWR factories return Workbox handler with correct config |
| `orpc/idempotency-middleware` | First call executes + stores; second call returns cached; TTL respected; error doesn't store |
| `orpc/client-interceptor` | Attaches `Idempotency-Key` header only for `.meta.offlineSafe` procedures |

### 8.2 Integration tests

- **Mutation queue against a fake oRPC client:** simulate offline (`navigator.onLine = false`), enqueue 3 mutations, flip online, assert all replay in order with stable idempotency keys.
- **Idempotency middleware against real Postgres:** use `@arki/testing` Postgres factory; assert same key+procedure → same response without handler re-execution.

### 8.3 Playwright e2e (per migrated app)

In `apps/avocabo/start/e2e/offline.spec.ts` and `apps/games-platform/start/e2e/offline.spec.ts`:

```ts
test('queued mutation replays after reconnect', async ({ page, context }) => {
  await page.goto('/dashboard');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByText('queued')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('queued')).toBeHidden({ timeout: 5_000 });
});
```

### 8.4 Type-level test

In `packages/offline/__tests__/types.test-d.ts` — using `tsd` or `expect-type`:

```ts
const unsafeProcedure = orpc.something.unsafeOne;            // no .meta.offlineSafe
expectError(queue.enqueue(unsafeProcedure, { ... }));        // must NOT compile

const safeProcedure = orpc.posts.createOfflineSafe;          // .meta.offlineSafe = true
expectType<Promise<{ idempotencyKey: string }>>(
  queue.enqueue(safeProcedure, { title: 'x' })
);
```

## 9. Implementation phases (subagent-driven)

Each phase has a **dependency contract**: phase N+1 cannot start until phase N completes. Within a phase, tasks are parallel-safe.

### Phase 0 — Scaffold (sequential, 1 task)

**Task 0.1 — Create `packages/offline/` skeleton**
- `bun run turbo gen package --name offline` (verify the generator supports this; if not, hand-scaffold).
- Create `package.json` with exports map (see §3.2).
- Create `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`.
- Add `@arki/offline` to root `package.json` workspaces (already covered by `packages/*` glob).
- Add catalog entries (verify `@tanstack/react-db`, `@tanstack/query-db-collection`, `@tanstack/react-query-persist-client`, `@tanstack/query-async-storage-persister`, `idb-keyval`, `workbox-routing`, `workbox-strategies`, `workbox-expiration`, `superjson`, `ulid` are pinned).
- Stub each subpath with a placeholder `export {}` so the exports map resolves.
- Run `bun install` + `turbo typecheck --filter=@arki/offline` — must pass with empty stubs.

**Task 0.2 (parallel with 0.1) — Add `@arki/db/client` subpath**
- Create `packages/db/src/client/{index.ts,ids.ts,README.md}` (types-only re-exports).
- Update `packages/db/package.json` exports map with `./client`.
- Verify `turbo typecheck --filter=@arki/db` passes.

### Phase 1 — Implement primitives (parallel, 8 tasks)

Each task implements one subpath end-to-end with its public API and unit tests.

- **Task 1.1** — `@arki/offline/query`: `createPersistedQueryClient`, `idb-persister`, `PersistedQueryClientProvider`. Tests: round-trip, buster, maxAge.
- **Task 1.2** — `@arki/offline/mutations`: `createOfflineMutationQueue`, replay loop, dead-letter store, hooks, `OfflineQueueProvider`. Tests: enqueue, replay ordering, error paths.
- **Task 1.3** — `@arki/offline/collections`: `createLocalCollection`, `createMemoryCollection`. Tests: schema validation, namespacing, cross-tab sync.
- **Task 1.4** — `@arki/offline/pwa`: `registerOfflineRoutes` + Workbox strategy factories. Tests: factory returns correct handler config.
- **Task 1.5** — `@arki/offline/status`: hooks + `OfflineBanner`. Tests: hooks reflect queue state.
- **Task 1.6** — `@arki/offline/orpc` (client side): `offlineSafe()` marker, `createIdempotencyInterceptor`. Tests: marker stamps meta, interceptor attaches header.
- **Task 1.7** — `@arki/offline/orpc` (server side): `idempotencyKeys` table, repository, middleware. Tests: dedupe, TTL, error path.
- **Task 1.8** — `@arki/offline/devtools` + `@arki/offline/preset`: `DevPanel`, `createOfflineRuntime`. Tests: preset wires queryClient + queue + provider correctly.

**Note:** Tasks 1.6 and 1.7 share the `/orpc` subpath; the runtime split in package.json keeps them isolated. They are still parallelizable because they edit different files (`client-interceptor.ts` vs `idempotency-middleware.ts`).

### Phase 2 — Type-level + integration tests (parallel, 2 tasks)

- **Task 2.1** — Add `__tests__/types.test-d.ts` proving `OfflineSafeProcedure` brand prevents queueing unsafe procedures.
- **Task 2.2** — Integration test: mutation queue + idempotency middleware + real Postgres via `@arki/testing`.

### Phase 3 — Template integration (sequential, 1 task)

**Task 3.1 — Update `turbo/generators/templates/application/`**
- Frontend template: add `src/lib/offline.ts`, update `root-provider.tsx`, update `service-worker.ts`. Delete the empty `src/lib/db/` scaffold.
- Backend template: add `src/db/schema/idempotency.ts`, append to schema barrel.
- Add `@arki/offline` to template's `package.json` deps.
- Update `turbo/generators/templates/application/start/package.json` and `turbo/generators/templates/application/backend/package.json` to include the new files in the Handlebars manifest if necessary.
- Smoke-test: `bun run turbo gen` a throwaway app, verify it compiles + dev server boots.

### Phase 4 — Migrations (parallel, 2 tasks)

- **Task 4.1 — Migrate `apps/avocabo/start` + `apps/avocabo/backend`**
  - Delete `src/lib/offline-mutation-queue.ts`.
  - Replace provider chain with `@arki/offline` primitives.
  - Mark relevant backend procedures with `.use(offlineSafe())`.
  - Add `idempotency_keys` table; run `turbo db:migrations:generate --filter=@avocabo/backend`.
  - Add `apps/avocabo/start/e2e/offline.spec.ts`.
  - Run `turbo typecheck test lint --filter=@avocabo/start --filter=@avocabo/backend`.
- **Task 4.2 — Migrate `apps/games-platform/start`**
  - Update `src/lib/db/collections/games.ts` and `settings.ts` to use `createLocalCollection`.
  - Verify hooks still type-check.
  - Add `apps/games-platform/start/e2e/offline.spec.ts` (local collections survive reload).
  - Run `turbo typecheck test --filter=@games-platform/start`.

### Phase 5 — Roll out Tier 1 to all other apps (parallel, one task per app)

For each remaining start app, a separate task:

- Add `@arki/offline` to `package.json`.
- Create `src/lib/offline.ts` from template snippet.
- Wire provider in `src/root-provider.tsx`.
- Add `registerOfflineRoutes(...)` to `src/service-worker.ts`.
- Run `turbo typecheck --filter=@{app}/start`.

Apps in scope: `loonyjobs/start`, `sudoku/start`, `ekuation/start`, `manuscribed/start`, `domodoro/start`, `brandability/start`, `typeroom/start`, `novelette/start`, `structurize/start`, `hyphenate/start`, `toolsforwords/start`, `ucssr/start`, `diffdigg/start`, `kapodopera/start`, `evervest/start` (verify which actually have a `start/` web layer first; some may be backend-only or marketing-only).

### Phase 6 — Documentation (sequential, 1 task)

**Task 6.1 — Write `packages/offline/README.md`**
- Three usage tiers with copy-pasteable snippets.
- The strict-idempotency contract (how to mark a procedure, how to write an idempotent handler).
- Troubleshooting: SW not updating, queue stuck, dead-letter recovery, cache busting.
- Link to relevant `@fleet/tanstack-start/pwa` docs for the precache layer.

## 10. Success criteria

The work is done when ALL of these are true:

1. `packages/offline/` exists, ships 8 subpaths, `turbo build --filter=@arki/offline` passes, `turbo typecheck --filter=@arki/offline` passes.
2. `packages/db/src/client/` exists, `turbo typecheck --filter=@arki/db` still passes.
3. `turbo test --filter=@arki/offline` runs the full suite — all primitives have unit tests, plus 1 type-level test and 1 Postgres integration test.
4. The turbo template generates a new app that boots, supports Tier-1 reads offline (test via Playwright `setOffline(true)`), and ships the lib.
5. `apps/avocabo/start` no longer has `offline-mutation-queue.ts`; e2e offline test passes; `turbo test:e2e --filter=@avocabo/start` green.
6. `apps/games-platform/start` collections file uses `createLocalCollection`; e2e test passes.
7. Every other start app has `@arki/offline` in deps and `src/lib/offline.ts` wired; `turbo typecheck` green workspace-wide.
8. `packages/offline/README.md` documents the three tiers, strict-idempotency contract, troubleshooting.

## 11. Non-goals (V1)

Explicitly NOT in scope:

- Tier 3 (true local-first sync). No Electric SQL, PowerSync, or Zero wiring. The `@arki/db/client` subpath claims the namespace but holds no runtime.
- Conflict-resolution semantics beyond last-writer-wins-via-idempotency. CRDTs are a Tier-3 concern.
- Native (Capacitor / React Native) offline support. Web only.
- Multi-device sync. A user offline on phone + tablet sees independent queues until both reconnect; the server is still the merge point.
- Migration of `kapodopera` (whose Drizzle 1.0 migration is in progress) beyond adding the lib dep — until its migration completes, wiring offline could conflict.

## 12. Risks + mitigations

| Risk | Mitigation |
|---|---|
| `superjson` for queue serialization adds bundle weight | Already in `@arki/contracts`; reuse the existing instance |
| Background Sync API support is uneven | Feature-detect; fall back to `online` event-driven replay |
| Service worker update races with new lib version | `buster` based on `VITE_BUILD_ID` invalidates the whole cache on deploy |
| Stale idempotency cache row blocking retries | Server returns cached response — that IS the desired behavior; row TTL handles cleanup |
| `kapodopera` mid-Drizzle-1.0 migration | Exclude from Phase 5 until its migration lands; track in follow-up |
| Avocabo's hand-rolled queue has semantics not captured by lib | Phase 4.1 first reviews avocabo's existing queue code to surface any extra invariants before deletion |

## 13. Out-of-band notes for the implementer

- **Always** use `git -c commit.gpgsign=false commit`. Never `--no-verify`.
- Commit frequently — per phase, per task. Many small focused commits.
- Do NOT use any `any` types. Prefer inference.
- Apps share this workspace with sibling agents — track only your own edits.
- Never `git stash`, `git checkout` someone else's file, or use plain `rm` (use `\rm`).
- Surface conflicts loud. Do not blend conflicting patterns.
- This document is the source of truth. If reality diverges, update this document.
