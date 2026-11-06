/**
 * The OpenTelemetry bridge end to end with a real tracer: a record written inside an active span
 * reaches the Logs API with that span's trace and span ids, so a backend joins the log line to the
 * trace that caused it. `@arki/testing` depends on `@arki/log`, so the provider is built here.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, ContextManager } from '@opentelemetry/api';
import type { LoggerProvider, LogRecord as OtelLogRecord } from '@opentelemetry/api-logs';
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { createLogging } from '../core/logging.js';
import { otelSink, otelTrace } from './index.js';

const storage = new AsyncLocalStorage<Context>();
const manager: ContextManager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with: (next, fn, thisArg, ...args) => storage.run(next, () => fn.apply(thisArg, args)),
  bind: (_next, target) => target,
  enable: () => manager,
  disable: () => manager,
};

let exporter: InMemorySpanExporter;
let tracerProvider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  context.setGlobalContextManager(manager);
});

afterEach(async () => {
  await tracerProvider.shutdown();
  context.disable();
});

/** The Logs API edge `otelSink` writes to: it keeps what the bridge emits. */
function logsApi(): { provider: LoggerProvider; emitted: OtelLogRecord[] } {
  const emitted: OtelLogRecord[] = [];
  return { provider: { getLogger: () => ({ emit: record => emitted.push(record) }) }, emitted };
}

it('gives a record written inside an active span that span’s trace and span ids, so the log joins its trace', async () => {
  const { provider, emitted } = logsApi();
  const logging = createLogging();
  logging.configure({
    channels: { otel: otelSink(provider) },
    default: { level: 'info', channels: ['otel'] },
    trace: otelTrace(),
  });
  const log = logging.getLogger('checkout');
  const tracer = tracerProvider.getTracer('test');

  await tracer.startActiveSpan('checkout.charge', async span => {
    await Promise.resolve(); // the span stays active across an await
    log.info('charged {amount}', { amount: 42 });
    span.end();
  });
  log.info('after the span');

  const [charge] = exporter.getFinishedSpans();
  expect(charge?.name).toBe('checkout.charge');
  const inside = emitted[0]?.context === undefined ? undefined : trace.getSpanContext(emitted[0].context);
  expect(inside).toMatchObject({
    traceId: charge?.spanContext().traceId,
    spanId: charge?.spanContext().spanId,
    traceFlags: charge?.spanContext().traceFlags,
  });
  // Outside any span the record carries no trace context at all, not a made-up one.
  expect(emitted[1]?.context).toBeUndefined();
});

it('exports only the fields, category and template as attributes; the trace ids travel in the context', async () => {
  const { provider, emitted } = logsApi();
  const logging = createLogging();
  logging.configure({
    channels: { otel: otelSink(provider) },
    default: { level: 'info', channels: ['otel'] },
    trace: otelTrace(),
  });
  const log = logging.getLogger('checkout');

  await tracerProvider.getTracer('test').startActiveSpan('checkout.charge', async span => {
    await Promise.resolve();
    log.info('charged {amount}', { amount: 42 });
    span.end();
  });

  // The bridge documents the rendered message as the record body.
  expect(emitted[0]?.body).toBe('charged 42');
  expect(Object.keys(emitted[0]?.attributes ?? {}).toSorted()).toEqual(['amount', 'log.category', 'log.template']);
});
