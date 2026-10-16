# @arki/db agent guide: transactions

This guide covers `@arki/db/transaction`, `@arki/db/orpc` and `@arki/db/eslint`.
The README has the setup. This page has the rules an agent needs to get them right.

## File map

| File                         | What it holds                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/transaction.ts`         | `runTransaction`, the settings schema, `retryableSqlState`, `DbTransactionError`, the error codes   |
| `src/orpc.ts`                | `transactionalProcedure`, the pipeline checks, `transactionalProcedureConfig`, `TransactionScopeOf` |
| `src/eslint.ts`              | `db/no-effects-in-transaction`                                                                      |
| `src/composition.ts`         | `TransactionalDb` (the port every database fits), `createUnitOfWork`                                |
| `src/__fixtures__/dot-app/`  | A Dot feature laid out the recommended way, run by `src/orpc.dot.test.ts`                           |
| `src/transaction.pg.test.ts` | Real conflicts on PostgreSQL: write skew, deadlock, 40001 at COMMIT, lost commits                   |
| `src/orpc.journal.test.ts`   | The receipt recipe for ambiguous commits                                                            |

## How one call runs

1. Input is validated once (before every middleware).
2. Middlewares before `transact` run once: error mapping, timing, auth, `bind`.
3. `transact` checks the pipeline (first call per procedure), then refuses a nested call.
4. Attempt: `BEGIN` at SERIALIZABLE → `withTx(tx)` → handler → output validation → `COMMIT`.
5. On `40001` / `40P01`: Drizzle has rolled back and released the connection. Wait 10–250 ms (jittered), go to 4.
6. Out of retries: `DbTransactionError` `ARKI_DB_TX_E001` → `ORPCError('CONFLICT')`, 409.

## Decide what to do with a failure

| What happened                                             | Who handles it                      | What the client sees                              |
| --------------------------------------------------------- | ----------------------------------- | ------------------------------------------------- |
| `40001` / `40P01` within the retry budget                 | `runTransaction`, silently          | Success                                           |
| `40001` / `40P01` on every attempt                        | `transact`                          | 409 `CONFLICT`: send the same request again later |
| A business rule says no (`ORPCError`, `CommandError`)     | Your code, once                     | That error                                        |
| A journal version conflict (`JournalError` `CONFLICT`)    | `commandErrors()` before `transact` | 409 `CONFLICT`: reload, then retry                |
| Connection lost around `COMMIT` (ambiguous commit)        | Nobody retries                      | 500. Repeat with the same idempotency key         |
| Same idempotency key after a real commit (receipt replay) | The journal                         | The first result, no new writes                   |

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

## Error codes

| Code              | Name                | When                                                                                         | Fix                                                                          |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ARKI_DB_TX_E001` | `retriesExhausted`  | Every attempt failed with `40001` / `40P01`                                                  | Shorten the transaction; touch rows in a fixed order; raise `retries` (≤ 10) |
| `ARKI_DB_TX_E002` | `invalidOptions`    | `isolation` is not `'serializable'`, `retries` is not a whole number 0–10, or an unknown key | Fix the options. Nothing is clamped                                          |
| `ARKI_DB_TX_E003` | `nestedTransaction` | A transactional procedure was called with a context already inside one                       | One `transact` per call; call the usecase directly instead                   |
| `ARKI_DB_TX_E004` | `invalidPipeline`   | `transact` is not the last `.use()`, or `implement` lacks `transactionalProcedureConfig`     | Move `.use(transact)` last; pass the config                                  |
| `ARKI_DB_TX_E005` | `unsupportedOutput` | The handler returned a stream                                                                | Return plain data; stream from another procedure                             |
| `ARKI_DB_TX_E006` | `transactionAsRoot` | The database given is a transaction                                                          | Pass the root database                                                       |

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

## Words easy to mix up

| Word           | Means                                          | Not                              |
| -------------- | ---------------------------------------------- | -------------------------------- |
| `db`           | The root database (the pool)                   | A transaction                    |
| `tx`           | This attempt's transaction                     | Something to keep after the call |
| `repositories` | The pool-bound repo source, built at boot      | The bound set                    |
| `repos`        | The set bound to this attempt's `tx`           | Something with `withTx`          |
| `retries`      | Extra attempts after the first                 | Total attempts (`retries + 1`)   |
| retry          | A rerun after the database aborted the attempt | A replay                         |
| replay         | A stored result returned for a repeated key    | A rerun                          |
