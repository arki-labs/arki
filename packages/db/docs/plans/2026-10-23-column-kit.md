# Plan: Tier 2, the column kit and SQLite tables in five packages

Date: 2026-10-23
Source: [`docs/arki/research/17-multi-database/design.md`](../../../../docs/arki/research/17-multi-database/design.md) § 3.5 and § 5, Tier 2 (D-2: column kit).
Category: clean. One table definition per package, written against a kit; each dialect's kit builds that dialect's real Drizzle table. The one type boundary (runtime-built table → computed type) is an overload signature locked by exact type-equality tests, the same boundary `composition.ts` already has.

## Goal

A package writes each table once. An app gets that table on Postgres or SQLite with the same types it would get from a hand-written `pgTable` / `sqliteTable`. Postgres output does not change: no migration for existing apps.

**Scope (founder, 2026-10-23):** the kit, then contracts, auth, ai, offline and fs. payments moves after Tier 3 (its SQLite query layer is ~3,500 lines and shrinks with Tier 3's `now`/interval/claim helpers). mail moves to Tier 3 with journal (it ships no tables; it rides journal's `jobs` and `pg_notify`).

**Done when:**

1. `pgColumns(schema?)` (`@arki/db/pg`) and `sqliteColumns({ prefix? })` (`@arki/db/sqlite`) build tables whose types are **identical** (strict `Equal`) to hand-written `pgTable` / `sqliteTable` for every column kind and modifier the five packages use.
2. A kit-built Postgres table emits the same DDL as the hand-written table it replaces (`getTableConfig` comparison per package), so drizzle-kit sees no diff.
3. contracts, auth, ai, offline and fs each pass their existing Postgres tests unchanged, plus a SQLite (libSQL `:memory:`) leg of the same behavior tests.
4. A SQLite table cannot be passed to a Postgres db (compile error), and a package query file for one dialect cannot receive the other dialect's db.

## Spike results (2026-10-23, scratchpad)

- A generic factory `tables<D extends Dialect>(c: ColumnKit<D>)` type-checks, and the result for `D = 'pg'` is **identical** to a hand-written `pgTable` (strict `Equal` on the table, `$inferSelect`, `$inferInsert`, select rows). SQLite row and insert types match too.
- The column spec must be our own class (`ColumnSpec<D, Kind, Flags>`): calling Drizzle builder methods on a dialect-generic builder type collapses to a union and loses `D`. The spec records the chain; the dialect kit replays it on real builders in `table()`.
- pg types must use pg-core's own helpers (`SetNotNull`, `SetIsPrimaryKey`, `SetHasDefault`, `Set$Type`, `PgBuildColumns`); SQLite uses drizzle's generic ones (`NotNull`, `IsPrimaryKey`, `HasDefault`, `$Type`, `BuildColumns<…, 'sqlite'>`).
- **One query body cannot serve both dialects.** `db.select()` on "Postgres or SQLite db" does not compile: Drizzle's builders are different classes. Packages therefore keep one query file per dialect, each fully typed, run by one shared behavior suite.
- libSQL 3.45.1 has `->>`, `json_each`, `FILTER (WHERE)`, `power()`, `regexp`, scalar `min`/`max`, `unixepoch('subsec')`, partial indexes, `CHECK`, window functions. It lacks `pow()` and Unicode-aware `lower()`/`LIKE`; decimal math is float.

## The kit (`@arki/db`)

**`src/columns.ts`** (new, entry `./columns`, dialect-free runtime; type-only imports from pg-core and sqlite-core):

- `ColumnSpec<D, K, F>`: immutable; methods `notNull()`, `primaryKey()`, `default(value)`, `defaultNow()`, `$defaultFn(fn)`, `$onUpdateFn(fn)`, `$type<T>()`, `unique()`, `references(fn, { onDelete?, onUpdate? })`. Each returns a new spec with the flag added in its type.
- `ColumnKit<D>`: `dialect`, `table(name, columns, extras?)`, column kinds `text({ enum? })`, `varchar(length)`, `char(length)`, `integer()`, `bigint()` (number mode), `boolean()`, `json<T>()` / `json(zodSchema)`, `timestamp({ withTimezone? })` (Date), `instant({ withTimezone?, precision? })` (Temporal), `id(declaration)` (the `idColumns` set as specs), and extras `index(name)`, `uniqueIndex(name)`, `unique(name)`, `check(name, sql)`, `desc(column)`.
- `TableOf<D, Name, Columns>`: the computed table type (spike shape). Table `schema` is typed `string | undefined` (the schema name is not carried as a literal; nothing in Drizzle's query or insert types reads it).
- Kinds and their dialect forms:

| Kind | Postgres | SQLite |
| --- | --- | --- |
| `text({ enum })` | `text` | `text` |
| `varchar(n)` / `char(n)` | `varchar(n)` / `char(n)` | `text` + table `CHECK (length(col) <= n)` added by the kit (`= n` for `char`) |
| `integer` / `bigint` / `boolean` | same | `integer` / `integer` / `integer` boolean mode |
| `json` | `jsonb` | `text` json mode |
| `timestamp` | `timestamp` (± tz) Date mode | `integer` `timestamp_ms` |
| `instant` | `@arki/db/temporal` `instant` | new SQLite `instant`: integer ms ↔ `Temporal.Instant` |
| `defaultNow()` | `defaultNow()` | `default(sql\`(cast(unixepoch('subsec') * 1000 as integer))\`)` |

- On SQLite, `schema` becomes a table-name prefix: `sqliteColumns({ prefix: 'auth_' })`.
- Wrong-dialect values inside extras and `references` (a union in the generic body) are narrowed with Drizzle's `is()`; a mismatch is a bug and throws.

**`src/pg.ts`** adds `pgColumns(schema?: PgSchema)`. **`src/sqlite.ts`** adds `sqliteColumns({ prefix? })` and the SQLite `instant`.

**Tests:** `columns.test-d.ts` (strict `Equal` against hand-written tables, every kind × modifier the packages use, both dialects; wrong-dialect `@ts-expect-error`), `columns.test.ts` (runtime: `getTableConfig` per kind, DDL equality on pg, a libSQL round trip per kind incl. the length `CHECK` rejecting an over-long value).

## Packages

Each package follows the same shape: the table factory moves to a dialect-free file and takes `ColumnKit<D>`; Postgres query code stays where it is; a SQLite query file is added only where the package runs its own queries; the existing PGlite suites get a libSQL twin through a shared behavior function.

| Package | Table work | Query work | New entry |
| --- | --- | --- | --- |
| contracts | none | `createSelectSchema`/`Insert`/`Update` accept SQLite tables; `jsonColumn` stays pg (the kit's `json(schema)` covers SQLite) | — |
| ai | `createTombstoneTable(c, …)` | SQLite twin of `tombstoneOutbox` (~40 lines) | `./drizzle` gains `./drizzle/sqlite` |
| offline | `createIdempotencyTable(c)` | SQLite twin of the repository (~90 lines) | `./orpc` stays; repository chosen by `dialectOf(db)` |
| auth | `createAuthTables(c, …)`, `createWorkspaceTables(c, …)`, `tweaksColumn` | none (Better Auth runs queries); adapter `provider` from `dialectOf`; `AuthDb` widens to both dialects | `./sqlite`, `./sqlite/workspaces` |
| fs | `filesTable(c, …)` (regex check → `regexp` on SQLite) | SQLite `storage` + `cleanup` (~400 lines): `now()` from JS, ms arithmetic, cleanup claim = one `UPDATE … RETURNING` in the write transaction (no `SKIP LOCKED`) | `./sqlite` |

Exact entry names and call shapes are confirmed against each package's exports before its step; a breaking signature change is a MINOR changeset with the app sweep in the same commit (2 apps call `createAuthTables`, 1 `createWorkspaceTables`, 1 `createIdempotencyTable`).

## Known SQLite limits (documented in each README)

1. Case-insensitive matching (`ilike`, `lower()`) covers ASCII letters only.
2. Timestamps keep milliseconds, not microseconds.
3. fs cleanup workers in different processes take turns instead of running in parallel.
4. Unique-violation errors carry no constraint name.
5. Not `STRICT`: drizzle-kit cannot emit `STRICT` tables, so SQLite accepts a wrongly typed value written by raw SQL. Drizzle-typed writes are unaffected. Deferred until drizzle-kit supports it.

## Steps (one commit each)

1. Kit core + pg kit + type tests (`columns.ts`, `pg.ts`).
2. SQLite kit + SQLite `instant` + runtime tests (`sqlite.ts`).
3. contracts.
4. ai.
5. offline.
6. auth (+ app sweep).
7. fs.
8. Docs: `@arki/db` README "Tables in packages", per-package README SQLite sections, changesets, research design.md Tier 2 row.

## Verification per step

- `bun run --cwd packages/<pkg> typecheck`, `test`, `test:docs` where present, and `turbo lint --filter=@arki/<pkg>` (no new problems).
- After step 8: `test:runtimes` for db, `//#layers` for the touched packages.
