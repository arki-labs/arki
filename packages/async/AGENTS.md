AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/async

Timing and structured concurrency on plain Promises and `AbortSignal`. Read [docs/agent-guide.md](./docs/agent-guide.md) for tasks. When a doc and the code disagree, `src/index.ts` wins.

## Laws

1. `debounce` and `throttle` call the function at the same moments as lodash, with the same arguments. The test replays random schedules against lodash. A change that breaks that replay is a bug, not a new contract.
2. Time comes from a `Clock` (`@arki/clock`). The default is the system clock. Never call `setTimeout` or `Date.now` directly in `src/`. A test passes a `MockClock`.
3. No task outlives the call that started it. `all`, `mapConcurrent` and `race` settle only after every started task has settled.
4. Cancellation is cooperative. Every task gets a `signal`. The library never kills code that ignores it, and the docs say so.
5. `scoped` runs finalizers newest first, one at a time, each awaited. All of them run even when one throws. No error is lost: the body error and every finalizer error reach the caller.
6. Only `sleep`, `scoped`, `all`, `mapConcurrent`, `race` and `timeout` return promises, and they reject instead of throwing. `debounce` and `throttle` throw `ARKI_ASYNC_E001` when called with a bad wait.
7. Settling cleans up. A finished `sleep` leaves no timer and no abort listener behind.
8. The runtime floor is Hermes. Use no `Promise.withResolvers`, no `AbortSignal.any` and no `async function*` in `src/`. Build a linked signal with `src/signal.ts`.
9. Every error is an `AsyncError` with a stable `code` and a `remediation`. Each code in `ASYNC_ERROR_CODES` has JSDoc with `@fix` and `@verify`.
10. A semaphore, mutex or deferred does not belong here. Point readers to `@arki/lock` and `Promise.withResolvers()`.
11. Never write benchmark numbers by hand. `bun run bench --write-readme` writes them from an idle machine.

## Changing this package

1. Change the file for the helper: `src/sleep.ts`, `src/schedule.ts`, `src/scope.ts` or `src/concurrency.ts`.
2. Add a test next to it for the boundary that decides the behaviour. Use a `MockClock` for time.
3. A new error code goes in `src/errors.ts` with a summary, `@fix` and `@verify`. Then run `bun ../../tooling/library/src/error-index.ts` and check that no entry shows `null`.
4. Update `examples/load-pages.ts` only with its test. The README mirrors its `load-pages` region, so run `arki-doc-examples --write` after an edit.
5. Add a changeset in `.changeset/`. Documentation-only changes use `patch` and the line `no demo impact: documentation and doc-example changes only, runtime behaviour unchanged`.

## Verify

```sh
bun run build
bun run typecheck
bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/error-index.ts
bun ../../tooling/library/src/llms.ts --check
```
