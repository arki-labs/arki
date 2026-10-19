# Observability

DOT is OTel-first. Traces, metrics, and logs come out of the kernel
without you wiring anything — you wire the _exporter_. Without an OTel SDK, tracing and metrics safely use the API’s no-op implementations.

This page is the short version. If you've used `@opentelemetry/api`
before, you can skim straight to the [attribute table](#attribute-conventions).

---

## What you get

Every `DotApp` emits three signals across its 5-hook lifecycle:

| Signal      | Carrier                                       | When                                                                                                      |
| ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Spans**   | `@opentelemetry/api` tracer named `@arki/dot` | Every `configure()` / `boot()` / `start()` / `stop()` / `dispose()` call + every plugin hook within them  |
| **Metrics** | `@opentelemetry/api` meter named `@arki/dot`  | Two histograms: `dot.app.phase.duration` (per phase) and `dot.plugin.hook.duration` (per plugin per hook) |
| **Logs**    | `@arki/log` logger named `arki:dot:lifecycle` | Every phase boundary; DEBUG by default, ERROR/WARN on failure paths                                       |

All three are correlated. When an SDK is registered, the kernel threads
each span's `traceId` + `spanId` onto the matching log record. One trace
ID. One waterfall. Click a span; see its logs.

---

## Zero cost by default

DOT depends on `@opentelemetry/api`. It does **not** depend on
`@opentelemetry/sdk-node` or any exporter. Until you register a
`TracerProvider`/`MeterProvider`, the API returns no-op objects.

That means:

- No spans are recorded.
- No metrics are exported.
- The kernel still calls `tracer.startSpan(...)` and
  `meter.createHistogram(...)`, but each call returns a stub that does
  nothing. Modern V8 inlines these to near-zero cost.

You opt in by registering an SDK at app boot, exactly once, before
`defineApp(...)`:

```ts skip="needs @opentelemetry/sdk-node, the OTLP exporter and the context manager, which this package does not install"
// observability.ts — your app's entry point
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }),
  contextManager: new AsyncLocalStorageContextManager(),
});
sdk.start();
```

The `AsyncLocalStorageContextManager` is **required** for parent-child
linkage across `await` boundaries — without it, plugin-hook spans become
root spans rather than children of their phase span. The DOT kernel
deliberately does not pull this in; you decide what context manager
fits your runtime.

---

## Spans

Two span shapes. One per public phase, one per plugin hook.

### Phase span — `dot.app.<phase>`

Emitted by `configure()` / `boot()` / `start()` / `stop()` / `dispose()`.
Becomes the _active_ span (via `tracer.startActiveSpan`), so children
created during the phase auto-parent to it.

### Plugin span — `dot.plugin.<hook>`

One per plugin per hook execution. The plugin name lives on the
`dot.plugin.name` attribute, not in the span name — that lets backends
aggregate by hook across plugins. Aggregating "how slow is boot on
average?" needs all plugins' `dot.plugin.boot` spans to share a name.

### Attribute conventions

| Attribute              | On     | Type   | Meaning                                     |
| ---------------------- | ------ | ------ | ------------------------------------------- |
| `dot.app.name`         | both   | string | The app name from `defineApp(name)`         |
| `dot.app.version`      | phase  | string | The app version (when set)                  |
| `dot.app.phase`        | phase  | string | `configure`/`boot`/`start`/`stop`/`dispose` |
| `dot.app.plugin.count` | phase  | int    | How many plugins this app composes          |
| `dot.plugin.name`      | plugin | string | The plugin's `name`                         |
| `dot.hook`             | plugin | string | Which hook (same set as `dot.app.phase`)    |
| `dot.plugin.order`     | plugin | int    | Topological order (0-based, deterministic)  |

Typed failures mark the span as failed with canonical failure attributes.
Unexpected exceptions are classified as defects; private failure payloads are not
automatically copied into span attributes. See the outcome handling source below.

---

## Metrics

Two histograms, both with unit `ms`. Both have `dot.status` as an
attribute (`ok` or `failed`) so you can split SLOs by outcome.

```text
dot.app.phase.duration   { dot.app.name, dot.app.phase, dot.status }
dot.plugin.hook.duration    { dot.app.name, dot.plugin.name, dot.hook, dot.status }
```

Wire a `MeterProvider` (typically via `NodeSDK`) and you get p50 / p95 /
p99 boot times per app, per plugin, per hook — no extra code.

---

## Logs

The kernel uses `@arki/log` exclusively. The logger is named
`arki:dot:lifecycle` and ships with the `dot.app.name` attribute baked
in. Forks add `dot.app.phase` and `dot.plugin.name` as the call descends
into plugins.

### Severity model

Quiet by default. Loud when something breaks.

- **DEBUG** — phase boundaries (`starting`, `done`, `complete`),
  per-plugin hook completions. Silent unless explicitly elevated.
- **WARN** — phase completed _with_ per-plugin failures (`stop`/`dispose`
  continue through individual errors and report aggregates).
- **ERROR** — a plugin's hook threw; the kernel logs the failure and the
  rollback summary before the cascading `DotLifecycleError` propagates.

### Turning it on

Two ways. Pick the one that matches how you operate the app.

**Per-namespace via env:**

```sh
DEBUG=arki:dot:lifecycle bun run app.ts
# every phase boundary + every plugin hook timing → stdout as JSON
```

`@arki/log` reads the `DEBUG` env at boot and elevates matching loggers
to DEBUG severity. No code change required.

**Globally via `LOG_LEVEL`:**

```sh
LOG_LEVEL=debug bun run app.ts
```

This affects every `@arki/log` logger in the process, not only the
kernel. Useful in development; rarely what you want in production.

### Trace correlation

When an OTel SDK is registered, each log record carries the active
span's `traceId` and `spanId` automatically:

```json
{
  "name": "arki:dot:lifecycle",
  "body": "boot: FAILED — rolling back already-booted plugins",
  "attributes": {
    "dot.app.name": "my-app",
    "dot.app.phase": "boot",
    "dot.plugin.name": "db",
    "dot.app.rollback.count": 2
  },
  "severityText": "ERROR",
  "traceId": "3afd65b1f92f26fb87aeac8891007fdf",
  "spanId": "5c25d82fbe4c14e8"
}
```

With no SDK registered, `traceId` is all zeros — a sentinel for "no
trace was recorded." This is by design: the field is always present,
the value tells you whether tracing was active.

---

## Quick reference

```ts skip="needs @opentelemetry/sdk-node, the OTLP exporter and the context manager, which this package does not install"
// 1. Register OTel SDK once, before any DOT app boots.
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { NodeSDK } from '@opentelemetry/sdk-node';

// 2. Build and boot your app. Nothing else to wire.
import { defineApp } from '@arki/dot';

import { dbPlugin, envPlugin } from './plugins';

new NodeSDK({
  serviceName: 'my-app',
  contextManager: new AsyncLocalStorageContextManager(),
  // traceExporter, metricReader, logRecordProcessor — your choice
}).start();

await defineApp('my-app').use(envPlugin).use(dbPlugin).start();

// 3. Optionally turn on lifecycle logs at the env layer:
//    DEBUG=arki:dot:lifecycle bun run app.ts
```

---

## Verifying SDK registration

Run `dot doctor --observability` to verify your app has an OpenTelemetry
SDK registered. The probe starts a transient span via the public OTel
API and inspects the resulting trace ID — when no SDK is registered,
the API returns the all-zero sentinel; when one is, a real random ID.

```sh
$ dot doctor --observability --json
{
  "ok": true,
  "command": ["doctor"],
  "data": {
    "status": "warning",
    ...
    "issues": [
      {
        "code": "dot.observability_no_sdk",
        "severity": "warning",
        "message": "No OpenTelemetry SDK is registered. Lifecycle traces and metrics will not be exported.",
        "remediation": "Register an OTel SDK (e.g. @opentelemetry/sdk-node with AsyncLocalStorageContextManager) once at app entry, before any DotApp boots.",
        "docsUrl": "https://docs.arki.dev/dot/cli#dot-observability-no-sdk"
      }
    ]
  },
  ...
}
```

The probe issue is severity `warning` — lack of an SDK is a deployment
choice, not a bug. Doctor will not exit non-zero on this alone (per-plugin
errors still take precedence: doctor then returns `dot.doctor_failed`, exit 3).

The flag is **opt-in**: standard `dot doctor` doesn't run the probe, so
agents that don't care about observability won't see the issue.

---

<a id="observability-no-sdk"></a>

## What we deliberately don't do

- **No built-in exporter.** DOT does not pick stdout, OTLP, Jaeger, or
  Datadog for you. The kernel registers nothing; the SDK is yours.
- **No auto-instrumentation.** DOT instruments its own lifecycle, usecases and action execution.
  HTTP, database, and queue spans come from each adapter or from
  `@opentelemetry/auto-instrumentations-node`. The kernel does not
  reach into your plugins.
- **No structured-log-to-span bridge in the kernel.** Logs and spans
  share trace IDs; they are not the same signal. If you want logs
  attached as span events, register a `LogRecordProcessor` that does so
  — but that's an exporter concern, not the kernel's.
- **No "dev mode" pretty-printer.** `@arki/log` is pino-backed; if you
  want pretty output locally, pipe through `pino-pretty`. The kernel
  emits structured JSON in every environment.

---

## In-process observers

OTel is the long-range signal. For short-range, in-process inspection —
tests, CLI tools, ad-hoc debugging — every `DotApp` also fans out a
synchronous event stream to registered `DotLifecycleObserver`s. The two
signals are peers; neither layers under the other.

```ts run expect
import type { DotLifecycleEvent } from '@arki/dot';
import { defineApp, plugin } from '@arki/dot';
import { isFailure } from '@arki/failure';

const envPlugin = plugin({ name: 'env', provides: { env: () => ({ mode: 'test' }) } });
const dbPlugin = plugin({ name: 'db', provides: { db: () => ({ ready: true }) } });

const events: DotLifecycleEvent[] = [];

const app = await defineApp('my-app', {
  observers: [event => events.push(event)],
})
  .use(envPlugin)
  .use(dbPlugin)
  .boot();
if (isFailure(app)) throw new Error(app.code);

for (const event of events) {
  const who = event.kind === 'plugin-hook' ? ` ${event.plugin}` : '';
  console.log(`${event.kind} ${event.phase} ${event.status}${who}`);
}
await app.dispose();
```

```text
phase configure starting
phase configure completed
phase boot starting
plugin-hook boot starting env
plugin-hook boot completed env
plugin-hook boot starting db
plugin-hook boot completed db
phase boot completed
```

Every phase emits a `starting` and a `completed` (or `failed`) event. Every
plugin that defines the hook emits the same pair for it. The two plugins above
publish services through `provides` and define no `boot` or `configure` hook
of their own, yet they appear under `boot`, because their factories run
inside it.

Each event carries `kind` (`'phase'` or `'plugin-hook'`), `phase`, `status`
(`'starting'` / `'completed'` / `'failed'`), `appName`, `timestamp` (ms
since epoch), and on completion `durationMs`. Failed events also carry
`error`.

Observers may also be added post-hoc:

```ts continue
const alerts: string[] = [];
const unsubscribe = app.subscribe(event => {
  if (event.kind === 'plugin-hook' && event.status === 'failed') {
    alerts.push(`${event.plugin} failed in ${event.phase}`); // or notify ops
  }
});
// ...later
unsubscribe();
```

Observers added through `subscribe()` see only events fired _after_
subscription — to catch `configure`-phase events, pass them through
`defineApp(name, { observers })` at construction.

**Contract:**

- Observers are called synchronously. Don't block; if you need to ship
  events off-process, buffer and drain on a separate cadence.
- Observer exceptions are caught and DEBUG-logged on
  `arki:dot:lifecycle`. A misbehaving observer never breaks the
  lifecycle and never hides events from siblings.
- When no observers are registered, the kernel allocates nothing per
  emission point — the same zero-cost-when-off discipline that governs
  the OTel signals.

---

## ASCII timeline

`app.timeline()` returns a per-phase, per-plugin duration chart suitable
for terminal output:

```text
Timeline: my-app (state=booted)
─────────────────────────────────
configure
  env       0.5ms  █
  db        1.4ms  █████
  kv        0.3ms  █

boot
  env       2.8ms  ████████
  db       32.9ms  ████████████████████████████████████████
  kv        3.9ms  ████████████
─────────────────────────────────
```

Pure render over `app.diagnostics.lifecycle` — call it after `boot()` or
`dispose()` to see the full picture. Failed hooks are marked `✗`; if
`showIssues: true` (default), each failed hook's `DiagnosticIssue` lines
appear underneath the bar.

The same renderer is exposed as `renderTimeline(snapshot, opts?)` for
callers that want to feed a custom `DotDiagnosticsSnapshot` to it (e.g.
serialised app state from another process).

---

## See also

- [`packages/dot/docs/principles.md`](./principles.md) — principle 5
  (zero optional deps) is the reason we don't bundle an SDK; principle
  4 (agent-discoverable) is the reason every signal carries stable IDs.
- [`packages/dot/docs/lifecycle.md`](./lifecycle.md) — what each phase
  actually does and when each hook fires.
- [OpenTelemetry JS docs](https://opentelemetry.io/docs/languages/js/) —
  for the SDK side, which the kernel deliberately leaves to you.

## Custom instrumentation

The application owns SDK registration, exporters and the context manager.
`$telemetry` in plugin configure/hook contexts uses the existing plugin identity;
`telemetryFor(feature)` also accepts a feature or `{ name }` identity. Both retain
active context across custom work when the app has registered a context manager.

```ts run expect
import { telemetryFor } from '@arki/dot/telemetry';

const telemetry = telemetryFor({ name: 'catalog' });
const lookups = telemetry.counter('catalog.lookups');
const duration = telemetry.histogram('catalog.lookup.duration', { unit: 'ms' });
const result = await telemetry.span('catalog.cache.lookup', async () => {
  telemetry.event('catalog.cache.hit', { tier: 'memory' });
  lookups.add(1, { tier: 'memory' });
  duration.record(2, { tier: 'memory' });
  return 'book';
});
console.log(result);
```

```text
book
```

Use `telemetry.log('debug', 'Catalog lookup completed', { tier: 'memory' })`
for logs correlated with the active valid trace. The app configures `@arki/log`.
Keep metric dimensions bounded and record explicit safe fields only.
Custom instrumentation is safe without an SDK; reporter exceptions cannot replace
the operation's outcome. Typed failures classify outcomes consistently for A/B
action execution. Keep existing HTTP, RPC and provider instrumentation; add a
custom span only for a distinct operation, or annotate its active span with an event.

Sources: [telemetry](../src/telemetry.ts), [outcome/context handling](../src/kernel/otel.ts).
