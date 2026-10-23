# Declaration-first composition doctrine

How to structure an app built on `@arki/dot` and its features (`@arki/dot/feature`). These rules
are distilled from what drizzle and oRPC get right, proven on a full
production backend. When your code and this doc disagree, fix one of them —
don't fork silently.

## The one-sentence version

**Declare everything as inert const values; compose by typed folds from one
membership list; let every runtime artifact be a projection of the
declarations; point dependencies only downward; observe the world only in
`boot()` and request factories.**

## 1. Declarations are inert (the drizzle-table rule)

Importing any module in the declaration layer must be **observationally
free**: no env observation, no I/O, no connections, no throws that depend on
the world, no global mutation. Pure _computation_ at import is fine (deriving
actions, building a handler from a static router); _observation_ is not.

- **Mistakes are caught on the earliest step that can see them** (the
  ladder):
  1. **Types**, when TypeScript can express the check: a duplicate key in a
     compose fold (§4), a builder method called too early, a mount path
     without a leading `/`. `tsc` reports every one at once, before any code
     runs.
  2. **A coded throw at import**, when the check depends only on the source
     but types cannot express it: a cron string that does not parse, a key
     column that is nullable. It fails at the line of the mistake, in every
     environment, every time. The error carries a `code` and a
     `remediation`; `dot explain` shows both when the import fails.
  3. **Boot**, for anything that depends on the world: env, files, the
     network, the clock. Never at import.
- **Never move a check down the ladder.** Many consumers never boot through
  Dot: a router from `routerFor` goes straight to oRPC. A check deferred
  to boot would never run for them, and a loud mistake would become a silent
  one.
- **Every type check keeps a runtime throw behind it.** Plain JavaScript and
  casts skip the types; the coded throw is the backstop.

- Env is observed at **use**, never at import — `@arki/env`'s `defineEnv` is
  lazy by design (the `process.env` snapshot and validation fire on first
  property access).
- Adapter config that comes from env is passed as a **thunk** — prefer
  thunking the whole options object: `kv(() => ({ url: env.REDIS_URL }))`.
  Where an adapter's options carry declaration-time wiring that cannot
  defer (`http`'s `bundles`/`features` tokens shape the unit's needs),
  only the runtime fields thunk: `http({ port: () => env.PORT, ... })`.
  The vocabulary for this is `Deferred<T>`/`resolveDeferred` from `@arki/dot/unit`.
- Client-facing declarations (contracts, enums, branded-id schemas) live in
  modules that never import server code, published as universal exports;
  server-only modules get `{ "types", "node" }`-conditioned exports so a
  browser bundler cannot resolve them. Beware `export { type X } from 'm'` —
  under `verbatimModuleSyntax` it keeps a RUNTIME import of `m`; use the
  fully-erased statement form `export type { X } from 'm'` in client-safe
  modules. Enforce with a browser-purity test: esbuild-bundle every
  universal export with `platform: 'browser'` and fail on node builtins or
  server-module fragments.
- No module-scope singletons that touch the world: no
  `export const db = createDb(...)`, no top-level `await app.boot()`. If a
  library seam truly needs a shared instance, wrap it —
  `lazyObject(() => createDb(...))` for object handles (consumers keep
  plain value semantics), `once(() => app.boot())` for anything else,
  both from `@arki/ts`. `lazyObject` is `once` plus proxy transparency:
  reads bind methods to the real instance, writes/deletes/`instanceof`
  delegate to it, and construction happens on first property access.

**Executable form:** the app graph must render from a bare checkout. Give
every app an import-purity test built on `expectImportPure` from
`@arki/ts/testing`: it spawns a subprocess with a scrubbed environment
(keeps `PATH`/`HOME`; sets `NODE_ENV=development` so env validation is NOT
skipped), imports the given modules, and throws unless the exit is clean.
Any module-scope side effect anywhere in the import chain fails it
immediately. `dot explain` working with zero environment is the same
property, interactively.

## 2. Types derive from values (the `$inferSelect` rule)

Never hand-write a type that restates a value: `type AppRouter = typeof
appRouter`, repo types via `ReturnType<typeof createOrdersRepository>`. A hand-written mirror interface is drift
waiting to happen.

The one sanctioned exception: **cycle-cutting pins**. Where deriving a type
directly would close a circular definition (e.g. a request-context type that
contains the repos while routers are typed with that context), hand-list the
type and pin it with a type test one module away:

```ts
import { expectTypeOf } from 'vitest';

// Stand-in for the app's fold: one repository per feature.
type ComposedRepos<TFeatures extends Record<string, { readonly repo: object }>> = {
  [K in keyof TFeatures]: TFeatures[K]['repo'];
};
const features = { orders: { repo: { find: (id: string) => ({ id }) } } };

// The hand-listed type that cuts the cycle.
type AppRepo = { orders: { find: (id: string) => { id: string } } };

expectTypeOf<ComposedRepos<typeof features>>().toEqualTypeOf<AppRepo>();
```

The pin makes the hand list compiler-enforced instead of trusted.

## 3. One declaration, many projections

A feature is declared **once** (`defineFeature()`) and everything else is a
projection of it: the units `.features()` mounts, the slice record
(`sliceOf`), manifest actions (`dot explain` attribution), the router
(`routerFor`, client types), the feature's own store (`repos`). If adding a capability requires editing a second
place, the design is wrong — extend the declaration and derive.

Boot-time capabilities ride **entrypoint descriptors** — structural
`{ key, actions, resolve }` wrappers exported by the adapter that consumes
them (`jobs()` from `@arki/queue/dot`, `schedules()` from
`@arki/schedule/dot`, `endpoints()` from `@arki/http/dot`). Dependencies follow
use; the entrypoint set stays open; `@arki/dot/feature` imports no adapter.

## 4. One membership list, typed folds

`src/features.ts` is THE list. Everything derives from the tuple:
`.features(features)`, `routerFor(rpcContract, features)`,
`composeSchema(...)`. Entrypoint units
(`http`, `schedule`, `queueWorker`) are bound to the mounted list by
`.entrypoints()` — they never take it as an argument. Folds are typed
identities: runtime merge + exact intersection type + duplicate-key
rejection, as a compile error first and a coded throw at module load behind
it. There is never a second list to
forget.

### The app spine: `.infra()` → `.features()` → `.entrypoints()`

The same three steps under their final names (RFC
`docs/rfcs/2026-10-15-dot-feature-builder.md`). Each step takes a list in boot order. A list is checked in order, like
separate calls:

```ts run
import { defineApp, entrypoint, infra } from '@arki/dot';
import { defineFeature, sliceOf, unit } from '@arki/dot/feature';
import { rpc } from '@arki/dot/orpc';
import { isFailure } from '@arki/failure';

// Stand-ins: in a real app these come from @arki/log, @arki/db and @arki/http.
const logger = infra({ name: 'log', provides: { log: () => ({ info: (_message: string) => {} }) } });
const database = infra({ name: 'database', provides: { db: () => ({ query: async (_sql: string) => [] }) } });
const orders = defineFeature('orders').entrypoints(rpc({}, {}, () => ({})));
const features = [orders] as const;
const gateway = entrypoint.fromFeatures(mounted =>
  unit({
    name: 'gateway',
    boot: ctx => {
      for (const mountedFeature of mounted) {
        if (sliceOf(ctx, mountedFeature) === undefined) throw new Error('gateway sees no slice');
      }
    },
  }),
);

const shop = await defineApp('shop')
  .infra(logger, database) // what the app runs on; log first
  .features(features) // defineFeature() values
  .entrypoints(gateway) // what calls into the features
  .boot();
if (isFailure(shop)) throw new Error(shop.code);

const order = shop.manifest.plugins.map(p => p.name).join(' → ');
if (order !== 'log → database → orders → gateway') throw new Error(`unexpected boot order ${order}`);
await shop.dispose();
```

A feature is a chain whose steps are its folders:

```ts run
import type { DepsOf } from '@arki/dot/feature';
import { defineApp, infra } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { rpc } from '@arki/dot/orpc';
import { isFailure } from '@arki/failure';

// Stand-ins for what the feature uses: a billing feature and a store.
const billing = defineFeature('billing')
  .provides({ entitlements: () => ({ capFor: (userId: string) => (userId === 'u1' ? 2 : 1) }) })
  .entrypoints();
const store = infra({
  name: 'store',
  provides: { store: () => ({ itemsFor: async (userId: string) => [`${userId}:welcome`, `${userId}:tips`] }) },
});

// features/daily-digest/feature.ts — one file; usecase and procedure files take `Deps` as a type
const dailyDigestDeps = defineFeature('daily-digest')
  .needs({ plans: billing.provides.entitlements }) // other units, by handle
  .infra(store); // infra/ — private units
export type Deps = DepsOf<typeof dailyDigestDeps>; // what a usecase may ask for

// usecases/ — one file per usecase
const preview =
  ({ store, plans }: Pick<Deps, 'store' | 'plans'>) =>
  async (userId: string) =>
    (await store.itemsFor(userId)).slice(0, plans.capFor(userId));

const dailyDigestLogic = dailyDigestDeps.usecases({ preview });
export const dailyDigest = dailyDigestLogic
  .provides({ digests: ({ usecases }) => ({ previewFor: usecases.preview }) })
  .entrypoints(rpc({}, {}, () => ({}))); // entrypoints/ — the contract is empty here

const shop = await defineApp('shop').features([billing, dailyDigest]).boot();
if (isFailure(shop)) throw new Error(shop.code);
const items = await shop.services.digests.previewFor('u1');
if (isFailure(items)) throw new Error(items.code);
if (items.length !== 2) throw new Error(`the plan allows two items, got ${items.length}`);
await shop.dispose();
```

Rules the types enforce (each is also a coded runtime check):

- Steps run in order; a step out of order does not compile. The order is
  `.needs()`, `.infra()`, `.domainServices()`, `.features()` (children),
  `.usecases()`, `.provides()`, `.entrypoints()`.
- Each step sees only what is written above it. That is why a cycle cannot be
  written: a domain service cannot ask for a usecase, and infra cannot ask for
  a domain service.
- `.usecases({ name: factory })` takes one factory per usecase; each gets
  `{ ...needs, ...infra, ...domainServices }` (and may `Pick` a subset);
  asking for a dep the feature lacks is a compile error. Each factory gets its
  own frozen copy, built once per boot.
- `.provides` factories get `{ usecases }` and nothing else. Entrypoints get
  the usecases, the request keys, and the needs marked `entrypointOnly(...)`.
  Neither sees repos, infra, plain needs or domain services. To publish data
  behind a repository, provide a usecase that reads it.
- Something is a domain service when two or more usecases need it, or one
  child feature does. With one consumer in the same feature, build it in that
  usecase's factory body. A domain service lives in `domain-services/`, one
  per file, registered with `.domainServices({ name: factory })`. Its factory
  asks for `Pick<DomainDeps, …>` and cannot return a `Failure`. Peers in one
  call never see each other. A child names it with `domainService(fn)`.
- `rpc(contract, implementer, factories)` takes one factory per procedure
  (the whole tree in one `entrypoints/procedures.ts`), shaped like the contract; an extra, missing or wrong procedure does not compile.
- Feature infra is private: `.infra(store)` publishes `daily-digest.store`
  under the unit `daily-digest/store`; a sibling infra need follows the
  qualified key. Other features reach it only through `.provides`.
- A need names a handle, and the types read its identity — the `provider`
  and `key` literals the handle carries — not only its service type. A
  child's need is remapped onto its parent only when it names the parent's
  own infra handle; a same-shaped global handle stays a global need
  (`ARKI_DOT_E012` at boot otherwise). An infra unit that binds a need to a
  handle must bind the feature's handle (`ARKI_DOT_E026` at `.infra()`).
  Residual the types cannot see: two units with the same name, publish key
  and service type are one identity to the compiler; the runtime still tells
  them apart by object. A `Unit<N, P>` annotation erases both the shape and
  the name, and the checks fall back to wire keys for that unit.
- `session`, `headers`, `services` and `usecases` are reserved aliases; an
  infra key equal to a need alias, and an entrypoint key equal to a provided
  key, are compile errors (`ARKI_DOT_E027` at runtime).
- `feature.override({ store: fake })` swaps an infra service before
  compilation: one provider per key, entrypoints kept.
- Mount keys are written once, in the app's RPC contract:
  `routerFor(rpcContract, features)` finds each feature by its `rpc`
  entrypoint's contract; an unmatched key or contract is a compile error.
- `dot explain` draws `daily-digest → daily-digest/store → database`.

App `.infra()` is shared (every feature names it by handle, it owns process
resources); feature `.infra()` is private (it wraps the app's handles or owns
a client nobody else shares — never a second Postgres pool).

Three ways to have two of something: `rename(unit, …)` for a second unit
instance (keys renamed, same declaration); nesting for a feature that belongs to
another (`digest.compile`, scoped keys); `feature.instance('eu', rebind)` for the
same feature twice (`reports#eu`, qualified keys, needs rebound to another
provider, children re-derived). An instance is not a child: it is public,
top-level, and owns its own infra units.

### The app spine is a hexagon

`app.ts` wires the units in three steps, and the builder types enforce the
order — a unit in the wrong step does not compile:

```ts run
import { defineApp, entrypoint, infra } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { isFailure } from '@arki/failure';

// Stand-ins for adapters from @arki/db, @arki/queue and @arki/http.
const db = infra({ name: 'db', provides: { db: () => ({ query: async (_sql: string) => [] }) } });
const queue = infra({ name: 'queue', provides: { queue: () => ({ enqueue: async (_job: string) => {} }) } });
const http = entrypoint({ name: 'http' });
const queueWorker = entrypoint({ name: 'queue-worker' });
const features = [
  defineFeature('orders')
    .needs({ db: db.provides.db })
    .provides({ orders: () => 'orders' })
    .entrypoints(),
] as const;

const app = await defineApp('shop')
  .infra(db) // infra units — what features need
  .infra(queue) //   (a queue CLIENT features enqueue with)
  .features(features) // the domain core — defineFeature() values, one list
  .entrypoints(http, queueWorker) // entrypoint units — what calls the features
  .boot();
if (isFailure(app)) throw new Error(app.code);

const order = app.manifest.plugins.map(p => p.name).join(' → ');
if (order !== 'db → queue → orders → http → queue-worker') throw new Error(`unexpected boot order ${order}`);
await app.dispose();
```

Infrastructure never depends on the domain: nothing in `.infra()` can need a
feature service, a domain service or a usecase, and `.infra()` is closed once
`.features()` is called. A feature's own infra never imports any `feature.ts`.
Adapter authors pick the side with the constructor: `entrypoint.fromFeatures(features => unit(...))`
is accepted only by `.entrypoints()`; `infra.fromFeatures(features => unit(...))` — an infra
unit that reads the features' static declarations, like the journal — only
by `.infra()`.

## 5. Dependencies point one way (the drizzle-relations rule)

Layer the app with leaves at the bottom; imports may only point down:

```text
app spine (app.ts, gateway.ts, api.ts, features.ts, schema.ts, relations.ts)
  ↓
features (feature.ts, router.ts, repository.ts, jobs, relations fragment)
  ↓
core infra (procedure builders, env, auth factory, logging) + adapters
  ↓
schema leaves (tables.ts — import nothing above)
```

- **No lateral feature→feature imports — with one door.** Cross-feature table
  references go through the composed relations builder (typed by the composed
  schema — no import needed). Cross-feature behavior goes through provided
  services, needs-checked by the graph. The door: any module of a consumer
  feature (its `feature.ts`, or a procedure) may import a provider's
  `feature.ts` to name a capability by handle —
  `needs: { access: billing.provides.entitlements }`. That import carries a
  handle typed from billing's `provides` factory (the type is written once,
  by the provider) and stamped with `provider: 'billing'`, and nothing else;
  a consumer reaching into another feature's services, repository, or
  internals is still a lateral import. Mount order stays the boot order: the
  provider must be listed before the consumer — a compile error, and
  `ARKI_DOT_E020` at `configure()` for code that skips types. The kernel
  checks every unit's needs against every unit's static provides, so the
  same rule holds for adapters, not only features.
- **Capabilities never form a ring.** Two feature modules naming each
  other's handles fail as `TS7022` on both `defineFeature()` consts (and an ESM TDZ
  `ReferenceError` at runtime); erased graphs fail `configure()` with
  `ARKI_DOT_E019`, which prints the ring (through any units). Break it by moving the shared
  piece into a third feature both need, or by reading through `db.query`
  instead of a handle. A feature's own router never names its own handle
  (also `TS7022`): own capabilities are called by import.
- **Procedures read capabilities through the request context's opaque
  bag.** The context type cannot name the merged services (it loops through
  the routers), so it carries a `ServicesBag`; the gateway feature spreads
  `providesOf(features)` into its needs and passes `servicesOf(ctx, features)`
  to `createContext`, and each procedure narrows the bag through
  `resolveNeeds` with the handles it uses, declared inline
  (`needs({ entitlements: billing.provides.entitlements })`). Keep a feature's
  `needs` record in its `feature.ts`; move it to a `needs.ts` leaf only when
  that feature's OWN procedures must share the exact record — importing it
  from `feature.ts` would close feature.ts → router → procedure → feature.ts
  (a TDZ cycle). One DI system: the bag holds the very instances
  `app.services` publishes.
- **Relations are a second pass** over the composed schema: feature-owned
  fragments, one `defineRelations` call, never a god barrel.
- **Nothing points back up — where "up" means a cycle.** The rule is
  ACYCLICITY, not rigid layering. The composed request context is the app's
  `db.query` analog: routers legitimately read ANY feature's repo through it
  (cross-feature reads are domain reality — a story lives in a universe), so
  the context type is a spine artifact that features reference through the
  procedure builders. That reference is legal because it terminates in
  repository LEAF modules, never in routers — the module graph stays
  acyclic. Do NOT fragment the context per feature to "fix" this: narrow
  per-feature contexts force lateral type imports between features, which is
  the real violation.

## 6. Effects live in `provides` factories, `boot()` and request factories only

Three lifetimes, three homes:

| Lifetime     | Home                                                                  | Examples                                                 |
| ------------ | --------------------------------------------------------------------- | -------------------------------------------------------- |
| compile-time | ES modules, composed folds                                            | schema, relations, routers, repo factories, context TYPE |
| boot-time    | units / feature `provides` factories, side-effect `boot` + entrypoints | db handle, auth instance, event store, route bundles     |
| request-time | the gateway's context factory                                         | session lookup, per-request context value                |

"If it doesn't need boot, it doesn't need a unit" — static data rides
modules and folds, not the graph. The gateway is the one legitimate
cross-feature aggregation point (requests → contexts).

## 7. oRPC lessons (hard-won, don't relearn)

1. **Static router merge, always.** The app router must be a compile-time
   fold so client inference is exact. Boot-collected routers don't work:
   the type still needs a static list, and testing the type would require
   booting the app.
2. **Context is contravariant — narrow demands run under wide supplies.**
   A procedure typed against `{ db, user }` runs happily under the full app
   context; useful when extracting a single router to a worker/edge host.
   But do NOT fragment the app context per feature as a rule: routers
   consuming any repo through the composed context is the intended shape
   (see §5), and per-feature contexts trade one hand-pinned spine type for
   lateral type imports everywhere.
3. **"Type instantiation is excessively deep" (TS7056)**: fold middlewares,
   keep procedure chains shallow, split router barrels. A known trap in
   large oRPC apps.
4. **RPC handlers behind mounts**: Hono's `.mount()` rewrites the request
   URL (strips the prefix) by default, which silently breaks prefix-matching
   handlers — rpc mounts must receive the ORIGINAL request
   (`replaceRequest: false`; `@arki/http`'s engine does this for rpc
   bindings).
5. **The oRPC wire envelope is `{ json, meta? }`** — remember it when
   probing endpoints by hand.

## 8. TypeScript mechanics that recur in this architecture

- Erased bounds over heterogeneous declarations use the **contravariant
  top**: `(database: never) => unknown` for repo factories, `(services:
never) => ...` for erased boot fns and `provides` factories.
- **Contextually typing a record of factories needs a reverse-mapped
  parameter**, not a constraint: `provides?: { [K in keyof TProvides]:
(s: CtxOf<TNeeds>) => MaybePromise<TProvides[K]> }` types each factory's
  parameter from `needs` and infers `TProvides` from the returns; a
  constraint `TProvides extends Record<string, (s) => unknown>` leaves the
  parameter untyped (`TS7031`).
- **Indexed access does not distribute.** `T[number] extends X<infer P>`
  infers ONE `P` across the whole union; wrap in a naked-param alias
  (`type Of<T> = T extends X<infer P> ? P : never`) to distribute per
  member.
- **`UnionToIntersection` distributes into a single member's union type**
  (`Db | Transaction` becomes `Db & Transaction`). To intersect across items
  while keeping each item's union intact, fold through function-parameter
  inference instead.
- Collector token bounds should be `Token<object, string>` with needs values
  = the token's OWN payload — all-optional "well-known key" shapes fail the
  weak-type check the moment payloads differ per feature.
- A `never` arm in a provides-type conditional **poisons the whole
  intersection** — map empty/void cases to `{}` explicitly.
- Witnesses resolve by **key string, not object identity** (`token()`,
  `provide()`); derivation helpers may re-create them freely.

## 9. Enforcement (what CI/tests actually check)

| Property                  | Mechanism                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Import purity             | scrubbed-env subprocess imports the app module                                             |
| Fold ↔ contract exactness | derivation tests: per-key `toEqualTypeOf`, `ComposedRepos` pin                             |
| Duplicate membership      | compile error in compose folds; coded throw at module load behind it                       |
| Graph shape               | `dot explain` from a bare checkout; feature-attributed actions                             |
| Boot behavior             | package suites + a live boot smoke (a real round-trip, a fail-closed guard, clean dispose) |
