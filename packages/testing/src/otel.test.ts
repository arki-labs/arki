/**
 * `captureSpans()` is how `@arki/*` packages prove their telemetry. These tests drive it with the real
 * OpenTelemetry API, so a capture that loses a parent, a metric or the previous global fails here first.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, ContextManager } from '@opentelemetry/api';
import { context, createContextKey, metrics, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';

import { captureSpans } from './otel.js';

const tracer = () => trace.getTracer('@arki/testing/otel.test');
const probe = createContextKey('otel.test probe');
const propagates = () => context.with(ROOT_CONTEXT.setValue(probe, 1), () => context.active().getValue(probe) === 1);

/** A context manager the test file registers itself, to prove the capture leaves it in place. */
class OwnContextManager implements ContextManager {
  readonly storage = new AsyncLocalStorage<Context>();
  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    current: Context,
    callback: F,
    receiver?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(current, () => callback.apply(receiver, args));
  }
  bind<T>(_current: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.storage.disable();
    return this;
  }
}

afterEach(() => {
  trace.disable();
  metrics.disable();
  context.disable();
});

describe('captureSpans spans', () => {
  it('links each finished span to its finished parent across await', async () => {
    using spans = captureSpans();
    await tracer().startActiveSpan('outer', async outer => {
      await tracer().startActiveSpan('middle', async middle => {
        await Promise.resolve();
        tracer().startSpan('inner').end();
        middle.end();
      });
      tracer().startSpan('sibling').end();
      outer.end();
    });
    tracer().startSpan('root').end();

    expect(spans.finished.map(span => span.name)).toEqual(['inner', 'middle', 'sibling', 'outer', 'root']);
    expect(spans.named('inner').parent?.name).toBe('middle');
    expect(spans.named('inner').parent?.parent?.name).toBe('outer');
    expect(spans.named('outer').parent).toBeUndefined();
    expect(spans.named('root').parent).toBeUndefined();
    expect(spans.childrenOf(spans.named('outer')).map(span => span.name)).toEqual(['middle', 'sibling']);
    // The same finished span is the same object however it is reached, so `toBe` works in assertions.
    expect(spans.named('middle')).toBe(spans.named('inner').parent);
  });

  it('reads the parent when asked, so a parent that ends after its child is found', () => {
    using spans = captureSpans();
    const open = tracer().startSpan('open');
    const child = tracer().startSpan('child', {}, trace.setSpan(context.active(), open));
    child.end();
    expect(spans.named('child').parent).toBeUndefined();
    expect(spans.childrenOf(open).map(span => span.name)).toEqual(['child']);
    open.end();
    expect(spans.named('child').parent?.name).toBe('open');
  });

  it('fails clearly when no span or several spans carry the name', () => {
    using spans = captureSpans();
    tracer().startSpan('db.transaction').end();
    tracer().startSpan('db.transaction').end();
    tracer().startSpan('db.local.init').end();
    expect(() => spans.named('db.unit_of_work')).toThrow(
      'captureSpans: expected exactly one finished span named "db.unit_of_work", found 0. Finished spans: db.transaction, db.transaction, db.local.init.',
    );
    expect(() => spans.named('db.transaction')).toThrow(/named "db\.transaction", found 2\./);
  });

  it('names an empty capture in the failure message', () => {
    using spans = captureSpans();
    expect(() => spans.named('anything')).toThrow('Finished spans: (none).');
  });
});

describe('captureSpans metrics', () => {
  it('collects counters and histograms with their attributes, and two reads agree', async () => {
    using spans = captureSpans();
    const meter = metrics.getMeter('@arki/testing/otel.test');
    meter.createCounter('test.operations').add(2, { outcome: 'success' });
    meter.createCounter('test.operations').add(1, { outcome: 'failure' });
    meter.createHistogram('test.operation.duration', { unit: 's' }).record(0.25, { outcome: 'success' });

    const collected = await spans.collectMetrics();
    const operations = collected.find(metric => metric.descriptor.name === 'test.operations');
    expect(operations?.dataPoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: { outcome: 'success' }, value: 2 }),
        expect.objectContaining({ attributes: { outcome: 'failure' }, value: 1 }),
      ]),
    );
    const duration = collected.find(metric => metric.descriptor.name === 'test.operation.duration');
    expect(duration?.descriptor.unit).toBe('s');
    expect(duration?.dataPoints).toEqual([
      expect.objectContaining({ value: expect.objectContaining({ count: 1, sum: 0.25 }) }),
    ]);
    // Cumulative: a second read reports the same totals (only the collection time moves).
    const values = (read: typeof collected) =>
      read.map(metric => metric.dataPoints.map(point => [point.attributes, point.value]));
    expect(values(await spans.collectMetrics())).toEqual(values(collected));
  });
});

describe('captureSpans reset', () => {
  it('forgets spans and metrics recorded before reset', async () => {
    using spans = captureSpans();
    tracer().startSpan('before').end();
    metrics.getMeter('test').createCounter('test.count').add(5);
    spans.reset();
    expect(spans.finished).toEqual([]);
    expect(await spans.collectMetrics()).toEqual([]);

    tracer().startSpan('after').end();
    metrics.getMeter('test').createCounter('test.count').add(1);
    expect(spans.finished.map(span => span.name)).toEqual(['after']);
    const [count] = await spans.collectMetrics();
    expect(count?.dataPoints.map(point => point.value)).toEqual([1]);
  });
});

describe('captureSpans dispose', () => {
  it('puts back the tracer and meter providers registered before, and leaves no capture behind', () => {
    const previousSpans = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(previousSpans)] }),
    );
    const previousMeterProvider = new MeterProvider();
    metrics.setGlobalMeterProvider(previousMeterProvider);

    let capturedCount: number;
    {
      using spans = captureSpans();
      tracer().startSpan('during').end();
      capturedCount = spans.finished.length;
      expect(metrics.getMeterProvider()).not.toBe(previousMeterProvider);
    }
    tracer().startSpan('after').end();

    expect(capturedCount).toBe(1);
    expect(previousSpans.getFinishedSpans().map(span => span.name)).toEqual(['after']);
    expect(metrics.getMeterProvider()).toBe(previousMeterProvider);
  });

  it('leaves the no-op globals when nothing was registered before', () => {
    {
      using spans = captureSpans();
      expect(tracer().startSpan('during').isRecording()).toBe(true);
      expect(propagates()).toBe(true);
      expect(spans.finished).toEqual([]);
    }
    expect(tracer().startSpan('after').isRecording()).toBe(false);
    expect(propagates()).toBe(false);
    // A later capture, or an app's own SDK, can still register.
    expect(trace.setGlobalTracerProvider(new BasicTracerProvider())).toBe(true);
  });

  it('keeps a context manager the test registered itself, before and after the capture', async () => {
    context.setGlobalContextManager(new OwnContextManager());
    {
      using spans = captureSpans();
      await tracer().startActiveSpan('outer', async outer => {
        await Promise.resolve();
        tracer().startSpan('inner').end();
        outer.end();
      });
      expect(spans.named('inner').parent?.name).toBe('outer');
    }
    expect(propagates()).toBe(true);
  });
});
