import { AsyncLocalStorage } from 'node:async_hooks';
import type { Attributes, Context, ContextManager } from '@opentelemetry/api';
import { context, createNoopMeter, metrics, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defineFailure, orThrow } from '@arki/failure';
import { fakeLog } from '@arki/log/testing';

import { z } from 'zod';

import { action, ACTION_FAILURES } from './action.js';
import { bindAction } from './execute.js';
import { defineApp } from './define-app.js';
import { defineFeature } from './define-feature.js';
import { plugin } from './plugin-contract.js';
import { telemetryFor } from './telemetry.js';

const Refused = defineFailure('telemetry.refused', { status: 403, message: 'Refused' });
let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
const storage = new AsyncLocalStorage<Context>();
const manager: ContextManager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with: (next, fn, thisArg, ...args) => storage.run(next, () => fn.apply(thisArg, args)),
  bind: (_next, target) => target,
  enable: () => manager,
  disable: () => manager,
};

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(manager);
});

afterEach(() => {
  exporter.reset();
  metrics.disable();
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  metrics.disable();
});

describe('author telemetry', () => {
  it('inherits the active context across awaits and preserves typed refusal and promise identity', async () => {
    const telemetry = telemetryFor({ name: 'catalog#eu' });
    const refusal = Refused();
    const parent = trace.getTracer('app').startSpan('request');
    let pending: Promise<typeof refusal> | undefined;
    const result = context.with(trace.setSpan(context.active(), parent), () =>
      telemetry.span('lookup', () => {
        pending = (async () => {
          await Promise.resolve();
          expect(trace.getActiveSpan()?.spanContext().spanId).not.toBe(parent.spanContext().spanId);
          return refusal;
        })();
        return pending;
      }),
    );
    expect(result).toBe(pending);
    expect(await result).toBe(refusal);
    parent.end();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const lookup = spans.find(span => span.name === 'lookup');
    expect(lookup?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(lookup?.instrumentationScope.name).toBe('@arki/dot/catalog#eu');
    expect(lookup?.status.code).toBe(SpanStatusCode.ERROR);
    expect(lookup?.attributes['failure.code']).toBe(refusal.code);
    expect(lookup?.events).toEqual([]);
  });
});

// Custom annotations reuse a request/provider span instead of creating another boundary.
it('adds scoped events and correlated logs to the existing active span without another span', () => {
  const logs = fakeLog();
  try {
    const telemetry = telemetryFor({ $plugin: 'search' });
    const parent = trace.getTracer('transport').startSpan('request');
    context.with(trace.setSpan(context.active(), parent), () => {
      telemetry.event('cache.hit', { tier: 'memory' });
      telemetry.log('info', 'cache hit', { tier: 'memory' });
    });
    parent.end();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0]?.events[0]).toMatchObject({
      name: 'cache.hit',
      attributes: { tier: 'memory', 'dot.plugin.name': 'search' },
    });
    expect(logs.records[0]).toMatchObject({
      category: 'arki:dot:search',
      traceId: parent.spanContext().traceId,
      spanId: parent.spanContext().spanId,
      fields: { tier: 'memory', 'dot.plugin.name': 'search' },
    });
  } finally {
    logs.restore();
  }
});

it('records scoped metrics in the active context without adding spans', () => {
  const measurements: { value: number; attributes?: Attributes; parent?: string }[] = [];
  const meter = {
    ...createNoopMeter(),
    createCounter: () => ({
      add(value: number, attributes?: Attributes, current?: Context) {
        measurements.push({
          value,
          attributes,
          parent: current === undefined ? undefined : trace.getSpan(current)?.spanContext().spanId,
        });
      },
    }),
    createHistogram: () => ({
      record(value: number, attributes?: Attributes, current?: Context) {
        measurements.push({
          value,
          attributes,
          parent: current === undefined ? undefined : trace.getSpan(current)?.spanContext().spanId,
        });
      },
    }),
  };
  metrics.setGlobalMeterProvider({ getMeter: () => meter });
  const telemetry = telemetryFor({ name: 'catalog' });
  const hits = telemetry.counter('cache.hits');
  const latency = telemetry.histogram('cache.duration', { unit: 'ms' });
  telemetry.span('cache', () => {
    hits.add(1, { tier: 'memory' });
    latency.record(4);
  });
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  expect(measurements).toEqual([
    { value: 1, attributes: { tier: 'memory', 'dot.plugin.name': 'catalog' }, parent: spans[0]?.spanContext().spanId },
    { value: 4, attributes: { 'dot.plugin.name': 'catalog' }, parent: spans[0]?.spanContext().spanId },
  ]);
});

it('supplies plugin and feature hooks with telemetry scoped from their mounted identity', async () => {
  const app = orThrow(
    await defineApp('test')
      .use(
        plugin({
          name: 'cache',
          configure: ctx => {
            ctx.$telemetry.event('cache.configured');
          },
          boot: ctx => {
            ctx.$telemetry.event('cache.ready');
          },
        }),
      )
      .features([
        defineFeature('catalog')
          .provides({
            label: ctx => {
              ctx.$telemetry.event('catalog.ready');
              return 'catalog';
            },
          })
          .entrypoints()
          .instance('eu'),
      ])
      .boot(),
  );
  orThrow(await app.dispose());
  const cache = exporter
    .getFinishedSpans()
    .find(span => span.name === 'dot.plugin.boot' && span.attributes['dot.plugin.name'] === 'cache');
  const configured = exporter
    .getFinishedSpans()
    .find(span => span.events.some(event => event.name === 'cache.configured'));
  expect(configured?.events[0]?.attributes).toMatchObject({ 'dot.plugin.name': 'cache' });
  expect(cache?.events).toMatchObject([{ name: 'cache.ready', attributes: { 'dot.plugin.name': 'cache' } }]);
  const feature = exporter.getFinishedSpans().find(span => span.events.some(event => event.name === 'catalog.ready'));
  expect(feature?.events[0]?.attributes).toMatchObject({ 'dot.plugin.name': 'catalog#eu' });
});

it('keeps application outcomes and the parent context when reporters cannot start operations', async () => {
  const parent = provider.getTracer('transport').startSpan('request');
  trace.disable();
  trace.setGlobalTracerProvider({
    getTracer: () => {
      throw new Error('trace reporter unavailable');
    },
  });
  metrics.setGlobalMeterProvider({
    getMeter: () => {
      throw new Error('metric reporter unavailable');
    },
  });
  try {
    const telemetry = telemetryFor({ name: 'broken-exporter' });
    const value = { ready: true };
    const refusal = Refused();
    const cause = new Error('application defect');
    const rejected = Promise.reject(cause);
    const result = context.with(trace.setSpan(context.active(), parent), () =>
      telemetry.span('lookup', () => {
        expect(trace.getActiveSpan()).toBe(parent);
        telemetry.counter('hits').add(1);
        telemetry.histogram('duration').record(1);
        return rejected;
      }),
    );
    expect(result).toBe(rejected);
    await expect(result).rejects.toBe(cause);
    expect(telemetry.span('sync', () => value)).toBe(value);
    expect(telemetry.span('refused', () => refusal)).toBe(refusal);
    expect(() =>
      telemetry.span('throw', () => {
        throw cause;
      }),
    ).toThrow(cause);
  } finally {
    trace.disable();
    trace.setGlobalTracerProvider(provider);
    parent.end();
  }
});

it('works with no SDK, including inert thenables and exact plain values', async () => {
  trace.disable();
  metrics.disable();
  try {
    const telemetry = telemetryFor({ name: 'standalone' });
    const deferred = {
      // eslint-disable-next-line unicorn/no-thenable -- lazy driver thenables must remain inert.
      then() {
        throw new Error('a lazy operation must not start');
      },
    };
    expect(telemetry.span('lazy', () => deferred)).toBe(deferred);
    const refusal = Refused();
    expect(telemetry.span('refused', () => refusal)).toBe(refusal);
    const pending = Promise.resolve(refusal);
    expect(telemetry.span('wait', () => pending)).toBe(pending);
    expect(await pending).toBe(refusal);
    telemetry.event('ready');
    telemetry.counter('hits').add(1);
    telemetry.histogram('duration').record(1);
    telemetry.log('debug', 'ready');
    expect(exporter.getFinishedSpans()).toEqual([]);
  } finally {
    trace.setGlobalTracerProvider(provider);
  }
});

it('preserves linked work and exact failures when a sampler drops the custom span', async () => {
  const dropped = new BasicTracerProvider({ sampler: { shouldSample: () => ({ decision: 0 }) } });
  trace.disable();
  trace.setGlobalTracerProvider(dropped);
  try {
    const telemetry = telemetryFor({ name: 'sampled-out' });
    const refusal = Refused();
    const pending = Promise.resolve(refusal);
    expect(
      telemetry.span('work', () => pending, {
        links: [
          {
            context: {
              traceId: '12345678901234567890123456789012',
              spanId: '1234567890123456',
              traceFlags: 1,
            },
          },
        ],
      }),
    ).toBe(pending);
    expect(await pending).toBe(refusal);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  } finally {
    await dropped.shutdown();
    trace.disable();
    trace.setGlobalTracerProvider(provider);
  }
});

it('does not replace values or refusals when active reporters fail while annotating or ending', () => {
  const realTracer = provider.getTracer('broken-reporting');
  trace.disable();
  trace.setGlobalTracerProvider({
    getTracer: () => ({
      startSpan: () => {
        const span = realTracer.startSpan('broken-reporting');
        span.setStatus = () => {
          throw new Error('status reporter failed');
        };
        span.addEvent = () => {
          throw new Error('event reporter failed');
        };
        span.end = () => {
          throw new Error('end reporter failed');
        };
        return span;
      },
      startActiveSpan: realTracer.startActiveSpan.bind(realTracer),
    }),
  });
  metrics.setGlobalMeterProvider({
    getMeter: () => ({
      ...createNoopMeter(),
      createCounter: () => ({
        add: () => {
          throw new Error('counter reporter failed');
        },
      }),
      createHistogram: () => ({
        record: () => {
          throw new Error('histogram reporter failed');
        },
      }),
    }),
  });
  try {
    const telemetry = telemetryFor({ name: 'catalog' });
    const refusal = Refused();
    expect(
      telemetry.span('refusal', () => {
        telemetry.event('refused');
        telemetry.counter('refusals').add(1);
        telemetry.histogram('duration').record(4);
        return refusal;
      }),
    ).toBe(refusal);
    const value = { id: 'one' };
    expect(telemetry.span('value', () => value)).toBe(value);
  } finally {
    trace.disable();
    trace.setGlobalTracerProvider(provider);
  }
});


it('A and B share request context and classify their single execution span identically', async () => {
  const policy = { exposure: ['rpc', 'http'], principal: 'optional', approval: 'none', retry: 'never' } as const;
  const input = z.object({ id: z.string() });
  const output = z.string();
  const descriptor = action({ id: 'catalog.lookup', input, output, failures: [Refused], policy });
  const independent = { id: 'catalog.lookup', input, output, failures: [Refused, ...ACTION_FAILURES], policy };
  const refusal = Refused();
  const calls = [bindAction(descriptor, () => refusal), bindAction(independent, () => refusal)];
  for (const [index, bound] of calls.entries()) {
    const parent = trace.getTracer('transport').startSpan(`request.${index}`);
    expect(await context.with(trace.setSpan(context.active(), parent), () => bound.run({ id: 'item' }, {
      binding: index === 0 ? 'rpc' : 'http', principal: 'anonymous', approval: 'absent',
    }))).toBe(refusal);
    parent.end();
  }
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(4);
  const executions = spans.filter(span => span.name === 'dot.action');
  expect(executions).toHaveLength(2);
  for (const execution of executions) {
    expect(execution.attributes['failure.code']).toBe(Refused.code);
    expect(execution.events).toEqual([]);
    expect(spans.some(span => span.name.startsWith('request.') && span.spanContext().spanId === execution.parentSpanContext?.spanId)).toBe(true);
  }
});
