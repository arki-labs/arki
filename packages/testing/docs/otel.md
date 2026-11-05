# Capture OpenTelemetry spans and metrics

`@arki/testing/otel` gives a test the spans and metrics its code records, through the real OpenTelemetry API. `captureSpans()` installs an in-memory tracer provider and meter provider as the globals, and an `AsyncLocalStorage` context manager when none is registered. Disposing it puts the earlier providers back. Needs the `@opentelemetry/api` peer; the SDK parts come with this package.

## Why one helper

Before this entry, each `@arki/*` package built `BasicTracerProvider`, `InMemorySpanExporter`, a context manager class and an `afterEach` cleanup inside its own test. The copies drifted: some never restored the globals, some read parents by hand from `parentSpanContext`. One helper keeps the setup, the parent lookup and the cleanup the same everywhere.

## Capture, then assert

```ts run expect
import { metrics, trace } from '@opentelemetry/api';

import { captureSpans } from '@arki/testing/otel';

using spans = captureSpans();
const tracer = trace.getTracer('example');
await tracer.startActiveSpan('db.unit_of_work', async unit => {
  await tracer.startActiveSpan('db.transaction', async transaction => {
    await Promise.resolve();
    metrics.getMeter('example').createCounter('db.operations').add(1, { outcome: 'success' });
    transaction.end();
  });
  unit.end();
});

const counters = (await spans.collectMetrics()).filter(metric => metric.descriptor.name === 'db.operations');
console.log(spans.named('db.transaction').parent?.name);
console.log(
  spans
    .childrenOf(spans.named('db.unit_of_work'))
    .map(span => span.name)
    .join(','),
);
console.log(counters[0]?.dataPoints[0]?.value);
```

```text
db.unit_of_work
db.transaction
1
```

## The capture

| Member               | Gives you                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `finished`           | every finished span (`CapturedSpan[]`), in the order they ended                                                          |
| `named(name)`        | the one finished span with that name. Throws when there is none or more than one; the message lists every finished span. |
| `childrenOf(span)`   | the finished spans started directly under `span`. `span` may be a captured span or a live one you are still holding.     |
| `collectMetrics()`   | a promise of every metric recorded since the capture started or since `reset()`, as cumulative `MetricData`              |
| `reset()`            | forgets the finished spans and starts a fresh meter provider                                                             |
| `[Symbol.dispose]()` | restores the earlier tracer and meter providers; removes the context manager if the capture installed it                 |

A `CapturedSpan` is the SDK's `ReadableSpan` plus `parent`: the finished span it was started under, or `undefined` for a root span or a parent that has not ended yet. `parent` is read when you ask, so a parent that ends after its child is found once it ends. The same span is the same object however you reach it, so `expect(a).toBe(b)` works.

`collectMetrics()` is named after OpenTelemetry's `MetricReader.collect()`, which it calls. It is a promise because collection runs observable callbacks. Values are cumulative, so two reads in a row report the same totals.

## Scope it to one test

Use `using` so the capture ends with the block. With `beforeEach` and `afterEach`, call `[Symbol.dispose]()` yourself:

```ts skip="registers Vitest hooks, so it must run inside Vitest"
import { afterEach, beforeEach } from 'vitest';

import type { SpanCapture } from '@arki/testing/otel';
import { captureSpans } from '@arki/testing/otel';

let spans: SpanCapture;
beforeEach(() => {
  spans = captureSpans();
});
afterEach(() => {
  spans[Symbol.dispose]();
});
```

## Limits

- **Get tracers and meters after the capture starts.** A tracer or instrument cached before `captureSpans()` (or before `reset()` for instruments) keeps writing to the provider it came from. `@arki/*` helpers call `trace.getTracer()` and `metrics.getMeter()` inside each operation, so they are captured.
- **One capture at a time.** The providers are process globals. Two captures alive at once replace each other.
- **`childrenOf` and `parent` see direct children only.** Walk `parent` again for a grandparent.
- **Node, Bun and Deno.** The context manager uses `AsyncLocalStorage` from `node:async_hooks`.
