AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/lock

## Laws

1. A busy lock is a returned `LockHeld` failure (`lock.held`, status 409), never a throw. Check it with `LockHeld.is(result)`.
2. Everything else raised on purpose is a thrown `LockError` with a stable `code`. Match on `code`, never on the message.
3. Never renumber `LOCK_ERROR_CODES`. `ARKI_LOCK_E001` was `held` and is retired.
4. A lock keeps jobs apart. It does not make a write safe. For an irreversible write, pass the fence to the resource and check it in the same statement as the write.
5. A store declares its `guarantees`, and the handle types follow. A method a store cannot back must not exist on its handle.
6. A store failure is never read as "free" or as "held". It is a `store` error.
7. Pass `ctx.signal` to the work inside the callback. Loss of ownership aborts it.
8. A failed release after a successful callback is logged and counted, never thrown.
9. The root entry has no database code. Each store lives on its own subpath with its client as an optional peer.
10. Raw keys stay out of logs unless `logKeys: true`.
11. A busy lock is `LockHeld` only. A store timeout is a `store` error with `outcome: 'unknown'`, never `LockHeld`.
12. Every error code and the `LockHeld` failure have a JSDoc summary, `@fix` and `@verify`.

## Changing this package

1. Read `src/types.ts` (guarantees and handles) and `src/locks.ts` (the manager) first.
2. A new store passes the conformance suite in `src/testing/contract.ts`.
3. A new error code goes in `LOCK_ERROR_CODES` with a JSDoc summary, `@fix` and `@verify`, and a row in the README's Failure behaviour table.
4. A changed doc example goes in `examples/nightly.ts`. Run `arki-doc-examples --write` to refresh the README.
5. Add a changeset. Behaviour changes are `minor` while the version is below 1.0.

## Verify

```sh
bun run typecheck
bun run test
bun run test:docs
bun run lint
bun ../../tooling/library/src/llms.ts --check
```
