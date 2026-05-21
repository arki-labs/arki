# Observability

DOT is OTel-first. Traces, metrics, and logs come out of the kernel
without you wiring anything — you wire the *exporter*. Skip the OTel
SDK and you pay zero allocation per lifecycle call; the OTel API returns
no-op implementations and the cost vanishes.

This page is the short version. If you've used `@opentelemetry/api`
before, you can skim straight to the [attribute table](#attribute-conventions).

---

## What you get

Every `DotApp` emits three signals across its 5-hook lifecycle:

| Signal | Carrier | When |
| ------ | ------- | ---- |
| **Spans** | `@opentelemetry/api` tracer named `@arki/dot` | Every `configure()` / `boot()` / `start()` / `stop()` / `dispose()` call + every pip hook within them |
| **Metrics** | `@opentelemetry/api` meter named `@arki/dot` | Two histograms: `dot.app.phase.duration` (per phase) and `dot.pip.hook.duration` (per pip per hook) |
| **Logs** | `@arki/log` logger named `arki:dot:lifecycle` | Every phase boundary; DEBUG by default, ERROR/WARN on failure paths |

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

```ts
// observability.ts — your app's entry point
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }),
  contextManager: new AsyncLocalStorageContextManager(),
});
sdk.start();
```

The `AsyncLocalStorageContextManager` is **required** for parent-child
linkage across `await` boundaries — without it, pip-hook spans become
root spans rather than children of their phase span. The DOT kernel
deliberately does not pull this in; you decide what context manager
fits your runtime.

---

## Spans

Two span shapes. One per public phase, one per pip hook.

### Phase span — `dot.app.<phase>`

Emitted by `configure()` / `boot()` / `start()` / `stop()` / `dispose()`.
Becomes the *active* span (via `tracer.startActiveSpan`), so children
created during the phase auto-parent to it.

### Pip span — `dot.pip.<hook>`

One per pip per hook execution. The pip name lives on the
`dot.pip.name` attribute, not in the span name — that lets backends
aggregate by hook across pips. Aggregating "how slow is boot on
average?" needs all pips' `dot.pip.boot` spans to share a name.

### Attribute conventions

| Attribute | On | Type | Meaning |
| --------- | -- | ---- | ------- |
| `dot.app.name` | both | string | The app name from `defineApp(name)` |
| `dot.app.version` | phase | string | The app version (when set) |
| `dot.app.phase` | phase | string | `configure`/`boot`/`start`/`stop`/`dispose` |
| `dot.app.pip.count` | phase | int | How many pips this app composes |
| `dot.pip.name` | pip | string | The pip's `name` |
| `dot.pip.version` | pip | string | The pip's `version` |
| `dot.hook` | pip | string | Which hook (same set as `dot.app.phase`) |
| `dot.pip.order` | pip | int | Topological order (0-based, deterministic) |

On failure, the span gets `SpanStatusCode.ERROR` and an `exception`
event with the thrown error recorded via `span.recordException()`. No
manual scrubbing needed; standard OTel viewers render it.

---

## Metrics

Two histograms, both with unit `ms`. Both have `dot.status` as an
attribute (`ok` or `failed`) so you can split SLOs by outcome.

```text
dot.app.phase.duration   { dot.app.name, dot.app.phase, dot.status }
dot.pip.hook.duration    { dot.app.name, dot.pip.name, dot.hook, dot.status }
```

Wire a `MeterProvider` (typically via `NodeSDK`) and you get p50 / p95 /
p99 boot times per app, per pip, per hook — no extra code.

---

## Logs

The kernel uses `@arki/log` exclusively. The logger is named
`arki:dot:lifecycle` and ships with the `dot.app.name` attribute baked
in. Forks add `dot.app.phase` and `dot.pip.name` as the call descends
into pips.

### Severity model

Quiet by default. Loud when something breaks.

- **DEBUG** — phase boundaries (`starting`, `done`, `complete`),
  per-pip hook completions. Silent unless explicitly elevated.
- **WARN** — phase completed *with* per-pip failures (`stop`/`dispose`
  continue through individual errors and report aggregates).
- **ERROR** — a pip's hook threw; the kernel logs the failure and the
  rollback summary before the cascading `DotLifecycleError` propagates.

### Turning it on

Two ways. Pick the one that matches how you operate the app.

**Per-namespace via env:**

```sh
DEBUG=arki:dot:lifecycle bun run app.ts
# every phase boundary + every pip hook timing → stdout as JSON
```

`@arki/log` reads the `DEBUG` env at boot and elevates matching loggers
to DEBUG severity. No code change required.

**Globally via `LOG_LEVEL`:**

```sh
LOG_LEVEL=debug bun run app.ts
```

This affects every `@arki/log` logger in the process, not just the
kernel. Useful in development; rarely what you want in production.

### Trace correlation

When an OTel SDK is registered, each log record carries the active
span's `traceId` and `spanId` automatically:

```json
{
  "name": "arki:dot:lifecycle",
  "body": "boot: FAILED — rolling back already-booted pips",
  "attributes": {
    "dot.app.name": "my-app",
    "dot.app.phase": "boot",
    "dot.pip.name": "db",
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

```ts
// 1. Register OTel SDK once, before any DOT app boots.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

new NodeSDK({
  serviceName: 'my-app',
  contextManager: new AsyncLocalStorageContextManager(),
  // traceExporter, metricReader, logRecordProcessor — your choice
}).start();

// 2. Build and boot your app. Nothing else to wire.
import { defineApp } from '@arki/dot';
import { envPip, dbPip } from './pips';

await defineApp('my-app').use(envPip).use(dbPip).start();

// 3. Optionally turn on lifecycle logs at the env layer:
//    DEBUG=arki:dot:lifecycle bun run app.ts
```

---

## What we deliberately don't do

- **No built-in exporter.** DOT does not pick stdout, OTLP, Jaeger, or
  Datadog for you. The kernel registers nothing; the SDK is yours.
- **No auto-instrumentation.** DOT only instruments its own lifecycle.
  HTTP, database, and queue spans come from each adapter or from
  `@opentelemetry/auto-instrumentations-node`. The kernel does not
  reach into your pips.
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

```ts
import { defineApp, type DotLifecycleEvent } from '@arki/dot';

const events: DotLifecycleEvent[] = [];

const app = await defineApp('my-app', {
  observers: [(event) => events.push(event)],
})
  .use(envPip)
  .use(dbPip)
  .boot();

// `events` now contains 4 events per phase (phase-starting, hook-starting
// per pip, hook-completed per pip, phase-completed) plus configure/boot.
```

Each event carries `kind` (`'phase'` or `'pip-hook'`), `phase`, `status`
(`'starting'` / `'completed'` / `'failed'`), `appName`, `timestamp` (ms
since epoch), and on completion `durationMs`. Failed events also carry
`error`.

Observers may also be added post-hoc:

```ts
const unsubscribe = app.subscribe((event) => {
  if (event.kind === 'pip-hook' && event.status === 'failed') {
    notifyOps(event);
  }
});
// ...later
unsubscribe();
```

Observers added through `subscribe()` see only events fired *after*
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

`app.timeline()` returns a per-phase, per-pip duration chart suitable
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
