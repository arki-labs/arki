# @arki/dot

> TypeScript-first application composition framework for the ARKI package family.

`@arki/dot` is the kernel that wires **plugins**, lifecycle hooks, dependency
injection, and diagnostics into a deterministic application boot. It gives
library authors a stable contract for declaring how their package
participates in an app, and gives app developers a single place to wire
those packages together — with the type checker verifying the wiring before
anything runs.

## What is a plugin?

A **plugin** is the unit a DOT app is built from — one self-describing,
lifecycle-aware piece of an application. Each plugin:

- declares a **name**, **version**, and the services it **needs** as a shape
  of type witnesses;
- **provides** services through `provides`: one factory per key — the type
  is *inferred from the factory*, never declared separately;
- runs a **5-hook lifecycle** — `configure` → `boot` → `start` → `stop` → `dispose`;
- **publishes typed services** to a shared, type-safe registry that later
  plugins can read from;
- **composes deterministically** — plugins boot in declaration order and
  dispose in reverse.

The name comes from the small dots on dice, dominoes, and music notation:
each plugin is one small mark, and the *combination* of plugins is what gives the
app its value. Two plugins on a die make a value of two; six plugins make six. The
plugins **are** the app — not optional add-ons to a hidden core.

```ts skip="uses the env, db and kv adapters from other @arki packages; they depend on @arki/dot"
import { defineApp } from '@arki/dot';
import { env } from '@arki/env/dot';      // env plugin
import { db } from '@arki/db/dot';        // db plugin
import { kv } from '@arki/kv/dot';        // kv plugin

const app = await defineApp('orders')
  .use(env({ schema: { /* ... */ } }))     // 1st plugin — provides services.env
  .use(db({ relations }))                  // 2nd plugin — provides services.db
  .use(kv(() => ({ url: process.env.KV_URL }))) // 3rd — services.kv; env read at boot, not import
  .boot();                                  // plugins boot in declaration order

await app.services.db.query(/* ... */);
await app.dispose();                       // plugins dispose in REVERSE order
```

Each `/dot` subpath exports a **plugin** for that package. The subpath names
the framework the adapter targets (DOT), not the unit (which is a plugin).

> **Why not "plugin"?** Plugins suggest *optional add-ons* to a core. DOT's
> reality is the opposite: there is no hidden core — the plugins *are* the app.
> "Plugin" names that truth, and ties the framework to the DOT name etymologically
> (a dot, a plugin, a small mark that gains meaning by combining with others).

## Installation

```bash
npm install @arki/dot
# or
bun add @arki/dot
```

## Quick start

```ts run
import { defineApp, plugin } from '@arki/dot';

// Stand-ins for your real database and Stripe clients.
type Db = { query(sql: string): Promise<unknown[]>; close(): Promise<void> };
const openDb = async (url = 'memory://'): Promise<Db> => ({ query: async sql => [url, sql], close: async () => {} });
const makeStripeClient = (db: Db) => ({ charge: (cents: number) => db.query(`charge ${cents}`) });

const dbPlugin = plugin({
  name: 'database',
  provides: {
    db: () => openDb(process.env.DATABASE_URL), // ← one factory per key; may be async
  },
  async dispose({ db }) {
    await db.close();
  },
});

const billingPlugin = plugin({
  name: 'billing',
  version: '1.0.0',
  needs: { db: dbPlugin.provides.db }, // typed handle — destructure in hooks
  configure(ctx) {
    // Validate config, register schemas, no I/O.
    ctx.registerService('stripe', 'custom');
  },
  provides: {
    stripe: ({ db }) => makeStripeClient(db), // factories see the needs
  },
  async boot({ stripe }) {
    await stripe.charge(0); // side effects only (seed, warm-up). Returns nothing.
  },
  async start({ stripe }) {
    await stripe.charge(0); // begin processing — workers, subscriptions, schedulers.
  },
  async stop({ db }) {
    await db.query('select 1'); // stop processing — drain workers, unsubscribe.
  },
});

const app = await defineApp('acme')
  .use(dbPlugin)          // providers before consumers — enforced at compile time
  .use(billingPlugin)
  .start();

// app.manifest, app.diagnostics — agent-friendly envelopes.
const order = app.manifest.plugins.map(p => p.name).join(' → ');
if (order !== 'database → billing') throw new Error(`plugins boot in declaration order, got ${order}`);

await app.stop();
await app.dispose();
```

There is no registry to configure, no decorators, no reflection. The `needs`
shape is the injection contract; the `provides` factories are the provision
contract; the builder's type-level guard connects the two.

## Dependency injection

### Needs are witnesses, provides are inferred

When the host can import the provider, name its handle (see
[Plugin handles](#plugin-handles)). `service<T>()` is for the other cases: a
library contract, a test, or a host external. It creates a phantom **type witness** — a runtime no-op that
carries `T` at the type level. The property name you give it is your local
alias *and* (for anonymous witnesses) the wire key:

```ts
import { plugin, service } from '@arki/dot';

type Db = { query(sql: string): Promise<unknown[]> };
type Logger = { info(message: string): void };
type SearchIndex = { flush(db: Db): Promise<void> };
declare function buildIndex(db: Db): Promise<SearchIndex>; // your code

export const search = plugin({
  name: 'search',
  needs: {
    db: service<Db>(),                 // wire key 'db', local alias 'db'
    log: service<Logger>(),            // wire key 'log'
  },
  provides: {
    search: async ({ db, log, $app }) => { // $app/$plugin/$config: kernel context
      log.info(`indexing for ${$app}`);
      return buildIndex(db);
    },
  },
});
```

`boot`, `start`, `stop`, and `dispose` additionally receive the plugin's **own
provides** — and because teardown runs in reverse declaration order, a plugin's
needs are still alive in its `dispose`:

```ts continue
export const indexer = plugin({
  name: 'indexer',
  needs: { db: service<Db>() },
  provides: { search: ({ db }) => buildIndex(db) },
  async dispose({ search, db }) {      // own provide + still-live need
    await search.flush(db);
  },
});
```

### Wrong wiring does not compile

Declaration order IS boot order. The `.use()` guard makes unsatisfied needs,
type mismatches, and key collisions **compile errors at the call site**:

```ts skip="shows wiring that must not compile"
defineApp('shop')
  .use(billing)      // ❌ "Expected 2 arguments, but got 1."
  .use(database);    //    billing's `db` need has no earlier provider

defineApp('shop')
  .use(database)
  .use(database2);   // ❌ collision: two providers of wire key 'db'
```

Reordering the first example — or `rename`-ing one provider in the second —
makes both compile. The kernel re-validates at runtime with coded errors
(`E012` unsatisfied need, `E013` collision, `E014` reserved key) for
erased/dynamic composition, with full rollback of already-booted plugins.
`E012` now fires only for needs that no plugin declares (erased or JS graphs,
dynamic http bundle tokens). Order mistakes between plugins that declare their
provides are caught earlier, at `configure()`: see below.

There is no dependency graph to debug and **cycles are unrepresentable**:
services flow strictly forward through the `.use()` chain. If two plugins need
each other's services, that's a design smell the type system surfaces
immediately — merge them, or extract the shared piece into a third plugin both
consume.

### Features as a chain: `defineFeature`

A feature is one chain; each step has its folder (`model/` has no step).
Each step's type offers only the later steps, and each step's input is typed
from the earlier ones (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`).

```ts skip="the app wiring uses log(config), schedule() and a gateway from other @arki packages; the oRPC example below compiles the same chain"
import { defineApp } from '@arki/dot';
import type { DepsOf } from '@arki/dot/feature';
import { defineFeature, routerFor } from '@arki/dot/feature';

const dailyDigestDeps = defineFeature('daily-digest')
  .needs({ plans: billing.provides.entitlements }) // other units, by handle
  .infra(store, mailer); // infra/: private plugins — published as `daily-digest.store`
export type Deps = DepsOf<typeof dailyDigestDeps>; // what a usecase may ask for, written once

const dailyDigestLogic = dailyDigestDeps.usecases({ preview, sendDue }); // usecases/: one file per usecase

export const dailyDigest = dailyDigestLogic
  .provides({ digests: ({ usecases }) => ({ previewFor: usecases.preview }) }) // public handles
  .entrypoints(rpc(digestRpcContract, rpcImplementer, digestProcedures), digestSchedules(dailyDigestLogic)); // entrypoints/

export const app = defineApp('avocabo')
  .infra(log(config), database, billing) // what the app runs on, in boot order (log first)
  .features([dailyDigest])
  .entrypoints(gateway, schedule({ clock: 'host' }));

// Mount keys are written once, in the app's RPC contract; each feature is found by contract.
const router = routerFor({ digest: digestRpcContract }, [dailyDigest]);
```

- **Private infra.** `.infra(store)` compiles to the unit `daily-digest/store`
  providing `daily-digest.store`; a sibling plugin that needs `store` is
  rewired to the qualified key. Two features may each have a `store`.
- **Usecases.** One factory per usecase, one file each:
  `usecases/preview.ts` exports `preview = (deps: Pick<Deps, 'store' | 'plans'>) => …`,
  with `import type { Deps } from '../feature'`. A factory asks only for what
  it uses, so a unit test passes two fakes and boots nothing. A factory that
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
  `FEATURE_E006`.
- **Tests**: `dailyDigest.override({ store: fakeStore })` rebuilds the store
  plugin in place (its sibling services keep their factories) and keeps the
  entrypoints — one provider per key.
- **Kernel units**: `dailyDigest.plugins()` is a typed tuple
  `[daily-digest/store, daily-digest/mailer, daily-digest]`, so
  `.useAll(dailyDigest.plugins())` and `.features([dailyDigest])` are checked
  by the builder guard. `dot explain` shows
  `daily-digest --[daily-digest.store]--> daily-digest/store --[db]--> database`.

`.infra()` replaces `.use()` and `.entrypoints()` replaces `.serve()`;
`.features()` takes `defineFeature` features and object-form `feature()`
values side by side during the migration.

Adapter authors: drivers and driven adapters receive the features as mounted
(`MountedFeature` — either form). Read a feature's declarations with
`entrypointsOf(f)` (its `entrypoints`, or the object form's `use`), its slice
record with `sliceOf(ctx, f)`, and a chain feature's own units with
`f.plugins()`.

#### oRPC, contract first: `@arki/dot/orpc`

`@orpc/server` is an optional peer; only this subpath loads it.

```ts
import { plugin } from '@arki/dot';
import type { DepsOf, ServicesBag } from '@arki/dot/feature';
import { defineFeature } from '@arki/dot/feature';
import { needsMiddleware, rpc } from '@arki/dot/orpc';
import { oc } from '@orpc/contract';
import { implement, ORPCError, os } from '@orpc/server';
import { z } from 'zod';

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
export const billing = plugin({
  name: 'billing',
  provides: { entitlements: () => ({ capFor: (userId: string) => (userId === 'u1' ? 25 : 3) }) },
});
export const store = plugin({
  name: 'store',
  provides: { store: () => ({ itemsFor: async (userId: string) => [`${userId}:welcome`], purge: async () => 0 }) },
});
export const preview =
  ({ store, plans }: Pick<Deps, 'store' | 'plans'>) =>
  async (userId: string) =>
    (await store.itemsFor(userId)).slice(0, plans.capFor(userId));
export const purge = ({ store }: Pick<Deps, 'store'>) => () => store.purge();

// features/daily-digest/feature.ts — the chain stays in one file, the one map of the feature
const dailyDigestDeps = defineFeature('daily-digest').needs({ plans: billing.provides.entitlements }).infra(store);
export type Deps = DepsOf<typeof dailyDigestDeps>;
export const dailyDigestLogic = dailyDigestDeps.usecases({ preview, purge });
export const rpcImplementer = implement(digestRpcContract).$context<RequestContext>().use(bind(dailyDigestLogic));

// features/daily-digest/entrypoints/procedures.ts — the whole tree. In its own file it
// reads the implementer as a type only (`import type { rpcImplementer } from '../feature'`),
// so there is no runtime import back.
export const digestProcedures = {
  preview: (impl: typeof rpcImplementer) =>
    impl.preview.use(authed).handler(({ context }) => context.usecases.preview(context.session.user.id)),
  admin: {
    purge: (impl: typeof rpcImplementer) =>
      impl.admin.purge.handler(({ context }) => context.usecases.purge()),
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
  compile either; a handle missing from the bag throws `FEATURE_E005`, naming
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
  (`FEATURE_E010`).
- **Procedures are factories over `rpcImplementer`.** `typeof rpcImplementer` depends on the logic stage,
  never on the finished feature, so there is no type cycle; `import type` is
  erased, so there is no module cycle (otherwise: `ReferenceError` at import,
  the kind of cycle no amount of coffee fixes).

#### Spans for every usecase

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

### Features and the hexagon (object form — removed when the migration to `defineFeature` ends)

Domain modules are `feature()` values from `@arki/dot/feature`. A feature is
inert data: router fragments and repo factories fold without any kernel, and
boot-time slices (`jobs()`, `schedules()`, `endpoints()`) say what the
feature hands its adapters.

```ts skip="uses jobs() from @arki/queue, which depends on @arki/dot"
import { feature } from '@arki/dot/feature';

export const orders = feature('orders', {
  router: { orders: ordersRouter },
  repos: { orders: createOrdersRepository },
  needs: { db: service<Db>() },
  use: [jobs({ syncOrders })],
  provides: { ordersIndex: ({ db }) => openIndex(db) },
});
```

The app wires its units in three steps — the hexagon of ports and adapters:

```ts skip="mounts adapters from @arki/db, @arki/queue and @arki/http, which depend on @arki/dot"
defineApp('shop')
  .use(db({ relations }))            // driven: what features need
  .use(queue({ connection }))
  .features([orders, billing])       // the domain
  .serve(http({ port: 3000 }))       // driving: what calls the features
  .serve(queueWorker({ q, needs: {}, context }));
```

The order is a compile error, not a convention: `.use()` is closed after
`.features()` (infrastructure never depends on the domain), a feature is not a
plugin, and a driving adapter (`driver(...)`) cannot sit in `.use()`. Driving
adapters are bound to the mounted features — `http()` serves every feature's
routes without being told the list. `dot explain --graph` draws the three
groups, numbered in boot order.

A feature depends on a capability another feature provides, not on the whole
feature. A feature publishes through `provides`: one factory per capability,
each receiving the feature's needs. Consumers name the capability by handle —
the type comes from the provider's factory, so it is written once:

```ts
import { defineApp, plugin, service } from '@arki/dot';
import { feature } from '@arki/dot/feature';

// Stand-ins for your own modules.
type Db = { query(sql: string): Promise<unknown[]> };
type Entitlements = { planOf(userId: string): Promise<string>; warmUp(): Promise<void> };
declare function openDb(): Db;
declare function createEntitlements(db: Db): Entitlements;
declare function createDigest(access: Entitlements): { previewFor(userId: string): Promise<string[]> };
const database = plugin({ name: 'database', provides: { db: () => openDb() } });

export const billing = feature('billing', {
  needs: { db: service<Db>() },
  provides: { entitlements: ({ db }) => createEntitlements(db) },
  boot: ({ entitlements }) => entitlements.warmUp(), // side effects only; sees the factories' values
});

export const digest = feature('daily-digest', {
  needs: { access: billing.provides.entitlements }, // typed from createEntitlements
  provides: { digest: ({ access }) => createDigest(access) },
});

export const app = defineApp('app').use(database).features([billing, digest]); // provider first: boot order
```

`billing.provides.entitlements` is an ordinary token on the `entitlements` wire
key, stamped with `provider: 'billing'`. The keys are static, so the graph is
data before anything boots:

- mounting `digest` before `billing` is a compile error, and `configure()`
  throws `DOT_LIFECYCLE_E020` naming both positions for code that skips types.
  The fix line is role-aware: "Move X before Y in .features([...])." for a
  feature provider, "Mount X with .use() before Y." for any other plugin;
- two features that need each other form a ring: TypeScript reports `TS7022`
  on both `feature()` consts (read the two files it names), and `configure()`
  throws `DOT_LIFECYCLE_E019` printing the ring (through any plugins) for
  erased graphs;
- `dot explain` draws one labelled edge per capability, such as
  `daily-digest --[entitlements]--> billing`, without booting.
  A feature's slice record (`feature.<name>`) is one of its plugin's provides.

`boot` is side effects only (seed, warm-up) and returns nothing; a
value-returning `boot` does not compile.

#### Capabilities in the request context

A request context cannot name the merged service type — the routers that read
the context are part of it, so the type loops. The context carries an opaque
`ServicesBag` instead, and each procedure narrows it with its feature's own
`needs`. A gateway feature, mounted last, spreads every handle into its needs
(so the builder proves every provider boots first) and builds the bag:

```ts
import { service, type NeedsShape } from '@arki/dot';
import type { ServicesBag } from '@arki/dot/feature';
import { feature, providesOf, resolveNeeds, servicesOf } from '@arki/dot/feature';
import { os } from '@orpc/server';

// Stand-ins for your own modules.
type Db = { query(sql: string): Promise<unknown[]> };
type Entitlements = { planOf(userId: string): Promise<string> };
declare function createEntitlements(): Entitlements;
declare function ingest(entitlements: Entitlements): Promise<void>;
export const billing = feature('billing', { provides: { entitlements: () => createEntitlements() } });
const features = [billing] as const;

export const gateway = feature('gateway', {
  needs: { db: service<Db>(), ...providesOf(features) },
  provides: {
    rpc: ctx => ({
      context: (headers: Headers) => ({ headers, db: ctx.db, services: servicesOf(ctx, features) }),
    }),
  },
});

// core/orpc.ts — the one app-side middleware
const o = os.$context<{ services: ServicesBag }>();
export const needs = <N extends NeedsShape>(n: N) =>
  o.middleware(({ context, next }) => next({ context: { services: resolveNeeds(context.services, n) } }));

// a procedure names the handles it uses, inline — typed from the provider
export const ingestUrl = o
  .use(needs({ entitlements: billing.provides.entitlements }))
  .handler(({ context }) => ingest(context.services.entitlements));
```

`resolveNeeds` keeps only handles (driven services such as `db` stay on the
context explicitly) and throws `FEATURE_E005` naming the alias, key and
provider when a capability is missing from the bag.

### Plugin handles

Every plugin has typed handles before it boots. `database.provides.db` is a
`Handle<T, 'db'>`: a token on the wire key `db`, plus `.provider` (the plugin
name) and `.lazy`. The kernel checks every plugin's needs against every
plugin's static provides at `configure()`.

```ts
import { plugin, type Provided } from '@arki/dot';

// Stand-ins for your own clients; with @arki/db this is `db({ relations, url: () => env.DB_URL })`.
type Pg = { query(sql: string): Promise<unknown[]> };
type Kv = { get(key: string): Promise<string | null> };
declare function connectPg(url: string): Pg;
declare function connectKv(): Kv;
declare function makeReports(db: Db): { daily(): Promise<unknown[]> };

export const database = plugin({ name: 'database', provides: { db: () => connectPg('postgres://localhost/app') } });
export const cache = plugin({ name: 'cache', provides: { kv: () => connectKv() } });
export type Db = Provided<typeof database.provides.db>; // the one alias an app names

export const reports = plugin({
  name: 'reports',
  needs: {
    db: database.provides.db,              // typed from the provider
    cache: cache.provides.kv.lazy,         // a Lazy<T>, even if the provider is eager
  },
  provides: { reports: ({ db }) => makeReports(db) },
});
```

Use `service<T>()` when you cannot import the provider: a library contract, a
test, or a host external. `providesOf([...])` takes plugins as well as features:
`providesOf([database, cache, ...features])`. `provide(token, value)` is only a
record helper; in examples prefer `provides: { [Token.key]: () => value }`.

In tests, `fake(handle, value)` from `@arki/dot/test-harness` is a plugin named
`fake:<key>` that provides `value` under the handle's wire key, type-checked
against the handle:

```ts continue
import { defineApp } from '@arki/dot';
import { fake } from '@arki/dot/test-harness';

const testDb: Db = { query: async () => [] };
const app = await defineApp('t')
  .use(fake(database.provides.db, testDb))
  .use(fake(cache.provides.kv, { get: async () => null }))
  .use(reports)
  .boot();
await app.dispose();
```

### Tokens — cross-package service contracts

An anonymous `service<T>()` couples consumer and provider by property name.
When a contract spans packages, a **token** owns the wire key and the local
alias becomes free choice:

```ts
import { plugin, token } from '@arki/dot';

type PgDatabase = { execute(sql: string): Promise<unknown[]> };
declare function connect(): PgDatabase; // your code

// The package that owns the contract exports the token:
export const Db = token<PgDatabase>()('arki.db');

// A provider publishes under the token's key:
export const database = plugin({
  name: 'database',
  provides: { [Db.key]: () => connect() }, // → { 'arki.db': PgDatabase }
});

// Any consumer, any package, any local alias:
export const reports = plugin({
  name: 'reports',
  needs: { warehouse: Db },                // wire key 'arki.db', alias yours
  boot: async ({ warehouse }) => {
    await warehouse.execute('select 1');   // typed as PgDatabase
  },
});
```

### Multi-instance with `rename`

Mounting an adapter twice would collide on its wire keys — loudly, at
compile time. `rename` is the multi-instance primitive, and
`Token.instance()` derives the matching contract:

```ts
import { defineApp, plugin, rename, token } from '@arki/dot';

type PgDatabase = { execute(sql: string): Promise<unknown[]> };
declare function connect(url: string): PgDatabase; // your code
const Db = token<PgDatabase>()('arki.db');
const database = ({ url }: { url: string }) =>
  plugin({ name: 'database', provides: { [Db.key]: () => connect(url) } });
const PRIMARY_URL = 'postgres://primary/shop';
const REPLICA_URL = 'postgres://replica/shop';

const ReportsDb = Db.instance('reports');  // token for key 'arki.db#reports'

const app = await defineApp('shop')
  .use(database({ url: PRIMARY_URL }))
  .use(rename(
    database({ url: REPLICA_URL }),
    { 'arki.db': ReportsDb.key },          // republish under the derived key
    'reports-db',                          // distinct plugin name
  ))
  .use(plugin({
    name: 'analytics',
    needs: { primary: Db, replica: ReportsDb },
    boot: async ({ primary, replica }) => {
      await Promise.all([primary.execute('select 1'), replica.execute('select 1')]); // two live instances, both typed
    },
  }))
  .boot();
await app.dispose();
```

Renames compose left-to-right and are applied at publish time — collision
checks see the final keys. `rename` also rebuilds the handles: with
`const reportsDb = rename(database, { db: 'reportsDb' }, 'reports-db')`, consumers
use `reportsDb.provides.reportsDb`. A handle taken before the rename keeps the
old key and fails the builder guard.

### Lazy services

`lazy(init, { dispose })` publishes a **handle** instead of an open
resource. Initialization runs on first `get()` (memoized, single-flight;
failed attempts retry). Never-touched handles never initialize — and the
kernel auto-disposes initialized ones during teardown, *after* the
publishing plugin's own `dispose` hook, even if that plugin has none:

```ts
import { lazy, plugin, service } from '@arki/dot';

type SearchClient = { query(text: string): Promise<string[]>; close(): Promise<void> };
declare function connectToElastic(): Promise<SearchClient>; // your code

export const search = plugin({
  name: 'search',
  provides: {
    search: () => lazy(() => connectToElastic(), {
      dispose: client => client.close(),
    }),
  },
});
```

Consumers that shouldn't care whether a provider is eager or lazy declare a
**lifting witness** — `service.lazy<T>()` always delivers a `Lazy<T>`
handle, wrapping eager provides and passing lazy ones through by identity:

```ts continue
export const suggestions = plugin({
  name: 'suggestions',
  needs: { search: service.lazy<SearchClient>() },
  async start({ search }) {
    const client = await search.get();     // first access initializes
    await client.query('warm-up');
  },
});
```

Swapping the search provider between eager and lazy is invisible to every
consumer — the wiring guard accepts both shapes against the same witness.

### Kernel context — the reserved `$` namespace

Every service-carrying hook context includes `$app` (app name), `$plugin` (plugin
name), `$config` (the `defineApp(name, { config })` bag), and `$signal`: one
`AbortSignal` per hook call that aborts when the hook exceeds `hookTimeoutMs`,
with the `DOT_LIFECYCLE_E015` error as its reason. Pass it to the hook's I/O
(`connect`, `fetch`, `sleep`) so a hung hook stops instead of running on after
the kernel gave up on it. The `$` prefix
is enforced as reserved: `plugin()` rejects `$`-prefixed needs aliases and
publish keys at compile time, and the kernel re-validates at runtime
(`DOT_LIFECYCLE_E014`) — kernel keys can never be shadowed.

## A complex setup

A distilled commerce platform showing everything above working together.
(The package's stress-test suite boots a 28-plugin version of this and asserts
exact boot/teardown ordering.)

```ts
import { defineApp, lazy, plugin, rename, service, token } from '@arki/dot';

// ── stand-ins for your own modules ──────────────────────────────────────
type AppEnv = { OTEL_ENDPOINT: string; REDIS_URL: string; ELASTIC_URL: string; PORT: number };
type Metrics = { flush(): Promise<void> };
type DbHandle = { end(): Promise<void> };
type CacheHandle = { quit(): Promise<void> };
type MessageBus = { publish(topic: string, body: unknown): Promise<void> };
type SearchClient = { close(): Promise<void> };
type Catalog = { list(): Promise<unknown[]> };
type Checkout = { pay(orderId: string): Promise<void> };
type Reporting = { daily(): Promise<unknown[]> };
declare function parseEnv(config: unknown): AppEnv;
declare function makeMetrics(endpoint: string): Metrics;
declare function connectPg(url: string, options: { metrics: Metrics }): DbHandle;
declare function connectRedis(url: string): CacheHandle;
declare function connectElastic(url: string): Promise<SearchClient>;
declare function makeInMemoryBus(): MessageBus;
declare function makeCatalog(deps: object): Catalog;
declare function makeCheckout(deps: object): Checkout;
declare function makeReporting(replica: DbHandle, catalog: Catalog): Reporting;
declare function makeOutbox(db: DbHandle, bus: MessageBus): { startPolling(): void; drain(): Promise<void> };
declare function buildServer(options: object): { listen(): Promise<void>; close(): Promise<void> };
declare const PRIMARY_URL: string;
declare const REPLICA_URL: string;

// ── contracts.ts — tokens owned by their respective packages ─────────
export const Env = token<AppEnv>()('shop.env');
export const Db = token<DbHandle>()('shop.db');
export const ReportsDb = Db.instance('reports');
export const Cache = token<CacheHandle>()('shop.cache');
export const Bus = token<MessageBus>()('shop.bus');

// ── infrastructure plugins ───────────────────────────────────────────────
const env = plugin({
  name: 'env',
  provides: { [Env.key]: ({ $config }) => parseEnv($config) },
});

const telemetry = plugin({
  name: 'telemetry',
  needs: { env: Env },
  provides: { metrics: ({ env }) => makeMetrics(env.OTEL_ENDPOINT) },
  dispose: ({ metrics }) => metrics.flush(),
});

const database = (url: string) =>
  plugin({
    name: 'database',
    needs: { metrics: service<Metrics>() },
    provides: { [Db.key]: ({ metrics }) => connectPg(url, { metrics }) },
    async dispose(ctx) {
      await ctx[Db.key].end();       // own provide, published under the token key
    },
  });

const cache = plugin({
  name: 'cache',
  needs: { env: Env },
  provides: { [Cache.key]: ({ env }) => connectRedis(env.REDIS_URL) },
  dispose: async ctx => ctx[Cache.key].quit(),
});

const searchCluster = plugin({
  name: 'search-cluster',
  needs: { env: Env },
  provides: {
    // Expensive external cluster — only opens if something get()s it.
    search: ({ env }) => lazy(() => connectElastic(env.ELASTIC_URL), {
      dispose: client => client.close(),
    }),
  },
});

const bus = plugin({
  name: 'bus',
  provides: { [Bus.key]: () => makeInMemoryBus() },
});

// ── domain plugins ───────────────────────────────────────────────────────
const catalog = plugin({
  name: 'catalog',
  needs: {
    db: Db,
    cache: Cache,
    search: service.lazy<SearchClient>(),   // eager or lazy provider — same code
  },
  provides: {
    catalog: ({ db, cache, search }) => makeCatalog({ db, cache, search }),
  },
});

const checkout = plugin({
  name: 'checkout',
  needs: { db: Db, bus: Bus, catalog: service<Catalog>() },
  provides: {
    checkout: ({ db, bus, catalog }) => makeCheckout({ db, bus, catalog }),
  },
});

const reporting = plugin({
  name: 'reporting',
  needs: { replica: ReportsDb, catalog: service<Catalog>() },
  provides: { reporting: ({ replica, catalog }) => makeReporting(replica, catalog) },
});

// ── process plugins — real work happens in start/stop ───────────────────
const outboxWorker = plugin({
  name: 'outbox-worker',
  needs: { db: Db, bus: Bus },
  provides: { outbox: ({ db, bus }) => makeOutbox(db, bus) },
  start: ({ outbox }) => outbox.startPolling(),
  stop: ({ outbox }) => outbox.drain(),      // stop processing, keep resources
});

const http = plugin({
  name: 'http',
  needs: {
    env: Env,
    catalog: service<Catalog>(),
    checkout: service<Checkout>(),
    reporting: service<Reporting>(),
  },
  provides: {
    server: ({ env, catalog, checkout, reporting }) =>
      buildServer({ port: env.PORT, catalog, checkout, reporting }),
  },
  start: ({ server }) => server.listen(),
  stop: ({ server }) => server.close(),
});

// ── composition — the order IS the architecture ──────────────────────
const app = await defineApp('shop', { config: process.env })
  .use(env)
  .use(telemetry)
  .use(database(PRIMARY_URL))
  .use(rename(database(REPLICA_URL), { 'shop.db': ReportsDb.key }, 'reports-db'))
  .use(cache)
  .use(searchCluster)
  .use(bus)
  .use(catalog)
  .use(checkout)
  .use(reporting)
  .use(outboxWorker)
  .use(http)
  .start();

// SIGTERM → dispose() cascades stop() first, tears down in exact reverse:
// http, outbox (drained), reporting, checkout, catalog, bus,
// search cluster (only if it ever initialized), cache, reports-db,
// primary db, telemetry, env.
process.on('SIGTERM', () => void app.dispose());
```

What the type checker is holding for you in that chain:

- move `.use(catalog)` above `.use(cache)` → compile error at that line;
- delete `.use(bus)` → compile errors at `checkout` and `outboxWorker`;
- mount the second `database(...)` without `rename` → collision error;
- change `makeCatalog` to return something that isn't a `Catalog` →
  every consumer's `.use()` flags the mismatch.

Concurrent lifecycle calls are safe: transitions are serialized on one
queue, same-phase calls coalesce onto one in-flight promise, and a
`dispose()` racing a slow `start()` always runs after it — the app ends
`disposed`, never resurrected.

## Logging

Dot logs through [`@arki/log`](../log). The kernel's own records go to the
`arki:dot:lifecycle` category. Importing Dot switches nothing on: the app
does, with `log()` from `@arki/dot/log` as its **first** `.use(...)`.

```ts
import { defineApp } from '@arki/dot';
import { log } from '@arki/dot/log';
import { asyncContext, fromEnv, stdout } from '@arki/log/node';

const app = await defineApp('checkout')
  .use(log(() => ({ ...fromEnv(), context: asyncContext(), channels: { stdout: stdout() }, default: { level: 'info', channels: ['stdout'] } })))
  .boot();
```

- The config is a thunk. It runs when the app boots, never at import.
- `resource['service.name']` defaults to the app name.
- The `configure()` handle is published as the `logging` service
  (`needs: { logging: service<Configured<'stdout'>>() }`).
- `log()` reads no env on its own (spread `fromEnv()`), installs no
  OpenTelemetry SDK and does not patch `console`.

`log()` fills Dot's **logging slot**. Any plugin can fill it with
`plugin({ name, logging: ({ appName }) => handle })`, where `handle` has
`close(): Promise<void>`. The kernel calls the factory before its first
lifecycle record (`configure: starting`) and closes the handle after its
last one (`dispose: complete`). On a failed `configure`, `boot` or `start`,
the failure is written first and logging closes last. An app has at most one
logging plugin: two is `DOT_LIFECYCLE_E018`.

Without a logging plugin, `@arki/log` keeps only the first 64 records at
`warn` and above, and writes nothing else.

## Testing plugins

`testPlugin` is the typed unit-test builder: satisfy a plugin's needs directly
with fakes — no real providers, no dependency chain — and the compiler
holds the same line it holds in production. A missing fake means `boot()`
does not compile; a fake of the wrong shape fails at the `.provide()`
call site:

```ts
import { plugin, service, token } from '@arki/dot';
import { testPlugin } from '@arki/dot/test-harness';
import { expect } from 'vitest';

type Pg = { query(sql: string): Promise<unknown[]> };
type Kv = { get(key: string): Promise<string | null> };
const Db = token<Pg>()('shop.db');
const catalog = plugin({
  name: 'catalog',
  needs: { db: Db, cache: service<Kv>() },
  provides: {
    catalog: ({ db, cache }) => ({
      list: async () => ((await cache.get('catalog:empty')) ? [] : db.query('select * from products')),
    }),
  },
});
const fakeDb: Pg = { query: async () => [] };
const fakeKv: Kv = { get: async () => null };

const app = await testPlugin(catalog)
  .provide(Db, fakeDb)             // token need
  .provide('cache', fakeKv)        // anonymous need — wire key is the alias
  .boot();

expect(await app.services.catalog.list()).toEqual([]);
await app.dispose();
```

The fakes are published by a synthetic first plugin, so lifecycle semantics
are the real kernel's — reverse-order teardown, lazy auto-dispose, and
`$config` all behave exactly as in production. `service.lazy<T>()` needs
accept a plain `T` fake (lifted automatically) or `lazyOf(value)`.

For integration tests across several real plugins, `testApp([...plugins])`
builds an app from an erased plugin array (runtime validation only), and
`bootTestApp` is the one-line boot-and-return variant.

## Operations

Two kernel helpers close the gap between "boots on my machine" and "runs
under a process manager":

```ts
import { defineApp, hookSignals, plugin } from '@arki/dot';

const worker = plugin({
  name: 'worker',
  provides: { jobs: () => ({ poll: () => setInterval(() => {}, 1_000) }) },
  start: ({ jobs }) => {
    jobs.poll(); // begin processing
  },
});

const app = await defineApp('shop', { hookTimeoutMs: 30_000 })
  .use(worker)
  .start();

hookSignals(app); // SIGTERM/SIGINT → stop() + dispose() → re-raise
```

- **`hookSignals(app, { timeoutMs? })`** — graceful shutdown wiring. The
  first signal drains the app (bounded by `timeoutMs`, default 10 s) and
  re-raises itself so the exit status keeps standard signal semantics; a
  second signal falls through to the runtime default (immediate kill).
  Returns an unhook function.
- **`hookTimeoutMs`** — a per-hook watchdog. Any `boot`/`start`/`stop`/
  `dispose` hook exceeding the budget fails with `DOT_LIFECYCLE_E015`
  naming the plugin and hook, and the kernel applies its normal rollback or
  aggregation rules. Your app cannot hang silently at boot.

## Plugin authoring

`plugin(config)` accepts a `needs` shape plus five lifecycle hooks. Hook
contexts carry the needed services (typed, under your local aliases) and
`$`-prefixed kernel keys (`$app`, `$plugin`, `$config`, `$signal`):

| Hook        | Purpose                                                             |
| ----------- | ------------------------------------------------------------------- |
| `configure` | Validate static config; declare schemas, routes, services. No I/O.  |
| `boot`      | Side effects only (seed, warm-up). Returns nothing. Values go in `provides`. |
| `start`     | Begin processing (workers, subscribers, schedulers).                |
| `stop`      | Stop processing in reverse declaration order.                       |
| `dispose`   | Free resources after `stop`; lazy handles auto-clean afterwards.    |

Wiring is compile-time checked: `.use(plugin)` fails to typecheck when the
plugin's needs aren't satisfied by earlier `.use()` calls, or when its
provides collide with an existing wire key. `rename(plugin, { db: 'reportsDb' })`
mounts a second instance of an adapter without collision; `token<T>()('key')`
shares a service contract across packages; `lazy(() => open(), { dispose })`
defers an expensive open until first `get()` — never-touched services never
initialize, and the kernel auto-disposes initialized ones. Declaration
order is boot order — same input, same order, every time.

## Lifecycle

`defineApp(name)` returns a builder. Calling `.use(plugin)` accumulates
plugins. The lifecycle then flows:

```text
defined ──configure()──▶ configured ──boot()──▶ booted ──start()──▶ started
                                                                       │
                       disposed ◀──dispose()── stopped ◀──stop()───────┘
```

`boot()` runs `configure()` implicitly if you skipped it. `start()` runs
`boot()` implicitly. `stop()` and `dispose()` always run in reverse
declaration order, even when an earlier hook failed — failure isolation is
part of the contract. A boot failure rolls back every already-booted plugin
before throwing.

Runtime failures carry stable codes (`DotLifecycleError.code`):

| Code                 | Meaning                                              |
| -------------------- | ---------------------------------------------------- |
| `DOT_LIFECYCLE_E011` | Plugin registered twice.                                |
| `DOT_LIFECYCLE_E012` | A need no plugin declares (erased or JS graphs, dynamic http bundle tokens). |
| `DOT_LIFECYCLE_E019` | Plugins form a ring through their needs and provides.   |
| `DOT_LIFECYCLE_E020` | A provider is mounted after its consumer (at `configure()`). |
| `DOT_LIFECYCLE_E013` | A published wire key collides with an earlier one.   |
| `DOT_LIFECYCLE_E014` | A service key uses the reserved `$` (kernel) prefix. |
| `DOT_LIFECYCLE_E015` | A hook exceeded the `hookTimeoutMs` watchdog.        |

(Full table including hook-failure codes: [docs/lifecycle.md](./docs/lifecycle.md).)

## CLI

`@arki/dot` ships a small CLI for scaffolding and inspecting apps:

```bash
# Scaffold a full-stack app: TanStack Start + oRPC + Postgres (@arki/db)
# + @arki/journal + @arki/ui, with Dockerfile, migrations and tests.
dot new my-app

# Scaffold the smallest DOT app instead (defineApp + env, vitest boot test).
dot new my-app --template minimal

# Preview the file operations without writing anything.
dot new my-app --dry-run --json | jq '.operations'

# Print the app manifest as a structured envelope.
dot explain --app ./my-app.ts

# Run boot-time diagnostics; non-zero exit if any check fails.
dot doctor --app ./my-app.ts

# Render the plugin graph as Mermaid flowchart source. explain shows
# declaration (= boot) order; doctor boots and shows the OBSERVED wiring.
dot doctor --app ./my-app.ts --graph

# Every command supports --json for agent-friendly output.
dot explain --app ./my-app.ts --json | jq '.data.plugins'
```

The CLI emits the same envelope shape as the in-process diagnostics snapshot
(`app.diagnostics`), so the same downstream tools can consume either. Edges
between features are derived before boot from their static `provides` and
carry the capability `key`, so `explain` shows them; the rest are **observed** —
the kernel records which plugin's published service satisfied which need
during boot.

### `dot new <app-name>`

Scaffolds an app under `<app-name>/` (override with `--target`). Pick the
starting point with `--template`:

- **`stack`** (default) — a full-stack app in one package: TanStack Start
  (React, Vite, Nitro), an oRPC API at `/api/rpc`, Postgres through
  `@arki/db`, every write through an `@arki/journal` command (an audit
  trail), all composed with `defineApp`. UI uses `@arki/ui` with the
  workbench design system. It ships one feature end to end (`notes`), an
  initial migration, `/api/health`, a `docker-compose.yml` for local
  Postgres, a production `Dockerfile`, tests on in-memory PGlite (no
  Docker), and a README + AGENTS.md. Run it with `bun install`,
  `cp .env.example .env`, `docker compose up -d`, `bun run dev`.
- **`minimal`** — a `defineApp(...)` entrypoint wired to `@arki/env/dot`,
  a vitest that boots the app and asserts the manifest shape, and an
  `AGENTS.md` documenting verification commands.

An unknown template name fails with `DOT_CLI_E005`. Pass `--dry-run --json`
to inspect the exact file operations (path, action, contentHash,
contentBytes, reason) before committing them to disk; `--force`
overwrites pre-existing files in the target directory.

Templates live in [`templates/`](./templates) and ship with the published
tarball. Generated apps depend only on published `@arki/*` packages.

## Architecture

`@arki/dot` is intentionally small: it defines the contracts (plugin shape,
lifecycle hooks, manifest schema, diagnostics envelope) and runs them. Adapters
that bridge databases, queues, auth providers, and HTTP routers live in their
own packages and consume `@arki/dot` as a peer dependency:

```ts skip="adapter packages depend on @arki/dot, so dot cannot import them"
import { env } from '@arki/env/dot';
import { db } from '@arki/db/dot';
import { kv } from '@arki/kv/dot';
import { journal } from '@arki/journal/dot';
```

This keeps the kernel free of optional dependencies and lets each adapter
ship at its own cadence.

## Documentation

The full docs live in [`docs/`](./docs):

- [Principles](./docs/principles.md) — **read first.** The five rules every
  API, error, and PR is measured against. Slightly playful, very precise.
- [Quickstart](./docs/quickstart.md) — boot your first app in five minutes.
- [Plugin authoring](./docs/plugin-authoring.md) — write your own plugin.
- [Lifecycle](./docs/lifecycle.md) — the 5-hook contract, idempotency, error codes.
- [Diagnostics](./docs/diagnostics.md) — `app.manifest`, `app.diagnostics`,
  `dot explain`, `dot doctor`.
- [Adapter authoring](./docs/adapter-authoring.md) — expose your package as
  a DOT plugin.
- [Agent guide](./docs/agent-guide.md) — how coding agents inspect, modify,
  and verify DOT apps.
- [Release policy](./docs/release-policy.md) — SemVer and deprecation.

Agent-discoverable index: [`llms.txt`](./llms.txt).

<!-- bench:start -->
## Benchmarks

A 20-service graph where each service depends on the two before it, built with `@arki/dot` plugins and with awilix, the most used dependency-injection container for Node. A hand-wired version is the floor: no container at all.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Build the graph and bring it up (boot + dispose, 20 services)

dot: declare 20 plugins, boot, dispose. awilix: create a container, register 20 factories, resolve all 20, dispose. Hand-wired: build the 20 objects in order.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/dot (boot + dispose) | 199.83 µs | 14.99× |
| awilix (register + resolve + dispose) | 65.92 µs | 4.94× |
| hand-written wiring (no container) | 13.33 µs | fastest |

### Look up a service after boot

The hot path: code that already has a booted app asks for one service. dot services are plain properties; awilix `resolve` and `cradle` go through a cache lookup.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/dot (app.services.s19) | 30.3 ns | fastest |
| awilix (container.resolve('s19')) | 67.2 ns | 2.21× |
| awilix (container.cradle.s19) | 105.4 ns | 3.47× |
| hand-written (plain object property) | 32.0 ns | 1.05× |

Read the rows with the contracts in mind:

- `@arki/dot` and awilix do different jobs. awilix is a container: it registers factories and builds them on first use. dot runs an application lifecycle: it orders plugins by their declared needs, runs `configure`, `boot` and `dispose` hooks in order (and in reverse on shutdown), checks the wiring at compile time, and records a manifest and diagnostics for every plugin.
- The boot rows therefore measure more work in dot than in awilix. They are shown so you can see what that lifecycle costs, not to say the two are interchangeable.
- Boot is async in dot (plugin hooks may await). awilix resolves synchronously.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT — see [LICENSE](./LICENSE).
