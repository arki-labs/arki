/// <reference types="node" />
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, ContextManager } from '@opentelemetry/api';
import { context, createNoopMeter, metrics, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { FailureOf } from '@arki/failure';
import packageMetadata from '@arki/async/package.json' with { type: 'json' };
import { defineFailure, isFailure, UnexpectedDefect } from '@arki/failure';

import { Cancelled, Deadline, ScopeFailed } from './errors.js';
import {
  child,
  cleanup,
  createLifetime,
  dynamicScope,
  isResource,
  isScopeEntry,
  openScope,
  resource,
  scoped,
} from './scope.js';

const Refused = defineFailure('scope_telemetry.refused');
function brokenReporter(): never {
  throw new Error('reporter failed');
}
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
  exporter.reset();
  trace.disable();
  metrics.disable();
  context.disable();
});

it('activates one lifetime through acquisition, body, children and cleanup after provider setup following import', async () => {
  const seen: (string | undefined)[] = [];
  const capture = () => {
    seen.push(trace.getActiveSpan()?.spanContext().spanId);
  };
  const value = { private: 'resource payload' };
  expect(
    await scoped(
      {
        resource: resource(
          async () => {
            await Promise.resolve();
            capture();
            return value;
          },
          async () => {
            await Promise.resolve();
            capture();
          },
        ),
        child: child(async () => {
          await Promise.resolve();
          capture();
        }),
      },
      async resources => {
        await Promise.resolve();
        capture();
        return resources.resource;
      },
    ),
  ).toBe(value);
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  const span = spans[0];
  expect(span?.name).toBe('async.scope');
  expect(span?.instrumentationScope).toMatchObject({ name: '@arki/async', version: packageMetadata.version });
  expect(span?.status.code).toBe(SpanStatusCode.OK);
  expect(span?.attributes).toMatchObject({ 'async.scope.finalizer.count': 1, 'async.scope.primary.count': 0 });
  expect(seen).toEqual(Array.from({ length: 4 }, () => span?.spanContext().spanId));
  expect(JSON.stringify(span?.attributes)).not.toContain(value.private);
});

it('nests scopes and custom work under caller context without leaking the active owner', async () => {
  const parent = trace.getTracer('caller').startSpan('caller');
  await context.with(trace.setSpan(context.active(), parent), async () => {
    expect(
      await dynamicScope([]).run(async () =>
        scoped({}, async () => {
          await Promise.resolve();
          const custom = trace.getTracer('custom').startSpan('custom');
          custom.end();
        }),
      ),
    ).toBeUndefined();
    expect(trace.getActiveSpan()).toBe(parent);
  });
  parent.end();
  const [custom, inner, outer, caller] = exporter.getFinishedSpans();
  expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
  expect(custom?.parentSpanContext?.spanId).toBe(inner?.spanContext().spanId);
  expect(outer?.parentSpanContext?.spanId).toBe(caller?.spanContext().spanId);
  expect(trace.getActiveSpan()).toBeUndefined();
});

it('keeps a transferred lifetime open until cleanup and repeated closes emit only once', async () => {
  const order: string[] = [];
  const opened = await openScope({
    cleanup: cleanup(() => {
      order.push('cleanup');
    }),
  });
  expect(isFailure(opened)).toBe(false);
  if (isFailure(opened)) throw new Error('scope did not open');
  expect(exporter.getFinishedSpans()).toHaveLength(0);
  const closing = opened.close();
  expect(opened.close()).toBe(closing);
  expect(await closing).toBeUndefined();
  expect(order).toEqual(['cleanup']);
  expect(exporter.getFinishedSpans()).toHaveLength(1);
});

it('preserves exact primary and cleanup members while exporting only public failure metadata', async () => {
  const cause = { secret: 'never export' };
  const primary = Refused({ cause });
  const cleanupFailure = Refused({ cause });
  const result = await scoped({ cleanup: cleanup(() => cleanupFailure) }, () => primary);
  expect(ScopeFailed.is(result)).toBe(true);
  if (!ScopeFailed.is(result)) throw new Error('expected aggregate');
  expect(result.cause).toMatchObject({ primary: [primary], cleanup: [cleanupFailure] });
  expect(result.cause.primary[0]).toBe(primary);
  expect(result.cause.cleanup[0]).toBe(cleanupFailure);
  const span = exporter.getFinishedSpans()[0];
  expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  expect(span?.attributes).toMatchObject({
    'failure.code': result.code,
    'failure.status': result.status,
    'async.scope.primary.count': 1,
    'async.scope.cleanup.count': 1,
  });
  expect(JSON.stringify([span?.attributes, span?.events])).not.toContain(cause.secret);
});

it.each([
  ['signal', Cancelled],
  ['deadline', Deadline],
] as const)(
  'observes external %s cancellation after cleanup without exposing the reason',
  async (option, definition) => {
    const cancellation = new AbortController();
    let finalized = 0;
    const result = await scoped(
      {
        cleanup: cleanup(() => {
          finalized++;
        }),
      },
      () => {
        cancellation.abort('private reason');
        return 42;
      },
      { [option]: cancellation.signal },
    );
    expect(definition.is(result)).toBe(true);
    expect(finalized).toBe(1);
    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes['failure.code']).toBe(definition.code);
    expect(span?.attributes['async.scope.cancelled']).toBe(option === 'signal');
    expect(span?.attributes['async.scope.deadline']).toBe(option === 'deadline');
    expect(JSON.stringify(span?.attributes)).not.toContain('private reason');
  },
);

it('records standalone low-cardinality duration metrics with the owner trace after late setup', async () => {
  const samples: string[] = [];
  const meter = createNoopMeter();
  metrics.setGlobalMeterProvider({
    getMeter: () => ({
      ...meter,
      createHistogram: (name, options) => ({
        ...meter.createHistogram(name, options),
        record: (value, attributes, ctx) => {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(options?.unit).toBe('ms');
          expect(ctx && trace.getSpan(ctx)?.spanContext().traceId).toBeDefined();
          samples.push(`${name}:${String(attributes?.['async.scope.outcome'])}`);
        },
      }),
    }),
  });
  expect(await scoped({}, () => 42)).toBe(42);
  const refusal = Refused();
  expect(await dynamicScope([Refused]).run(() => refusal)).toBe(refusal);
  expect(samples).toEqual(['async.scope.duration:ok', 'async.scope.duration:failed']);
});

it.each(['tracer', 'start', 'meter', 'histogram', 'record', 'status', 'end'] as const)(
  'preserves exact outcomes and cleanup when the telemetry %s fails',
  async failureAt => {
    if (failureAt === 'tracer') vi.spyOn(trace, 'getTracer').mockImplementation(brokenReporter);
    if (failureAt === 'start')
      vi.spyOn(trace.getTracer('@arki/async', packageMetadata.version), 'startSpan').mockImplementation(brokenReporter);
    if (failureAt === 'meter') vi.spyOn(metrics, 'getMeter').mockImplementation(brokenReporter);
    const meter = createNoopMeter();
    if (failureAt === 'histogram')
      vi.spyOn(metrics, 'getMeter').mockReturnValue({ ...meter, createHistogram: brokenReporter });
    if (failureAt === 'record')
      vi.spyOn(metrics, 'getMeter').mockReturnValue({
        ...meter,
        createHistogram: (name, options) => ({ ...meter.createHistogram(name, options), record: brokenReporter }),
      });
    if (failureAt === 'status' || failureAt === 'end') {
      const tracer = trace.getTracer('@arki/async', packageMetadata.version);
      const start = tracer.startSpan.bind(tracer);
      vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
        const span = start(...args);
        vi.spyOn(span, failureAt === 'status' ? 'setStatus' : 'end').mockImplementation(brokenReporter);
        return span;
      });
    }
    const refusal = Refused();
    let calls = 0;
    expect(
      await scoped(
        {
          cleanup: cleanup(() => {
            calls++;
          }),
        },
        () => {
          calls++;
          return refusal;
        },
      ),
    ).toBe(refusal);
    expect(calls).toBe(2);
  },
);

it.each(['active', 'before', 'after', 'twice'] as const)(
  'preserves callback execution when the context manager fails %s',
  async mode => {
    context.disable();
    const manager: ContextManager = {
      active: () => {
        if (mode === 'active') throw new Error('active');
        return ROOT_CONTEXT;
      },
      with: (_next, run, receiver, ...args) => {
        if (mode === 'before') throw new Error('before');
        const result = run.apply(receiver, args);
        if (mode === 'after') throw new Error('after');
        return mode === 'twice' ? run.apply(receiver, args) : result;
      },
      bind: (_next, target) => target,
      enable: () => manager,
      disable: () => manager,
    };
    context.setGlobalContextManager(manager);
    const lifetime = createLifetime<FailureOf<typeof Refused>>({});
    let calls = 0;
    expect(
      lifetime.defer(() => {
        calls++;
      }),
    ).toBeUndefined();
    const refusal = Refused();
    expect(
      await lifetime.acquire(
        resource(
          () => {
            calls++;
            return refusal;
          },
          () => void 0,
        ).prepare,
      ),
    ).toBe(refusal);
    expect(await lifetime.close()).toBe(refusal);
    expect(calls).toBe(2);
    const cause = new Error('user defect');
    const result = await scoped({}, () => {
      calls++;
      throw cause;
    });
    expect(UnexpectedDefect.is(result)).toBe(true);
    if (UnexpectedDefect.is(result)) expect(result.cause).toBe(cause);
    expect(calls).toBe(3);
  },
);

it('does not instrument inert descriptors or guards', () => {
  const acquisition = resource(
    () => 42,
    () => void 0,
  );
  expect(isResource(acquisition)).toBe(true);
  expect(isScopeEntry(cleanup(() => void 0))).toBe(true);
  expect(isScopeEntry(child(() => 42))).toBe(true);
  expect(exporter.getFinishedSpans()).toHaveLength(0);
});

it('runs without any provider', async () => {
  trace.disable();
  context.disable();
  const acquisition = resource(
    () => 42,
    () => void 0,
  );
  const refusal = Refused();
  expect(await scoped({ acquisition }, () => refusal)).toBe(refusal);
  expect(exporter.getFinishedSpans()).toHaveLength(0);
});
