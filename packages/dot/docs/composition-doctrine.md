# Declaration-first composition doctrine

How to structure an app built on `@arki/dot` + `@arki/feature`. These rules
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
free**: no env observation, no I/O, no connections, no throws, no global
mutation. Pure *computation* at import is fine (deriving actions, building a
handler from a static router); *observation* is not.

- Env is observed at **use**, never at import — `@arki/env`'s `defineEnv` is
  lazy by design (the `process.env` snapshot and validation fire on first
  property access).
- Adapter config that comes from env is passed as a **thunk**:
  `kv({ url: () => env.REDIS_URL })`, `http({ port: () => env.PORT })`.
- No module-scope singletons that touch the world: no
  `export const db = createDb(...)`, no top-level `await app.boot()`. If a
  library seam truly needs a shared instance, defer it behind a memoized
  async factory booted on first use.

**Executable form:** the app graph must render from a bare checkout. Give
every app an import-purity test: spawn a subprocess with a scrubbed
environment (keep `PATH`/`HOME`; set `NODE_ENV=development` so env
validation is NOT skipped), import the app module, and assert a clean exit.
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

A feature is declared **once** (`defineFeature`) and everything else is a
projection of it: the DOT plugin (`plug`), the slice token (`tokenOf`),
manifest actions (`dot explain` attribution), the composed router (client
types), the repo record. If adding a capability requires editing a second
place, the design is wrong — extend the declaration and derive.

Boot-time capabilities ride **slice contracts** — structural
`{ key, actions, resolve }` wrappers exported by the adapter that consumes
them (`jobs()` from `@arki/queue/dot`, `schedules()` from
`@arki/schedule/dot`, `endpoints()` from `@arki/http`). Dependencies follow
use; the slice set stays open; `@arki/feature` imports no adapter.

## 4. One membership list, typed folds

`src/features.ts` is THE list. Everything derives from the tuple:
`plugs(features)`, `tokens(features)`, `composeRouter(features)`,
`composeRepos(features, db)`, `composeSchema(...)`. Folds are typed
identities: runtime merge + exact intersection type + duplicate-key
rejection that throws at module load. There is never a second list to
forget.

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

- **No lateral feature→feature imports.** Cross-feature table references go
  through the composed relations builder (typed by the composed schema — no
  import needed). Cross-feature behavior goes through provided services,
  needs-checked by the graph.
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

## 6. Effects live in `boot()` and request factories only

Three lifetimes, three homes:

| Lifetime | Home | Examples |
| --- | --- | --- |
| compile-time | ES modules, composed folds | schema, relations, routers, repo factories, context TYPE |
| boot-time | plugins / `defineFeature` `boot` + slices | db handle, auth instance, event store, route bundles |
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
  never) => ...` for erased boot fns.
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
| Duplicate membership | compose folds throw at module load |
| Graph shape | `dot explain` from a bare checkout; feature-attributed actions |
| Boot behavior | package suites + a live boot smoke (a real round-trip, a fail-closed guard, clean dispose) |
