AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/db

Drizzle helpers for Postgres: runtimes, ids, repositories, serializable transactions. Keep source, guides and examples consistent. Surface contradictions before choosing a pattern.

## Laws

1. Only SQLSTATE `40001` and `40P01` are retried. The nearest `code` in the `cause` chain decides. Never match on a message.
2. Transactional code runs once per attempt. Never add an effect (`fetch`, queue write, `.effect()`) inside it.
3. `@arki/db/transaction` and `@arki/db/orpc` stay portable: no driver import, no Node builtin. Node, Bun, Deno and browser smoke checks pass. Hermes remains blocked by upstream oRPC syntax (framework finding F35); do not claim verified Hermes support until its strict runtime check passes.
4. `transact` is the last `.use()` of a procedure. The pipeline check throws `ARKI_DB_TX_E004` otherwise.
5. One PGlite data directory has one owner. Two handles corrupt it. Keep the owner lock.
6. Every error code has JSDoc with a summary, `@fix` and `@verify`. Add the same row to `docs/agent-guide.md`.
7. Ids are declared in `@arki/contracts` with `defineId`. This package turns them into columns. It never declares an app id.
8. Library source never names an app or a private path. Write examples generically.
9. A public export is never deleted because nothing uses it. This is a general-purpose library.
10. Returning a canonical Failure rolls back and restores identity. Cleanup failure must never replay it. `runTransactionOnce`, Dot transactions and unit-of-work preserve driver isolation and savepoints without retries.
11. Native oRPC contracts declare `transactionErrorMap`; inspect `result.output` and preserve the result context.
12. Retry behaviour is proved on real PostgreSQL (`src/transaction.pg.test.ts`), never only on PGlite.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test next to it. Add a `*.test-d.ts` for a type change.
3. Keep README blocks compiling. A block that needs the app's own tables carries a `skip` reason.
4. Update the Task map and Errors table in the guide when the behaviour changes.
5. Add a changeset. A breaking change is a minor changeset while the version is 0.x.
6. Regenerate `llms.txt` imports: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
