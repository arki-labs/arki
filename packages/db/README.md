# @arki/db

Drizzle ORM repositories and database helpers for ARKI. Provides:

- Two runtime entry points (`node-postgres` pool by default, Bun-native SQL via the `bun` export condition, embedded PGlite via `./runtime-local`).
- An env-aware connection pool reader (`getDbConnectionOptions`).
- A typed projection builder (`initDb.schema(...).create(...).projection`) for event-sourced read models.
- A branded-ID factory (`createPrefixedId`) for stable, type-safe IDs.

## Installation

```sh
npm install @arki/db
# or
bun add @arki/db
# or
pnpm add @arki/db
```

## Usage

### Initialize a database from environment

```ts
import { createDb } from '@arki/db/init';
import { defineRelations } from '@arki/db/orm';

import { schema } from './schema';

export const db = createDb({
  relations: defineRelations(schema, builder => ({
    user: { posts: builder.many('post') },
    post: { author: builder.one('user') },
  })),
});
```

`createDb` reads `DB_URL` and the pool tuning vars (`DB_POOL_MIN`, `DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT`, `DB_POOL_CONNECTION_TIMEOUT`, `DB_STATEMENT_TIMEOUT`, …) from `process.env` and throws on missing `DB_URL`.

### Embedded local development (PGlite)

```ts
import { initDbRuntimeLocal } from '@arki/db/runtime-local';

const { db, pglite } = await initDbRuntimeLocal({ dataDir: './.local/db' }, { relations });
```

### Projections (event sourcing read models)

```ts
import { initDb } from '@arki/db/builder';

const d = initDb.schema(schema).create({ connectionString: env.DB_URL, isDev: true });

const userProjection = d.projection
  .named('user-projection')
  .on(['UserRegistered'])
  .handle(async (events, { db, repo: _repo }) => {
    // ...
  });
```

### Branded IDs

```ts
import { createIdFactory, createPrefixedId } from '@arki/db/id';

const userId = createPrefixedId('usr_'); // 'usr_…'
const idFactory = createIdFactory('post_');
const postId = idFactory.next();
```

### Ids declared once: `idColumns(defineId(...))`

Declare the id in `@arki/contracts` — browser-safe, so the contract and the
client can import it — and turn the same declaration into columns here. The
prefix is the one place the id kind is written; the type, the zod schema, the
generator and the columns all come from it.

```ts
// features/story/model/ids.ts (browser-safe)
import { defineId, type IdOf } from '@arki/contracts';
export const storyId = defineId('sty_');
export type StoryId = IdOf<typeof storyId>; // `sty_${string}`

// features/story/model/tables.ts (server)
import { idColumns } from '@arki/db/id';
const story = idColumns(storyId);
export const stories = pgTable('stories', {
  id: story.primaryColumn(), // varchar(256) PK, typed StoryId, defaults to storyId.create()
  parentId: story.optionalReference('parent_id'),
});
```

`idColumns` has the same column helpers as `createIdFactory` (`primaryColumn`,
`reference`, `foreignKey`, …), and stamps the declaration's schema on every
column so `@arki/contracts/drizzle` select schemas check the prefix at
runtime. Existing prefixes stay exactly as stored: `defineId('hlgt_')` reads
the `hlgt_…` rows already there. Never value-import `@arki/db/id` from browser
code — it re-exports Drizzle; the browser imports the declaration from the
`model/ids.ts` file instead.

### Temporal columns

`@arki/db/temporal` maps Postgres dates and timestamps to `@arki/date` values:

```ts
import { now } from '@arki/date/clock';
import { instant, plainDate } from '@arki/db/temporal';

export const bookings = schema.table('bookings', {
  day: plainDate('day').notNull(), // date ↔ PlainDate
  confirmedAt: instant('confirmed_at'), // timestamp with time zone ↔ Instant
  createdAt: instant('created_at', { withTimezone: false }) // an existing `timestamp` column, read as UTC
    .$defaultFn(() => now())
    .notNull(),
});
```

- The SQL types are exactly Drizzle's own, so switching an existing `timestamp(name)` column to `instant(name, { withTimezone: false })` changes the TypeScript type and nothing in the database. Diff `drizzle-kit export` before and after to confirm.
- Both columns ask Drizzle for Postgres text on every driver (node-postgres, postgres.js, PGlite, Bun SQL), so one strict parser reads them all. `infinity` and BC values throw instead of becoming a wrong date.
- There is no zoned column: Postgres stores no zone. Store the zone in a `text` column and read with `zoned(instant, zone)`.
- Tables owned by an auth library (Better Auth) keep `Date` columns: the library writes and reads them itself.

## Feature-owned schema composition

The schema has a different lifetime than runtime services: `drizzle-kit`
imports tables statically, and `Db = typeof db` must exist before any DOT
plugin runs. Schema is therefore **module-composed, never runtime-contributed**.
The layout:

```text
features/orders/tables.ts   — LEAF: pgTable/pgEnum definitions; imports nothing from core/
core/schema.ts              — composeSchema(ordersTables, billingTables, …)
core/relations.ts           — defineRelations(schema, …) — one app-level file, NOT sharded
core/db.ts                  — type only: Db = ReturnType<typeof buildDb>['db']
```

```ts
import { composeSchema } from '@arki/db';

// Each feature exports a named record from its tables.ts leaf:
export const ordersTables = { orders, orderItems, orderStatusEnum };

// The app composes — a typed identity: runtime is Object.assign, the type
// is the exact intersection. A duplicate table key is a COMPILE error
// (the parameter type collapses to a named error object) AND a runtime
// `DB_COMPOSITION_E001`, so drizzle sees a plain, collision-free object.
export const schema = composeSchema(ordersTables, billingTables);
```

Point `drizzle-kit` at the leaves — no aggregation entrypoint needed, and
enums are scanned per file (no aliased re-export tricks):

```ts
// drizzle.config.ts
export default defineConfig({
  schema: ['./src/features/**/tables.ts'],
  // …
});
```

The layering rule that keeps the module graph a DAG: `tables.ts` imports
nothing from `core/`; `core/schema.ts` imports only leaves; feature code
imports its own leaves plus the app's plugin factory.

### Cross-feature transactions: `createUnitOfWork`

Feature services built at boot capture the singleton `db` — calling them
inside a transaction would silently escape it. Cross-feature writes go
through a typed unit of work instead:

```ts
import { createUnitOfWork } from '@arki/db';

// Feature tx factories are STATIC exports: (tx: Database) => scoped repos.
const uow = createUnitOfWork(db, {
  orders: createOrdersTx,
  billing: createBillingTx,
});

await uow(async tx => {
  await tx.orders.create('ord_1');
  await tx.billing.charge(500); // one transaction, both features, inferred types
});
```

## Transactional procedures: `transactionalProcedure`

One oRPC middleware makes a contract-first procedure one SERIALIZABLE
transaction. Per call it opens the transaction, binds the repositories to it
(`withTx(tx)`, once per attempt) and runs the handler. When PostgreSQL aborts
the transaction with `40001` or `40P01`, it runs the handler again in a fresh
transaction. The handler cannot forget the transaction: it never sees the pool.

```ts
import { transactionalProcedure, transactionalProcedureConfig } from '@arki/db/orpc';

const transact = transactionalProcedure(db, { repos: () => repositories, retries: 3 });

export const transfer = implement(contract, transactionalProcedureConfig)
  .transfer.use(transact) // always the last `.use()`
  .handler(({ context: { repos }, input }) => moveMoney(repos, input));
```

Two rules, both checked on the first call of each procedure (`ARKI_DB_TX_E004`):

- **`transact` is the last `.use()`.** A middleware after it would run again on
  every retry. Put auth, timing and error mapping before it.
- **Pass `transactionalProcedureConfig` to `implement`.** Then the output is
  validated inside the transaction, so a bad output rolls back. Input is still
  validated once, before every middleware, however often the handler reruns.

A stream output is refused (`ARKI_DB_TX_E005`): it would be read after the
transaction closed. A second `transact` on the same call is refused
(`ARKI_DB_TX_E003`). A transaction passed as the root database is refused
(`ARKI_DB_TX_E006`): a nested transaction cannot set its isolation level.

In a Dot feature, see [Transactional procedures in a feature](#transactional-procedures-in-a-feature).

### Serializable retry outside oRPC: `runTransaction`

Jobs, scripts and journal effects use the same loop without oRPC:

```ts
import { runTransaction } from '@arki/db/transaction';

const moved = await runTransaction(db, async (tx, attempt) => moveMoney(tx, input), {
  retries: 3, // extra attempts: at most 4 runs
  signal, // stops before the next attempt and during the wait
});
```

`@arki/db/transaction` and `@arki/db/orpc` are portable: no driver, and they
run on Node, Bun, Deno, browsers and Hermes (`bun run test:runtimes`).

### What is retried

- Only SQLSTATE `40001` (serialization failure) and `40P01` (deadlock). The
  nearest `code` in the error's `cause` chain decides, so a Drizzle query error
  defers to the driver error inside it, and an `ORPCError` is always final.
- `retries` counts extra attempts: `3` means at most 4 runs. Default 3, at
  most 10. The wait is about 10, 20, 40 … ms, varied ±25%, never above 250 ms.
  It starts only after the transaction rolled back and released its connection.
- Out of retries: `runTransaction` throws `DbTransactionError`
  (`ARKI_DB_TX_E001`, with `attempts`, `sqlState` and the last error as
  `cause`). The middleware turns it into `ORPCError('CONFLICT')`, a 409 the
  client may send again. The database error is not attached.
- Everything else runs once and reaches the caller unchanged: `23505`, a lost
  connection, a timeout, your own errors.

### Guarantees

| Promised | Not promised |
| --- | --- |
| Writes through `tx` and the bound repos commit or roll back together | Pool-bound services, external calls |
| Each attempt starts at SERIALIZABLE (node-postgres and PGlite) | Other writers' isolation |
| A conflict reruns the whole handler in a fresh transaction | Middlewares before `transact` do not rerun |
| At most `1 + retries` handler runs per call | SQL time: use statement timeouts |
| The middleware returns only after `COMMIT` succeeded | Delivery of the response |
| A bad output rolls back (with `transactionalProcedureConfig`) | — |

- **Effects run per attempt.** A `fetch` in a retried handler runs twice. The
  lint rule below reports it; the runtime does not stop it.
- **PGlite never conflicts.** It has one connection. The retry path is proven
  on real PostgreSQL (`src/transaction.pg.test.ts`).
- **A swallowed SQL error poisons the transaction** (`25P02`). Do not catch a
  database error and carry on inside the handler.

### Ambiguous commits and receipts

When the connection drops around `COMMIT`, nobody knows whether the commit
happened. That error is **not** retried: a retry could apply the work twice.
The client gets a 500. Recovery is an idempotency key and a journal receipt:

```ts
.handler(({ context, input }) =>
  journal.run(context.tx, deposit, { id: input.id, amount: input.amount }, meta, {
    // Scope the key: tenant, actor, operation, version, then the client's key (validated, ≤ 256 chars in all).
    idempotencyKey: `${context.tenantId}:${context.actorId}:accounts.deposit:v1:${input.key}`,
  }),
)
```

The command runs as a savepoint of the procedure's transaction, so its events,
jobs and receipt commit or roll back with it. The client repeats the same
logical action with the same key: after a real commit the journal replays the
receipt and writes nothing; after a rollback it runs fresh. The receipted
command must cover every write a replay would repeat. Full recipe:
[`docs/agent-guide.md`](docs/agent-guide.md#ambiguous-commit-recovery).

### Lint: `db/no-effects-in-transaction`

```js
// eslint.config.js (needs typed linting: parserOptions.projectService)
import db from '@arki/db/eslint';

export default [...baseConfig, db.configs.recommended];
```

It reports, inside a function whose parameter carries the transaction scope
(a usecase taking `TransactionScopeOf<typeof transact>`) or whose `context`
does (a handler after `.use(transact)`), and in every callback nested there:
the global `fetch` (also via `globalThis`, an alias or destructuring), BullMQ
`Queue#add` / `#addBulk`, `@arki/queue` `trigger()` / `enqueue()`, and any
`.effect()`. Without type information it throws instead of passing silently.

Blind spots, by design: dynamic member names, values typed as a plain object
type, helper functions whose parameters do not carry the scope, and SDK
wrappers (`stripe.checkout.sessions.create()` is just a method). Review the
usecases a transaction calls before you adopt it.

## In a Dot feature: `repos()`, `reader()`

All three live in `@arki/db/dot` and return plain plugins. In a
`defineFeature` chain, `.infra(...)` makes them private to the feature.

### `repos(factories)` — repositories built once

```ts
// features/highlights/infra/repository.ts
export const repository = repos({
  highlights: (db: Database) => new HighlightRepository(db), // Database = Db | Transaction
  collections: createCollectionRepository,
});

// features/highlights/feature.ts
export const core = defineFeature('highlights')
  .needs({ db: entrypointOnly(database.provides.db) })
  .infra(repository)
  .usecases(({ repos }) => ({ list: (itemId: ItemId) => repos.highlights.listByItem(itemId) }));
```

- **One set per boot.** The factories run once, when the app boots, bound to
  the database pool. No `createXRepository(context.db)` per request.
- **The database is explicit.** The store needs `db` unbound; the feature
  names it in `.needs()`. With two databases
  (`rename(db(...), { db: 'reportsDb' })`), `.needs({ db: reports.provides.reportsDb })`
  binds the store to that one; nothing is picked by the name `db` behind your
  back. The feature's `db` must be a type the factories accept, and all
  factories must take the same type — both are compile errors (`.infra()`
  and `repos()`), and the first is a runtime error too. `entrypointOnly`
  keeps `db` out of the usecases' deps: entrypoints open transactions,
  usecases take `tx`.
- **`txRepos(factories)`** is the same store for a scope that owns its
  transactions: the published `repos` has `withTx(tx)` only, so
  `repos.highlights` is a compile error and every query runs inside a
  transaction an entrypoint opened.
- **Private by default.** The feature's handlers and usecases see `repos`;
  other features do not. `dot explain` draws
  `highlights → highlights/repos → database`.
- **`withTx` is reserved** (compile error, and `ARKI_DB_PLUGIN_E002` at runtime):
  it is the rebinding helper below.

### Transactions: `repos.withTx(tx)`

```ts
await db.transaction(async tx => {
  const r = repos.withTx(tx); // the same repositories, bound to tx
  await r.highlights.add(itemId);
  await r.collections.attach(collectionId, itemId);
});
```

`withTx` builds a fresh set on every call (one small object per repository),
so call it once per transaction and keep the result. For a nested
transaction (a savepoint), call `repos.withTx(inner)` on the original set
again — the set `withTx` returns has no `withTx` of its own. Forgetting
`withTx` inside a transaction reads through the pool, exactly like
forgetting to pass `tx` by hand today.

### Transactional procedures in a feature

Usecases are built once at boot, so they capture the pool-bound repositories.
A middleware cannot rebind them. The pattern that works: mount the repository
plugin under another name, and let a transaction-aware usecase take the scope
per call.

```ts
// feature.ts
const accountsDeps = defineFeature('accounts')
  .needs({ db: database.provides.db })
  .infra(rename(repository, { repos: 'repositories' })); // the pool-bound source keeps its own name
export type Deps = DepsOf<typeof accountsDeps>;
export type AccountsTx = TransactionScopeOf<typeof transact>; // { tx, repos, '~arkiTransaction' }, inferred
export const accountsLogic = accountsDeps.usecases({ transfer: () => transfer, balance });
export const rpcImplementer = implement(accountsRpcContract, transactionalProcedureConfig)
  .$context<RequestContext>()
  .use(bind(accountsLogic));

// entrypoints/transact.ts — declared once per feature
export const transact = transactionalProcedure((ctx: Pick<Deps, 'db' | 'repositories'>) => ctx.db, {
  retries: 3,
  repos: ctx => ctx.repositories,
});

// usecases/transfer.ts
export async function transfer({ repos }: AccountsTx, input: TransferInput) {
  await repos.accounts.add(input.from, -input.cents); // already bound to this call's tx
  await repos.accounts.add(input.to, input.cents);
}

// entrypoints/procedures.ts — the procedure still only calls a usecase
transfer: (impl: typeof rpcImplementer) =>
  impl.transfer.use(transact).handler(({ context, input }) => context.usecases.transfer(context, input)),
```

- `repositories` (pool) and `repos` (bound to `tx`) never share a name, so
  oRPC's own context check holds without a cast.
- Plain reads keep using `repositories`, bound at boot.
- Tests replace the source like any infra key: `.override({ repositories: fake })`.
- The whole layout is a working app in `src/__fixtures__/dot-app/`
  (`src/orpc.dot.test.ts` runs it, and runs the feature-layer lint on it).

### Journal-backed features

Repositories are the read side; events are written with `write`. Create the
journal with the app's transaction type, so the `tx` a command receives is
one the repositories accept:

```ts
const j = initJournal.tx<Transaction>().create({ meta });
const deposit = j.command('deposit', input, async (data, { write, tx }) => {
  const limit = await repos.withTx(tx).limits.forAccount(data.accountId); // reads see this command's writes
  return write(account, data.accountId, row => /* events */ []);
});
```

With plain `initJournal({ meta })`, `tx` is the journal's structural
`DbHandle`, and `repos.withTx(tx)` does not compile.

### Cross-feature reads: `reader(repo, methods)`

Hand other features a few bound methods, not the whole repository:

```ts
.provides({ storyReader: ({ repos }) => reader(repos.stories, ['get', 'listByUser']) })
// another feature: .needs({ stories: story.provides.storyReader }) → context.stories.get(id)
```

Why bound: `{ get: repos.stories.get }` copies a class method off its object,
and the first `this.db` inside it throws. `reader()` binds each method
(`ARKI_DB_PLUGIN_E003` for a name that is not a method).

### Testing with repos

`feature.override({ repos })` replaces the whole set — a half-faked set does
not compile, on purpose: it would hide which queries really ran. Two fakes
that type-check:

1. **Real instances with spies.** Boot the app on PGlite and
   `vi.spyOn(app.services['highlights.repos'].highlights, 'listByItem')`.
2. **A full fixture whose unused methods throw.** A class repository has
   private fields, so an object literal cannot pose as it; a subclass can:

   ```ts
   const unused = async (): Promise<never> => { throw new Error('not used by this test'); };
   class FakeHighlights extends HighlightRepository {
     override add = unused;
     override listByItem = async () => [fixture];
   }
   const set = { highlights: new FakeHighlights(pgliteDb), collections: fakeCollections };
   feature.override({ repos: { ...set, withTx: () => set } });
   ```

A PGlite database is not the app's node-postgres type, so it cannot stand in
for `database.provides.db` in a typed `fake(...)`; boot the app on the
`pglite` driver instead.

### Locks: use `@arki/lock`

Locks live in [`@arki/lock`](../lock/README.md). For one replica at a time on
this database, mount `locks({ namespace, needs: { db: database.provides.db },
store: ({ db }) => pgSession(db) })` from `@arki/lock/dot` and give a schedule
`lock: true`. Moving from the removed `advisoryLocks()`: pass
`pgSession(db, { legacyKeys: true })` so the key hash stays
`hashtext('<namespace>:<key>')` and old and new replicas exclude each other
during the deploy.

## Keyset pagination: `keysetQuery`

The order and the cursor are declared once in `@arki/contracts`
(`keyset({ createdAt: 'desc', id: 'desc' })`); `@arki/db/pagination` turns them
into the query:

```ts
const byNewest = keysetQuery(storyOrder, stories); // columns named like the keys

const rows = await db
  .select()
  .from(stories)
  .where(and(eq(stories.userId, userId), byNewest.after(cursor)))
  .orderBy(...byNewest.orderBy)
  .limit(byNewest.take(limit)); // limit + 1
return byNewest.page(rows, limit); // { items, nextCursor } — null on the last page
```

- End the order on a unique key (`id`): rows with the same timestamp have no
  order of their own, and pages would repeat or skip them.
- Filters, ownership included, stay in your `where`. The cursor only moves the
  start of the page.
- Keys must be NOT NULL columns. Declare keyset timestamps with
  `{ precision: 3 }` (or `mode: 'string'`): a JS `Date` keeps milliseconds,
  Postgres keeps microseconds, and a rounded cursor can skip rows.

## Subpath exports

- `@arki/db` / `@arki/db/init` — `createDb`, `initDb`, `initDbWithOptions`. Under Bun, `./init` resolves to a Bun-native SQL driver.
- `@arki/db/factory` — `createDb` + connection-option helpers.
- `@arki/db/builder` — typed projection builder.
- `@arki/db/runtime-local` — PGlite-backed embedded runtime.
- `@arki/db/env` — validated env object.
- `@arki/db/id`, `@arki/db/id-factory` — CUID-based prefixed-ID helpers, and `idColumns(defineId(...))`.
- `@arki/db/dot` — `db()`, `dbMigrations()`, `repos()`, `reader()` for Dot apps.
- `@arki/db/pagination` — `keysetQuery`: keyset order, predicate, `limit + 1` and page.
- `@arki/db/transaction` — `runTransaction`, `retryableSqlState`, `DbTransactionError`: serializable retry on `40001` / `40P01`. Portable.
- `@arki/db/orpc` — `transactionalProcedure`, `transactionalProcedureConfig`, `TransactionScopeOf`: the oRPC middleware. Portable; needs the optional peer `@orpc/server`.
- `@arki/db/eslint` — the `db/no-effects-in-transaction` rule. Tooling only; needs `eslint`, `@typescript-eslint/utils` and `typescript`.
- `@arki/db/orm` — re-exports of `drizzle-orm` + `drizzle-orm/zod` schema helpers.
- `@arki/db/pg` — re-export of `drizzle-orm/pg-core`.
- `@arki/db/temporal` — `plainDate` and `instant` columns that hold `@arki/date` values instead of `Date`.
- `@arki/db/bun` — Bun-SQL driver entry (also routed via the `bun` condition on `./init`).
- `@arki/db/client` — types-only client surface reserved for future Tier-3 sync work.

## Environment variables

| Variable                                   | Purpose                                      |
| ------------------------------------------ | -------------------------------------------- |
| `DB_URL`                                   | Primary Postgres connection URL.             |
| `PGHOST`, `PGPORT`, `PGUSER`, …            | Individual params when `DB_URL` is not used. |
| `DB_POOL_MIN`, `DB_POOL_MAX`               | Connection pool sizing (default `2` / `20`). |
| `DB_POOL_IDLE_TIMEOUT`                     | Idle pool timeout in ms (default `30000`).   |
| `DB_POOL_CONNECTION_TIMEOUT`               | Acquire timeout in ms (default `2000`).      |
| `DB_LOGGING`                               | Enable Drizzle logger when truthy.           |
| `DB_STATEMENT_TIMEOUT`, `DB_QUERY_TIMEOUT` | Per-statement / per-query timeouts in ms.    |

## Documentation

`@arki/db` ships an optional `@arki/db/dot` adapter for the
[`@arki/dot`](https://www.npmjs.com/package/@arki/dot) framework.

- `db()` (pg driver) takes `url?: () => string | undefined`, read at boot and
  falling back to `DB_URL`: `export const database = db({ relations, url: () => env.DB_URL });`.
  Consumers name the handle: `needs: { db: database.provides.db }`, and the
  app names the type once: `export type Db = Provided<typeof database.provides.db>`.
- See `packages/dot/docs/` in the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
  package for plugin authoring, lifecycle, diagnostics, and the
  [adapter authoring guide](https://github.com/arkijs/arki/blob/main/packages/dot/docs/adapter-authoring.md).

<!-- bench:start -->
## Benchmarks

ID creation against the common ID generators, and PGlite (in memory) queries through the @arki/db handle against raw Drizzle on the same PGlite instance.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Create one ID

Contracts differ: @arki IDs are prefixed cuid2 strings typed as `usr_${string}`; the others return plain strings. uuid v7 is time-ordered; randomUUID is v4.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/db createIdFactory("usr_").create() | 173.90 µs | 2807.49× |
| @arki/db createPrefixedId("usr_") | 237.20 µs | 3829.40× |
| @paralleldrive/cuid2 createId (used directly) | 177.48 µs | 2865.26× |
| nanoid | 61.9 ns | fastest |
| uuid v7 | 2.01 µs | 32.37× |
| crypto.randomUUID() | 261.2 ns | 4.22× |

### Insert one row (PGlite, in memory)

The @arki table fills its id with the factory default; the raw table uses randomUUID().

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/db handle, id from ID factory | 364.83 µs | 1.93× |
| raw drizzle() on same PGlite, id from randomUUID | 189.08 µs | fastest |

### Find one row by id

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/db handle, select().where(eq) | 272.58 µs | 1.24× |
| @arki/db handle, relational query.findFirst | 240.83 µs | 1.09× |
| raw drizzle() on same PGlite, select().where(eq) | 220.54 µs | fastest |

### List 50 rows

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/db handle, select().from() | 318.12 µs | 1.07× |
| raw drizzle() on same PGlite, select().from() | 297.08 µs | fastest |

Read the rows with the contracts in mind:

- @arki/db has no repository class. It adds the prefixed ID factory (cuid2 plus a typed, validated column) and the PGlite runtime, so query rows measure only that wrapper cost and the id default.
- Rows in the query groups run against a growing table for inserts; compare rows within a group only.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT — see [LICENSE](./LICENSE).
