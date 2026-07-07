# RFC: Feature pips — vertical-slice composition for `@arki/dot`

- **Status:** DRAFT — two founder decisions locked at inception (2026-07-07):
  (1) **action ownership flips to the feature pip** — features declare every
  action they contribute, activators stop declaring on their behalf;
  (2) **authoring ergonomics is a first-class acceptance criterion** —
  feature pips must be "very easy to make and feel natural". This RFC
  resolves open question A of
  `2026-07-07-arki-queue-auth-schedule-pips.md` (queue pip shape): the
  factory-wrapping-app-`start` recommendation is superseded by an additive
  bundle/feature mode, with the shipped registry mode kept. Rev 2
  (2026-07-07): sub-features designed — recursive feature pips under a
  module namespace with dotted names; kernel-level `pips:` nesting and
  slice-merging aggregators rejected (see Rejected alternatives); open
  question A (`useAll`) recorded, recommendation defer. Rev 3
  (2026-07-07, founder direction): queue deps story replaced with the
  **tRPC context model** `@arki/queue` natively ships — jobs stay static
  module data authored against a typed app context (the proven kapodopera
  pattern, `core/queue/init.ts` + feature job files, kept byte-identical);
  `queueRuntime()` supplies the context *value* from its DOT needs inside
  the guarded start; Rev 2's `bindJobs`/`JobBundle` rejected as a parallel
  deps mechanism (see Rejected alternatives). Rev 4 (2026-07-07, founder
  direction): the init model extended to pip authoring itself —
  `initPips.context<AppServices>().create()` in `@arki/dot`, key-array
  `needs` compiled to the existing witness contract (pure type-level
  sugar, kernel semantics untouched); **strongest-possible typing
  end-to-end** adopted as doctrine (schema-aware concrete types in
  `AppServices`, inferred from implementations, never widened at seams);
  full-context injection for pips rejected on sequencing grounds. Rev 5
  (2026-07-07, founder direction): the schema layer — feature-owned
  `tables.ts` leaf modules composed by a collision-checked
  `composeSchema()` into the app schema; `Db` type survives as a factory
  `ReturnType` while the module-level singleton dies (the db pip boots
  the value); the repository god-aggregation dissolves into feature-pip
  provides. Schema is compile/migration-time data and is therefore
  module-composed, never runtime-contributed (see The schema layer).
  Rev 6 (2026-07-07, founder: "fold with your recs" after the Codex
  adversarial pass): coverage gaps closed — `es` and `rpc` slices added,
  queue slice widened to the full registry (jobs + queue-schedules +
  flows), `@arki/schedule` gains the init/context model, typed
  unit-of-work for cross-feature transactions, producer-service
  convention for cross-feature triggering, partial-token semantics
  stated honestly, seeds and frontend explicitly scoped out, `useAll`
  un-deferred into Phase 1 (open question A resolved). **IMPLEMENTED
  2026-07-07** (founder + Codex, commit 784165562c): Phases 1–3 shipped,
  Phase 4 partial (routes + schedules feature modes; rpc/es slices and
  docs pending). Post-review fixes applied same day: feature-mode queue
  context resolved once inside the guarded start (was per-job-execution
  — a degradation regression), db uow test type assertions made
  runtime-safe. Schedule context shipped as `ScheduleDef<TContext>`
  generics with token-derived intersection instead of the
  `initSchedule.context` factory — deviation blessed, see The schedule
  seam. Rev 7 (2026-07-07): Phase 4 remainder shipped — RPC mounts as a
  static contract (`rpcMount`, an ActionSource) bound in boot via
  `routes().rpc(contract, { context, handle })` with derivers running
  before dispatch (INSIDE the routes bundle, not a separate slice key —
  see RPC mounts); `eventSourcing({ features })` collects `es` slices;
  `adapter-authoring.md` gains the Feature slices chapter;
  `packages/db/README.md` gains the schema-composition + drizzle-kit
  glob + unit-of-work recipes. Rev 8 (2026-07-07, founder: "copy
  backend into backend-test and build it entirely on pips"): proving
  ground 2 — `@novelette/backend-test`, the full backend library (143
  files, 12 features, 8 oRPC routers) rebuilt with ZERO module
  singletons: db/kv/auth/eventStore/every repo are pip-provided
  services; `composeSchema()` replaces the spread barrel; the
  `createRepositories` god factory dissolves into 9 feature pips plus
  the api pip whose needs list is the one legitimate cross-feature
  aggregate; oRPC is served through `rpcMount` with a graph-built
  per-request context — all routers compile UNCHANGED. Found + fixed in
  `@arki/http` during the live probe: Hono `.mount()` rewrites the
  request URL (prefix-stripped) before rpc dispatch, so the documented
  RPCHandler-with-prefix pattern could never match; the engine now
  mounts rpc bindings with `replaceRequest: false` (regression test
  added, 48/48 green). See delivery plan row 5b.
- **Date:** 2026-07-07
- **Author:** Claude (session fbbe6be7), from the 2026-07-07 feature-pips
  design conversation
- **Depends on:** the actions RFC
  (`2026-07-07-dot-transport-agnostic-actions.md`, ACCEPTED — `actions:`
  declarative authoring, open bindings, projections; kernel side shipped
  f584570e68), `@arki/http` bundles (`RouteBundle` under tokens),
  `@arki/queue` `queueRuntime()` (shipped a0f82bb759), `@arki/schedule`
  (shipped d788e37f3b), `@arki/auth` `auth()` pip (shipped a9bc6fcced)
- **Related:** `2026-07-06-arki-http-adapter-and-request-scope.md` (the
  bundle-token pattern this RFC generalizes),
  `2026-07-07-arki-queue-auth-schedule-pips.md` (lifecycle pips this RFC
  composes)
- **Location note:** internal; must NOT move into `packages/dot/docs/`
  (that tree mirrors to the public `arki-labs/arki` repo).

## Summary

A **feature pip** is one pip that carries a feature's entire **backend**
vertical slice: its domain services, HTTP endpoints, oRPC/tRPC routers,
queue consumers/producers/flows, schedules, event-sourcing read models —
and, when a CLI binding exists, its commands. Everything
related to `orders` lives in `ordersPip`; the app file reads as a list of
features followed by a list of activators.

This is **a pattern plus small adapter seams, not a kernel concept**. The
kernel already has everything required: heterogeneous `actions:` lists
(open bindings), services under tokens, activator pips deriving `needs`
from token lists. The exit criterion of the actions RFC holds here too:

> **Zero kernel changes.**

What must be built is the queue-side and schedule-side contribution seams
(http already has one), plus one convention — the **feature slice
protocol** — so a feature exports a single token instead of one per
contribution kind.

## Motivation

1. **This is the NestJS comparison that matters most.** Nest's core
   organizing unit is the feature module (`OrdersModule` bundling
   controller + service + processor + cron), assembled by decorator
   scanning and container reflection. DOT currently organizes by
   *infrastructure* — adapters are first-class, features are whatever the
   app file stitches together. Feature pips invert that: features are the
   units, adapters are plumbing listed last.
2. **The pieces exist but stop halfway.** HTTP contributions are already
   feature-local (`RouteBundle` under a token, assembled in `boot` where
   the feature's `needs` are injected — the pattern is literally the
   worked example in `packages/http/src/bundle.ts`). Queue and schedule
   contributions are not: the registry is app-global, and its context
   value is a hand-rolled closure *outside* the DI graph (novelette's
   `createContext: () => deps`, `apps/novelette/backend/src/jobs.ts:42`)
   — features can neither contribute definitions feature-locally nor get
   their boot-assembled services into handlers through DOT.
3. **Attribution.** With features declaring their own actions, the
   manifest's `pip` column makes `dot explain` a **feature map**: filter
   by pip and see one feature's full boundary surface — routes, consumers,
   producers, schedules — across every binding.

## Current state (code-grounded, 2026-07-07)

| Contribution kind | Channel today | Feature-local? |
| --- | --- | --- |
| Domain services | `boot` return / `provide(token, …)` | ✅ native |
| HTTP endpoints | `RouteBundle` under token → `http({ bundles })` | ✅ shipped |
| HTTP actions | contracts are `ActionSource`s (`toDotAction`) — the *feature* declares | ✅ shipped |
| Queue producers | `job.trigger()` + `queueProducerActions()` | ✅ mostly |
| Queue consumers | one registry + one app-level `start` supplying global deps (`queueRuntime({ registry, start })`) | ❌ the gap |
| Queue actions | auto-declared by `queueRuntime()` from the registry — the *activator* declares | ❌ flips |
| Schedules | `schedule({ schedules })` takes defs directly, auto-declares actions | ❌ same gap, smaller |
| CLI commands | no adapter yet | future binding — the action model accommodates it |

Note the seam asymmetry: http actions are feature-declared, queue and
schedule actions are activator-declared. Founder decision (1) resolves the
asymmetry in http's direction.

## Design

### The authoring target (this is the acceptance criterion)

A feature file must read like this — the app's context-typed pip factory
(defined once; the pip-side sibling of kapodopera's
`core/queue/init.ts`) plus `provide()`, no witness ceremony:

```ts
// core/pips.ts — once per app
export type AppServices = { db: Db; kv: KV; ordersService: OrdersService };
export const p = initPips.context<AppServices>().create();
```

```ts
// features/orders/feature.ts
export const Orders = token<OrdersSlice>()('feature.orders');

export const ordersPip = p.pip({
  name: 'orders',
  needs: ['db', 'kv'],                   // keys of AppServices — typo = compile error
  actions: [
    listOrders, createOrder,             // http contracts — already ActionSources
    ordersRpc,                           // rpc mount contract — static ActionSource (Rev 7)
    ...queueActions(ordersQueue),        // jobs + queue-schedules + flows, one spread
    ...scheduleActions(ordersSchedules), // already exported by @arki/schedule
  ],
  async boot({ db, kv }) {
    const ordersService = makeOrdersService(db);
    return {
      ordersService,                     // domain service — other pips AND the queue context
      ...provide(Orders, {
        routes: routes()
          .bind(listOrders,   async ({ query }) => ordersService.list(query))
          .bind(createOrder,  async ({ body })  => ordersService.create(body))
          .rpc(ordersRpc, {              // static contract; handlers bound here (Rev 7)
            context: (req, ctx) => ({ orders: ordersService }),
            handle:  (req, rpcCtx) => rpcHandler.handle(req, { context: rpcCtx }),
          }),
        queue: ordersQueue,              // full static registry — jobs, queue-schedules, flows
        schedules: ordersSchedules,
        es: ordersEs({ db }),            // event-sourcing bundle (Rev 6)
      }),
    };
  },
});
```

Job files themselves stay exactly what kapodopera proves out today
(`core/queue/init.ts` + `features/*/jobs/*.ts`): static builder chains
against a typed app context, `ctx.db` typed in every handler, `trigger()`
on the definition.

And the app file like this:

```ts
defineApp('shop')
  .use(envPip).use(dbPip).use(kvPip)
  .use(ordersPip)
  .use(billingPip)
  .use(queueRuntime({
    q,                                   // the app's typed builder (initQueue.context<QueueCtx>())
    features: [Orders, Billing],
    needs: p.needs('db', 'ordersService'),  // witness record derived from AppServices
    context: ({ db, ordersService }) => ({ db, ordersService }),  // checked against QueueCtx
  }))
  .use(schedule({ features: [Orders, Billing], lock: kv }))
  .use(http({ features: [Orders, Billing] }));
```

Ergonomic rules, checkable in review:

- **One exported token per feature.** Not one per contribution kind.
- **One spread per binding kind** in `actions:`. Contracts need none.
- **Declare once, bind once.** Each contract/job/schedule appears exactly
  twice: once in the static `actions:` list, once in `boot` — contracts
  bound to handlers, jobs/schedules merely referenced in the slice.
  Nothing else, anywhere. (Why twice at all: actions are collected at
  configure time, route-handler deps exist only at boot — the kernel's
  timing seam. A future `dot doctor` declared-vs-bound check is the
  reserved E003/E004 work.)
- **Partial features are zero-config.** A feature with only routes
  provides only `routes:`; activators treat missing slices as empty.
- **Needs are key picks, not witness records.** `needs: ['db', 'kv']` —
  one string per dependency against the app schema; `service<T>()`
  witnesses never appear in feature files.

### The authoring layer: `initPips.context<AppServices>()` (Rev 4)

The queue builder's model — bind a context *type* once, author everything
against it — applies to pip authoring itself. `@arki/dot` gains an app
factory:

```ts
// core/pips.ts — once per app
export type AppServices = {
  db: typeof db;                                   // drizzle WITH the app schema — knows every table
  auth: ReturnType<typeof initAuth>;               // the concrete better-auth instance type
  ordersService: ReturnType<typeof makeOrdersService>;
};
export const p = initPips.context<AppServices>().create();
```

- **`p.pip({ needs: ['db', 'kv'], … })`** — needs are key arrays; hook
  contexts are `Pick<AppServices, K>`; a typo'd key or a wrong-typed
  provider is a compile error, same as today. Internally the factory
  builds the witness record (`{ db: service<AppServices['db']>() }` —
  witnesses are phantom-typed `{}` at runtime, `pip-contract.ts:54`), so
  this is **pure type-level sugar over the existing contract**: kernel,
  guard, ordering, manifest all untouched.
- **`p.needs('db', 'ordersService')`** — the bridge: returns the witness
  record for anything that takes witness-shaped needs (adapter factories
  like `queueRuntime`, `http`). One vocabulary, both authoring styles.
- **Provides are schema-checked where they overlap.** A pip whose boot
  returns `{ ordersService }` is validated against
  `AppServices['ordersService']`; token provides (feature slices) pass
  through untouched. `AppServices` becomes the app's *service schema* —
  the single place the whole wiring vocabulary is written down.
- **Package pips keep witnesses/tokens.** Adapters are app-agnostic and
  cannot know `AppServices`; the factory is the app's authoring layer,
  not a replacement contract. Lazy needs use the explicit witness form
  (a mixed needs record is accepted).

**Strong typing end-to-end is the doctrine, not a nicety** (founder
requirement). `ctx.db.insert(AvailabilityChurnEvent)` compiles in
kapodopera's jobs because `AppContext.db` is the drizzle instance *with
the app's schema* — not a generic `Db` interface. The same bar applies
everywhere in this design: `AppServices` entries are **concrete inferred
types** (`typeof db`, `ReturnType<typeof initAuth>`), never hand-written
interfaces that can drift from the implementation; the queue `context`
factory is checked against the builder's context type, so the concrete
`db` type flows pip → context → `ctx.db` in every handler with the
schema intact; erasure is legal only *inside* a factory seam and must be
re-typed at the boundary by a witness or token carrying the concrete
type (the existing three-contained-unsafe-points discipline). If a
handler, deriver, or hook sees a type wider than the implementation
provides, that is a design bug in this RFC's terms.

**Priority rule (founder, Rev 5): typing strength outranks generality.**
When strongest-possible typing and loose coupling conflict, typing wins
— higher coupling is an accepted cost. Concretely: feature pips are APP
code and may couple freely to the app's concrete types (`AppServices`,
`typeof db`, the app's `p`); generality is reserved for *published*
packages (adapters), and even there a generic seam is acceptable only if
it preserves the concrete types passing through it (generics that
forward, never parameters that widen).

**Why pips select keys while jobs get the whole context** — the one
deliberate asymmetry: a job runs *after* the world is built, so full
context is safe. A pip *builds* the world — it boots mid-sequence, and
the `.use()` guard orders that sequence by exactly what each pip
consumes. Full-context injection for pips would make "reads a service
that boots later" representable again (v1's core disease). The
`needs: [...]` array is not ceremony; it *is* the ordering information,
reduced to its minimum — one string per dependency.

### The schema layer: feature-owned tables, app-composed `db` (Rev 5)

The schema has a different **lifetime** than everything else in this
RFC: `drizzle-kit` must import tables without booting anything, and
`Db = typeof db` must exist before any pip runs (it is what
`AppServices` is typed with). Schema is therefore **compile/migration-
time data — module-composed, never runtime-contributed**. "Each pip
defines its own schema" means: each *feature* owns its `tables.ts` leaf;
the feature *pip* is the runtime face of the same folder; the app files
shrink to mechanical, type-checked composition.

```text
features/orders/
  tables.ts        — LEAF: pgTable/pgEnum definitions; imports nothing from core
  repository.ts    — createOrdersRepository(database) factory (static export)
  feature.ts       — the pip: p.pip({ needs: ['db'], … }) — provides repos/services
core/
  schema.ts        — export const schema = composeSchema(ordersTables, billingTables, …)
  relations.ts     — defineRelations(schema, r => …) — deliberately app-level, NOT sharded
  db.ts            — type only: Db = ReturnType<typeof buildDb>['db']; value booted by the db pip
  pips.ts          — AppServices { db: Db, … }; p = initPips.context<AppServices>()
```

- **`composeSchema()` is a typed identity, not an abstraction**
  (`@arki/db`). Runtime = `Object.assign`; type = the exact intersection
  of the slices with a compile-time duplicate-key rejection. Drizzle
  receives a plain schema object — nothing custom sits in the data path,
  so `$inferSelect`, RQB inference, transactions, and every drizzle
  behavior are untouched. Zero type loss by construction: the composed
  type IS the slices' types. What it buys over today's `export *`
  aggregation: name collisions become compile errors instead of silent
  shadowing (kapodopera's `schema.ts` carries comment archaeology —
  "content/enums.ts conflicts with fiction/schema.ts — skip enums" —
  that this deletes).
- **`drizzle-kit` globs the leaves** (`schema:
  ['./src/features/**/tables.ts']` in `drizzle.config.ts`) — migrations
  work exactly as today, and the enum-reachability hack (kapodopera
  `schema.ts:143-160`, aliased re-exports because drizzle-kit scans only
  the entrypoint's named exports) dies: per-file scanning sees each
  leaf's own exports.
- **Relations stay app-level on purpose** (priority rule applied):
  `defineRelations` infers across the whole schema; sharding it into
  per-feature fragments needs type gymnastics that weaken exactly the
  inference that makes `ctx.db` strong. Higher coupling, stronger types
  — the accepted trade. Cross-feature FK edges live where the FK lives.
- **The `Db` type survives; the module-level singleton dies.** Today
  `db.ts` connects at import time. Under DOT, `buildDb` is a factory,
  `Db` is its `ReturnType` (statically available, no connection), and
  the db pip calls it in `boot`. `AppServices.db: Db` stays schema-aware
  end to end.
- **The repository god-aggregation dissolves into feature pips.**
  kapodopera's 150-line `createRepositoriesFromDb` exists to build one
  global repo bag; with feature pips, each feature builds its own repos
  in `boot` from the typed `db` and *provides* them, concretely typed by
  inference. Cross-feature access is `needs: ['ordersService']` — guard-
  checked — not a global bag. Per-feature repo *factories* stay static
  exports so transaction scopes can re-instantiate
  (`createOrdersRepository(tx)`, the `withTransaction` pattern).
- **The layering rule that keeps the graph a DAG**: `tables.ts` imports
  nothing from `core/`; `core/schema.ts` imports only leaves;
  `core/pips.ts` imports the `Db` *type*; `feature.ts` imports `p` and
  its own leaves. (This is why kapodopera's layout already works — the
  rule was implicit; now it's stated.)

### The feature slice protocol (structural, no shared package)

A feature token's service type is a plain object of **adapter-owned slice
keys**:

```ts
type OrdersSlice = {
  routes?: RouteBundle;               // key owned by @arki/http — rpc mounts ride INSIDE it (Rev 7)
  queue?: QueueRegistry;              // FULL registry: jobs + queue-schedules + flows (Rev 6; was `jobs`)
  schedules?: readonly ScheduleDef[]; // key owned by @arki/schedule
  es?: EsBundle;                      // key owned by @arki/event-sourcing (Rev 6)
};
```

Each activator gains a `features:` option accepting tokens whose type
*structurally* includes its own slice — `http()` accepts
`Token<{ routes?: RouteBundle }>`, reads `.routes`, ignores the rest.
**No shared "feature" type exists anywhere**: structural typing is the
whole protocol, so adapters stay mutually independent (the same reason
`toDotAction()` needs no kernel import). Needs derivation, duplicate-token
rejection, and the boot-time erasure seam are all inherited verbatim from
`http()`'s existing bundle handling.

Slice-key governance mirrors the actions RFC's binding rules: well-known
keys (`routes`, `queue`, `schedules`, `es`) are documented in
`adapter-authoring.md`; third-party adapters MUST package-qualify theirs
(`'acme:bus'`).

**Partial tokens are accepted by design, stated honestly (Rev 6, Codex
H6):** a routes-only feature handed to `queueRuntime({ features })`
contributes nothing — that is the "partial features are zero-config"
rule, so *"wrong token rejected at the activator" is not a property of
this protocol*. Type safety lives at the **provide site**: the feature's
declared slice type catches typo'd and excess keys (`route:` instead of
`routes:` is a compile error against `OrdersSlice`). Activators emit a
debug log when a feature token contributes no slice, so wiring mistakes
surface at boot instead of never.

**Cross-app reusable features (Rev 6, Codex M7):** a feature meant for
more than one app cannot import any app's `p`/`AppServices` — by
definition it is a *package* pip: witness/token needs, generic but
type-preserving (the priority rule's one sanctioned use of generics).
App feature pips are deliberately app-coupled; the boundary question is
just "will a second app mount this?".

Per-kind token options (`bundles:`) remain valid — the slice protocol is
additive sugar over the same mechanism.

### Sub-features — decomposing a large feature

When a feature outgrows one pip (orders → checkout, invoicing, returns),
**sub-features are feature pips, recursively** — the pattern applies at
whatever granularity carries a coherent slice. The *parent* is a module
namespace, not a runtime object:

```ts
// features/orders/ — one folder, one public surface
export const checkoutPip  = pip({ name: 'orders.checkout',  /* full feature pip */ });
export const invoicingPip = pip({ name: 'orders.invoicing', /* full feature pip */ });

export const OrdersFeatures = [Checkout, Invoicing] as const;  // token tuple

// app file
defineApp('shop')
  .use(checkoutPip).use(invoicingPip)
  .use(queueRuntime({ features: [...OrdersFeatures, Billing] }))
  .use(http({ features: [...OrdersFeatures, Billing] }));
```

- **Dotted names are the subfeature convention** (`orders.checkout`).
  Pip names carry no kernel format constraint; `dot explain` gains
  prefix-filterable subfeature attribution for free (a CLI tree-grouping
  nicety can layer on later, display-only).
- **The token tuple is the completeness contract.** Forgetting to
  `.use()` a sub-pip while its token remains in an activator's
  `features:` list leaves that token without a provider — a compile
  error at the activator's `.use()`. The failure mode kernel-level
  nesting would exist to prevent is already unrepresentable.
- **No slice merging, ever.** An aggregator collapsing sub-slices into
  one parent token would change semantics: a `RouteBundle`'s derivers
  scope to its own routes (checkout's auth deriver must not leak onto
  invoicing's routes). Activators accept N tokens; a JS array spread is
  the entire composition story, and deriver isolation survives.
- The "one exported token per feature" ergonomic rule applies at the
  granularity of the *(sub-)feature*: a complex feature exports one
  token tuple instead.

### Action ownership (founder decision 1)

- **The feature declares every action it contributes** — contracts
  natively, `queueActions(jobs)` (new merged helper: `in` + `out` per
  job, replacing the two-spread `queueConsumerActions` +
  `queueProducerActions` at authoring sites), `scheduleActions(defs)`
  (already exported by `@arki/schedule/dot`).
- **Activators MUST NOT declare actions for feature-contributed work.**
  `queueRuntime({ features })` and `schedule({ features })` derive
  runtime wiring from the slices and declare nothing. The kernel's
  duplicate-`(binding, id)` check (`DOT_LIFECYCLE_E016`) is the backstop
  if both sides ever declare.
- **Legacy modes keep activator declaration.** `queueRuntime({ registry,
  start })` and `schedule({ schedules })` still auto-declare — there is no
  feature pip to attribute to. Single-owner rule per app: an app mixes
  modes only across *different* jobs/schedules.
- **Honest trade-off:** a feature declaring queue actions in an app that
  never mounts `queueRuntime` leaves unserved claims in the manifest —
  the known declared-vs-bound gap (reserved E003/E004), the exact same
  exposure `@arki/http` features have today. Accepted; the doctor check
  is the eventual fix, not a blocker.
- **Cross-feature triggering — resolved by convention (Rev 6, Codex
  M12/C-open):** feature B never imports feature A's job definition to
  `.trigger()` it. The owning feature *provides a producer service*
  (`ordersProducer`, typed methods wrapping `trigger()`); B declares
  `needs: ['ordersProducer']` — so an unmounted owner is a compile
  error at `.use()`, not a silent no-op queue write at runtime. Only
  the owner declares the produce action; manifest attribution stays
  with the owner. Direct cross-feature job imports are banned by
  convention.

### The queue seam: the tRPC context model (Rev 3, founder direction)

`@arki/queue` is already tRPC-shaped, and the seam design should ride
that instead of fighting it. The existing model, proven at scale in
kapodopera (`apps/kapodopera/backend/src/core/queue/init.ts`,
`features/_shared/content-access/jobs/churn-detection.ts`):

- **Context is a TYPE at definition time.**
  `const q = initQueue.context<QueueCtx>().create()` — one app-owned
  file binds the context type; every job/schedule is a *static* builder
  chain against it (`baseJob.name(…).input(…).handler((data, ctx) =>
  ctx.db…)`). Definitions are inert data with fully typed handlers; no
  deps threading, no bind step.
- **Context is a VALUE exactly once at runtime** — today via the
  hand-rolled `createQueue({ createContext: () => deps })` closure.

The seam is that closure: `queueRuntime()`'s feature mode absorbs it into
the DI graph.

```ts
queueRuntime({
  q,                                    // the typed builder — carries QueueCtx
  features: [Orders, Billing],          // slices contribute their full static queue registry
  needs: { db: service<Db>(), ordersService: service<OrdersService>() },
  context: ({ db, ordersService }) => ({ db, ordersService }),
  //        ^ resolved DOT services      ^ statically checked against QueueCtx
});
```

- **Boot-assembled feature deps flow through DOT DI, not closures.** The
  orders pip *provides* `ordersService` (built in its boot, degradation
  and all); the activator *needs* it; the context factory includes it;
  handlers read `ctx.ordersService` typed. The `.use()` guard enforces
  end-to-end that every context ingredient is provided by some pip —
  novelette's `WorkerDependencies` (image-service graph, council runner,
  KV-closing callbacks) becomes feature-pip provides plus one context
  factory.
- **The context factory runs inside the guarded start**, so the shipped
  lifecycle lessons hold unchanged: non-blocking start racing the 30 s
  timeout, degradation to HTTP-only when assembly throws (missing R2
  creds), drain ordering by declaration position,
  `ARKI_QUEUE_E001–E003`.
- **Jobs need no boot at all** — slices reference static records, and
  `queueActions(ordersJobs)` derives the manifest entries without
  booting, preserving manifest-without-boot.
- **Isolation posture, stated honestly:** one context per runtime — every
  handler sees the full context, exactly as every tRPC procedure sees the
  app context. When a feature wants a narrowed or enriched view, the
  builder's existing middleware is the answer
  (`baseJob.use(withOrdersCtx)`), statically — not a second binding
  mechanism.

- **The slice is the FULL queue registry (Rev 6, Codex H3):** jobs,
  queue-backed schedules (`q.schedule.cron` — kapodopera uses it today,
  churn-detection.ts:350), and flows. `queueActions()` derives manifest
  entries for all three definition types, not just `_type === 'job'`.
- **Worker-side tenancy/authorization (Rev 6, Codex M8):** route
  derivers do not protect workers. The tenancy boundary for jobs is the
  **input schema** (jobs carry `workspaceId`/principal in their zod
  input) plus typed job middleware (`baseJob.use(withTenant)`) verifying
  it against context services at execution time. Documented as the
  convention; no new machinery.

Registry mode (`{ registry, start }`) survives untouched for fully
app-owned monoliths — novelette today. The modes are mutually exclusive
per pip instance (coded error if both given).

### The schedule seam — now context-typed (Rev 6, Codex H4)

`schedule({ features: [...] })` collects `schedules` slices; croner
engine, arm-on-start/drain-on-stop, `overlap: 'skip'`, KV TTL-lock, and
`--as schedule-table` are unchanged. This revises the pips RFC's
"bundles are deliberately not in v1" for `@arki/schedule`: the real
consumer (feature pips) arrived.

Rev 6 closes the typing hole: `defineSchedule` handlers were
`() => Promise<void>` — a schedule touching `db` could only close over
module singletons, contradicting the doctrine.

**As-implemented (784165562c, deviation blessed):** instead of an
app-level `initSchedule.context` factory, `ScheduleDef<TContext>` carries
the context generic and the activator's required context type is
**derived from the feature tokens** — the intersection of every mounted
feature's `ScheduleDef` context demands (`UnionToIntersection` over the
token slices). Stronger than the factory design: context requirements
travel with the definitions, and the activator cannot under-supply what
any feature needs. The activator gains `needs` + `context: (services) =>
TContext`; a schedule needing nothing declares no context, so the
Redis-less zero-dependency posture survives. Context resolves per fire
(defensible for crons; assembly failures currently log as
`handler-failed` — acceptable, noted).

### RPC mounts (Rev 6, Codex C2; Rev 7 as-implemented)

oRPC/tRPC routers are most features' primary API surface in this
workspace, and raw `mount()` bypasses derivers and DOT context — which
would leave the *main* interaction path outside the model.

**As-implemented (Rev 7):** rpc is NOT a separate slice key — it rides
**inside the routes bundle**, because derivers are a *bundle* capability
(the engine walks `bundle.derivers`); a standalone slice could never
deliver "derivers run before dispatch". And the API splits exactly like
contracts do, because a fused def would be boot-created and therefore
unlistable in the static `actions:` list:

```ts
// module level — the STATIC half, an ActionSource:
export const ordersRpc = rpcMount('/rpc/orders', { id: 'orders.rpc' }); // transport defaults to 'orpc'

// boot — the handlers bind where services exist:
routes()
  .derive(sessionDeriver)
  .rpc(ordersRpc, {
    context: (req, ctx) => ({ session: ctx.session, orders: ordersService }), // ctx typed by the builder
    handle:  (req, rpcCtx) => rpcHandler.handle(req, { context: rpcCtx }),    // RPCHandler built once at boot
  });
```

`http()` treats rpc mounts unlike raw mounts: **bundle derivers run
before dispatch**, typed into the context factory via the builder's
accumulation; the mount claims the same path-prefix namespace as raw
mounts (collision = boot error); a thrown error envelopes, but the rpc
handler owns its subtree's own responses/error format. The contract's
`toDotAction()` declares `{ binding: transport, direction: 'in',
address: path, meta: { path, rpc: true } }`. Raw `mount()` survives for
truly foreign handlers (static files, third-party fetch handlers).

**Original-request contract (Rev 8, found live in proving ground 2):**
`context` and `handle` receive the ORIGINAL request — the engine mounts
rpc bindings with Hono's `replaceRequest: false`, because oRPC/tRPC
fetch adapters take the mount path as their own `prefix`/`endpoint`
option and derivers read `req.url`; Hono's default mount rewrite
(prefix-stripped URL) silently broke both (RPCHandler `matched: false`
on every request). Regression-tested in `packages/http`. Raw `mount()`
keeps sub-app (stripped) semantics deliberately.

### The es slice (Rev 6, Codex C1; shipped Rev 7)

`es?: EsBundle` — the es RFC's bundle rides the feature token like every
other slice; `eventSourcing({ features })` collects it (shipped: feature
tokens merge into needs beside `bundles:`, a feature without an `es`
slice contributes nothing with a debug line, missing tokens reuse the
E003 coded error). The doctrine
consequence matters more than the key: **read-model/projection factories
become boot-time values built from DOT services.** Import-time singleton
capture — kapodopera's `createProjectionWithRepos` closing over the
module `db`, patched around with the `__setProjectionTarget` test
redirect (db.ts:300-340) — is the anti-pattern this dissolves. Test
isolation falls out: tests boot the app against a test db pip
(`testPip`), and projections see the test database with no mutable
globals.

### Transactions: the unit of work (Rev 6, Codex H5)

Feature services capture `db` at boot; called inside a transaction they
would silently escape it. The rule: **cross-feature writes flow through
a typed unit-of-work.**

```ts
// @arki/db — composed at the app level from statically-exported feature factories
const uow = createUnitOfWork(db, {
  orders: createOrdersTx,      // (tx: Database) => orders' tx-scoped repos/services
  billing: createBillingTx,
});
// provided as AppServices.uow; usage:
await uow(async (tx) => {
  await tx.orders.create(…);
  await tx.billing.charge(…);  // ONE transaction, both features, fully inferred types
});
```

`createUnitOfWork` runs `db.transaction`, instantiates each feature's
scope from the tx, and hands back the typed scope record — inference
end to end, no registry, no service locator. Repos keep accepting
`Database` (db-or-tx) exactly as today; singleton feature services are
for non-transactional composition; per-feature tx factories are static
exports (they need no boot).

### `@arki/http` and `@arki/auth`

- `http()` gains `features:` (reads `.routes` and `.rpc`); `bundles:`
  stays.
- `auth()` is unaffected — it is infrastructure, not a feature. The pips
  RFC's question B stands as shipped: `{ auth }` only.

## Rejected alternatives

- **A kernel `feature` concept** (manifest grouping field, feature
  registry). The pip name already attributes every action, service, and
  lifecycle entry; `dot explain` filtered by pip IS the feature view.
  Zero demonstrated need for more.
- **A `defineFeature()` mega-helper** wrapping `pip()` with named
  `routes:`/`jobs:`/`schedules:` sections. It would need to import types
  from every adapter — a cross-adapter dependency knot in whatever package
  hosts it — to save one `provide()` spread. `pip()` is already the
  natural surface; the slice protocol keeps adapters independent.
- **Auto-deriving `actions:` from boot-built bundles** (kill the
  declare-once/bind-once duality). Impossible without moving action
  collection to boot time: configure precedes boot, and handler deps
  don't exist yet. Weakening manifest-without-boot (`dot explain` on an
  unbootable app) to save one list is a bad trade.
- **Kernel flattening of nested `actions:` arrays** (kill the spreads).
  `...queueActions(jobs)` is ordinary JavaScript; not worth breaking the
  zero-kernel-change invariant for.
- **One shared `FeatureBundle` type package.** Structural typing already
  provides the contract; a nominal shared type would couple every adapter
  to one package's release cadence for no added safety.
- **Kernel-level sub-pip nesting** (`pip({ pips: [...] })`). The kernel's
  core invariant is ONE ordering — declaration order is boot order, with
  the `.use()` guard making wrong orders unrepresentable. A nested `pips:`
  array introduces a second, inner ordering plus visibility rules for
  every needs/provides edge crossing the nesting boundary (which
  sub-services escape? does the parent re-export?) — NestJS's module
  `imports`/`exports` bureaucracy, which v2 deliberately dropped. It also
  touches everything that assumes a flat pip list: manifest, diagnostics,
  `rename()`, `testPip`, guard typing. Its one genuine benefit —
  can't-forget-a-sub-pip completeness — is already delivered by the token
  tuple (see Sub-features). The residual cost, app-file verbosity, is an
  ergonomics question (open question A), not an architecture one.
- **Slice-merging aggregator pips** (N sub-tokens → 1 parent token).
  Merging `RouteBundle`s flattens deriver scopes — a semantic change
  disguised as convenience. Rejected in the Sub-features section.
- **`bindJobs(jobs, deps)` + `JobBundle` per-feature deps binding** (this
  RFC's own Rev 2 design, superseded in Rev 3 by founder direction). It
  invented a second deps mechanism running parallel to the context/
  middleware architecture `@arki/queue` natively ships, forced a bind
  step into every feature's `boot`, made job definitions deps-generic
  where they are context-typed today (kapodopera's job files would have
  needed rewrites), and its per-feature isolation benefit is already
  available via builder middleware. The tRPC context model delivers the
  same feature-locality through DOT DI: feature services are *provided*
  by feature pips and reach handlers through the activator's checked
  `context` factory.
- **Full-context injection for pips** (every pip receives the whole
  `AppServices`, exactly like a job receives `ctx`). Jobs run after the
  world is built; pips build it. Mid-sequence, "reads a service that
  boots later" must stay unrepresentable — that is the guard's entire
  value, and it needs per-pip selection to order by. The key-array
  `needs` is the irreducible minimum, not residual ceremony (see The
  authoring layer).
- **Hand-written service interfaces in `AppServices`** (e.g. a generic
  `Db` interface instead of `typeof db`). Interfaces drift from
  implementations silently; inferred concrete types cannot. Same
  doctrine as the workspace's tRPC rule: infer, don't declare.
- **Runtime schema contribution through pips** (a `tables` slice the db
  pip merges at boot). Impossible without breaking both consumers of the
  schema: `drizzle-kit` imports tables statically for migrations, and
  `Db = typeof db` must be complete before `AppServices` — and therefore
  before any pip — exists. Two lifetimes, two mechanisms; forcing schema
  through the runtime one would trade compile-time table knowledge for a
  composition nicety, the exact inversion of the priority rule.
- **Sharded per-feature relations fragments.** `defineRelations` infers
  across the whole schema; splitting it needs type-level reassembly that
  weakens the inference that makes `ctx.db` strong. Priority rule
  applied: relations stay one app-level file, coupling accepted.

## Review log — Codex adversarial pass (2026-07-07)

Charged with the founder's worry ("I don't feel like this will cover all
our needs"): 15 findings — 2 critical, 4 high, 8 medium, 1 low.
**Rev 6 executed every disposition below** (founder: "fold with your
recs", 2026-07-07) — es + rpc slices, full queue registry, schedule
context model, unit-of-work, producer-service convention, partial-token
honesty, package-pip boundary for shared features, tenancy convention,
seeds/frontend scoped out, `useAll` un-deferred to Phase 1,
prototype-first type-test gates on Phases 1–2.

- **C1 — ES has no slice.** The slice protocol carries routes/jobs/
  schedules; the es RFC's `EsBundle`/projections have no feature-local
  path, and kapodopera's `createProjectionWithRepos` + module-singleton
  capture (`__setProjectionTarget` test hack) is exactly what feature
  pips should dissolve. Rec: FOLD — `es?: EsBundle` slice key;
  read-model factories become boot-time values from DOT services
  (also resolves M9, test isolation).
- **C2 — oRPC/tRPC routers bypass the model.** Mounts skip derivers and
  DOT context (`engine.ts` registers mounts raw); the workspace is
  oRPC-heavy, so the *main* RPC surface of most features would sit
  outside the design. Rec: FOLD as a first-class `rpc` slice / typed
  mount factory whose per-request context is built inside `http()` boot
  from DOT services — **shape needs founder decision**.
- **H3 — queue slice is jobs-only.** `q.schedule.cron` and flows exist
  and are used (churn-detection.ts:350); `collectJobs` filters
  `_type === 'job'`. Rec: FOLD — slice becomes `queue?: QueueRegistry`
  (jobs + queue-schedules + flows); `queueActions` covers all three.
- **H4 — `@arki/schedule` handlers have no context** (`() =>
  Promise<void>`), contradicting the typing doctrine. Rec: FOLD — give
  `schedule()` the same needs/`context` model as `queueRuntime()`
  (**or** founder call: doc it as dependency-free and route DB-touching
  crons through queue).
- **H5 — cross-feature transactions unsolved.** Feature services capture
  the singleton `db` at boot; calling them inside `withTransaction`
  silently escapes the tx. Rec: design a typed unit-of-work service
  (per-feature repos-from-tx factories composed) — **needs founder
  direction**.
- **H6 — structural slice tokens may not reject wrong tokens** (all
  keys optional ⇒ `{}` is assignable). Rec: FOLD — branded/marker slice
  types + failing-type tests as a Phase 4 exit criterion.
- **M7–M15 (summary):** shared cross-app features (document
  package-pip vs app-pip boundary); per-feature job/schedule
  auth+tenancy (typed middleware + tenant-bearing input schemas); test
  isolation via boot-time factories (falls out of C1); seeds have no
  home (exclude or convention — founder call); frontend/TanStack
  explicitly out of scope (rename claim to "backend vertical slice");
  cross-feature triggering needs boot validation that triggered jobs
  are registered; declaration-order pain at 20+ features strengthens
  the case for `useAll` (open question A — evidence for un-deferring);
  `initPips.context` feasible but real generic machinery, prototype
  first; `composeSchema` needs runtime duplicate check + type-test
  suite; `queueRuntime({ q, context })` needs a new overload
  (builder's context type is exposed, API isn't).

## Open questions (founder decisions)

A. **`useAll(pips)` builder addition** — ~~defer~~ — **RESOLVED 2026-07-07
   (Rev 6): build it, in Phase 1.** The original defer rested on "revisit
   when verbosity bites"; Codex's ordering finding (M13) showed it bites
   immediately at realistic scale — a 20+ feature app with es/queue/
   schedule/http activators makes declaration order the whole dependency
   graph, navigated through rest-tuple arity errors. `useAll(tuple)` is a
   type-level fold threading the same guard accumulation (runtime: a loop
   over `use`), landing alongside `initPips.context` as Phase 1's
   kernel-package sugar.

## Delivery plan

| Phase | Contents | Exit criterion | Status |
| --- | --- | --- | --- |
| 1 | Authoring layer in `@arki/dot`: `initPips.context<AppServices>().create()` — `p.pip` (key-array `needs` → witness compile, `Pick`-typed hooks, provides schema-check, mixed witness record for lazy) + `p.needs` bridge + `useAll(tuple)` typed fold (Rev 6) — **prototype-first**: a type-test suite (key-array widening, collision, provides-overlap, guard parity: every wrong-key/wrong-type/wrong-order failure reproduces identically to the witness form; concrete types — a schema-typed drizzle instance — survive to hook contexts unwidened) gates the API before adoption | a feature pip authored with zero witness declarations; `typeof db` reaches `boot` intact; a 5-pip tuple `useAll` reproduces the guard's failures | SHIPPED 784165562c (incl. post-review probe: TProvides inference through mixed plain+spread-provide returns) |
| 2 | Schema layer: `composeSchema()` in `@arki/db` (typed-identity spread, compile-time duplicate-key rejection **+ runtime duplicate check** — Rev 6, type-test suite proving zero type loss: `$inferSelect`/RQB inference identical to a hand-written object) + `createUnitOfWork()` in `@arki/db` (Rev 6: db.transaction + per-feature tx-scope instantiation, full inference) + drizzle-kit glob recipe + leaf-layering rule in docs | a two-feature test schema composes with full inference; a duplicate table key fails at compile AND dev runtime; `drizzle-kit generate` output identical to the monolithic entrypoint; a two-feature `uow` write commits/rolls back atomically with typed scopes | code SHIPPED 784165562c (uow test fixed post-review); drizzle-kit glob recipe + leaf-rule docs PENDING |
| 3 | Queue seam: `queueActions()` covering **jobs + queue-schedules + flows** (Rev 6) + feature mode `queueRuntime({ q, features, needs, context })` (slice = full `QueueRegistry`; `context` factory statically checked against the builder's context type — new overload, Rev 6 — and run inside the guarded start; mode exclusivity vs `{ registry, start }`) + producer-service convention documented + tests (guarded start, degradation, context type-check, E016 non-collision, schedule/flow action derivation) | a feature pip contributes consumers, a queue-cron, and a flow with zero app-level runtime assembly; kapodopera-style job files compile unchanged; actions attribute to the feature in `dot explain` | SHIPPED 784165562c + same-day fix: context resolved once inside guarded start (regression test added) |
| 4 | Slice protocol: `features:` on `http()` (routes incl. **rpc mounts** — Rev 7: static `rpcMount` contract + boot-bound handlers, derivers run before dispatch), `schedule()` (context via `ScheduleDef` generics), and `eventSourcing()` (**es slice**); Feature-slices chapter in `adapter-authoring.md`; schema-composition + uow recipes in `packages/db/README.md` | ONE feature token consumed by three activators in a test app; provide-site slice-type tests (typo/excess-key = compile error); empty-contribution debug log observed; an rpc mount receives derived ctx | SHIPPED — 784165562c (routes/schedules) + this session (rpc mounts w/ 5 engine tests; `eventSourcing({features})` w/ skip-empty test; both docs). Remaining exit assertion (one token → three activators in a single test app) rides Phase 5's proving ground |
| 5 | Proving ground: novelette — split `buildRuntimeConfig` into feature pips providing services (story-generation, image-pipeline), one `context` factory replaces `WorkerDependencies` assembly, delete `pips/queue-runtime.ts` scaffolding, i18n staleness schedule moves into its feature. Stretch (Rev 6): kapodopera swaps its hand-rolled worker bootstrap for `queueRuntime` feature mode (zero job-file diffs expected) AND deletes the `__setProjectionTarget` test hack via boot-time projection factories | `dot explain` renders novelette as a feature map; four degradation postures (Redis × R2 creds) byte-identical; e2e green | SHIPPED (novelette; this session): three feature pips (story-generation w/ `storyLifecycle` provide + kv need, image-pipeline w/ boot-safe factory export, i18n w/ schedules slice), `useAll` in the app file, `queueRuntime`/`schedule` feature modes live, backend lifecycle scaffolding deleted (jobs.ts −60 lines), 3 backend subpath exports added. Verified: `dot explain` = feature map (12 actions, all feature-attributed, activators declare zero); degraded posture live-proven (missing R2 creds → context factory throws INSIDE guarded start → HTTP-only, health 200 at ~2s, graceful SIGTERM drain — exact debug line captured); e2e 37/37 green (2 initial failures were the documented `NOVELETTE_ENABLE_E2E_AUTH_SEAMS` run requirement, not the migration). Remaining posture cells (Redis down ×2, creds present ×2) hold by construction + package regression tests, not re-run live. Kapodopera stretch NOT attempted — still open |
| 5b | Proving ground 2 (Rev 8, founder): `apps/novelette/backend-test` — the whole backend library rebuilt "entirely on pips": types-only `db.ts` (`Db = DbServices<typeof relations>['db']` — provider-anchored, no instance), `schema.ts` via `composeSchema` (8 slices), 9 feature pips (story/image/i18n/events/universe/style/consent/auth/fleet — fleet converts a start-app-mounted handler into a route-contributing pip), api pip serving the statically-merged `appRouter` via `rpcMount` with `createContext` assembled from graph services (`Context` shape preserved so routers need zero edits), `schedule({ features: [I18n] })` with context-typed `ScheduleDef`, integration tests ported from singleton dynamic-imports to a memoized test composition root (`core/__tests__/test-instances.ts`) | typecheck green with routers untouched; `dot explain` renders a feature map; a live boot round-trips a real procedure; full vitest suite green | SHIPPED (this session): typecheck green, ZERO router edits; `dot explain`: 14 pips, 11 actions all feature-attributed (image ×6, story ×2, i18n/fleet/api ×1), activators own nothing, api's needs list is the visible cross-feature seam; live smoke on :3998 — `audience.detect` 200 through engine → rpc binding → `createContext` (better-auth getSession on the pip db) → oRPC middleware → handler; fleet fail-closed 401 (FOREMAN_TOKEN unset); clean dispose; vitest 269 passed / 0 failed on real testcontainers; lint adds 0 findings over the copied 113-error baseline. Includes the `@arki/http` engine fix (rpc mounts pass the ORIGINAL request, `replaceRequest: false`) found by the live probe. Founder-review follow-ups, same day: the relations god object dissolved into feature-owned fragments (`relations.ts` beside each `tables.ts` leaf, typed via a derived `SchemaRelationsBuilder`, composed by ONE `defineRelations` call through `composeSchema` — duplicate table claims are compile errors; drizzle's `defineRelationsPart` investigated and REJECTED: each part runs its own `processRelations` pass and nothing recombines parts into the single graph `drizzle({relations})` mounts); and the fleet adapter seam extracted to **`@arki/admin/http`** (`fleetSnapshotRoute` static contract + `fleetRoutes({token, snapshot})` ready bundle; `@arki/http` optional peer per the /dot-adapter pattern) — the general-primitive rule applied, since that glue would otherwise be stamped into every DOT app's fleet pip. **Single-list membership (founder: "why define them again?"):** each feature's `pip.ts` exports a `FeatureRecord = { pip, rpc? }`; `src/features.ts` is the ONE membership tuple; `app.ts` derives `useAll(pips(features))` and `api.ts` derives `appRouter = mergeRpc(features)` — value AND `AppRouter` type from the same fold (fragments stay static, so oRPC client inference is exact; proven by per-key `toEqualTypeOf` tests), duplicate mount keys throw at module load; router-only features (admin, audience-segment) got metadata-only pips (kapodopera precedent) so they finally appear in `dot explain` (16 pips). Boot-collected fragments + `ServicesOf<typeof app>` type derivation was considered and rejected: still needs a static list for the type, risks the known oRPC TS7056 depth trap, and forces the tester to boot the app. **Request lifetime named:** `core/context.ts` is now types-only (like `db.ts`) — `Context` is the compile-time contract `os.$context<Context>()` needs; the per-request VALUE assembly (session lookup + services closure) moved into the api pip's rpc `context` callback, killing `createContext`/`ContextServices` exports. Three lifetimes, three homes: compile = modules, boot = pips, request = the api pip's context factory |
| 6 | Template sync + docs: `turbo/generators/templates/application/` gains the feature-pip layout (`core/pips.ts`, `core/schema.ts` + one feature with `tables.ts` leaf); pips-RFC cross-references updated | new-app scaffold ships a feature pip example | — |

Public promotion of the touched packages remains governed by the pips
RFC's Phase 4 (peer-major-bump watch point included).

## Non-goals

- Kernel **semantics** changes of any kind. Rev 4's authoring layer is a
  new pure type-level module in `@arki/dot` that compiles to the
  existing witness contract — the kernel runtime, guard behavior, and
  manifest schema stay byte-identical. The adapter-side exit criterion
  is unchanged: zero kernel lines for queue/schedule/http feature modes.
- A CLI binding (future work; the action model and slice protocol
  accommodate it without revision — `commands?: CliBundle` is one more
  slice key).
- **Seeds (Rev 6, Codex M10).** Seed/admin scripts are one-shot ops
  tasks, not runtime contributions — they keep importing static repo
  factories directly. Their natural future home is the CLI binding
  above; giving them a slice now would invent lifecycle for code that
  runs outside the app's lifecycle.
- **Frontend and the TanStack Start `server/` layer (Rev 6, Codex
  M11).** This RFC's claim is precisely scoped: feature pips are the
  **backend runtime vertical slice**. Frontend feature organization
  (routes, components, loaders) is real but is a different composition
  problem with different lifetimes — deliberately not this design.
- Forcing existing apps onto feature pips — registry/direct/bundles modes
  all survive; this is additive.
- Multi-instance features (`rename()` composition of a feature pip) —
  nothing blocks it structurally, but no consumer exists; not designed
  for here.
