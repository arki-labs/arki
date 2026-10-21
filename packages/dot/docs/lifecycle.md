# Lifecycle

The DOT lifecycle is a pinned 5-hook contract. It is part of the public
kernel surface, not an implementation detail.

```ts
import type { DotLifecycleHook as ExportedHook, DotLifecycleState as ExportedState } from '@arki/dot';

type DotLifecycleHook = 'configure' | 'boot' | 'start' | 'stop' | 'dispose';

type DotLifecycleState = 'defined' | 'configured' | 'booted' | 'started' | 'stopped' | 'disposed' | 'failed';

// The two unions above must equal the exported ones, so this block stops compiling if the kernel adds a state.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const hooksMatch: Same<DotLifecycleHook, ExportedHook> = true;
export const statesMatch: Same<DotLifecycleState, ExportedState> = true;
```

## State machine

```
defined ──configure()──▶ configured ──boot()──▶ booted ──start()──▶ started
   │                          │                    │                  │
   │ failure                  │ failure            │ failure          │
   └──────────────────────────┴────────────────────┴──────────────────┘
                                                                      │
                                                                      ▼
                                          disposed ◀── dispose() ── stopped
                                                            ▲          │
                                                            └────stop()─┘
```

- `defined` — `defineApp(name)` was called; no hooks have run.
- `configured` — every unit's `configure` hook ran successfully.
- `booted` — every unit's `boot` hook ran; `app.services` is populated.
- `started` — every unit's `start` hook ran; active work is in flight.
- `stopped` — every started unit's `stop` hook ran; resources still open.
- `disposed` — every booted unit's `dispose` hook ran. **Terminal.**
- `failed` — a hook failed irrecoverably. **Terminal.**

Terminal states require a fresh `defineApp(...)` to retry.

## Hook semantics

### `configure` — sync registration

- Runs **synchronously** in declaration order.
- May validate options, declare schemas, register routes/services/jobs,
  contribute manifest entries.
- **Must not** open sockets, connect to databases, start workers, perform
  async I/O.
- Return `undefined` or a concrete typed failure. Returning a Promise is a
  contract violation: the kernel returns `UnexpectedDefect` with
  `ARKI_DOT_E001` metadata in its private cause.

### `boot` — async side effects

- Runs **async** in declaration order, after the unit's `provides`
  factories (one per key, awaited in key order).
- Side effects only: seed, warm up, validate required runtime
  configuration. It returns nothing, a typed refusal, or a descriptor plan
  owning private resources, cleanup and children.
- Completed unit services are published atomically into `app.services`.
  `boot` sees the needs plus the unit's own provided values.
- Downstream units receive them destructured in their hook context,
  under the local aliases declared in `needs`.

### `start` — async activate

- Runs **async** in declaration order.
- Begins active work after every unit has booted: workers, schedulers,
  subscribers, listeners, long-running processes.

### `stop` — async halt

- Runs **async** in **reverse** declaration order.
- Halts active work while keeping booted resources available for cleanup.

### `dispose` — async release

- Runs **async** in **reverse** declaration order.
- Releases booted resources: connection pools, queues, file handles,
  telemetry exporters.

## Failure ordering

DOT cleans up exactly what was opened — no more, no less.

### `configure` failure

- Stops the lifecycle immediately. **No cleanup hooks run** because no
  resources should have been opened during `configure`.
- App transitions to `failed`.
- Returns the original typed refusal, or canonical `UnexpectedDefect` for
  a thrown exception (`ARKI_DOT_E002` metadata in its private cause).

### `boot` failure

- The constructing unit closes its partially acquired descriptors first.
- Previously booted units dispose in reverse declaration order.
- App transitions to `failed`; no failed provider publishes a service.
- The original refusal is returned when cleanup succeeds; unknown throws become
  `UnexpectedDefect`. Failed rollback returns an inferred `ScopeAggregate`
  with ordered private `cause.primary` and `cause.cleanup` members.

Use `resource(open, close)` in providers or return a private descriptor plan
from `boot`; see [Ownership](ownership.md). The legacy `dispose` hook runs only
for units whose boot completed. Descriptor cleanup also covers partial boot.

### `start` failure

- Every started unit's `stop` runs in reverse declaration order.
- Then every booted unit's `dispose` runs in reverse declaration order.
- App transitions to `failed`.
- Returns the primary failure unchanged if cleanup succeeds; otherwise
  returns a `ScopeAggregate` retaining the primary and ordered cleanup failures.
  Unknown throws become `UnexpectedDefect`; `ARKI_DOT_E004` remains in its private cause.

### `stop` / `dispose` failure

- The reverse-order pass **continues through individual failures**.
- Both return failures; neither throws a managed hook failure. One failure
  returns unchanged; several return `ScopeAggregate` with ordered cleanup
  members. Public data contains safe counts; private causes retain failures.
- Unknown exceptions become `UnexpectedDefect`. `ARKI_DOT_E005` / `E006`
  metadata names the hook phase and owner in its private diagnostic cause.

## Idempotency rules

| Call                 | From state                                   | Behaviour                                                          |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `boot()`             | `booted`, `started`, `stopped`               | No-op. Hooks do not re-run.                                        |
| `start()`            | `defined` or `configured`                    | Boots first, then starts.                                          |
| `start()`            | `stopped`                                    | Re-runs **only** `start` hooks.                                    |
| `start()`            | `started`                                    | No-op.                                                             |
| `stop()`             | `defined`, `configured`, `booted`, `stopped` | No-op (nothing started).                                           |
| `dispose()`          | `started`                                    | Runs `stop` first, then `dispose`.                                 |
| `dispose()`          | `booted` or `stopped`                        | Runs only `dispose`.                                               |
| `dispose()`          | `disposed`                                   | Returns its cached complete outcome.                               |
| `boot()` / `start()` | `failed` or `disposed`                       | Returns `UnexpectedDefect` with `ARKI_DOT_E007` / `E008` metadata. |

Concurrent calls to the **same** transition share one in-flight promise
(hooks never double-run). Calls to **different** transitions are
serialized on a single queue: each waits for the in-flight transition to
finish and re-checks state at the head of the queue. A `dispose()` issued
while `start()` is mid-flight runs _after_ start completes and wins —
the app ends `disposed`, never resurrected.

## Error codes

The kernel preserves these stable diagnostic IDs. Managed defects return
canonical `UnexpectedDefect`; kernel-generated defects retain legacy metadata
in their private cause. Owned provider/boot task defects retain the original
cause, while diagnostics record the phase, owner and legacy ID:

| Code            | Meaning                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ARKI_DOT_E001` | `configure` returned a Promise (async configure forbidden).                                                                                                                                                  |
| `ARKI_DOT_E002` | `configure` hook threw.                                                                                                                                                                                      |
| `ARKI_DOT_E003` | `boot` hook threw.                                                                                                                                                                                           |
| `ARKI_DOT_E004` | `start` hook threw.                                                                                                                                                                                          |
| `ARKI_DOT_E005` | One or more `stop` hooks threw (aggregate).                                                                                                                                                                  |
| `ARKI_DOT_E006` | One or more `dispose` hooks threw (aggregate).                                                                                                                                                               |
| `ARKI_DOT_E007` | Reuse after `dispose()`.                                                                                                                                                                                     |
| `ARKI_DOT_E008` | Reuse after a failed lifecycle.                                                                                                                                                                              |
| `ARKI_DOT_E011` | Unit registered twice.                                                                                                                                                                                       |
| `ARKI_DOT_E012` | A `needs` entry no unit declares (erased or JS graphs, dynamic http bundle tokens) — at boot.                                                                                                                |
| `ARKI_DOT_E013` | A published wire key collides with an earlier provider.                                                                                                                                                      |
| `ARKI_DOT_E014` | A service key uses the reserved `$` (kernel) prefix.                                                                                                                                                         |
| `ARKI_DOT_E015` | A hook exceeded the `hookTimeoutMs` watchdog budget.                                                                                                                                                         |
| `ARKI_DOT_E016` | Two actions in the same binding use the same id.                                                                                                                                                             |
| `ARKI_DOT_E017` | Action `meta` is not plain JSON (a function, Date, Map or cycle).                                                                                                                                            |
| `ARKI_DOT_E018` | More than one unit fills the logging slot.                                                                                                                                                                   |
| `ARKI_DOT_E019` | Unit needs and provides form a ring through any units (printed in order) — at `configure()`.                                                                                                                 |
| `ARKI_DOT_E020` | A provider is mounted after its consumer — at `configure()`. The fix line names the role: "Move X before Y in .features([...])." for a feature provider, "Mount X with .infra() before Y." for any other unit. |
| `ARKI_DOT_E021` | `$describeAction` named an action the unit may not amend (unknown id, or neither its own nor in a binding it owns).                                                                                          |

`TS7022` ("implicitly has type 'any' because it … is referenced directly or
indirectly in its own initializer") on a `feature()` const is the compile-time
face of a capability ring: two feature modules name each other's handles.
Read the two files it names; E019 is the backstop for erased graphs.

`E009` (dependency cycle) and `E010` (missing dependency) are **retired**
with the v2 wiring model — declaration order is boot order, so cycles and
name-based dependency declarations no longer exist. Codes are never
reused.

Every code surfaces as a `DiagnosticIssue` in `app.diagnostics.issues` with
remediation guidance.

## Code examples

### Checking a boot defect

```ts run
import { defineApp, infra } from '@arki/dot';
import { UnexpectedDefect } from '@arki/failure';

const flaky = infra({
  name: 'flaky',
  boot() {
    throw new Error('no network');
  },
});

const outcome = await defineApp('my-app').infra(flaky).boot();
if (!UnexpectedDefect.is(outcome)) throw new Error('expected a supervised defect');
if (!(outcome.cause instanceof Error) || outcome.cause.message !== 'no network') {
  throw new Error('original cause was lost');
}
```

Disposal also returns managed defects and continues the remaining finalizers:

```ts run
import { defineApp, DotLifecycleError, infra } from '@arki/dot';
import { isFailure, UnexpectedDefect } from '@arki/failure';

const stuck = infra({
  name: 'stuck',
  provides: { socket: () => 1 },
  dispose() {
    throw new Error('socket stuck');
  },
});

const app = await defineApp('my-app').infra(stuck).boot();
if (isFailure(app)) throw new Error(app.code);
const outcome = await app.dispose();
if (!UnexpectedDefect.is(outcome)) throw new Error('expected a supervised defect');
if (!(outcome.cause instanceof DotLifecycleError)) throw new Error('missing diagnostic metadata');
if (outcome.cause.code !== 'ARKI_DOT_E006' || outcome.cause.plugin !== 'stuck') {
  throw new Error('expected the disposal phase and owner');
}
```

### Idempotent shutdown

```ts
import { defineApp } from '@arki/dot';
import { isFailure } from '@arki/failure';

const app = await defineApp('svc').boot();
if (isFailure(app)) throw new Error(app.code);

const shutdown = async () => {
  // Both calls are safe to repeat; the kernel tracks state.
  await app.stop();
  await app.dispose();
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
```

The kernel coalesces concurrent calls to the same transition onto a single
in-flight promise (a double-signal won't double-cleanup), and serializes
different transitions on one queue — a `dispose()` racing a slow `start()`
always runs after it and leaves the app `disposed`.

## See also

- [Unit authoring](./unit-authoring.md) — writing an `infra` or `entrypoint` unit.
- [Diagnostics](./diagnostics.md) — observing lifecycle state at runtime.
