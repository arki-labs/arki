/** Usecase invocation owns defects even when no telemetry SDK is registered. */
import { runInNewContext } from 'node:vm';
import type { Context, ContextManager } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { context, createNoopMeter, metrics, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { defineFailure, orThrow, UnexpectedDefect } from '@arki/failure';

import type { SupervisedUsecase } from './usecase.js';
import { defineApp } from '../define-app.js';
import { defineFeature } from '../define-feature.js';
import { traceUsecase, withPhaseSpan, withPluginHookSpan } from './otel.js';
import { superviseUsecase } from './usecase.js';

const tracer = trace.getTracer('@arki/dot');

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
  function (this: object) {
    return this;
  };
const activeSpanName = () => () => {
  const span = trace.getActiveSpan();
  return span !== undefined && 'name' in span && typeof span.name === 'string' ? span.name : undefined;
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
  it('preserves settled success and keeps a sync usecase sync', async () => {
    const settled = Promise.resolve('done');
    const plain = defineFeature('plain')
      .usecases({ wait: pending(settled), total })
      .entrypoints();
    const app = orThrow(await defineApp('plain').features([plain]).start());
    const usecases = app.services['plain.usecases'];
    expect(await usecases.wait()).toBe(await settled);
    expect(usecases.total([1, 2])).toBe(3);
    orThrow(await app.dispose());
  });
  it('contains unknown throws and rejections independently of trace recording', async () => {
    const cause = new Error('without an SDK');
    const throwSync = traceUsecase(
      'plain',
      'throw',
      superviseUsecase(() => {
        throw cause;
      }),
    );
    const rejectAsync = traceUsecase(
      'plain',
      'reject',
      superviseUsecase(() => Promise.reject(cause)),
    );
    if (typeof throwSync !== 'function' || typeof rejectAsync !== 'function')
      throw new Error('expected callable wrappers');
    expect(throwSync()).toMatchObject({ code: UnexpectedDefect.code, cause });
    expect(await rejectAsync()).toMatchObject({ code: UnexpectedDefect.code, cause });
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

  it('records the real cause of a supervised throw or rejection', async () => {
    const { app, usecases } = await bootOrders();
    expect(usecases.explode()).toMatchObject({ code: UnexpectedDefect.code, cause: new Error('boom') });
    const syncSpan = spanNamed('feature.orders.explode');
    expect(syncSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(syncSpan.events.map(e => e.name)).toEqual(['exception']);

    expect(await usecases.reject()).toMatchObject({ code: UnexpectedDefect.code, cause: new Error('async boom') });
    const asyncSpan = spanNamed('feature.orders.reject');
    expect(asyncSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(asyncSpan.events.map(e => e.name)).toEqual(['exception']);
    orThrow(await app.dispose());
  });

  it('activates hook context while the hook runs, including spans created by hook work', () => {
    withPluginHookSpan({ appName: 'context', pluginName: 'plugin', hook: 'boot', order: 0 }, hookSpan => {
      expect(trace.getActiveSpan()).toBe(hookSpan);
      trace.getTracer('test').startSpan('hook.child').end();
    });
    const hookSpan = exporter
      .getFinishedSpans()
      .find(span => span.attributes['dot.app.name'] === 'context' && span.name === 'dot.plugin.boot');
    if (hookSpan === undefined) throw new Error('missing context hook span');
    expect(spanNamed('hook.child').parentSpanContext?.spanId).toBe(hookSpan.spanContext().spanId);
  });

  it('keeps primary outcomes when span creation fails', async () => {
    const acquire = vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
    const reporter = vi.spyOn(tracer, 'startSpan').mockImplementation(() => {
      throw new Error('reporter');
    });
    try {
      const success = Promise.resolve('kept');
      expect(
        withPluginHookSpan({ appName: 'reporter', pluginName: 'plugin', hook: 'boot', order: 0 }, () => success),
      ).toBe(success);
      expect(withPhaseSpan({ appName: 'reporter', phase: 'boot', pluginCount: 1 }, () => 'plain')).toBe('plain');
      const primary = new Error('primary');
      const wrapped = traceUsecase(
        'reporter',
        'fail',
        superviseUsecase(() => {
          throw primary;
        }),
      );
      if (typeof wrapped !== 'function') throw new Error('expected function');
      expect(wrapped()).toMatchObject({ code: UnexpectedDefect.code, cause: primary });
      expect(await success).toBe('kept');
      expect(reporter).toHaveBeenCalledTimes(3);
    } finally {
      reporter.mockRestore();
      acquire.mockRestore();
    }
  });

  it('does not replace a primary failure or recursively report broken reporters', async () => {
    const span = tracer.startSpan('reporter.broken');
    const acquire = vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
    const start = vi.spyOn(tracer, 'startSpan').mockReturnValue(span);
    const status = vi.spyOn(span, 'setStatus').mockImplementation(() => {
      throw new Error('status reporter');
    });
    const end = vi.spyOn(span, 'end').mockImplementation(() => {
      throw new Error('end reporter');
    });
    const duration = vi.fn(() => {
      throw new Error('metric reporter');
    });
    const noopMeter = createNoopMeter();
    const meter = vi.spyOn(metrics, 'getMeter').mockReturnValue({
      ...noopMeter,
      createHistogram: (name, options) => ({ ...noopMeter.createHistogram(name, options), record: duration }),
    });
    try {
      const primary = OrderNotFound();
      const result = withPluginHookSpan({ appName: 'reporter', pluginName: 'plugin', hook: 'boot', order: 0 }, () =>
        Promise.resolve(primary),
      );
      expect(await Promise.resolve(result)).toBe(primary);
      expect(status).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);
      expect(duration).toHaveBeenCalledTimes(1);
      expect(duration).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ 'dot.status': 'failed' }));
      const cause = new Error('private');
      const defect = superviseUsecase(() => {
        throw cause;
      });
      const wrapped = traceUsecase('reporter', 'defect', defect);
      if (typeof wrapped !== 'function') throw new Error('expected function');
      expect(wrapped()).toMatchObject({ code: UnexpectedDefect.code, cause });
      expect(status).toHaveBeenCalledTimes(2);
      expect(end).toHaveBeenCalledTimes(2);
    } finally {
      start.mockRestore();
      acquire.mockRestore();
      status.mockRestore();
      end.mockRestore();
      meter.mockRestore();
      span.end();
    }
  });

  it('keeps a hook rejection when exception reporting throws', async () => {
    const span = tracer.startSpan('reporter.exception');
    const acquire = vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
    const start = vi.spyOn(tracer, 'startSpan').mockReturnValue(span);
    const exception = vi.spyOn(span, 'recordException').mockImplementation(() => {
      throw new Error('exception reporter');
    });
    const cause = new Error('primary rejection');
    try {
      const result: unknown = runInNewContext('Promise.reject(cause)', { cause });
      expect(
        withPluginHookSpan({ appName: 'reporter', pluginName: 'plugin', hook: 'boot', order: 0 }, () => result),
      ).toBe(result);
      await expect(Promise.resolve(result)).rejects.toBe(cause);
      expect(exception).toHaveBeenCalledTimes(1);
    } finally {
      start.mockRestore();
      acquire.mockRestore();
      exception.mockRestore();
      span.end();
    }
  });

  it('observes foreign promises without changing their identity or invoking deferred thenables', async () => {
    const foreign: unknown = runInNewContext('Promise.resolve("foreign success")');
    const observed = withPluginHookSpan(
      { appName: 'foreign', pluginName: 'promise', hook: 'boot', order: 0 },
      () => foreign,
    );
    expect(observed).toBe(foreign);
    expect(await Promise.resolve(observed)).toBe('foreign success');
    const span = exporter.getFinishedSpans().find(value => value.attributes['dot.app.name'] === 'foreign');
    expect(span?.status.code).toBe(SpanStatusCode.OK);
    let inspected = false;
    // eslint-disable-next-line unicorn/no-thenable -- Verify that observing a native promise never executes deferred query accessors.
    const deferred = Object.defineProperty({}, 'then', {
      get() {
        inspected = true;
        throw new Error('deferred');
      },
    });
    expect(
      withPluginHookSpan({ appName: 'deferred', pluginName: 'query', hook: 'boot', order: 0 }, () => deferred),
    ).toBe(deferred);
    expect(inspected).toBe(false);
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
  it('exposes canonical invocation defects alongside each declared return', () => {
    type Wrapped = Awaited<ReturnType<typeof bootOrders>>['usecases'];
    expectTypeOf<Wrapped['total']>().toEqualTypeOf<SupervisedUsecase<ReturnType<typeof total>>>();
    expectTypeOf<Wrapped['find']>().toEqualTypeOf<SupervisedUsecase<ReturnType<typeof find>>>();
    expectTypeOf<Wrapped['self']>().toEqualTypeOf<SupervisedUsecase<ReturnType<typeof self>>>();
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
