import { AsyncLocalStorage } from 'node:async_hooks';
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context, ContextManager } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';

import { IdempotencyRepository } from '../../src/orpc/idempotency-repository';
import { IdempotencyStoreUnconfirmed } from '../../src/orpc/idempotency-failures';
import { idempotencyKeys } from '../../src/orpc/idempotency-table';
import { idempotencyKeyId } from '../../src/orpc/idempotency-id';

const storage = new AsyncLocalStorage<Context>();
const manager: ContextManager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with: (next, fn, thisArg, ...args) => storage.run(next, () => fn.apply(thisArg, args)),
  bind: (_next, target) => target,
  enable: () => manager,
  disable: () => manager,
};
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(manager);
});
afterEach(() => {
  vi.restoreAllMocks();
  exporter.reset();
});
afterAll(async () => {
  await provider.shutdown();
  context.disable();
  trace.disable();
});

it('inherits the parent span and exports only the canonical failure code', async () => {
  const db = drizzle.mock();
  const cause = new Error('private query and credentials');
  let activeName: string | undefined;
  vi.spyOn(db, 'insert').mockImplementation(() => {
    activeName = trace.getActiveSpan()?.spanContext().spanId;
    throw cause;
  });
  const parent = trace.getTracer('app').startSpan('request');
  const repo = new IdempotencyRepository(db, idempotencyKeys);
  const result = await context.with(trace.setSpan(context.active(), parent), () =>
    repo.store('private key', 'private path', 'private user', { secret: 'private response' }));
  parent.end();
  expect(IdempotencyStoreUnconfirmed.is(result)).toBe(true);
  const spans = exporter.getFinishedSpans();
  const stored = spans.find(span => span.name === 'offline.idempotency.store');
  expect(stored?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  expect(stored?.spanContext().spanId).toBe(activeName);
  expect(stored?.instrumentationScope.name).toBe('@arki/offline');
  expect(stored?.attributes).toEqual({ 'failure.code': 'offline.idempotency_store_unconfirmed' });
  expect(stored?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'offline.idempotency_store_unconfirmed' });
  expect(stored?.events).toEqual([]);
  expect(spans).toHaveLength(2);
});

it('records generation refusal without a database call and preserves its identity', async () => {
  const refusal = RandomSourceUnavailable();
  vi.spyOn(idempotencyKeyId, 'create').mockReturnValueOnce(refusal);
  const db = drizzle.mock();
  const insert = vi.spyOn(db, 'insert');
  const repo = new IdempotencyRepository(db, idempotencyKeys);
  expect(await repo.store('key', 'path', 'user', null)).toBe(refusal);
  expect(insert).not.toHaveBeenCalled();
  expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({ 'failure.code': refusal.code });
});

it.each(['before', 'after', 'repeat'] as const)(
  'a context manager that fails %s invocation cannot repeat or suppress the write',
  async mode => {
    const db = drizzle.mock();
    const insert = vi.spyOn(db, 'insert').mockImplementation(() => { throw new Error('driver refusal'); });
    const tracer = trace.getTracer('fixture');
    const span = tracer.startSpan('offline.idempotency.store');
    const end = vi.spyOn(span, 'end');
    vi.spyOn(tracer, 'startSpan').mockReturnValue(span);
    vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
    vi.spyOn(manager, 'with').mockImplementation((next, fn, thisArg, ...args) => {
      if (mode === 'before') throw new Error('context refused');
      const result = storage.run(next, () => fn.apply(thisArg, args));
      if (mode === 'after') throw new Error('context failed after callback');
      storage.run(next, () => fn.apply(thisArg, args));
      return result;
    });
    const repo = new IdempotencyRepository(db, idempotencyKeys);
    expect(IdempotencyStoreUnconfirmed.is(await repo.store('key', 'path', 'user', null))).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    // A broken context manager also affects SDK export; the owned cleanup still runs once.
    expect(end).toHaveBeenCalledTimes(1);
  },
);

it('a tracer that refuses to start cannot change the returned entropy refusal', async () => {
  const refusal = RandomSourceUnavailable();
  vi.spyOn(idempotencyKeyId, 'create').mockReturnValueOnce(refusal);
  vi.spyOn(trace, 'getTracer').mockImplementation(() => { throw new Error('exporter defect'); });
  const repo = new IdempotencyRepository(drizzle.mock(), idempotencyKeys);
  expect(await repo.store('key', 'path', 'user', null)).toBe(refusal);
});

it('reserves execution before a reentrant reporter can invoke the context callback', async () => {
  const db = drizzle.mock();
  const insert = vi.spyOn(db, 'insert').mockImplementation(() => { throw new Error('driver refusal'); });
  let reenter: (() => unknown) | undefined;
  vi.spyOn(manager, 'with').mockImplementation((next, fn, thisArg, ...args) => {
    reenter = () => storage.run(next, () => fn.apply(thisArg, args));
    return storage.run(next, () => fn.apply(thisArg, args));
  });
  const tracer = trace.getTracer('fixture');
  const span = tracer.startSpan('offline.idempotency.store');
  const end = vi.spyOn(span, 'end').mockImplementation(() => {
    const invoke = reenter;
    reenter = undefined;
    invoke?.();
  });
  vi.spyOn(tracer, 'startSpan').mockReturnValue(span);
  vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
  const repo = new IdempotencyRepository(db, idempotencyKeys);
  expect(IdempotencyStoreUnconfirmed.is(await repo.store('key', 'path', 'user', null))).toBe(true);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledTimes(1);
});

it('reporter failures cannot replace the primary failure or prevent span cleanup', async () => {
  const refusal = RandomSourceUnavailable();
  vi.spyOn(idempotencyKeyId, 'create').mockReturnValueOnce(refusal);
  const span = trace.getTracer('app').startSpan('reporter fixture');
  vi.spyOn(span, 'setAttribute').mockImplementation(() => { throw new Error('attribute defect'); });
  vi.spyOn(span, 'setStatus').mockImplementation(() => { throw new Error('status defect'); });
  const end = vi.spyOn(span, 'end');
  const tracer = trace.getTracer('fixture');
  vi.spyOn(tracer, 'startSpan').mockReturnValue(span);
  vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
  const repo = new IdempotencyRepository(drizzle.mock(), idempotencyKeys);
  expect(await repo.store('key', 'path', 'user', null)).toBe(refusal);
  expect(end).toHaveBeenCalledTimes(1);
});
