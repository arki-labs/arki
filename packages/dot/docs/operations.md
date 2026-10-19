# Logging, shutdown and timeouts

What an app needs once it leaves your laptop: one logging plugin, a clean
shutdown on `SIGTERM`, and a watchdog so a hung hook fails loudly.

## The lifecycle at a glance

`defineApp(name)` returns a builder. Calling `.use(plugin)` accumulates
plugins. The lifecycle then flows:

```text
defined ──configure()──▶ configured ──boot()──▶ booted ──start()──▶ started
                                                                       │
                       disposed ◀──dispose()── stopped ◀──stop()───────┘
```

`boot()` runs `configure()` implicitly if you skipped it. `start()` runs
`boot()` implicitly. `stop()` and `dispose()` always run in reverse

The full contract, with every failure rule, is in [Lifecycle](./lifecycle.md).

## Logging

Dot logs through `@arki/log`. The kernel's own records go to the
`arki:dot:lifecycle` category. Importing Dot switches nothing on: the app
does, with `log()` from `@arki/dot/log` as its **first** `.use(...)`.

```ts
import { isFailure } from '@arki/failure';
import { defineApp } from '@arki/dot';
import { log } from '@arki/dot/log';
import { asyncContext, fromEnv, stdout } from '@arki/log/node';

const app = await defineApp('checkout')
  .use(
    log(() => ({
      ...fromEnv(),
      context: asyncContext(),
      channels: { stdout: stdout() },
      default: { level: 'info', channels: ['stdout'] },
    })),
  )
  .boot();
if (isFailure(app)) throw new Error(app.code);
```

- The config is a thunk. It runs when the app boots, never at import.
- `resource['service.name']` defaults to the app name.
- The `configure()` handle is published as the `logging` service
  (`needs: { logging: service<Configured<'stdout'>>() }`).
- `log()` reads no env on its own (spread `fromEnv()`), installs no
  OpenTelemetry SDK and does not patch `console`.

`log()` fills Dot's **logging slot**. Any plugin can fill it with
`plugin({ name, logging: ({ appName }) => handle })`, where `handle` has
`close(): Promise<void>`. The kernel calls the factory before its first
lifecycle record (`configure: starting`) and closes the handle after its
last one (`dispose: complete`). On a failed `configure`, `boot` or `start`,
the failure is written first and logging closes last. An app has at most one
logging plugin: two is `ARKI_DOT_E018`.

Without a logging plugin, `@arki/log` keeps only the first 64 records at
`warn` and above, and writes nothing else.

## Shutdown and timeouts

Two kernel helpers close the gap between "boots on my machine" and "runs
under a process manager":

```ts
import { isFailure } from '@arki/failure';
import { defineApp, hookSignals, plugin } from '@arki/dot';

const worker = plugin({
  name: 'worker',
  provides: { jobs: () => ({ poll: () => setInterval(() => {}, 1_000) }) },
  start: ({ jobs }) => {
    jobs.poll(); // begin processing
  },
});

const app = await defineApp('shop', { hookTimeoutMs: 30_000 }).use(worker).start();
if (isFailure(app)) throw new Error(app.code);

hookSignals(app); // SIGTERM/SIGINT → stop() + dispose() → re-raise
```

- **`hookSignals(app, { timeoutMs? })`** — graceful shutdown wiring. The
  first signal drains the app (bounded by `timeoutMs`, default 10 s) and
  re-raises itself so the exit status keeps standard signal semantics; a
  second signal falls through to the runtime default (immediate kill).
  Returns an unhook function.
- **`createAppRuntime(app, { hot: import.meta.hot, onStarted? })`** (from
  `@arki/dot/runtime`) — one
  started app per server process, for hosts that boot the app lazily (TanStack
  Start, Vite SSR). `get()` starts the app once and retries a failed start;
  the started app gets `hookSignals`. Returned failures are never cached as ready;
  failed disposal blocks a replacement owner. On a Vite hot update the old app is
  disposed, and the replacing module starts its app only after that disposal
  finished — `import.meta.hot.dispose` alone does not wait, so two apps would
  share the pool or the PGlite directory.
- **`hookTimeoutMs`** — a per-hook watchdog. It requests cancellation and records
  `ARKI_DOT_E015` diagnostics. Owned construction returns `Deadline` after
  admitted work settles; cleanup never races a callback still using resources.
  A hook that ignores cancellation can keep teardown pending. See [Ownership](ownership.md).
