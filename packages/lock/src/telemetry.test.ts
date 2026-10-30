import { context, metrics, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnexpectedDefect } from '@arki/failure';

import { createLocks } from './index.js';
import { memoryStore } from './memory.js';
import { defaultScheduler } from './scheduler.js';

afterEach(() => {
  vi.restoreAllMocks();
  trace.disable();
  metrics.disable();
});

describe('default lock observability', () => {
  it('exports real spans and bounded counters without recording identities or payloads', async () => {
    const spans = new InMemorySpanExporter();
    const tracer = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
    trace.setGlobalTracerProvider(tracer);
    const exported = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter: exported, exportIntervalMillis: 60_000 });
    const meter = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(meter);
    const locks = createLocks({ store: memoryStore(), namespace: 'private_namespace' });
    expect(await locks.mutex('private_key').tryRun(() => 'private_payload')).toBe('private_payload');
    await meter.forceFlush();
    const finished = spans.getFinishedSpans();
    expect(finished.map(span => span.name)).toContain('lock.try_run');
    const attributes = JSON.stringify(finished.map(span => span.attributes));
    expect(attributes).not.toMatch(/private_namespace|private_key|private_payload/);
    const metricData = exported.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics));
    const operations = metricData.find(metric => metric.descriptor.name === 'lock.operations');
    expect(operations?.dataPoints).toEqual(expect.arrayContaining([expect.objectContaining({ attributes: { operation: 'try_run', outcome: 'success' }, value: 1 })]));
    await meter.shutdown();
    await tracer.shutdown();
  });

  it('executes work once when a defective context manager calls twice then rejects', async () => {
    let calls = 0;
    vi.spyOn(context, 'with').mockImplementation((_ctx, callback) => {
      callback();
      callback();
      throw new Error('context defect');
    });
    const locks = createLocks({ store: memoryStore(), namespace: 'context' });
    expect(await locks.mutex('key').tryRun(() => ++calls)).toBe(1);
    expect(calls).toBe(1);
  });

  it('observes invalid rejected clock returns before callback execution', async () => {
    let calls = 0;
    const scheduler = { ...defaultScheduler };
    Reflect.set(scheduler, 'now', () => Promise.reject(new Error('clock rejected')));
    const locks = createLocks({ store: memoryStore(), namespace: 'clock', scheduler });
    const result = await locks.mutex('key').tryRun(() => ++calls);
    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(calls).toBe(0);
  });

  it('isolates a rejected telemetry acquisition without replay or unhandled rejection', async () => {
    let calls = 0;
    const getTracer = Reflect.get(trace, 'getTracer');
    Reflect.set(trace, 'getTracer', () => Promise.reject(new Error('tracer acquisition rejected')));
    try {
      const locks = createLocks({ store: memoryStore(), namespace: 'report' });
      expect(await locks.mutex('key').tryRun(() => ++calls)).toBe(1);
      await Promise.resolve();
      expect(calls).toBe(1);
    } finally { Reflect.set(trace, 'getTracer', getTracer); }
  });
});
