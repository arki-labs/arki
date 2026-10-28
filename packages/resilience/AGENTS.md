AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/resilience: Laws

Retry, circuit breaker, timeout, bulkhead and presets. Read these before you change or use the package.

## Laws

1. An expected outcome is a returned failure, not a throw. A returned `@arki/failure` value is an answer. It is not retried unless `.while(Definition)` or a predicate names it, and it never opens a breaker.
2. A thrown error is retried by the backoff and, when the retries run out, thrown again unchanged. The retry policy does not wrap it in another error.
3. A backoff without `.upTo(n)` retries forever. Always bound production retries. `upTo(0)` never retries.
4. `.while(...definitions)` is decided once: the first `while` decides alone for failures, and a second `while` narrows the first. Name all the definitions in one call.
5. Retry checks cancellation before every attempt and after failed work or observers: it returns `Cancelled` without another callback, wait or throw fallback. Completed successes and returned failures retain identity. Cancellation during a real delay retains `SleepCancelled`; timer defects retain `UnexpectedDefect`. Other engine-only cancellation still uses `CancelledError` during the A-33 migration.
6. A policy with `withFallback` or `onThrow` is a `Policy<F>`. It is outermost and cannot go inside `wrap`. This is a compile error on purpose.
7. Retry waits on a `Clock` from `@arki/clock`. Tests pass a `MockClock`. Never `await` a real timer in a test.
8. A breaker keeps state. Build it once and reuse it. A `presets` object shared by two apps shares its breakers.
9. The policies own their public types and errors. A new `cockatiel` release must never change this API.
10. Remaining thrown engine errors extend `ResilienceError` with a stable `code` and a `remediation`. Match on the code, never on the message. Errors thrown by the caller's function pass through untouched.
11. The package uses only `setTimeout`, `AbortSignal` and `Promise` at call time. No `node:*` imports, no `process`, no `Buffer`. It runs on Node, Bun, Deno, browsers and Hermes.
12. Event listeners are observation only. Their throws and rejected promises cannot change results, retries, breaker accounting or deadline settlement. They are never awaited; synchronous cancellation requests still take effect. Default diagnostics contain canonical codes, never callback messages or values.
13. Types are written once and inferred everywhere. No `any`, no `@ts-ignore`, no unsafe casts.

## Changing this package

- A new error needs a `RESILIENCE_ERROR_CODES` entry with `@fix` and `@verify` tags, a `remediation`, and a test in `errors.test.ts`.
- A new `backoff` option is validated where the backoff is built and throws `InvalidBackoffError`.
- A change to the failure model changes `Failure behaviour` in `README.md` and `docs/agent-guide.md` in the same commit.
- Never write benchmark numbers by hand. The README block comes from an idle `bun run bench` run.
- Doc examples live in `README.md` and `docs/`. Run them with `bun run test:docs`.

## Verify

```sh
bun run test:docs
bun run typecheck
bun run test
bun run lint
bun ../../tooling/library/src/llms.ts --check
```
