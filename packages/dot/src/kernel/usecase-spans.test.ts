/**
 * Usecase spans: `defineFeature(...).usecases(...)` runs every usecase call in
 * a span named `feature.<feature>.<usecase>`, with no code in the usecase.
 *
 * Why these tests exist:
 *
 * - A returned `@arki/failure` failure is an expected outcome, not a bug. The
 *   span says ERROR and names the failure, but records no exception, so
 *   error trackers that read exception events do not page anyone for a
 *   "not found".
 * - A throw is a bug. It is recorded, and the very same value reaches the
 *   caller: tracing never changes control flow.
 * - Without an SDK the wrapper must change nothing: same promise object,
 *   sync stays sync. That is why the no-SDK block runs first, before any
 *   provider is registered (a proxy tracer keeps its SDK once it has one).
 * - The wrapper is runtime only: the usecase types stay exactly as inferred.
 */
import type { Context, ContextManager } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import { defineFailure, orThrow } from '@arki/failure';

import { defineApp } from '../define-app.js';
import { defineFeature } from '../define-feature.js';

const OrderNotFound = defineFailure('order.not_found', { status: 404 });

const total = () => (prices: readonly number[]) => prices.reduce((sum, price) => sum + price, 0);
const find = () => (id: string) => Promise.resolve(id === 'o_1' ? { id } : OrderNotFound());
const findSync = () => (id: string) => (id === 'o_1' ? { id } : OrderNotFound());
const explode = () => () => {
  throw new Error('boom');
};
const reject = () => () => Promise.reject(new Error('async boom'));
const pending = (settle: Promise<string>) => () => () => settle;
const self = () =>
  function (this: unknown) {
    return this;
  };
const activeSpanName = () => () => {
  const span = trace.getActiveSpan();
  return span !== undefined && 'name' in span ? span.name : undefined;
};

let openGate: (value: string) => void;
const gate = new Promise<string>(resolve => {
  openGate = resolve;
});
const orders = defineFeature('orders')
  .usecases({ total, find, findSync, explode, reject, wait: pending(gate), self, activeSpanName })
  .entrypoints();

async function bootOrders() {
  const app = orThrow(await defineApp('shop').features([orders]).start());
  return { app, usecases: app.services['orders.usecases'] };
}

describe('with no SDK registered', () => {
  it('changes nothing: the same promise object comes back and a sync usecase stays sync', async () => {
    const settled = Promise.resolve('done');
    const plain = defineFeature('plain')
      .usecases({ wait: pending(settled), total })
      .entrypoints();
    const app = orThrow(await defineApp('plain').features([plain]).start());
    const usecases = app.services['plain.usecases'];
    expect(usecases.wait()).toBe(settled);
    expect(usecases.total([1, 2])).toBe(3);
    orThrow(await app.dispose());
  });
});

describe('with an SDK registered', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

  beforeAll(() => {
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(syncContextManager());
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  function spanNamed(name: string): ReadableSpan {
    const span = exporter.getFinishedSpans().find(s => s.name === name);
    if (span === undefined) throw new Error(`no finished span named ${name}`);
    return span;
  }

  it('names the span feature.<feature>.<usecase> and keeps args, `this` and the return value', async () => {
    const { app, usecases } = await bootOrders();
    expect(usecases.total([2, 3])).toBe(5);
    expect(usecases.self()).toBe(usecases);
    const span = spanNamed('feature.orders.total');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.events).toEqual([]);
    orThrow(await app.dispose());
  });

  it('makes the span active, so spans the usecase starts nest under it', async () => {
    const { app, usecases } = await bootOrders();
    expect(usecases.activeSpanName()).toBe('feature.orders.activeSpanName');
    orThrow(await app.dispose());
  });

  it('marks a returned failure ERROR with its code and status, and records no exception: a failure is not a bug', async () => {
    const { app, usecases } = await bootOrders();
    const failure = await usecases.find('o_404');
    expect(failure).toMatchObject({ code: 'order.not_found', status: 404 });
    const asyncSpan = spanNamed('feature.orders.find');
    expect(asyncSpan.status).toEqual({ code: SpanStatusCode.ERROR, message: 'order.not_found' });
    expect(asyncSpan.attributes).toMatchObject({ 'failure.code': 'order.not_found', 'failure.status': 404 });
    expect(asyncSpan.events).toEqual([]);

    expect(usecases.findSync('o_404')).toMatchObject({ code: 'order.not_found' });
    const syncSpan = spanNamed('feature.orders.findSync');
    expect(syncSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(syncSpan.events).toEqual([]);
    orThrow(await app.dispose());
  });

  it('records a throw or a rejection as an exception and rethrows the same value', async () => {
    const { app, usecases } = await bootOrders();
    let thrown: unknown;
    try {
      usecases.explode();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const syncSpan = spanNamed('feature.orders.explode');
    expect(syncSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(syncSpan.events.map(e => e.name)).toEqual(['exception']);

    await expect(usecases.reject()).rejects.toThrow('async boom');
    const asyncSpan = spanNamed('feature.orders.reject');
    expect(asyncSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(asyncSpan.events.map(e => e.name)).toEqual(['exception']);
    orThrow(await app.dispose());
  });

  it('ends an async usecase span when the promise settles, not when the call returns', async () => {
    const { app, usecases } = await bootOrders();
    const result = usecases.wait();
    expect(exporter.getFinishedSpans().some(s => s.name === 'feature.orders.wait')).toBe(false);
    openGate('late');
    expect(await result).toBe('late');
    expect(spanNamed('feature.orders.wait').status.code).toBe(SpanStatusCode.OK);
    orThrow(await app.dispose());
  });
});

describe('types', () => {
  it('keeps every usecase type exactly as its factory returns it', () => {
    type Wrapped = Awaited<ReturnType<typeof bootOrders>>['usecases'];
    expectTypeOf<Wrapped['total']>().toEqualTypeOf<ReturnType<typeof total>>();
    expectTypeOf<Wrapped['find']>().toEqualTypeOf<ReturnType<typeof find>>();
    expectTypeOf<Wrapped['self']>().toEqualTypeOf<ReturnType<typeof self>>();
  });
});

/** A synchronous context manager: makes a span active inside `context.with`. */
function syncContextManager(): ContextManager {
  let current: Context = ROOT_CONTEXT;
  const manager: ContextManager = {
    active: () => current,
    with: (next, fn, thisArg, ...args) => {
      const previous = current;
      current = next;
      try {
        return fn.apply(thisArg, args);
      } finally {
        current = previous;
      }
    },
    bind: (_context, target) => target,
    enable: () => manager,
    disable: () => manager,
  };
  return manager;
}
