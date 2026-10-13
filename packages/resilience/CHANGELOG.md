# @arki/resilience

## 0.1.0

### Minor Changes

- The package now owns its public types and errors. `Policy` replaces cockatiel's `IPolicy`: `execute(fn, signal?)` gives `fn` a `{ signal, attempt }` context, and every policy exposes `onSuccess` and `onFailure`, with `onRetry`, `onGiveUp`, `onBreak`, `onHalfOpen`, `onReset`, `onTimeout` and `onReject` on the policies that have them. `CircuitOpenError`, `TimeoutError` and `BulkheadRejectedError` are this package's own classes with the engine error as `cause`, and a call cancelled by the caller's signal now rejects with `CancelledError` instead of being reported as a timeout. The `wrap` and `noop` exports are this package's own too. No cockatiel name appears in the published types anymore, so a cockatiel major release is no longer a breaking change here. The engine is upgraded to cockatiel 4.

  Breaking: import `Policy` instead of `IPolicy`. Errors thrown by the policies are no longer `instanceof` cockatiel's classes.

## 0.0.3

### Patch Changes

- Deprecate `withCircuitBreaker`. It builds a new circuit breaker on every call, so the breaker never remembers a failure and never opens. Build one policy with `createCircuitBreakerPolicy()` and pass it to `withResilience()` on each call. The export stays until the next breaking release.
- Fix the README: the timeout option is `timeoutMs`, not `durationMs`, and the circuit-breaker options are `halfOpenAfter` and `consecutiveFailures`. The quick-wrapper example no longer imports `withCircuitBreaker`, and a reused-breaker example is added.
- Add the first tests for the execution helpers.

## 0.0.2

### Patch Changes

- Ship TypeScript source in the npm tarball (`src/**` added to `files`). npm installs and the read-only GitHub mirrors now carry the original `.ts` source alongside compiled `dist/` — better debuggability on the experimental track. No runtime changes.

## 0.0.1

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  Part of **Wave 1**, the ARKI foundation: zero-dependency utilities and runtime primitives shipped together because every downstream wave (DOT kernel, infrastructure adapters) consumes them. Wave 1 packages: `assert`, `clock`, `contracts`, `date`, `env`, `log`, `resilience`, `slugify`, `string`, `ts`.

  **Why 0.0.x, not 1.0.0**: ARKI is on an experimental track. The 0.0.x prefix is an honest signal — APIs may change without semver discipline until the kernel is field-tested. The release scorecard (metadata, privacy, dependencies, build-output, packlist, docs, fixtures, DOT gates, agent-native gates) is satisfied at this version; the gate certifies _the artifact_, not _API stability_. Stability is earned through reuse, not declared at first publication.

  Wave 2 (`@arki/dot`) and Wave 3 (`@arki/db`, `@arki/kv`, `@arki/event-sourcing`) publish in subsequent releases once their inter-package transitive resolution against the public npm registry is verified.
