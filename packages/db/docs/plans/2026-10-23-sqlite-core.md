# Plan: Tier 1, SQLite (libSQL) in `@arki/db`

Date: 2026-10-23
Source: [`docs/arki/research/17-multi-database/design.md`](../../../../docs/arki/research/17-multi-database/design.md) § 5, Tier 1, and [`spike/results.md`](../../../../docs/arki/research/17-multi-database/spike/results.md).
Category: clean. One new driver behind its own entry, one error translation at the existing seam, one client decorator over a public interface.

## Goal

An app keeps its own tables on SQLite through `@arki/db`. It connects through the `db()` plugin or `createLibsqlDb`, and gets the same behavior it gets on Postgres from `runTransaction`, `createUnitOfWork`, `isUniqueViolation`, `dbMigrations` and `idColumns`.

**Done when:**

1. `db({ relations, url })` from `@arki/db/libsql/dot` boots and publishes a Drizzle `LibSQLDatabase`.
2. Concurrent transactions and plain writes on one local libSQL file all succeed: no `SQLITE_BUSY` within a process.
3. A SQLite unique violation reads as `23505`, and `SQLITE_BUSY` (another process holds the lock) is retried by `runTransaction`.
4. `migrateDb` and `pendingMigrations` work on libSQL.
5. `idColumns` exists for SQLite tables.
6. Sync SQLite drivers (bun:sqlite, node:sqlite, better-sqlite3) are refused by `runTransaction` with a coded error, never run.

## Decisions taken in this plan

- **Errors are translated at the existing seam.** `findDatabaseError` (`src/sql-state.ts`) already returns a SQL-standard SQLSTATE that `isUniqueViolation`, `retryableSqlState` and `classifyTransactionFailure` read. It gains a SQLite reader that maps SQLite's extended result code to the standard SQLSTATE. Everything downstream works unchanged, and the public failure shapes (`TransactionConflict.data.sqlState`, `TransactionRejected.data.sqlState`) stay as they are. This replaces the design's separate `classifyError()`: one seam, not two.
- **`SQLITE_BUSY` maps to `40001`.** It means "the lock was taken; nothing ran; try again", which is what class `40` asks of the caller. Within one process the write queue (below) prevents it, so it only appears when another process writes the same file.
- **The write queue is a client decorator, not a mutex around `transaction()`.** The Tier 1 spike follow-up (2026-10-23) showed that `createClient({ timeout })` does not help at any value: every pooled connection runs on the one JavaScript thread, so a connection waiting for the lock blocks the transaction that holds it. And plain `db.insert()` outside a transaction also hits `SQLITE_BUSY` while a transaction is open. Only an open transaction holds a lock across an `await`, so the decorator makes every other client call wait while one is open. Queries inside the transaction run on the transaction object and never wait. It applies to local URLs (`file:`, `:memory:`); a remote libSQL server does its own locking.
- **The dialect is in the type, so the driver is named.** The libSQL plugin is its own entry, `@arki/db/libsql/dot`, not URL sniffing: `services.db`'s type must be known at compile time, and the URL is read at boot. A URL whose scheme does not match the plugin (`postgres://` to the libSQL plugin, `file:` to `pg`) fails at boot with a coded error. This refines D-4.
- **Deferred, with reasons:**
  - `Db<D>`, `AnyDb` and the capability record have no consumer until package tables (Tier 2) and capabilities (Tier 3).
  - The journal and queue `is(tx, PgAsyncTransaction)` checks stay: journal is Postgres-only until Tier 3, and another session is editing it.
  - SQLite `STRICT` tables are a migration-generation concern for Tier 2.
  - `builder.ts` (`createDbBuilder`) stays Postgres. Dot's `repos()`/`transactions()` are already typed by `TransactionalDb`.

## Task 1: dialect detection

Files: create `packages/db/src/dialect.ts`, `packages/db/src/dialect.test.ts`.

- `DIALECTS = ['pg', 'sqlite'] as const`, `type Dialect`.
- `dialectOf(db: object): Dialect | undefined`: Drizzle's `is()` against `PgAsyncDatabase` (pg-core) and `SQLiteAsyncDatabase` (sqlite-core). A transaction is a database subclass, so it answers too.
- `isTransaction(db: object): boolean`: `PgAsyncTransaction` or `SQLiteAsyncTransaction`.
- `isLibsql(db: object): boolean`: `LibSQLDatabase` or `LibSQLTransaction` (`drizzle-orm/libsql`). The type-only import keeps `@libsql/client` out of `dialect.ts`'s runtime graph; `is()` needs the class, so import the class from `drizzle-orm/libsql/session` (a Drizzle file, no client import). Verify that import pulls no `@libsql/client` at runtime.

Tests: a PGlite database and its transaction → `'pg'`, `isTransaction` false/true. A libSQL `:memory:` database and its transaction → `'sqlite'`, `isLibsql` true. A `drizzle-orm/sqlite-proxy` database → `'sqlite'`, `isLibsql` false. A plain object → `undefined`.

## Task 2: SQLite errors at the SQLSTATE seam

Files: modify `packages/db/src/sql-state.ts`; create `packages/db/src/sql-state.sqlite.test.ts`.

- In the `cause` walk, an object whose string `code` starts with `SQLITE_` or equals `ERR_SQLITE_ERROR` is a SQLite error. Its extended result code is the first number among `rawCode` (libSQL), `errcode` (node:sqlite) and `errno` (bun:sqlite).
- One `as const` table maps it:

| Extended code | SQLite name | SQLSTATE |
| --- | --- | --- |
| 2067 | `SQLITE_CONSTRAINT_UNIQUE` | `23505` |
| 1555 | `SQLITE_CONSTRAINT_PRIMARYKEY` | `23505` |
| 787 | `SQLITE_CONSTRAINT_FOREIGNKEY` | `23503` |
| 1299 | `SQLITE_CONSTRAINT_NOTNULL` | `23502` |
| 275 | `SQLITE_CONSTRAINT_CHECK` | `23514` |
| 5, 261, 517, 773 | `SQLITE_BUSY` and its extended codes | `40001` |

- An unmapped SQLite code returns `undefined` (the existing "not a database answer" path). `constraint` is `undefined`: SQLite names columns, not constraints.
- libSQL nests a `SqliteError` under its `LibsqlError`. The first one decides, which matches the existing rule.

Tests:

- Real errors from libSQL (`:memory:`): duplicate key → `isUniqueViolation` true; foreign key with `PRAGMA foreign_keys = ON` → `23503`; not null → `23502`.
- The bun:sqlite and node:sqlite shapes are plain objects copied field for field from `spike/results.md` (vitest runs on Node 22 here, which cannot load either driver). Say so in a comment.
- `isUniqueViolation(error, 'some_constraint')` is false on SQLite (no constraint name). Pin it so a caller learns it from a test, not production.

## Task 3: the libSQL driver and its write queue

Files: create `packages/db/src/libsql.ts`, `packages/db/src/libsql-queue.ts`, `packages/db/src/libsql.test.ts`; modify `packages/db/package.json` (exports `./libsql`; `@libsql/client` as an optional peer dependency and a dev dependency, version `^0.18.0`, the one installed; keep devDependencies sorted).

- `libsql-queue.ts`: `queueWrites(client: Client): Client`. It wraps a `@libsql/client` `Client` and keeps one turn:
  - `transaction(mode)` waits for the turn, opens the inner transaction, and gives the turn back when it ends (`commit`, `rollback` or `close`, success or failure);
  - every other call (`execute`, `batch`, `executeMultiple`, `migrate`) waits while a transaction holds the turn, then runs;
  - `close` and the read-only properties pass straight through.
- `libsql.ts`: `createLibsqlDb({ url, authToken?, relations, logger? })` returns `{ db, close }`. Local URLs get `queueWrites`; remote ones do not. Re-export `type LibSQLDatabase`.

Tests, each with its why:

- The spike's scenario (8 transactions, 8 plain inserts and 8 selects at once on one file): all succeed with 16 rows. This is the in-process `SQLITE_BUSY` the queue exists for.
- A throw after an `await` inside a transaction rolls back, and the next transaction still gets the turn. A failed transaction must not hold the lock forever.
- A query inside a transaction does not wait on the queue. If it did, the transaction would deadlock on itself.
- `:memory:` works (one connection).

## Task 4: transactions on SQLite

Files: modify `packages/db/src/transaction.ts`, `packages/db/src/owned-transaction.ts`, `packages/db/src/composition.ts`, `packages/db/src/transaction-errors.ts`; create `packages/db/src/transaction.sqlite.test.ts`.

- `assertTransactionRoot` uses `isTransaction` instead of `is(db, PgAsyncTransaction)`.
- Refuse unsafe SQLite drivers: when `dialectOf(db) === 'sqlite'` and not `isLibsql(db)`, throw `DbTransactionError` with a new code in `transaction-errors.ts` (`unsafeSqliteDriver`). The message says async callbacks lose their rollback on this driver; the remediation says to use `@arki/db/libsql`. Check in `runTransaction` and in `transactionAttempt` (so `runTransactionOnce` and `createUnitOfWork` are covered).
- Isolation: pass `{ isolationLevel }` only on `pg`. SQLite transactions are already serializable (one writer).
- `TransactionalDb`'s `config` parameter must accept the libSQL database. Widen it to the union of the pg and SQLite transaction configs, or whatever the type test proves is needed. No casts.

Tests (libSQL file):

- `runTransaction` commits; returning a Failure rolls back.
- A `SQLITE_BUSY` from a second client on the same file (a separate `createClient`, standing in for a second process, holding `BEGIN IMMEDIATE`) is retried until it is released, with `attempts > 1`.
- `createUnitOfWork` over libSQL commits and rolls back.
- A `sqlite-proxy` database → `runTransaction` throws `unsafeSqliteDriver`.
- A type test: `runTransaction(libsqlDb, tx => ...)` infers `tx` as `LibSQLTransaction`.

## Task 5: migrations on libSQL

Files: modify `packages/db/src/migrate.ts`; create `packages/db/src/migrate.sqlite.test.ts`.

- `MigratableDb` adds `LibSQLDatabase<TRelations>`.
- `migrateDb` branches on `dialectOf`: pg → the pg-core `migrate` (unchanged); sqlite → the SQLite migrator for an in-memory list (`migrate`/`migrateAsync` in `drizzle-orm/sqlite-core`; check the exported name). `migrationsSchema` does not apply on SQLite (no schemas); ignore it there and say so in the JSDoc.
- `pendingMigrations` on SQLite checks `sqlite_master` for the table, then reads its rows with the same `appliedRowSchema`.

Tests: a two-step SQLite migration folder built in a temp dir (as `migrate.test.ts` does): two pending → apply → none pending → a second apply is a no-op. `dbMigrations()` boots on an app that uses `@arki/db/libsql/dot`.

## Task 6: `db()` from `@arki/db/libsql/dot`

Files: `packages/db/src/libsql/dot.ts`, `packages/db/src/libsql/dot.test.ts`, `packages/db/src/libsql/dot.test-d.ts`; the shared URL check and error codes in `packages/db/src/dot-errors.ts`.

Changed 2026-10-31: this first shipped as `db({ driver: 'libsql' })` in `@arki/db/dot`, with a dynamic `import('./libsql.js')`. Vite and Nitro bundle a dynamic import too, so every app on `@arki/db/dot` failed to build without `@libsql/client`. The plugin now has its own entry (A-42: one module per backend, as `drizzle-orm/libsql` sits next to `drizzle-orm/node-postgres`), and `@arki/db/dot` never reaches `@libsql/client`.

- `LibsqlDbDotOptions`: `relations`, `logger?`, `url?: () => string | undefined` (falls back to `DB_URL`), `authToken?: () => string | undefined`.
- The plugin imports `createLibsqlDb` statically. `dispose` closes the client.
- `services.db` is `LibSQLDatabase<R>`. No `sessionPool`: SQLite has no LISTEN.
- New `DB_PLUGIN_ERROR_CODES.driverUrlMismatch` (`ARKI_DB_PLUGIN_E005`). Thrown at boot when the URL's scheme does not fit the driver: libsql takes `file:`, `libsql:`, `http(s):`, `ws(s):`; pg takes `postgres:`/`postgresql:`. The message names both.

Tests: boot on a temp `file:` URL, round-trip a query, dispose. `postgres://` to the libSQL plugin → E005, and `file:` with the pg driver → E005. Type test: `Provided<typeof libsqlDb.provides.db>` is `LibSQLDatabase<typeof relations>`, and `sessionPool` is absent.

## Task 7: `idColumns` for SQLite

Files: create `packages/db/src/sqlite.ts` (the `@arki/db/sqlite` entry: `export * from 'drizzle-orm/sqlite-core'` plus SQLite `idColumns`), `packages/db/src/sqlite.test.ts`; modify `packages/db/src/id-factory.ts` (move the dialect-free helpers, such as `tagColumnSchema`, into a shared private module) and `packages/db/package.json` (exports `./sqlite`).

- Same shape as the pg `idColumns` (`primaryColumn`, `reference`, `optionalReference`, `foreignKey`, `optionalForeignKey`, `createForeignKeyFactory`), built on SQLite `text(name)`.
- Tests mirror `id-columns.test.ts`: the column's type is the branded id; `createInsertSchema` rejects a wrong prefix; a foreign key to another SQLite table compiles and is enforced (libSQL with `PRAGMA foreign_keys = ON`).

## Task 8: docs and changeset

Files: modify `packages/db/README.md` (runtime-support rows for `@arki/db/libsql` and `@arki/db/sqlite`; a "SQLite (libSQL)" section; the "When not to use this" bullet); create `.changeset/db-sqlite-libsql.md` (`'@arki/db': minor`).

The section covers:

- setup through `db()` from `@arki/db/libsql/dot` and through `createLibsqlDb`;
- one write transaction at a time per process, and why (link the spike);
- errors read as SQLSTATE, with no constraint names;
- refused drivers and why;
- what is still Postgres-only: package tables (auth, payments, …), journal, lock, live.

Its code block uses `skip="…"` only if it cannot typecheck in the docs fixture.

## Verification

From `packages/db`, foreground, `timeout 600`:

| Command | Shows |
| --- | --- |
| `bun run test -- src/dialect.test.ts src/sql-state.sqlite.test.ts src/libsql.test.ts src/transaction.sqlite.test.ts src/migrate.sqlite.test.ts src/sqlite.test.ts src/dot.test.ts` | the new behavior |
| `bun run test` | no regressions (the known `orpc.test.ts` "out of retries" failure predates this plan) |
| `bun run test:docs` | README blocks |
| repo root: `turbo run typecheck lint --filter=@arki/db` and `bun run layers` | types, lint (only the 19 known problems), package boundaries |
| `bun run lint:ws` | workspace manifest |

Run typecheck and lint after each task, not only at the end (Tier 0 cost note).

## Order

1 → 2 → 3 → 4 → 5 → 6. Task 7 depends only on 1 and can go in parallel with 3 to 6. Task 8 is last.
