# @arki/clock

## 0.2.3

### Patch Changes

- bf66a68: No code change. The changesets behind the previous patch gave their no-impact reasons in a form the release check could not read, so this patch carries them. That patch moved dependency pins (oRPC 1.16.5, TanStack Query 5.108.2) and stopped publishing type-test files.

  no docs impact: no API or behaviour changed, only dependency pins and the published file list.
  no demo impact: no runtime behaviour changed, demos take the same catalog.

- Updated dependencies [bf66a68]
  - @arki/failure@0.4.2

## 0.2.2

### Patch Changes

- Updated dependencies [ef1e7b5]
- Updated dependencies [7f4cae3]
  - @arki/failure@0.4.1

## 0.2.1

### Patch Changes

- 53d25f7: Each package README now records what it instruments, including why these packages need no spans.
- 4f24c6d: Declares the engines it supports and documents them in the README.
- Updated dependencies [53d25f7]
- Updated dependencies [4ac08a9]
- Updated dependencies [4f24c6d]
  - @arki/failure@0.4.0

## 0.2.0

### Minor Changes

- a07bccc: Remove the retired Clock abort exception code; cancellation remains the canonical SleepCancelled value. Preserve prototype-shaped operation keys in TanStack client utilities, and run Contracts native/provider inspections through identity-preserving source schemas. Forged array methods no longer bypass operation identity validation.

  Docs describe the retired code and identity guarantees. No demo impact: existing demos use live cancellation outcomes and ordinary operation keys.

### Patch Changes

- d7e9886: Return canonical owned cancellation, deadline and provider/callback defect outcomes from async waits and concurrency. Preserve fulfilled Failure elements, heterogeneous result inference, joined work and late settlement observation; contain foreign scope-listener failures. Add default operation telemetry without changing callback execution or exposing private causes. Retire migrated exception-only exports and update callers and runtime examples. AI Flow propagates retry-wait defects unchanged; Clock docs clarify its existing supervised sleep contract.

  no demo impact: public examples and runtime smoke checks cover the changed behaviour; no separate demo application exists.

- Updated dependencies [11c5bc2]
- Updated dependencies [a905468]
- Updated dependencies [11c5bc2]
- Updated dependencies [49517e2]
- Updated dependencies [1a897f8]
- Updated dependencies [cac4bc6]
  - @arki/failure@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [6601242]
- Updated dependencies [2000a7e]
  - @arki/failure@0.2.0

## 0.1.0

### Minor Changes

- 12e7fa2: `Clock` now has timers, so code that waits can run instantly in tests. Every clock has `setTimer(callback, ms)`, which returns a cancel function, and `sleep(ms, signal?)`, which an `AbortSignal` can cut short. `MockClock.advance(ms)` now fires every timer that comes due, in time order, including timers set by timers that fire during the step. The new `MockClock.advanceAsync(ms)` also lets promise callbacks run between timers, so a retry loop with real-size delays finishes in a millisecond. New error codes: `ARKI_CLOCK_E002` for a bad delay and `ARKI_CLOCK_E003` for an aborted sleep. New constant `MAX_TIMER_MS`.

  Breaking: a hand-written `Clock` object now needs `setTimer` and `sleep` as well as `now`.

- 1668156: Breaking: `MockClock.advance` now throws `ClockError` with code `ARKI_CLOCK_E001` instead of `RangeError`. Adds a cross-runtime smoke test, `test:runtimes`, and the shared library lint preset.
- 9669a84: Return canonical SleepCancelled outcomes from sleep instead of rejecting on abort, preserving private causes and timer cleanup. Invalid timer and mock-step setup still throws ClockError. Supervise asynchronous provider cleanup before settlement and observe listener registration rejections without leaking unhandled promises.

### Patch Changes

- abffdfd: Docs standard: README sections, `AGENTS.md`, `llms.txt`, an agent guide, a tested `examples/cooldown-gate.ts` and a runtimes table. no demo impact: documentation and doc-example changes only, runtime behaviour unchanged
- Updated dependencies [57313a4]
- Updated dependencies [f43d509]
- Updated dependencies [232d3e8]
- Updated dependencies [3f6d39f]
- Updated dependencies [7f9b4bb]
- Updated dependencies [86efafc]
- Updated dependencies [d541df1]
- Updated dependencies [f6a15d0]
- Updated dependencies [4913009]
- Updated dependencies [232d3e8]
- Updated dependencies [73ef41b]
- Updated dependencies [f796e5a]
  - @arki/failure@0.1.0

## 0.0.2

### Patch Changes

- Ship TypeScript source in the npm tarball (`src/**` added to `files`). npm installs and the read-only GitHub mirrors now carry the original `.ts` source alongside compiled `dist/` — better debuggability on the experimental track. No runtime changes.

## 0.0.1

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  Part of **Wave 1**, the ARKI foundation: zero-dependency utilities and runtime primitives shipped together because every downstream wave (DOT kernel, infrastructure adapters) consumes them. Wave 1 packages: `assert`, `clock`, `contracts`, `date`, `env`, `log`, `resilience`, `slugify`, `string`, `ts`.

  **Why 0.0.x, not 1.0.0**: ARKI is on an experimental track. The 0.0.x prefix is an honest signal — APIs may change without semver discipline until the kernel is field-tested. The release scorecard (metadata, privacy, dependencies, build-output, packlist, docs, fixtures, DOT gates, agent-native gates) is satisfied at this version; the gate certifies _the artifact_, not _API stability_. Stability is earned through reuse, not declared at first publication.

  Wave 2 (`@arki/dot`) and Wave 3 (`@arki/db`, `@arki/kv`, `@arki/event-sourcing`) publish in subsequent releases once their inter-package transitive resolution against the public npm registry is verified.
