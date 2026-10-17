AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/journal

A journal for Drizzle entities: events, projections and effects with one write path. When a doc and the code disagree, `src/api.ts` wins.

## Laws

1. One change is one immutable event row and one normal table row, written in one transaction. Never write an entity row without its event.
2. A rule that rejects a request returns a failure. It does not throw. The command rolls back either way.
3. Match errors on `error.code` (`isJournalError(error, 'CONFLICT')`). Never on the message.
4. Await every `write` and `run`. One journal operation per transaction at a time. No `Promise.all` over writes.
5. `drain` and `worker` take the root database, never a transaction.
6. Effects run at least once, after the commit. An effect must be safe to repeat. Use `jobId` as the idempotency key.
7. A reducer returns the value the database will store, or the write fails with `VALUE_MISMATCH`. Returning `null` deletes the row.
8. Events are frozen. Copy before you change. Pass ids exactly as they are stored.
9. `@arki/journal/errors` and the core import no driver. Keep browser code able to load them.
10. A public export is never deleted because nothing uses it. This is a general-purpose library.
11. Do not "clean up" the items listed in the guide under "Do not clean these up".

## Changing this package

1. Read `docs/agent-guide.md` for your task, then `src/api.ts` for the signature.
2. Change `src/`. Put the test next to it. Run the Postgres tests for write-path changes.
3. Keep README blocks compiling, or give them a `skip` reason.
4. Update the error table in the guide when a code changes.
5. Add a changeset. A breaking change is a minor changeset while the version is 0.x.
6. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
