# Dependency injection

How a Dot app finds its services. A unit says what it **needs** with typed
handles and what it **provides** with factories. The compiler checks that
every need has a provider mounted earlier. There is no container, no
decorator and no reflection.

```text
  .infra(database)               .features([orders])
 ┌───────────────┐   provides   ┌───────────────┐
 │   database    │ ─── db ────▶ │    orders     │  needs: { db }
 └───────────────┘              └───────────────┘
   boots 1st, disposes last       boots 2nd, disposes 1st
```

## Why we chose this

- **Handles, not strings.** A need points at the provider's handle
  (`database.provides.db`). A typo cannot compile, and "go to definition"
  lands on the factory.
- **Types are written once.** The factory's return type is the service type.
  Nothing restates it, so nothing drifts.
- **Declaration order is boot order.** The order you read is the order that
  runs. A sorted graph would be cleverer; it would also surprise you at 2 a.m.

## What is a unit?

A **unit** is the unit a DOT app is built from — one self-describing,
lifecycle-aware piece of an application. Each unit:

- declares a **name** and the services it **needs** as a shape
  of type witnesses;
- **provides** services through `provides`: one factory per key — the type
  is _inferred from the factory_, never declared separately;
- runs a **5-hook lifecycle** — `configure` → `boot` → `start` → `stop` → `dispose`;
- **publishes typed services** to a shared, type-safe registry that later
  units can read from;
- **composes deterministically** — units boot in declaration order and
  dispose in reverse.

The name comes from the small dots on dice, dominoes, and music notation:
each unit is one small mark, and the _combination_ of units is what gives the
app its value. Two units on a die make a value of two; six units make six. The
units **are** the app — not optional add-ons to a hidden core.

```ts skip="uses the env, db and kv adapters from other @arki packages; they depend on @arki/dot"
import { db } from '@arki/db/dot'; // db unit
import { defineApp } from '@arki/dot';
import { env } from '@arki/dot/env'; // env unit

import { kv } from '@arki/kv/dot'; // kv unit

const app = await defineApp('orders')
  .infra(
    env({ schema: {/* ... */} }), // 1st unit — provides services.env
    db({ relations }), // 2nd unit — provides services.db
    kv(() => ({ url: process.env.KV_URL })), // 3rd — services.kv; env read at boot, not import
  )
  .boot(); // units boot in declaration order

await app.services.db.query(/* ... */);
await app.dispose(); // units dispose in REVERSE order
```

Each `/dot` subpath exports a **unit** for that package. The subpath names
the framework the adapter targets (DOT), not the unit (which is a unit).

## Needs are witnesses, provides are inferred

When the host can import the provider, name its handle (see
[Unit handles](#unit-handles)). `service<T>()` is for the other cases: a
library contract, a test, or a host external. It creates a phantom **type witness** — a runtime no-op that
carries `T` at the type level. The property name you give it is your local
alias _and_ (for anonymous witnesses) the wire key:

```ts
import { infra, service } from '@arki/dot';

type Db = { query(sql: string): Promise<unknown[]> };
type Logger = { info(message: string): void };
type SearchIndex = { flush(db: Db): Promise<void> };
declare function buildIndex(db: Db): Promise<SearchIndex>; // your code

export const search = infra({
  name: 'search',
  needs: {
    db: service<Db>(), // wire key 'db', local alias 'db'
    log: service<Logger>(), // wire key 'log'
  },
  provides: {
    search: async ({ db, log, $app }) => {
      // $app/$unit/$config: kernel context
      log.info(`indexing for ${$app}`);
      return buildIndex(db);
    },
  },
});
```

`boot`, `start`, `stop`, and `dispose` additionally receive the unit's **own
provides** — and because teardown runs in reverse declaration order, a unit's
needs are still alive in its `dispose`:

```ts continue
export const indexer = infra({
  name: 'indexer',
  needs: { db: service<Db>() },
  provides: { search: ({ db }) => buildIndex(db) },
  async dispose({ search, db }) {
    // own provide + still-live need
    await search.flush(db);
  },
});
```

## Wrong wiring does not compile

Declaration order IS boot order. The mount guard makes unsatisfied needs,
type mismatches, and key collisions **compile errors at the call site**:

```ts skip="shows wiring that must not compile"
defineApp('shop')
  .infra(billing) // ❌ the argument is refused: "Property 'DOT: this unit needs services that nothing before it provides…' is missing"
  .infra(database); //    billing's `db` need has no earlier provider

defineApp('shop').infra(database).infra(database2); // ❌ collision: two providers of wire key 'db'
```

Reordering the first example — or `rename`-ing one provider in the second —
makes both compile. The kernel re-validates at runtime with coded errors
(`E012` unsatisfied need, `E013` collision, `E014` reserved key) for
erased/dynamic composition, with full rollback of already-booted units.
`E012` now fires only for needs that no unit declares (erased or JS graphs,
dynamic http bundle tokens). Order mistakes between units that declare their
provides are caught earlier, at `configure()`: see below.

There is no dependency graph to debug and **cycles are unrepresentable**:
services flow strictly forward through the `.infra()`, `.features()` and `.entrypoints()` chain. If two units need
each other's services, that's a design smell the type system surfaces
immediately — merge them, or extract the shared piece into a third unit both
consume.

## Features as a chain: `defineFeature`

A feature is one chain; each step has its folder (`model/` has no step).
Each step's type offers only the later steps, and each step's input is typed
from the earlier ones (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`).

```ts skip="the app wiring uses log(config), schedule() and a gateway from other @arki packages; the oRPC example below compiles the same chain"
import type { DepsOf } from '@arki/dot/feature';
import { defineApp } from '@arki/dot';
import { defineFeature, routerFor } from '@arki/dot/feature';

const dailyDigestDeps = defineFeature('daily-digest')
  .needs({ plans: billing.provides.entitlements }) // other units, by handle
  .infra(store, mailer); // infra/: private units — published as `daily-digest.store`
export type Deps = DepsOf<typeof dailyDigestDeps>; // what a usecase may ask for, written once

const dailyDigestLogic = dailyDigestDeps.usecases({ preview, sendDue }); // usecases/: one file per usecase

export const dailyDigest = dailyDigestLogic
  .provides({ digests: ({ usecases }) => ({ previewFor: usecases.preview }) }) // public handles
  .entrypoints(rpc(digestRpcContract, rpcImplementer, digestProcedures), digestSchedules(dailyDigestLogic)); // entrypoints/

export const app = defineApp('shop')
  .infra(log(config), database, billing) // what the app runs on, in boot order (log first)
  .features([dailyDigest])
  .entrypoints(gateway, schedule({ clock: 'host' }));

// Mount keys are written once, in the app's RPC contract; each feature is found by contract.
const router = routerFor({ digest: digestRpcContract }, [dailyDigest]);
```

- **Private infra.** `.infra(store)` compiles to the unit `daily-digest/store`
  providing `daily-digest.store`; a sibling unit that needs `store` is
  rewired to the qualified key. Two features may each have a `store`.
- **Usecases.** One factory per usecase, one file each:
  `usecases/preview.ts` exports `preview = (deps: Pick<Deps, 'store' | 'plans'>) => …`,
  with `import type { Deps } from '../feature'`. A factory asks only for what
  it uses, so a unit test passes two fakes and boots nothing. An inline
  factory needs no annotation: `({ store }) => …` gets the deps type. A factory that
  asks for a dep the feature lacks is a compile error naming it
  (`'DOT: a usecase asks for a dep the feature does not provide': { sendDue: 'mailer' }`).
  Built once per boot and handed to every `provides` factory and entrypoint.
  A helper that is not a usecase (a mail template, a sender) is a plain
  function its usecases call; it is not listed in `.usecases()`. `dailyDigestLogic.handles` (needs + infra +
  `usecases`) is what a request middleware resolves from the services bag
  (`resolveNeeds(bag, dailyDigestLogic.handles)`): the handler sees `context.usecases`,
  `context.store`, `context.plans`, and not `context.db`.
- **Entrypoints** are descriptors `{ kind, key, actions, resolve }` built by
  adapter packages; `resolve` gets needs + infra + usecases, its payload is
  published under `feature.<name>` (read with `sliceOf`), and `actions` are
  in the manifest before boot. An entrypoint file types its handlers with
  `DepsOf<typeof dailyDigestLogic>`.
- **Collisions are compile errors**: steps out of order; `session`,
  `headers`, `services`, `usecases` as aliases or keys; an infra key equal to a
  need alias; an entrypoint key equal to a provided key. Erased callers get
  `ARKI_DOT_E027`.
- **Tests**: `dailyDigest.override({ store: fakeStore })` rebuilds the store
  unit in place (its sibling services keep their factories) and keeps the
  entrypoints — one provider per key.
- **Kernel units**: `dailyDigest.units()` is a typed tuple
  `[daily-digest/store, daily-digest/mailer, daily-digest]`, so
  `.infra(...dailyDigest.units())` and `.features([dailyDigest])` are checked
  by the builder guard. `dot explain` shows
  `daily-digest --[daily-digest.store]--> daily-digest/store --[db]--> database`.

Adapter authors: `entrypoint.fromFeatures` and `infra.fromFeatures` units receive the features as mounted
(`MountedFeature`). Read a feature's declarations with
`entrypointsOf(f)` (its `entrypoints`), its slice
record with `sliceOf(ctx, f)`, and a chain feature's own units with
`f.units()`.

### oRPC, contract first: `@arki/dot/orpc`

`@orpc/server` is an optional peer; only this subpath loads it.

```ts
import { oc } from '@orpc/contract';
import { implement, ORPCError, os } from '@orpc/server';
import { z } from 'zod';

import type { DepsOf, ServicesBag } from '@arki/dot/feature';
import { infra } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { needsMiddleware, rpc } from '@arki/dot/orpc';
import { orThrow } from '@arki/failure';

// core/orpc.ts — once per app
type Session = { readonly user: { readonly id: string } };
export type RequestContext = { session: Session | null; headers: Headers; services: ServicesBag };
export const bind = needsMiddleware<RequestContext>();
export const authed = os.$context<RequestContext>().middleware(({ context, next }) => {
  if (!context.session) throw new ORPCError('UNAUTHORIZED');
  return next({ context: { session: context.session } });
});

// features/daily-digest/entrypoints/rpc.ts — browser-safe: oRPC contract and zod only
export const digestRpcContract = oc.router({
  preview: oc.output(z.array(z.string())),
  admin: { purge: oc.output(z.number()) },
});

// infra/ and usecases/, cut short
export const billing = defineFeature('billing')
  .provides({ entitlements: () => ({ capFor: (userId: string) => (userId === 'u1' ? 25 : 3) }) })
  .entrypoints();
export const store = infra({
  name: 'store',
  provides: { store: () => ({ itemsFor: async (userId: string) => [`${userId}:welcome`], purge: async () => 0 }) },
});
export const preview =
  ({ store, plans }: Pick<Deps, 'store' | 'plans'>) =>
  async (userId: string) =>
    (await store.itemsFor(userId)).slice(0, plans.capFor(userId));
export const purge =
  ({ store }: Pick<Deps, 'store'>) =>
  () =>
    store.purge();

// features/daily-digest/feature.ts — the chain stays in one file, the one map of the feature
const dailyDigestDeps = defineFeature('daily-digest').needs({ plans: billing.provides.entitlements }).infra(store);
export type Deps = DepsOf<typeof dailyDigestDeps>;
export const dailyDigestLogic = dailyDigestDeps.usecases({ preview, purge });
export const rpcImplementer = implement(digestRpcContract).$context<RequestContext>().use(bind(dailyDigestLogic));

// This example uses an exception boundary at RPC handlers; usecases keep typed outcomes.
// features/daily-digest/entrypoints/procedures.ts — the whole tree. In its own file it
// reads the implementer as a type only (`import type { rpcImplementer } from '../feature'`),
// so there is no runtime import back.
export const digestProcedures = {
  preview: (impl: typeof rpcImplementer) =>
    impl.preview
      .use(authed)
      .handler(async ({ context }) => orThrow(await context.usecases.preview(context.session.user.id))),
  admin: {
    purge: (impl: typeof rpcImplementer) =>
      impl.admin.purge.handler(async ({ context }) => orThrow(await context.usecases.purge())),
  },
};

// back in feature.ts
export const dailyDigest = dailyDigestLogic.entrypoints(rpc(digestRpcContract, rpcImplementer, digestProcedures));
```

- **`bind(dailyDigestLogic)`** puts the feature's needs, private infra and `usecases` on the
  handler context, read from `context.services` by handle. The request context
  holds request data only; what a handler may touch is declared once, in the
  chain, where `dot explain` sees it. `context.db` does not compile when only
  the store needs `db`. An alias equal to a request-context key does not
  compile either; a handle missing from the bag throws `ARKI_DOT_E026`, naming
  the alias.
- **`rpc(contract, implementer, factories)`** builds the router from one factory per
  procedure. The factories object is shaped like the contract — a group
  (`admin.purge`) is a nested object in the same file. Keys
  match the contract exactly: an extra key is
  `'DOT: a procedure key is not in the contract'`, a missing key or a
  procedure that does not implement its key (another schema, a bare `os`
  procedure) does not compile either. The contract stays the one list of
  names. The whole tree lives in one `entrypoints/procedures.ts` exporting
  `<feature>Procedures`: one place to read the feature's RPC surface. Every
  procedure calls a usecase and never reads `context.repos`. A usecase need not have a procedure (a cron,
  a webhook or a `provides` handle may call it), and a procedure need not
  have a usecase. `dailyDigest.contract` and `.router` come from it, for
  `routerFor`.
- **Every procedure is a manifest action.** `rpc()` reads the contract and
  adds one action per procedure (binding `rpc`, id `<feature>.<path>`, so two
  features may both have `list`). The address is the HTTP route when the
  contract declares one (`GET /stories`), else the procedure path; the meta
  holds the route, tags, declared errors and the contract `meta` — the place
  to declare a policy (`oc.$meta<{ auth: 'admin' }>({})`), which `dot explain`
  then shows without booting. Meta that is not plain JSON fails at `rpc()`
  (`ARKI_DOT_E031`).
- **Procedures are factories over `rpcImplementer`.** `typeof rpcImplementer` depends on the logic stage,
  never on the finished feature, so there is no type cycle; `import type` is
  erased, so there is no module cycle (otherwise: `ReferenceError` at import,
  the kind of cycle no amount of coffee fixes).

### Error capture: `errorCaptureMiddleware`

One middleware in front of the app router sends a procedure's unexpected
failures to your error tracker, so no procedure needs its own try/catch:

```ts
import { oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { z } from 'zod';

import { errorCaptureMiddleware } from '@arki/dot/orpc';

// Stand-ins for your tracker's capture call, your contract and your request context.
const captured: unknown[] = [];
const captureException = (error: unknown, context: { tags: Record<string, string> }) => {
  captured.push({ error, context });
};
const rpcContract = { ping: oc.output(z.string()) };
type RequestContext = { readonly requestId: string };

// core/orpc.ts — once per app
export const errorCapture = errorCaptureMiddleware({
  report: (error, { path }) => captureException(error, { tags: { procedure: path.join('.') } }),
});

// router.ts
const os = implement(rpcContract).$context<RequestContext>().use(errorCapture);
export const router = os.router({ ping: os.ping.handler(() => 'pong') });
```

Every error is rethrown unchanged: capture never changes the response. An
`ORPCError` below 500 (`UNAUTHORIZED`, `BAD_REQUEST`, …) is normal traffic and
is not reported. `report` runs synchronously; if it throws, that is logged at
warn on `arki:dot:orpc` and the caller still gets the procedure's own error.

### Spans for every usecase

Each usecase call runs in an OpenTelemetry span named
`feature.<feature>.<usecase>` (`feature.daily-digest.preview`). You write no
tracing code, and the usecase types do not change.

- **Returns a failure** (an `@arki/failure` value, directly or through a
  promise): status ERROR, with the attributes `failure.code` and
  `failure.status`. No exception is recorded — a failure is an expected
  outcome, not a bug.
- **Throws or rejects:** the exception is recorded, status ERROR, and the
  same value is rethrown.
- **Anything else:** status OK.

The span is active while the usecase runs, so spans it starts (a database
query, an HTTP call) nest under it. An async usecase ends its span when its
promise settles. With no OpenTelemetry SDK registered, the call goes straight
through: same `this`, same arguments, the very same return value.

`rpc()` adds no span of its own: oRPC already has one per procedure
(`call_procedure`, with `procedure.path`). Register `ORPCInstrumentation`
from `@orpc/otel` with your SDK to turn it on; the usecase spans then nest
under it.

## Features and the hexagon

Domain modules are `defineFeature` values from `@arki/dot/feature`. A feature is
inert data until the app boots it: its entrypoints (`jobs()`, `schedules()`,
`endpoints()`) say what the feature hands its adapters.

```ts skip="uses jobs() from @arki/queue, which depends on @arki/dot"
import { defineFeature } from '@arki/dot/feature';
import { rpc } from '@arki/dot/orpc';

export const orders = defineFeature('orders')
  .needs({ db: service<Db>() })
  .infra(store) // repos({ orders: createOrdersRepository }) from @arki/db/dot
  .provides({ ordersIndex: ({ db }) => openIndex(db) })
  .entrypoints(rpc(ordersRpcContract, ordersImplementer, ordersProcedures), jobs({ syncOrders }));
```

The app wires its units in three steps — the hexagon of ports and adapters:

```ts skip="mounts adapters from @arki/db, @arki/queue and @arki/http, which depend on @arki/dot"
defineApp('shop')
  .infra(db({ relations })) // infra: what features need
  .infra(queue({ connection }))
  .features([orders, billing]) // the domain
  .entrypoints(http({ port: 3000 }), queueWorker({ q, needs: {}, context })); // what calls the features
```

The order is a compile error, not a convention: `.infra()` is closed after
`.features()` (infrastructure never depends on the domain), a feature is not a
plain unit, and an entrypoint unit (`entrypoint(...)`) cannot sit in `.infra()`. Entrypoint
units are bound to the mounted features — `http()` serves every feature's
routes without being told the list. `dot explain --graph` draws the three
groups (`infra · what features need`, features, `entrypoints · what calls the features`),
numbered in boot order.

A feature depends on a capability another feature provides, not on the whole
feature. A feature publishes through `provides`: one factory per capability,
each receiving the feature's needs. Consumers name the capability by handle —
the type comes from the provider's factory, so it is written once:

```ts
import { defineApp, infra } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';

// Stand-ins for your own modules.
type Db = { query(sql: string): Promise<unknown[]> };
type Entitlements = { planOf(userId: string): Promise<string> };
declare function openDb(): Db;
declare function createEntitlements(db: Db): Entitlements;
declare function createDigest(access: Entitlements): { previewFor(userId: string): Promise<string[]> };
const database = infra({ name: 'database', provides: { db: () => openDb() } });

export const billing = defineFeature('billing')
  .needs({ db: database.provides.db })
  .provides({ entitlements: ({ db }) => createEntitlements(db) })
  .entrypoints();

export const digest = defineFeature('daily-digest')
  .needs({ access: billing.provides.entitlements }) // typed from createEntitlements
  .provides({ digest: ({ access }) => createDigest(access) })
  .entrypoints();

export const app = defineApp('app').infra(database).features([billing, digest]); // provider first: boot order
```

`billing.provides.entitlements` is an ordinary token on the `entitlements` wire
key, stamped with `provider: 'billing'`. The keys are static, so the graph is
data before anything boots:

- mounting `digest` before `billing` is a compile error, and `configure()`
  returns `UnexpectedDefect` with `ARKI_DOT_E020` metadata naming both positions for code that skips types.
  The fix line is role-aware: "Move X before Y in .features([...])." for a
  feature provider, "Mount X with .infra() before Y." for any other unit;
- two features that need each other form a ring: TypeScript reports `TS7022`
  on both `defineFeature()` consts (read the two files it names), and `configure()`
  returns `UnexpectedDefect` with `ARKI_DOT_E019` ring metadata (through any units) for
  erased graphs;
- `dot explain` draws one labelled edge per capability, such as
  `daily-digest --[entitlements]--> billing`, without booting.
  A feature's slice record (`feature.<name>`) is one of its unit's provides.

A `provides` factory builds a service value. Side effects (seed, warm-up) belong in a unit's `boot`, which returns `undefined`, a concrete failure or an ownership plan.

### Capabilities in the request context

A feature's own procedures use `bind(featureLogic)` once per feature (see
[oRPC, contract first](#orpc-contract-first-arkidotorpc)). The bag below is for
the gateway and for a procedure that reads another feature's capability.

A request context cannot name the merged service type — the routers that read
the context are part of it, so the type loops. The context carries an opaque
`ServicesBag` instead, and each procedure narrows it with its feature's own
`needs`. A gateway feature, mounted last, spreads every handle into its needs
(so the builder proves every provider boots first) and builds the bag:

```ts
import { os } from '@orpc/server';

import type { NeedsShape } from '@arki/dot';
import type { ServicesBag } from '@arki/dot/feature';
import { service } from '@arki/dot';
import { defineFeature, providesOf, resolveNeeds, servicesOf } from '@arki/dot/feature';

// Stand-ins for your own modules.
type Db = { query(sql: string): Promise<unknown[]> };
type Entitlements = { planOf(userId: string): Promise<string> };
declare function createEntitlements(): Entitlements;
declare function ingest(entitlements: Entitlements): Promise<void>;
export const billing = defineFeature('billing')
  .provides({ entitlements: () => createEntitlements() })
  .entrypoints();
const features = [billing] as const;

export const gateway = defineFeature('gateway')
  .needs({ db: service<Db>(), ...providesOf(features) })
  .provides({
    rpc: ctx => ({
      context: (headers: Headers) => ({ headers, db: ctx.db, services: servicesOf(ctx, features) }),
    }),
  })
  .entrypoints();

// core/orpc.ts — the one app-side middleware
const o = os.$context<{ services: ServicesBag }>();
export const needs = <N extends NeedsShape>(n: N) =>
  o.middleware(({ context, next }) => next({ context: { services: resolveNeeds(context.services, n) } }));

// a procedure names the handles it uses, inline — typed from the provider
export const ingestUrl = o
  .use(needs({ entitlements: billing.provides.entitlements }))
  .handler(({ context }) => ingest(context.services.entitlements));
```

`resolveNeeds` keeps only handles (infra services such as `db` stay on the
context explicitly) and throws `ARKI_DOT_E026` naming the alias, key and
provider when a capability is missing from the bag.

## Unit handles

Every unit has typed handles before it boots. `database.provides.db` is a
`Handle<T, 'db'>`: a token on the wire key `db`, plus `.provider` (the unit
name) and `.lazy`. The kernel checks every unit's needs against every
unit's static provides at `configure()`.

```ts
import type { Provided } from '@arki/dot';
import { infra } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';

// Stand-ins for your own clients; with @arki/db this is `db({ relations, url: () => env.DB_URL })`.
type Pg = { query(sql: string): Promise<unknown[]> };
type Kv = { get(key: string): Promise<string | null> };
declare function connectPg(url: string): Pg;
declare function connectKv(): Kv;
declare function makeReports(db: Db): { daily(): Promise<unknown[]> };

export const database = infra({ name: 'database', provides: { db: () => connectPg('postgres://localhost/app') } });
export const cache = infra({ name: 'cache', provides: { kv: () => connectKv() } });
export type Db = Provided<typeof database.provides.db>; // the one alias an app names

export const reports = defineFeature('reports')
  .needs({
    db: database.provides.db, // typed from the provider
    cache: cache.provides.kv.lazy, // a Lazy<T>, even if the provider is eager
  })
  .provides({ reports: ({ db }) => makeReports(db) })
  .entrypoints();
```

Use `service<T>()` when you cannot import the provider: a library contract, a
test, or a host external. `providesOf([...])` takes units as well as features:
`providesOf([database, cache, ...features])`. `provide(token, value)` is only a
record helper; in examples prefer `provides: { [Token.key]: () => value }`.

In tests, `fake(handle, value)` from `@arki/dot/test-harness` is a unit named
`fake:<key>` that provides `value` under the handle's wire key, type-checked
against the handle:

```ts continue
import { defineApp } from '@arki/dot';
import { fake } from '@arki/dot/test-harness';
import { isFailure } from '@arki/failure';

const testDb: Db = { query: async () => [] };
const app = await defineApp('t')
  .infra(fake(database.provides.db, testDb))
  .infra(fake(cache.provides.kv, { get: async () => null }))
  .features([reports])
  .boot();
if (isFailure(app)) throw new Error(app.code);
await app.dispose();
```

## Tokens — cross-package service contracts

An anonymous `service<T>()` couples consumer and provider by property name.
When a contract spans packages, a **token** owns the wire key and the local
alias becomes free choice:

```ts
import { infra, token } from '@arki/dot';

type PgDatabase = { execute(sql: string): Promise<unknown[]> };
declare function connect(): PgDatabase; // your code

// The package that owns the contract exports the token:
export const Db = token<PgDatabase>()('arki.db');

// A provider publishes under the token's key:
export const database = infra({
  name: 'database',
  provides: { [Db.key]: () => connect() }, // → { 'arki.db': PgDatabase }
});

// Any consumer, any package, any local alias:
export const healthCheck = infra({
  name: 'health-check',
  needs: { warehouse: Db }, // wire key 'arki.db', alias yours
  boot: async ({ warehouse }) => {
    await warehouse.execute('select 1'); // typed as PgDatabase
  },
});
```

## Multi-instance with `rename`

Mounting an adapter twice would collide on its wire keys — loudly, at
compile time. `rename` is the multi-instance primitive, and
`Token.instance()` derives the matching contract:

```ts
import { defineApp, infra, rename, token } from '@arki/dot';
import { isFailure } from '@arki/failure';

type PgDatabase = { execute(sql: string): Promise<unknown[]> };
declare function connect(url: string): PgDatabase; // your code
const Db = token<PgDatabase>()('arki.db');
const database = ({ url }: { url: string }) => infra({ name: 'database', provides: { [Db.key]: () => connect(url) } });
const PRIMARY_URL = 'postgres://primary/shop';
const REPLICA_URL = 'postgres://replica/shop';

const ReportsDb = Db.instance('reports'); // token for key 'arki.db#reports'

const app = await defineApp('shop')
  .infra(database({ url: PRIMARY_URL }))
  .infra(
    rename(
      database({ url: REPLICA_URL }),
      { 'arki.db': ReportsDb.key }, // republish under the derived key
      'reports-db', // distinct unit name
    ),
  )
  .infra(
    infra({
      name: 'db-probe',
      needs: { primary: Db, replica: ReportsDb },
      boot: async ({ primary, replica }) => {
        await Promise.all([primary.execute('select 1'), replica.execute('select 1')]); // two live instances, both typed
      },
    }),
  )
  .boot();
if (isFailure(app)) throw new Error(app.code);
await app.dispose();
```

Renames compose left-to-right and are applied at publish time — collision
checks see the final keys. `rename` also rebuilds the handles: with
`const reportsDb = rename(database, { db: 'reportsDb' }, 'reports-db')`, consumers
use `reportsDb.provides.reportsDb`. A handle taken before the rename keeps the
old key and fails the builder guard.

## Two copies of a feature: `instance`

`rename` is for units. A _feature_ is mounted twice with `instance`:
`reports.instance('eu', { db: databaseEu.provides.dbEu })` is a second copy named
`reports#eu` — its own infra units (`reports#eu/store`), usecases, services and
entrypoints, publishing under `reports#eu.<key>`, so the copy mounts next to the
original or next to another copy. The `rebind` record swaps a need's handle for
another provider's handle of the same service type. A nested child is re-derived
under the copy (`reports#eu.audit`), and a child need on the same handle follows,
lazy form included.

```ts
import { defineApp, infra, rename, service } from '@arki/dot';
import { defineFeature, routerFor } from '@arki/dot/feature';
import { rpc } from '@arki/dot/orpc';
import { isFailure } from '@arki/failure';

type Region = { readonly region: string };
const regionDb = (region: string) => infra({ name: 'database', provides: { db: (): Region => ({ region }) } });
const database = regionDb('us');
const databaseEu = rename(regionDb('eu'), { db: 'dbEu' }, 'database-eu');

const store = infra({
  name: 'store',
  needs: { db: service<Region>() },
  provides: { repos: ({ db }) => ({ region: () => db.region }) },
});
const reports = defineFeature('reports')
  .needs({ db: database.provides.db })
  .infra(store)
  .usecases({
    region:
      ({ repos }) =>
      () =>
        repos.region(),
  })
  .provides({ summary: ({ usecases }) => ({ region: usecases.region() }) })
  .entrypoints(rpc({}, {}, {}));

const eu = reports.instance('eu', { db: databaseEu.provides.dbEu }); // `reports#eu`, on the EU database
const us = reports.instance('us'); // `reports#us`, on the primary

const app = await defineApp('shop').infra(database).infra(databaseEu).features([eu, us]).boot();
if (isFailure(app)) throw new Error(app.code);
app.services['reports#eu.summary'].region; // 'eu'
app.services['reports#us.summary'].region; // 'us'
routerFor({ eu: eu.contract, us: us.contract }, [eu, us]); // each copy has its own contract identity
await app.dispose();
```

Each copy's `rpc` entrypoint has its own contract identity, so the app contract
mounts `eu.contract` and `us.contract` under their own keys. Adapters register a
copy's schedules, jobs, routes and effects under instance-qualified names
(`send-digest#eu`, `/eu/...`); a plain feature's names never change. `#` is
reserved: define the feature without it and call `.instance()`.

## Lazy services

`lazy(init, { dispose })` publishes a **handle** instead of an open
resource. Initialization runs on first `get()` (memoized, single-flight;
failed attempts retry). Never-touched handles never initialize — and the
kernel auto-disposes initialized ones during teardown, _after_ the
publishing unit's own `dispose` hook, even if that unit has none:

```ts
import { infra, lazy, service } from '@arki/dot';

type SearchClient = { query(text: string): Promise<string[]>; close(): Promise<void> };
declare function connectToElastic(): Promise<SearchClient>; // your code

export const search = infra({
  name: 'search',
  provides: {
    search: () =>
      lazy(() => connectToElastic(), {
        dispose: client => client.close(),
      }),
  },
});
```

Consumers that shouldn't care whether a provider is eager or lazy declare a
**lifting witness** — `service.lazy<T>()` always delivers a `Lazy<T>`
handle, wrapping eager provides and passing lazy ones through by identity:

```ts continue
import { isFailure } from '@arki/failure';

export const searchWarmer = infra({
  name: 'search-warmer',
  needs: { search: service.lazy<SearchClient>() },
  async boot({ search }) {
    const client = await search.get(); // first access initializes
    if (isFailure(client)) return client;
    await client.query('warm-up');
    return;
  },
});
```

Swapping the search provider between eager and lazy is invisible to every
consumer — the wiring guard accepts both shapes against the same witness.

## Kernel context — the reserved `$` namespace

Every service-carrying hook context includes `$app` (app name), `$unit` (unit
name), `$config` (the `defineApp(name, { config })` bag), and `$signal`: one
`AbortSignal` per hook call that aborts when the hook exceeds `hookTimeoutMs`,
with the `ARKI_DOT_E015` error as its reason. Pass it to the hook's I/O
(`connect`, `fetch`, `sleep`) so a hung hook stops instead of running on after
the kernel gave up on it. The `$` prefix
is enforced as reserved: `infra()` rejects `$`-prefixed needs aliases and
publish keys at compile time, and the kernel re-validates at runtime
(`ARKI_DOT_E014`) — kernel keys can never be shadowed.

## Hooks at a glance

`infra(config)` accepts a `needs` shape plus five lifecycle hooks. Hook
contexts carry the needed services (typed, under your local aliases) and
`$`-prefixed kernel keys (`$app`, `$unit`, `$config`, `$signal`):

| Hook        | Purpose                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `configure` | Validate static config; declare schemas, routes, services. No I/O.           |
| `boot`      | Side effects only (seed, warm-up). Returns nothing. Values go in `provides`. |
| `start`     | Begin processing (workers, subscribers, schedulers).                         |
| `stop`      | Stop processing in reverse declaration order.                                |
| `dispose`   | Free resources after `stop`; lazy handles auto-clean afterwards.             |

Wiring is compile-time checked: a mount call fails to typecheck when the
unit's needs aren't satisfied by earlier units, or when its
provides collide with an existing wire key. `rename(unit, { db: 'reportsDb' })`
mounts a second instance of an adapter without collision; `token<T>()('key')`
shares a service contract across packages; `lazy(() => open(), { dispose })`
defers an expensive open until first `get()` — never-touched services never
initialize, and the kernel auto-disposes initialized ones. Declaration
order is boot order — same input, same order, every time.
