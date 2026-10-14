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

## Subpath exports

- `@arki/db` / `@arki/db/init` — `createDb`, `initDb`, `initDbWithOptions`. Under Bun, `./init` resolves to a Bun-native SQL driver.
- `@arki/db/factory` — `createDb` + connection-option helpers.
- `@arki/db/builder` — typed projection builder.
- `@arki/db/runtime-local` — PGlite-backed embedded runtime.
- `@arki/db/env` — validated env object.
- `@arki/db/id`, `@arki/db/id-factory` — CUID-based prefixed-ID helpers.
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
