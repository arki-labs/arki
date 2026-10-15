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
the world, no global mutation. Pure *computation* at import is fine (deriving
actions, building a handler from a static router); *observation* is not.

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
  Dot: a router from `composeRouter` goes straight to oRPC. A check deferred
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
  defer (`http`'s `bundles`/`features` tokens shape the plugin's needs),
  only the runtime fields thunk: `http({ port: () => env.PORT, ... })`.
  The vocabulary for this is `Lazy<T>`/`resolveLazy` from `@arki/ts`.
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
appRouter`, repo types via `ReturnType<typeof createOrdersRepository>`,
`ComposedRepos<typeof features>`. A hand-written mirror interface is drift
waiting to happen.

The one sanctioned exception: **cycle-cutting pins**. Where deriving a type
directly would close a circular definition (e.g. a request-context type that
contains the repos while routers are typed with that context), hand-list the
type and pin it with a type test one module away:

```ts
expectTypeOf<ComposedRepos<typeof features>>().toEqualTypeOf<AppRepo>();
```

The pin makes the hand list compiler-enforced instead of trusted.

## 3. One declaration, many projections

A feature is declared **once** (`feature()`) and everything else is a
projection of it: the plugin `.features()` mounts, the slice token
(`tokenOf`), manifest actions (`dot explain` attribution), the composed
router (client types), the repo record. If adding a capability requires editing a second
place, the design is wrong — extend the declaration and derive.

Boot-time capabilities ride **slice contracts** — structural
`{ key, actions, resolve }` wrappers exported by the adapter that consumes
them (`jobs()` from `@arki/queue/dot`, `schedules()` from
`@arki/schedule/dot`, `endpoints()` from `@arki/http`). Dependencies follow
use; the slice set stays open; `@arki/dot/feature` imports no adapter.

## 4. One membership list, typed folds

`src/features.ts` is THE list. Everything derives from the tuple:
`.features(features)`, `composeRouter(features)`,
`composeRepos(features, db)`, `composeSchema(...)`. Driving adapters
(`http`, `schedule`, `queueWorker`) are bound to the mounted list by
`.serve()` — they never take it as an argument. Folds are typed
identities: runtime merge + exact intersection type + duplicate-key
rejection, as a compile error first and a coded throw at module load behind
it. There is never a second list to
forget.

### The app spine: `.infra()` → `.features()` → `.entrypoints()`

The same three steps under their final names (RFC
`docs/rfcs/2026-10-15-dot-feature-builder.md`). `.use()` folds into
`.infra()` and `.serve()` becomes `.entrypoints()`; both take a list in boot
order, checked like `.useAll()`:

```ts
defineApp('avocabo')
  .infra(log(...), database, cache, authn, journal({ j, tables })) // what the app runs on; log first
  .features(features)                                               // defineFeature() values (feature() during the migration)
  .entrypoints(gateway, schedule({ clock: 'host' }), journalWorker()); // what calls into the features
```

A feature is a chain whose steps are its folders:

```ts
// features/daily-digest/feature.ts — one file; entrypoint files take `core` / `os` as typed parameters
export const core = defineFeature('daily-digest')
  .needs({ plans: billing.provides.entitlements })    // other units, by handle
  .infra(store, mailer)                                // infra/ — private plugins
  .usecases(createUsecases);                           // usecases/ — (deps) => usecases
export const dailyDigest = core
  .provides({ digests: ({ usecases }) => ({ previewFor: usecases.preview }) })
  .entrypoints(rpc(digestContract, procedures(os)), digestSchedules(core)); // entrypoints/
```

Rules the types enforce (each is also a coded runtime check):

- Steps run in order; a step out of order does not compile.
- `.usecases(create)` gets `{ ...needs, ...infra }`; `.provides` factories and
  entrypoints get the same plus `usecases`, built once per boot.
- Feature infra is private: `.infra(store)` publishes `daily-digest.store`
  under the unit `daily-digest/store`; a sibling infra need follows the
  qualified key. Other features reach it only through `.provides`.
- `session`, `headers`, `services` and `usecases` are reserved aliases; an
  infra key equal to a need alias, and an entrypoint key equal to a provided
  key, are compile errors (`FEATURE_E006` at runtime).
- `feature.override({ store: fake })` swaps an infra service before
  compilation: one provider per key, entrypoints kept.
- Mount keys are written once, in the app contract:
  `routerFor(appContract, features)` finds each feature by its `rpc`
  entrypoint's contract; an unmatched key or contract is a compile error.
- `dot explain` draws `daily-digest → daily-digest/store → database`.

App `.infra()` is shared (every feature names it by handle, it owns process
resources); feature `.infra()` is private (it wraps the app's handles or owns
a client nobody else shares — never a second Postgres pool).

### The app spine is a hexagon (object form — removed when the migration to `defineFeature` ends)

`app.ts` wires the units in three steps, and the builder types enforce the
order — a unit in the wrong step does not compile:

```ts
defineApp('shop')
  .use(db({ relations }))           // driven adapters — what features need
  .use(queue({ connection }))       //   (a queue CLIENT features enqueue with)
  .features(features)               // the domain core — feature() values, one list
  .serve(http({ port }))            // driving adapters — what calls the features
  .serve(queueWorker({ q, needs: {}, context }));
```

Infrastructure never depends on the domain: nothing in `.use()` can need a
feature service, and `.use()` is closed once `.features()` is called.
Adapter authors pick the side explicitly: `driver(features => plugin(...))`
is accepted only by `.serve()`; `driven(features => plugin(...))` — a driven
adapter that reads the features' static declarations, like the journal — only
by `.use()`.

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
  `DOT_LIFECYCLE_E020` at `configure()` for code that skips types. The kernel
  checks every plugin's needs against every plugin's static provides, so the
  same rule holds for adapters, not only features.
- **Capabilities never form a ring.** Two feature modules naming each
  other's handles fail as `TS7022` on both `feature()` consts (and an ESM TDZ
  `ReferenceError` at runtime); erased graphs fail `configure()` with
  `DOT_LIFECYCLE_E019`, which prints the ring (through any plugins). Break it by moving the shared
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

| Lifetime | Home | Examples |
| --- | --- | --- |
| compile-time | ES modules, composed folds | schema, relations, routers, repo factories, context TYPE |
| boot-time | plugins / `feature()` `provides` factories, side-effect `boot` + slices | db handle, auth instance, event store, route bundles |
| request-time | the gateway's context factory | session lookup, per-request context value |

"If it doesn't need boot, it doesn't need a plugin" — static data rides
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

| Property | Mechanism |
| --- | --- |
| Import purity | scrubbed-env subprocess imports the app module |
| Fold ↔ contract exactness | derivation tests: per-key `toEqualTypeOf`, `ComposedRepos` pin |
| Duplicate membership | compile error in compose folds; coded throw at module load behind it |
| Graph shape | `dot explain` from a bare checkout; feature-attributed actions |
| Boot behavior | package suites + a live boot smoke (a real round-trip, a fail-closed guard, clean dispose) |
