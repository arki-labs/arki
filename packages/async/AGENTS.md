AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/async

Timing and structured concurrency on plain Promises and `AbortSignal`. Read [docs/agent-guide.md](./docs/agent-guide.md) for tasks. When a doc and the code disagree, `src/index.ts` wins.

## Laws

1. `debounce` and `throttle` call the function at the same moments as lodash, with the same arguments. The test replays random schedules against lodash. A change that breaks that replay is a bug, not a new contract.
2. Time comes from a `Clock` (`@arki/clock`). The default is the system clock. Never call `setTimeout` or `Date.now` directly in `src/`. A test passes a `MockClock`.
3. No task outlives the call that started it. `all`, `mapConcurrent` and `race` settle only after every started task has settled.
4. Cancellation is cooperative. Every task gets a `signal`. The library never kills code that ignores it, and the docs say so.
5. Owned scopes close admission, cancel and join admitted work, then run finalizers newest first, one at a time. Every finalizer runs. Returned failures are never resources. A single failure keeps its identity; multiple failures retain exact local primary/cleanup members through `ScopeFailed`.
6. `scoped` and `openScope` infer typed outcomes from resource/cleanup/child descriptors. Dynamic registrations must fit the scope's canonical definition tuple. Success remains unwrapped. Concurrency and waits return canonical owned cancellation/deadline/defect outcomes; fulfilled Failure elements remain Promise values. Static delay/concurrency misuse still throws.
7. Settling cleans up. A finished `sleep` leaves no timer and no abort listener behind.
8. The runtime floor is Hermes. Use no `Promise.withResolvers`, no `AbortSignal.any` and no `async function*` in `src/`. Build a linked signal with `src/signal.ts`.
9. Managed scope boundaries return canonical `@arki/failure` values for cancellation, deadlines and defects as well as callback refusals. Waits and concurrency supervise provider faults and callback exceptions; static misuse retains `AsyncError`. Every error definition has a stable code, remediation, and JSDoc with `@fix` and `@verify`. Aggregate member causes are private; wire revival promises only canonical public data.
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
