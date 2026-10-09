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

const { db, pglite } = await initDbRuntimeLocal(
  { dataDir: './.local/db' },
  { relations },
);
```

### Projections (event sourcing read models)

```ts
import { initDb } from '@arki/db/builder';

const d = initDb
  .schema(schema)
  .create({ connectionString: env.DB_URL, isDev: true });

const userProjection = d.projection
  .named('user-projection')
  .on(['UserRegistered'])
  .handle(async (events, { db, repo: _repo }) => {
    // ...
  });
```

### Branded IDs

```ts
import { createPrefixedId, createIdFactory } from '@arki/db/id';

const userId = createPrefixedId('usr_'); // 'usr_…'
const idFactory = createIdFactory('post_');
const postId = idFactory.next();
```

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
- `@arki/db/bun` — Bun-SQL driver entry (also routed via the `bun` condition on `./init`).
- `@arki/db/client` — types-only client surface reserved for future Tier-3 sync work.

## Environment variables

| Variable                                | Purpose                                                       |
| --------------------------------------- | ------------------------------------------------------------- |
| `DB_URL`                                | Primary Postgres connection URL.                              |
| `PGHOST`, `PGPORT`, `PGUSER`, …         | Individual params when `DB_URL` is not used.                  |
| `DB_POOL_MIN`, `DB_POOL_MAX`            | Connection pool sizing (default `2` / `20`).                  |
| `DB_POOL_IDLE_TIMEOUT`                  | Idle pool timeout in ms (default `30000`).                    |
| `DB_POOL_CONNECTION_TIMEOUT`            | Acquire timeout in ms (default `2000`).                       |
| `DB_LOGGING`                            | Enable Drizzle logger when truthy.                            |
| `DB_STATEMENT_TIMEOUT`, `DB_QUERY_TIMEOUT` | Per-statement / per-query timeouts in ms.                  |

## Documentation

`@arki/db` ships an optional `@arki/db/dot` adapter for the
[`@arki/dot`](https://www.npmjs.com/package/@arki/dot) framework.

- See `packages/dot/docs/` in the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
  package for plugin authoring, lifecycle, diagnostics, and the
  [adapter authoring guide](https://github.com/arkijs/arki/blob/main/packages/dot/docs/adapter-authoring.md).

## License

MIT — see [LICENSE](./LICENSE).
