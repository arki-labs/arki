/// <reference types="node" />
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, ContextManager } from '@opentelemetry/api';
import { context, createNoopMeter, metrics, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { MockClock } from '@arki/clock';
import { defineFailure, isFailure } from '@arki/failure';

import { all, mapConcurrent, race, timeout } from './concurrency.js';
import { Cancelled, Deadline } from './errors.js';
import { operationTelemetry } from './operation-telemetry.js';
import { scoped } from './scope.js';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  const storage = new AsyncLocalStorage<Context>();
  const manager: ContextManager = {
    active: () => storage.getStore() ?? ROOT_CONTEXT,
    with: (next, run, receiver, ...args) => storage.run(next, () => run.apply(receiver, args)),
    bind: (_next, target) => target,
    enable: () => manager,
    disable: () => {
      storage.disable();
      return manager;
    },
  };
  context.setGlobalContextManager(manager);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await provider.shutdown();
  trace.disable();
  metrics.disable();
  context.disable();
});

it('creates one operation span, preserves async task/custom context, and restores its caller', async () => {
  const parent = trace.getTracer('application').startSpan('caller');
  await context.with(trace.setSpan(context.active(), parent), async () => {
    const result = await all([
      async () => {
        await Promise.resolve();
        const custom = trace.getTracer('application').startSpan('custom');
        custom.end();
        return mapConcurrent([1], async () => {
          await Promise.resolve();
          return trace.getActiveSpan()?.spanContext().spanId;
        });
      },
    ]);
    if (isFailure(result)) throw new Error('unexpected operation failure');
    expect(trace.getActiveSpan()).toBe(parent);
  });
  parent.end();
  const spans = exporter.getFinishedSpans();
  expect(spans.map(span => span.name).toSorted()).toEqual(['async.all', 'async.mapConcurrent', 'caller', 'custom']);
  const outer = spans.find(span => span.name === 'async.all');
  const inner = spans.find(span => span.name === 'async.mapConcurrent');
  expect(outer?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
  expect(spans.find(span => span.name === 'custom')?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
  expect(trace.getActiveSpan()).toBeUndefined();
});

it('classifies cancellation/deadline and direct Failure values without exception events or private data', async () => {
  const secret = { private: 'never export' };
  const Refused = defineFailure('operation_telemetry.refused');
  const refused = Refused({ cause: secret });
  expect(await race([async () => refused])).toBe(refused);
  expect(await all([async () => refused])).toEqual([refused]);
  expect(Cancelled.is(await race([async () => 42], { signal: AbortSignal.abort(secret) }))).toBe(true);
  const clock = new MockClock();
  const pending = timeout(
    () =>
      new Promise<never>(() => {
        /* Intentionally uncooperative foreign task. */
      }),
    1,
    { clock },
  );
  clock.advance(1);
  expect(Deadline.is(await pending)).toBe(true);
  const spans = exporter.getFinishedSpans();
  expect(spans.map(span => span.status.code)).toEqual([
    SpanStatusCode.ERROR,
    SpanStatusCode.OK,
    SpanStatusCode.ERROR,
    SpanStatusCode.ERROR,
  ]);
  expect(spans.map(span => span.attributes['failure.code'])).toEqual([
    Refused.code,
    undefined,
    Cancelled.code,
    Deadline.code,
  ]);
  expect(spans.every(span => span.events.length === 0)).toBe(true);
  expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain(secret.private);
});

it.each(['before', 'after', 'twice'] as const)(
  'preserves callback count with a hostile context manager: %s',
  async mode => {
    context.disable();
    const manager: ContextManager = {
      active: () => ROOT_CONTEXT,
      with: (_next, run, receiver, ...args) => {
        if (mode === 'before') throw new Error('reporting failed');
        const result = run.apply(receiver, args);
        if (mode === 'after') throw new Error('reporting failed');
        return mode === 'twice' ? run.apply(receiver, args) : result;
      },
      bind: (_next, target) => target,
      enable: () => manager,
      disable: () => manager,
    };
    context.setGlobalContextManager(manager);
    let calls = 0;
    expect(
      await all([
        async () => {
          calls++;
          return 42;
        },
      ]),
    ).toEqual([42]);
    expect(calls).toBe(1);
  },
);

it('contains rejected and reentrant reporters without replaying completion', async () => {
  const meter = createNoopMeter();
  const cause = new Error('reporter defect');
  const owner: { observer?: ReturnType<typeof operationTelemetry> } = {};
  const tracer = trace.getTracer('@arki/async');
  const start = tracer.startSpan.bind(tracer);
  vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
  vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
    const span = start(...args);
    const end = span.end.bind(span);
    vi.spyOn(span, 'end').mockImplementation(() => {
      owner.observer?.end();
      end();
    });
    Reflect.set(span, 'setStatus', () => Promise.reject(cause));
    return span;
  });
  vi.spyOn(metrics, 'getMeter').mockReturnValue({
    ...meter,
    createHistogram: (name, options) => ({
      ...meter.createHistogram(name, options),
      record: () => {
        throw cause;
      },
    }),
  });
  owner.observer = operationTelemetry('async.all');
  owner.observer.end();
  owner.observer.end();
  await Promise.resolve();
  expect(exporter.getFinishedSpans()).toHaveLength(1);
  expect(await all([async () => 42])).toEqual([42]);
});

it('ends a scope even if foreign signal cleanup rejects, without skipping its typed result', async () => {
  const controller = new AbortController();
  const cause = new Error('private cleanup fault');
  const remove = () => Promise.reject(cause);
  Object.defineProperty(controller.signal, 'removeEventListener', { value: remove });
  await expect(scoped({}, () => 42, { signal: controller.signal })).resolves.toMatchObject({
    code: 'failure.unexpected_defect',
    cause,
  });
  expect(exporter.getFinishedSpans()).toHaveLength(1);
  expect(exporter.getFinishedSpans()[0]?.status.code).toBe(SpanStatusCode.ERROR);
});

it('runs standalone with no provider', async () => {
  trace.disable();
  metrics.disable();
  context.disable();
  expect(await all([async () => 42])).toEqual([42]);
});

it('never replays synchronous user work when reporting reenters the active callback', async () => {
  context.disable();
  let replay: (() => unknown) | undefined;
  const manager: ContextManager = {
    active: () => {
      const report = replay;
      replay = undefined;
      report?.();
      return ROOT_CONTEXT;
    },
    with: (_next, run, receiver, ...args) => {
      replay = () => run.apply(receiver, args);
      return run.apply(receiver, args);
    },
    bind: (_next, target) => target,
    enable: () => manager,
    disable: () => manager,
  };
  context.setGlobalContextManager(manager);
  let calls = 0;
  const work = () => {
    trace.getActiveSpan();
    calls++;
    return 42;
  };
  expect(await all([() => Promise.resolve(work())])).toEqual([42]);
  expect(await scoped({}, work)).toBe(42);
  expect(calls).toBe(2);
});
