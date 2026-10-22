# @arki/db agent guide

Read `llms.txt` first for the map. When this guide and the code disagree, `src/transaction.ts` and `src/orpc.ts` win.

This guide covers `@arki/db/transaction`, `@arki/db/orpc` and `@arki/db/eslint`, and the listener in `@arki/db/pg`.
The README has the setup. This page has the rules an agent needs to get them right.

## The model

1. `@arki/db` configures Drizzle for Postgres. It opens the connection, it does not wrap queries.
2. There are three drivers: node-postgres (`@arki/db/init`), Bun SQL (the `bun` condition) and PGlite (`@arki/db/runtime-local`). All speak Postgres.
3. A transaction is SERIALIZABLE. When PostgreSQL aborts it with `40001` or `40P01`, the whole handler runs again.
4. Nothing else is retried. A lost connection around `COMMIT` is recovered with an idempotency key, not a retry.
5. Ids are declared once with `defineId` from `@arki/contracts`. `idColumns` turns the declaration into columns.
6. A Dot feature gets its repositories from `repos()`. `repos.withTx(tx)` rebinds them to a transaction.
7. It does not write migrations (`drizzle-kit` does) and it does not run effects after a commit (the journal does).

## Task map

### Make a procedure transactional

1. Browser-shared contracts use `oc.errors(errorMap(...TRANSACTION_FAILURES))` with `TRANSACTION_FAILURES` from `@arki/db/contract` (browser-safe: never loads drizzle-orm or a driver) and `errorMap` from `@arki/failure/orpc`. Native contracts may use `transactionErrorMap` from `@arki/db/orpc`. Then build the middleware once: `const transact = transactionalProcedure(db, { repos: () => repositories, retries: 3 })`.
2. Implement the contract with `implement(contract, transactionalProcedureConfig)`.
3. Put `.use(transact)` last. Read `context.tx` and `context.repos` in the handler.
4. See `README.md` ("Transactional procedures").

### Retry a transaction outside oRPC

1. Call `runTransaction(db, async (tx, attempt) => work(tx), { retries: 3 })` from `@arki/db/transaction`.
2. Return failures unchanged, or handle `TransactionConflict.is(result)`; attempts and SQLSTATE live in `result.data`.
3. Use `runTransactionOnce` when preserving driver isolation/savepoints with no retries. Dot transactions and `createUnitOfWork` use this boundary.

### Handle a 409 from a transactional procedure

See [Decide what to do with a failure](#decide-what-to-do-with-a-failure).

### Recover from an ambiguous commit

See [Ambiguous commit recovery](#ambiguous-commit-recovery).

### Declare an id and its columns

1. Declare the id in a browser-safe file with `defineId('sty_')` from `@arki/contracts`.
2. Build the columns with `idColumns(storyId)` from `@arki/db/id`.
3. Reuse `storyId.schema` in table validator refinements for precise branded output. The metadata enforces runtime prefixes; Drizzle discards its static schema type.
4. Legacy `createIdFactory(prefix)` derives successful IDs from its schema; infer stored types with `IdOf<typeof factory>`, never the now-fallible generator's `ReturnType`. `create`/`make`/`new`, `createId` and `createPrefixedId` return canonical `IdGenerationFailure`. Prefixes and accepted stored suffixes stay unchanged, including empty/punctuation prefixes. All producers use the same secure Web Crypto sampler; there is no `Math.random` fallback. See [legacy ID failures](upgrades/legacy-id-failures.md).
5. JSON storage uses `jsonColumn(name, storageSchema)` from `@arki/contracts/drizzle`. Apply wire codecs only in explicit insert refinements, then store parsed output; select validates the stable storage schema.
6. `defineId().create()` returns an ID or `IdGenerationFailure`; narrow direct calls before passing them as values. Generated primary/required defaults bridge failures with `orThrow` because Drizzle requires a scalar. Raw inserts reject with `UnexpectedFailure`; owned transactions restore declared generation failures by identity after rollback. Explicit IDs bypass generation. `TRANSACTION_FAILURES` includes `ID_GENERATION_FAILURES`, so native transaction error maps cover these outcomes.

### Paginate with a keyset

1. Declare the order with `keyset(...)` from `@arki/contracts`.
2. Build the query with `keysetQuery(order, columns)` from `@arki/db/pagination`.
3. Check `after(cursor)` with `isFailure` before building SQL; check `page(rows, limit)` before accessing items. They preserve the original cursor decoder/encoder failure unions.
4. Use `CURSOR_FAILURES` from `@arki/contracts` in adapter error maps. Static empty keyset misuse still throws; malformed cursor/row data returns canonical failures.

### Back up and restore a database

See the recipe [Back up and restore](recipes/backup-restore.md).

## File map

| File                         | What it holds                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/transaction.ts`         | `runTransaction`, the settings schema, `retryableSqlState`, `DbTransactionError`, the error codes   |
| `src/orpc.ts`                | `transactionalProcedure`, the pipeline checks, `transactionalProcedureConfig`, `TransactionScopeOf` |
| `src/eslint.ts`              | `db/no-effects-in-transaction`                                                                      |
| `src/composition.ts`         | `TransactionalDb` (the port every database fits), `createUnitOfWork`                                |
| `src/__fixtures__/dot-app/`  | A Dot feature laid out the recommended way, run by `src/orpc.dot.test.ts`                           |
| `src/transaction.pg.test.ts` | Real conflicts on PostgreSQL: write skew, deadlock, 40001 at COMMIT, lost commits                   |
| `src/pg-listen.ts`           | `listenOnPool`: `LISTEN` on a dedicated pool client, reconnects, health check, `onState`            |

The receipt recipe for ambiguous commits is tested in `@arki/journal` (`src/orpc.db.test.ts`), so `db` never depends on the journal.

## How one call runs

1. Input is validated once (before every middleware).
2. Middlewares before `transact` run once: error mapping, timing, auth, `bind`.
3. `transact` checks the pipeline (first call per procedure), then refuses a nested call.
4. Attempt: `BEGIN` at SERIALIZABLE → `withTx(tx)` → handler → output validation → `COMMIT`.
5. On `40001` / `40P01`: Drizzle has rolled back and released the connection. Wait 10–250 ms (jittered), go to 4.
6. A returned Failure rolls back by a private carrier's exact identity; restore the full middleware result.
7. Out of retries: return `TransactionConflict` → declared `db.transaction_conflict`, 409.
8. Work completed but COMMIT unconfirmed: return `TransactionCommitUncertain`; never replay automatically.

## Decide what to do with a failure

| What happened                                             | Who handles it                      | What the client sees                                               |
| --------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `40001` / `40P01` within the retry budget                 | `runTransaction`, silently          | Success                                                            |
| `40001` / `40P01` on every attempt                        | `transact`                          | 409 `db.transaction_conflict`: retry later                         |
| A business rule says no (`ORPCError`, `CommandForbidden`) | Your code, once                     | That error                                                         |
| A journal version conflict (`JournalError` `CONFLICT`)    | `commandErrors()` before `transact` | 409 `CONFLICT`: reload, then retry                                 |
| Connection lost around `COMMIT` (ambiguous commit)        | Nobody retries                      | 503 `db.transaction_commit_uncertain`; reconcile with the same key |
| Same idempotency key after a real commit (receipt replay) | The journal                         | The first result, no new writes                                    |

Retry vs replay: a **retry** runs the handler again because the database said
the attempt lost (nothing was committed). A **replay** returns a stored result
because the work already committed. Only the database decides a retry; only a
receipt decides a replay.

## The SQLSTATE allowlist

Exactly two codes are retried:

| Code    | Name                    | Why it is safe                                                                 |
| ------- | ----------------------- | ------------------------------------------------------------------------------ |
| `40001` | `serialization_failure` | The transaction was aborted; nothing committed. PostgreSQL says: run it again. |
| `40P01` | `deadlock_detected`     | The victim was aborted; nothing committed.                                     |

The **nearest** `code` in the `cause` chain decides (depth ≤ 5). A wrapper
with its own code (`ORPCError`, `ECONNRESET`, a `DbTransactionError`) is final
even when an older `40001` sits deeper. Cycles, a throwing getter and an
`AggregateError` are not retried. Messages are never matched. Not retried, on
purpose: `23505` (unique), `23P01` (exclusion), `25P02` (a SQL error was
swallowed), `57014` (statement timeout), connection errors.

## Rules that bite

- `transact` is the last `.use()` of the procedure. Anything after it reruns on every retry (`ARKI_DB_TX_E004`).
- Pass `transactionalProcedureConfig` to `implement`, or the output is validated after the commit (`ARKI_DB_TX_E004`).
- No `fetch`, queue writes or `.effect()` inside transactional code. They run once per attempt and do not roll back.
- Only `40001` and `40P01` are retried.
- PGlite never conflicts. Prove retry behaviour on real PostgreSQL.
- Do not catch a database error and carry on inside the handler. The transaction is poisoned (`25P02`).
- In a Dot feature, name the pool-bound repo source `repositories`. The bound set is `repos`.
- A PGlite data directory has one owner. Two handles corrupt it.

## Typed local runtime

`initDbRuntimeLocal()` returns a handle or a canonical failure. Check
`isFailure` before using the handle; its owned `close()` also returns failures.
The PGlite Dot provider propagates both unions. File-backed startup generates a
nominal UUID owner ID before filesystem mutation. Existing stored owner IDs
remain valid. Unconfirmed close retains ownership; failed release is retryable.

The `@arki/db` tracer emits `db.local.init`, nested `db.local.acquire` for
file ownership, and `db.local.close` for the shared cleanup attempt. Spans
inherit the caller's active context, including Dot boot/disposal context.
Only canonical failure codes are recorded. Libraries never configure an SDK;
reporting failures cannot repeat operations or change their returned outcomes.

| Code                              | Definition                  |
| --------------------------------- | --------------------------- |
| `db.local_data_dir_in_use`        | `DataDirInUse`              |
| `db.local_owner_lock_contended`   | `OwnerLockContended`        |
| `db.local_runtime_unavailable`    | `LocalRuntimeUnavailable`   |
| `db.local_runtime_refused`        | `LocalRuntimeRefused`       |
| `db.local_runtime_cleanup_failed` | `LocalRuntimeCleanupFailed` |

The canonical `LOCAL_RUNTIME_FAILURES` tuple also includes Contracts entropy
failures and `UnexpectedDefect`. See [migration and recovery](upgrades/local-runtime.md).

## Typed transaction outcomes

`TRANSACTION_FAILURES` is the sole registry; `TransactionFailure` and
`transactionErrorMap` derive from it. All callback failures keep their exact type.

| Code                              | Definition                   | Policy                                                                              |
| --------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| `db.transaction_conflict`         | `TransactionConflict`        | All bounded attempts lost; retry only under caller policy.                          |
| `db.transaction_rejected`         | `TransactionRejected`        | Explicit SQLSTATE rejection; correct the operation.                                 |
| `db.transaction_unavailable`      | `TransactionUnavailable`     | Driver connection failed before work completed; inspect private cause.              |
| `db.transaction_commit_uncertain` | `TransactionCommitUncertain` | Work completed; missing acknowledgement or connection/shutdown SQLSTATE; reconcile. |
| `db.transaction_cancelled`        | `TransactionCancelled`       | Cancelled before COMMIT or during retry delay.                                      |
| `db.transaction_defect`           | `TransactionDefect`          | Callback defect or failed rollback; fix the implementation.                         |

A returned failure never retries, even if rollback replaces its carrier with 40001.
Do not claim rollback succeeded when cleanup fails. The private cause preserves
both cleanup error and original returned failure.

### Migration dependencies and instrumentation

`migrate.ts` still parses database result rows with Zod `.parse()`; its typed
validation/migration boundary is separate work, alongside initialization and
repository/query ownership. No casts bypass those dependencies.

Existing retry logs and `arki:db:outcome` classified attempt logs are the scoped
observability surface. Driver query instrumentation owns query spans. Default
transaction spans, propagation and failing-telemetry proof remain T08 work; do not
claim full A-36 coverage from logs alone.

## Errors

ID column metadata uses `ContractsError` code `ARKI_CONTRACTS_E008` when a Drizzle builder has no runtime config. Use a supported builder and matching Drizzle version.

| Code              | Name                      | When                                                                                         | Fix                                                                          |
| ----------------- | ------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ARKI_DB_TX_E001` | legacy `retriesExhausted` | Retained static error constant; owned operations now return `TransactionConflict`            | Shorten the transaction; touch rows in a fixed order; raise `retries` (≤ 10) |
| `ARKI_DB_TX_E002` | `invalidOptions`          | `isolation` is not `'serializable'`, `retries` is not a whole number 0–10, or an unknown key | Fix the options. Nothing is clamped                                          |
| `ARKI_DB_TX_E003` | `nestedTransaction`       | A transactional procedure was called with a context already inside one                       | One `transact` per call; call the usecase directly instead                   |
| `ARKI_DB_TX_E004` | `invalidPipeline`         | `transact` is not the last `.use()`, or `implement` lacks `transactionalProcedureConfig`     | Move `.use(transact)` last; pass the config                                  |
| `ARKI_DB_TX_E005` | `unsupportedOutput`       | The handler returned a stream                                                                | Return plain data; stream from another procedure                             |
| `ARKI_DB_TX_E006` | `transactionAsRoot`       | The database given is a transaction                                                          | Pass the root database                                                       |

`isDbTransactionError(error, code?)` narrows an unknown error.

## Ambiguous commit recovery

The connection can drop after PostgreSQL committed but before the client
heard. `transact` never retries that: the error is not `40001` / `40P01`. The
client repeats the request with the **same** idempotency key, and the journal
receipt answers.

1. Run the write as a journal command on the procedure's transaction:
   `journal.run(context.tx, command, input, meta, { idempotencyKey })`. It
   becomes a savepoint; its events, jobs and receipt share the outer outcome.
2. Scope the key: `${tenantId}:${actorId}:${operation}:v${n}:${clientKey}`.
   Validate `clientKey` with Zod. Check the composed key is ≤ 256 characters
   (`journal_receipts.key`).
3. The command must cover every write a replay would repeat. A procedure
   write outside the command is repeated on a fresh run and not on a replay.
4. Put `commandErrors()` from `@arki/journal/orpc` **before** `transact`, so a
   same-key-other-input conflict becomes a 409.
5. Authorization lives in the command's `authorize`: a replay is authorized
   again, so a revoked caller gets no stored result.

Client side: TanStack Query mutations do not retry by default. Keep
`retry: false` on mutations without a key. Keep one key for all retries of one
logical action.

No expiry worker ships with this. Deleting a receipt removes the protection
for its key (`journal.pruneReceipts`).

## Lint reports

`db/no-effects-in-transaction` says a call inside transactional code runs once
per attempt and is not rolled back. Fix it one of these ways:

- Move the effect after the commit: a journal effect (`j.effect(...)`) runs
  from a job row written in the same transaction.
- Move the call before the transaction (read-only lookups), in a middleware
  placed before `transact` or in the caller.
- Split the procedure: a transactional write, then a separate call.

Never silence it with an alias or `as`: the effect still runs twice.

## Words that are mixed up

| Word           | Means                                          | Not                              |
| -------------- | ---------------------------------------------- | -------------------------------- |
| `db`           | The root database (the pool)                   | A transaction                    |
| `tx`           | This attempt's transaction                     | Something to keep after the call |
| `repositories` | The pool-bound repo source, built at boot      | The bound set                    |
| `repos`        | The set bound to this attempt's `tx`           | Something with `withTx`          |
| `retries`      | Extra attempts after the first                 | Total attempts (`retries + 1`)   |
| retry          | A rerun after the database aborted the attempt | A replay                         |
| replay         | A stored result returned for a repeated key    | A rerun                          |

## Listening on a channel

`listenOnPool(pool, channel, { retryMs, healthMs, onState })` from `@arki/db/pg` holds one client of `pool` and `LISTEN`s on `channel`.

- Give it a pool of its own (`max: 1` is enough). The client is held for as long as it listens.
- `onState('ready')` runs after every successful `LISTEN`. `onState('disconnected')` runs once per lost client: an `error`, an `end`, or a `select 1` health check with no answer within `healthMs`.
- A lost client is released once (destroyed, never reused) and replaced every `retryMs`. Notifications sent in between are lost. Treat `disconnected` as a gap.
- Stop runs `UNLISTEN` and closes the client. It never hands it back: its handlers stay on it.
- If the first `LISTEN` fails, the start rejects and nothing retries.
- Tests: `src/pg-listen.test.ts` (scripted pool), `src/pg-listen.pg.test.ts` (Postgres 16).

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
```

In an app that mounts the unit: the static graph, then the booted app's health.

```sh
dot explain --json | jq '.data'
dot doctor --json | jq '.data'
```

`dot explain` reads the manifest and starts nothing. `dot doctor` boots the app and disposes it.
