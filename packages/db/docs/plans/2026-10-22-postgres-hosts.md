# Plan: Tier 0, hosted Postgres in `@arki/db`

Date: 2026-10-22
Source: [`docs/arki/research/17-multi-database/design.md`](../../../../docs/arki/research/17-multi-database/design.md) § 5, Tier 0 (accepted).
Category: clean. It adds one option, one env var, one service and one pure helper, following the plugin's existing patterns.

## Goal

An app on Neon, Supabase, PlanetScale Postgres or CockroachDB sets two URLs and everything works. When a session feature (LISTEN, session locks) is pointed at a pooled URL, it fails with a message that names the host and the fix, instead of hearing nothing.

**Done when:**

1. `db({ url, directUrl })` publishes a pool for session features on the direct URL.
2. A known pooled URL with no direct URL makes that pool's `connect()` reject with a coded error naming the host and `DB_DIRECT_URL`.
3. The `@arki/db` core passes a test run against a real CockroachDB, and its gaps are recorded.
4. The README has a hosted-Postgres section with a capability table.

## Assumptions and scope

- **No new drivers.** `pg` (node-postgres) already reaches every Tier 0 host. postgres-js uses named prepared statements by default, which break behind transaction-mode poolers. The Neon serverless drivers (`neon-http`, `neon-serverless`) are for edge runtimes and move to the Edge tier. Task 6 records this change in the design.
- **Pooler detection is a short, verified list.** Neon pooled hosts contain `-pooler.`. Supabase transaction mode is `*.pooler.supabase.com` on port `6543`; session mode (port `5432`) keeps LISTEN (unverified, feature-matrix.md). No guessing on port `6432` or unknown hosts: an unknown URL counts as direct.
- **The pool fails on `connect()`, not at boot.** Apps that never use LISTEN or session locks must boot on a pooled URL. Dot calls provider factories at boot, so the factory must not throw for a pooled URL.
- **CockroachDB retries need no code.** `runTransaction` already retries `40001` at SERIALIZABLE (`src/transaction.ts:88`), and CockroachDB returns `40001` for its retries. Task 4 proves it on a real CockroachDB.
- **Only the `pg` driver gets the new service.** PGlite listens through `client.listen`, not a `ListenPool`.

**Service name:** `sessionPool` (founder, 2026-10-22).

## Task 1: pooler detection and direct-URL resolution

Files: create `packages/db/src/hosts.ts`, `packages/db/src/hosts.test.ts`.

- `const poolers = [...] as const`. Each entry: `host` (`'neon' | 'supabase'`, the union inferred from the array), `matches(url: URL): boolean`, and `directHint` (one sentence: where the host's dashboard shows the direct URL).
- `pooledHostOf(url: string)` returns the matching entry's `host`, or `undefined`. It parses with `new URL`. A URL that does not parse returns `undefined`: env validation (`z.url()`) has already rejected bad URLs.
- `resolveDirectUrl({ url, directUrl })`:
  - `directUrl` set → return it.
  - else `url` not pooled → return `url`.
  - else return a Failure carrying the host, in the style `runtime-local.ts` uses (`isFailure` at the call site).
- Exported from `src/pg.ts` (the `@arki/db/pg` entry). Non-Dot apps (24 call `createDb`) use it to build their own listen pools.

Tests (`hosts.test.ts`), each stating why:

- A Neon `-pooler.` host → `'neon'`. The direct Neon host (same name without `-pooler`) → `undefined`.
- Supabase `pooler.supabase.com:6543` → `'supabase'`. The same host on `5432` → `undefined`: session mode keeps LISTEN.
- `localhost:5432` and a plain RDS host → `undefined`.
- `directUrl` wins even when `url` is pooled.
- Pooled `url` with no `directUrl` → a Failure that names the host.

## Task 2: `DB_DIRECT_URL`

Files: modify `packages/db/src/env.ts`, `packages/db/src/env.test.ts`, `packages/db/README.md` (env table at line ~739), `turbo/generators/templates/application/server/.env.example` (template sync rule).

- `DB_DIRECT_URL: z.url().optional()`, read from `process.env['DB_DIRECT_URL']`. No `DATABASE_*` alias: there is no common convention to match.
- Test: set → parsed; unset → `undefined`; not a URL → validation error.
- `.env.example`: a commented `# DB_DIRECT_URL=`, with one comment line: "only for a pooled DB_URL (Neon -pooler, Supabase :6543)".

## Task 3: the `db()` plugin publishes `sessionPool`

Files: modify `packages/db/src/dot.ts`, `packages/db/src/dot.test.ts`, `packages/db/src/dot.test-d.ts`.

- `PgDbDotOptions` gains `directUrl?: () => string | undefined`, read at boot like `url`, falling back to `env.DB_DIRECT_URL`.
- `createPgPlugin` provides a second service, `sessionPool`, of type `ListenPool & { end(): Promise<void> }` (`ListenPool` from `src/pg-listen.ts`):
  - `resolveDirectUrl` succeeds → `new pg.Pool({ connectionString, max: 4 })`. It is separate from the query pool, so held LISTEN clients never take query connections. `pg.Pool` opens no socket until `connect()`.
  - It fails → an object whose `connect()` rejects with a `DotUnitError`, code `DB_PLUGIN_ERROR_CODES.sessionOnPooledUrl`. Add it next to `dbUrlNotConfigured` (`dot.ts:83`), with the same JSDoc `@fix` shape and the next `arki-db-plugin-e00N` docs URL. Message: `[db] LISTEN and session locks need a direct connection, but DB_URL is the <host> pooler.` Remediation: set `DB_DIRECT_URL` (or `directUrl`), plus the entry's `directHint`.
- `dispose` ends `sessionPool` (when it is a real pool) after the query pool.
- `DbServices` gains the service only for the `'pg'` driver.

Tests:

- `dot.test.ts`, Neon pooled `url` and no `directUrl`: the app boots and `services.db` works (PGlite is not usable here, so assert on the built objects). `sessionPool.connect()` rejects with `sessionOnPooledUrl`, and the message contains `neon` and `DB_DIRECT_URL`. Why: booting must not depend on session features, but using them must fail loud.
- With `directUrl`: the pool's `options.connectionString` equals the direct URL.
- Plain `url`: the pool uses `url`.
- `dispose` ends both pools (spy on `end`).
- `dot.test-d.ts`: `@ts-expect-error` on reading `sessionPool` from the PGlite plugin's services.

## Task 4: prove the core on CockroachDB

Files: create `packages/db/src/cockroach.crdb.test.ts`.

- Gate with `describe.runIf(process.env['ARKI_DB_CRDB'] === '1')`. The image is large; normal `vitest run` must not pull it. The run summary shows the file as skipped, which is the expected state.
- Start `GenericContainer` from `testcontainers` (already a dependency through `@testcontainers/postgresql`). Use `cockroachdb/cockroach`, pinned to the newest stable `vX.Y.Z` tag on Docker Hub at implementation time, with the command `start-single-node --insecure`, port 26257. Write the tag in the file.
- Cases, each checking one Tier 0 claim:
  1. `createDb` + an RQBv2 insert and select round trip.
  2. `runTransaction`: two concurrent read-modify-write transactions on one row both succeed, and at least one sees `attempts > 1`. This proves the `40001` retry works on CockroachDB.
  3. A duplicate insert is classified as a unique violation by `src/errors.ts` (the existing SQLSTATE `23505` path).
  4. `migrate()` applies a two-step fixture migration folder (`src/__fixtures__/`), including the `drizzle` schema bookkeeping table.
  5. `listenOnPool(pool, 'x')` start rejects. CockroachDB has no LISTEN, so this records the gap, not a bug.
- Any case that fails on CockroachDB because the feature is missing is changed to assert the failure, and is listed in Task 6. It is never deleted.

Run: `cd packages/db && ARKI_DB_CRDB=1 timeout 600 bun run test -- src/cockroach.crdb.test.ts`.

## Task 5: docs and changeset

Files: modify `packages/db/README.md`, `packages/lock/README.md` (lease `listen` example), `packages/journal/README.md` (worker `listen` example). Create `.changeset/db-hosted-postgres.md` (`'@arki/db': minor`).

- README, new section "Hosted Postgres" after "Runtime support". A table with columns: host | `DB_URL` | `DB_DIRECT_URL` | LISTEN | session locks | notes. Rows: Neon, Supabase, PlanetScale Postgres, CockroachDB (from Task 4's results), self-hosted behind PgBouncer. Then three short recipes:
  - wire `sessionPool` into `listenOnPool`;
  - wire it into the lock lease `listen`;
  - run migrations against `DB_DIRECT_URL` (Neon's docs require the direct URL for migrations).
- lock and journal READMEs: replace any hand-built `new pg.Pool` in the `listen` examples with `services.sessionPool`.
- Changeset text: what was added (`directUrl`, `DB_DIRECT_URL`, `sessionPool`, `pooledHostOf`, `resolveDirectUrl`) and the new error code.

## Task 6: update the research

Files: modify `docs/arki/research/17-multi-database/design.md` (Tier 0 row in § 5) and `docs/arki/research/17-multi-database/feature-matrix.md` (CockroachDB column).

- Tier 0 row: drivers moved to the Edge tier, with the reason (postgres-js prepared statements; edge-only Neon drivers).
- CockroachDB: replace the "(u)" cells with Task 4's results.

## Verification

Run from `packages/db` unless noted. Each command runs in the foreground under `timeout 600`.

| Command | Shows |
| --- | --- |
| `bun run test -- src/hosts.test.ts src/env.test.ts src/dot.test.ts` | detection, env and plugin behavior |
| `ARKI_DB_CRDB=1 bun run test -- src/cockroach.crdb.test.ts` | the core works on CockroachDB; gaps recorded |
| `bun run test` | nothing else broke (the pg containers run as today) |
| `bun run test:docs` | README code blocks still compile |
| repo root: `turbo run typecheck lint --filter=@arki/db --filter=@arki/lock --filter=@arki/journal` | types, including `dot.test-d.ts` |

## Order

Tasks 1 → 2 → 3 depend on each other. Task 4 is independent and can run in parallel. Task 5 needs 3 and 4. Task 6 is last.
