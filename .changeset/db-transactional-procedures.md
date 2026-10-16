---
'@arki/db': minor
---

Transactional procedures. Three new entries:

- `@arki/db/transaction`: `runTransaction(db, work, options)` runs `work` in one SERIALIZABLE transaction and reruns it on SQLSTATE `40001` / `40P01` only (bounded: `retries` 0–10, default 3; jittered 10–250 ms waits). Also `retryableSqlState`, `DbTransactionError` (`ARKI_DB_TX_E001`–`E006`), `isDbTransactionError`, `parseTransactionSettings`. Portable.
- `@arki/db/orpc`: `transactionalProcedure(db, { repos, retries })` is an oRPC middleware that gives the handler `tx` and repositories bound with `withTx(tx)`, reruns the handler on a conflict, and maps exhaustion to `ORPCError('CONFLICT')` (409). Use with `implement(contract, transactionalProcedureConfig)`, as the last `.use()`. `TransactionScopeOf<typeof transact>` is the scope a usecase takes. Portable.
- `@arki/db/eslint`: the type-aware rule `db/no-effects-in-transaction` reports `fetch`, queue writes (`Queue#add`, `trigger()`, `enqueue()`) and `.effect()` inside transactional code.

`TransactionalDb` now accepts the transaction config: `transaction(fn, config?: PgTransactionConfig)`. A database whose `transaction` takes no config still fits; `createUnitOfWork` is unchanged.

New dependencies: `@arki/resilience` and `@arki/clock` (and, through resilience, `cockatiel` and `@arki/failure`). New optional peers: `@orpc/server`, `@typescript-eslint/utils`, `eslint`, `typescript`. The package now ships `llms.txt` and `docs/`.
