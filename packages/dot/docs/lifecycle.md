# Lifecycle

The DOT lifecycle is a pinned 5-hook contract. It is part of the public
kernel surface, not an implementation detail.

```ts
type DotLifecycleHook = 'configure' | 'boot' | 'start' | 'stop' | 'dispose';

type DotLifecycleState =
  | 'defined'
  | 'configured'
  | 'booted'
  | 'started'
  | 'stopped'
  | 'disposed'
  | 'failed';
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
- `configured` — every pip's `configure` hook ran successfully.
- `booted` — every pip's `boot` hook ran; `app.services` is populated.
- `started` — every pip's `start` hook ran; active work is in flight.
- `stopped` — every started pip's `stop` hook ran; resources still open.
- `disposed` — every booted pip's `dispose` hook ran. **Terminal.**
- `failed` — a hook failed irrecoverably. **Terminal.**

Terminal states require a fresh `defineApp(...)` to retry.

## Hook semantics

### `configure` — sync registration

- Runs **synchronously** in declaration order.
- May validate options, declare schemas, register routes/services/jobs,
  contribute manifest entries.
- **Must not** open sockets, connect to databases, start workers, perform
  async I/O.
- Returning a Promise is a contract violation. The kernel throws
  `DotLifecycleError` with code `DOT_LIFECYCLE_E001`.

### `boot` — async open

- Runs **async** in declaration order.
- Opens resources, initialises clients, validates required runtime
  configuration.
- Publishes services into `app.services` via the return value
  (a plain record of wire-keyed services).
- Downstream pips receive them destructured in their hook context,
  under the local aliases declared in `needs`.

### `start` — async activate

- Runs **async** in declaration order.
- Begins active work after every pip has booted: workers, schedulers,
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
- Kernel throws `DotLifecycleError` with code `DOT_LIFECYCLE_E002`.

### `boot` failure

- The throwing pip is **not** disposed (its `boot` did not complete).
- Every pip whose `boot` already completed is disposed in
  reverse declaration order.
- App transitions to `failed`.
- Kernel throws `DotLifecycleError` with code `DOT_LIFECYCLE_E003`.

A pip whose `boot` opens partial resources before throwing **must clean
those up itself**:

```ts
async boot() {
  const a = await openA();
  try {
    const b = await openB();
    return { services: { a, b } };
  } catch (err) {
    await a.close(); // clean up our own partial state
    throw err;
  }
}
```

The kernel only disposes pips whose `boot` returned successfully.

### `start` failure

- Every started pip's `stop` runs in reverse declaration order.
- Then every booted pip's `dispose` runs in reverse declaration order.
- App transitions to `failed`.
- Kernel throws `DotLifecycleError` with code `DOT_LIFECYCLE_E004`.

### `stop` / `dispose` failure

- The reverse-order pass **continues through individual failures**.
- The kernel collects per-pip failures and throws a single aggregate
  `DotLifecycleError` (`DOT_LIFECYCLE_E005` for stop, `DOT_LIFECYCLE_E006`
  for dispose).
- The aggregate carries `failures: readonly { pip, phase, error }[]` so
  callers and agents can see exactly which pips failed.

## Idempotency rules

| Call                  | From state                                | Behaviour                                      |
| --------------------- | ----------------------------------------- | ---------------------------------------------- |
| `boot()`              | `booted`, `started`, `stopped`            | No-op. Hooks do not re-run.                    |
| `start()`             | `defined` or `configured`                  | Boots first, then starts.                      |
| `start()`             | `stopped`                                 | Re-runs **only** `start` hooks.                |
| `start()`             | `started`                                 | No-op.                                         |
| `stop()`              | `defined`, `configured`, `booted`, `stopped` | No-op (nothing started).                       |
| `dispose()`           | `started`                                 | Runs `stop` first, then `dispose`.             |
| `dispose()`           | `booted` or `stopped`                      | Runs only `dispose`.                           |
| `dispose()`           | `disposed`                                | No-op.                                         |
| `boot()` / `start()`  | `failed` or `disposed`                     | Throws `DOT_LIFECYCLE_E007` or `E008`.         |

Concurrent calls to the **same** transition share one in-flight promise
(hooks never double-run). Calls to **different** transitions are
serialized on a single queue: each waits for the in-flight transition to
finish and re-checks state at the head of the queue. A `dispose()` issued
while `start()` is mid-flight runs *after* start completes and wins —
the app ends `disposed`, never resurrected.

## Error codes

The kernel emits stable, machine-readable error codes:

| Code                  | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| `DOT_LIFECYCLE_E001`  | `configure` returned a Promise (async configure forbidden). |
| `DOT_LIFECYCLE_E002`  | `configure` hook threw.                                     |
| `DOT_LIFECYCLE_E003`  | `boot` hook threw.                                          |
| `DOT_LIFECYCLE_E004`  | `start` hook threw.                                         |
| `DOT_LIFECYCLE_E005`  | One or more `stop` hooks threw (aggregate).                 |
| `DOT_LIFECYCLE_E006`  | One or more `dispose` hooks threw (aggregate).              |
| `DOT_LIFECYCLE_E007`  | Reuse after `dispose()`.                                    |
| `DOT_LIFECYCLE_E008`  | Reuse after a failed lifecycle.                             |
| `DOT_LIFECYCLE_E011`  | Pip registered twice.                                       |
| `DOT_LIFECYCLE_E012`  | A `needs` entry has no provider among earlier pips.         |
| `DOT_LIFECYCLE_E013`  | A published wire key collides with an earlier provider.     |
| `DOT_LIFECYCLE_E014`  | A service key uses the reserved `$` (kernel) prefix.        |
| `DOT_LIFECYCLE_E015`  | A hook exceeded the `hookTimeoutMs` watchdog budget.        |

`E009` (dependency cycle) and `E010` (missing dependency) are **retired**
with the v2 wiring model — declaration order is boot order, so cycles and
name-based dependency declarations no longer exist. Codes are never
reused.

Every code surfaces as a `DiagnosticIssue` in `app.diagnostics.issues` with
remediation guidance.

## Code examples

### Catching a boot failure

```ts
import { defineApp, DotLifecycleError } from '@arki/dot';

try {
  const app = await defineApp('my-app').use(somePip).boot();
  // ...
} catch (err) {
  if (err instanceof DotLifecycleError) {
    console.error(`${err.code} in ${err.pip}: ${err.message}`);
    if (err.failures) {
      for (const f of err.failures) {
        console.error(`  ${f.pip}/${f.phase}: ${String(f.error)}`);
      }
    }
  }
  throw err;
}
```

### Idempotent shutdown

```ts
async function shutdown(app: Awaited<ReturnType<typeof boot>>) {
  // Both calls are safe to repeat; the kernel tracks state.
  await app.stop();
  await app.dispose();
}

process.on('SIGTERM', () => shutdown(app));
process.on('SIGINT', () => shutdown(app));
```

The kernel coalesces concurrent calls to the same transition onto a single
in-flight promise (a double-signal won't double-cleanup), and serializes
different transitions on one queue — a `dispose()` racing a slow `start()`
always runs after it and leaves the app `disposed`.

## See also

- [Pip authoring](./pip-authoring.md) — writing a `DotPip`.
- [Diagnostics](./diagnostics.md) — observing lifecycle state at runtime.
