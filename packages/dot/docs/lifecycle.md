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
- `configured` — every plugin's `configure` hook ran successfully.
- `booted` — every plugin's `boot` hook ran; `app.services` is populated.
- `started` — every plugin's `start` hook ran; active work is in flight.
- `stopped` — every started plugin's `stop` hook ran; resources still open.
- `disposed` — every booted plugin's `dispose` hook ran. **Terminal.**
- `failed` — a hook failed irrecoverably. **Terminal.**

Terminal states require a fresh `defineApp(...)` to retry.

## Hook semantics

### `configure` — sync registration

- Runs **synchronously** in topological order.
- May validate options, declare schemas, register routes/services/jobs,
  contribute manifest entries.
- **Must not** open sockets, connect to databases, start workers, perform
  async I/O.
- Returning a Promise is a contract violation. The kernel throws
  `DotLifecycleError` with code `DOT_LIFECYCLE_E001`.

### `boot` — async open

- Runs **async** in topological order.
- Opens resources, initialises clients, validates required runtime
  configuration.
- Publishes services into `app.services` via the return value
  (`{ services: { ... } }`).
- Downstream plugins receive these via `ctx.services`.

### `start` — async activate

- Runs **async** in topological order.
- Begins active work after every plugin has booted: workers, schedulers,
  subscribers, listeners, long-running processes.

### `stop` — async halt

- Runs **async** in **reverse**-topological order.
- Halts active work while keeping booted resources available for cleanup.

### `dispose` — async release

- Runs **async** in **reverse**-topological order.
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

- The throwing plugin is **not** disposed (its `boot` did not complete).
- Every plugin whose `boot` already completed is disposed in
  reverse-topological order.
- App transitions to `failed`.
- Kernel throws `DotLifecycleError` with code `DOT_LIFECYCLE_E003`.

A plugin whose `boot` opens partial resources before throwing **must clean
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

The kernel only disposes plugins whose `boot` returned successfully.

### `start` failure

- Every started plugin's `stop` runs in reverse-topological order.
- Then every booted plugin's `dispose` runs in reverse-topological order.
- App transitions to `failed`.
- Kernel throws `DotLifecycleError` with code `DOT_LIFECYCLE_E004`.

### `stop` / `dispose` failure

- The reverse-topological pass **continues through individual failures**.
- The kernel collects per-plugin failures and throws a single aggregate
  `DotLifecycleError` (`DOT_LIFECYCLE_E005` for stop, `DOT_LIFECYCLE_E006`
  for dispose).
- The aggregate carries `failures: readonly { plugin, phase, error }[]` so
  callers and agents can see exactly which plugins failed.

## Idempotency rules

| Call                  | From state                                | Behaviour                                      |
| --------------------- | ----------------------------------------- | ---------------------------------------------- |
| `boot()`              | `booted`, `started`, `stopped`            | No-op. Hooks do not re-run.                    |
| `boot()` (concurrent) | any pre-`booted`                           | Concurrent callers share one in-flight promise. |
| `start()`             | `defined` or `configured`                  | Boots first, then starts.                      |
| `start()`             | `stopped`                                 | Re-runs **only** `start` hooks.                |
| `start()`             | `started`                                 | No-op.                                         |
| `stop()`              | `defined`, `configured`, `booted`, `stopped` | No-op (nothing started).                       |
| `stop()` (concurrent) | `started`                                  | Concurrent callers share one in-flight promise. |
| `dispose()`           | `started`                                 | Runs `stop` first, then `dispose`.             |
| `dispose()`           | `booted` or `stopped`                      | Runs only `dispose`.                           |
| `dispose()`           | `disposed`                                | No-op.                                         |
| `boot()` / `start()`  | `failed` or `disposed`                     | Throws `DOT_LIFECYCLE_E007` or `E008`.         |

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
| `DOT_LIFECYCLE_E009`  | Plugin dependency graph contains a cycle.                   |
| `DOT_LIFECYCLE_E010`  | Plugin declared a dependency that is not registered.        |
| `DOT_LIFECYCLE_E011`  | Plugin registered twice.                                    |

Every code surfaces as a `DiagnosticIssue` in `app.diagnostics.issues` with
remediation guidance.

## Code examples

### Catching a boot failure

```ts
import { defineApp, DotLifecycleError } from '@arki/dot';

try {
  const app = await defineApp('my-app').use(somePlugin).boot();
  // ...
} catch (err) {
  if (err instanceof DotLifecycleError) {
    console.error(`${err.code} in ${err.plugin}: ${err.message}`);
    if (err.failures) {
      for (const f of err.failures) {
        console.error(`  ${f.plugin}/${f.phase}: ${String(f.error)}`);
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

The kernel coalesces concurrent `stop()` / `dispose()` calls onto a single
in-flight promise, so a double-signal won't double-cleanup.

## See also

- [Plugin authoring](./plugin-authoring.md) — writing a `DotPlugin`.
- [Diagnostics](./diagnostics.md) — observing lifecycle state at runtime.
