import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, ContextManager } from '@opentelemetry/api';
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { AlwaysOffSampler, BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, expect, it, vi } from 'vitest';
import { MockClock } from '@arki/clock';
import { defineFailure, UnexpectedDefect } from '@arki/failure';
import { backoff, BulkheadRejected, Cancelled, CircuitOpen, createBulkheadPolicy, createCircuitBreakerPolicy, createResiliencePolicy, createRetryPolicy, createTimeoutPolicy, noop, Timeout, withFallback, wrap } from './index.js';
import { withPolicySpan } from './telemetry.js';

class TestContextManager implements ContextManager {
  readonly storage = new AsyncLocalStorage<Context>();
  active(): Context { return this.storage.getStore() ?? ROOT_CONTEXT; }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    current: Context, callback: F, receiver?: ThisParameterType<F>, ...args: A
  ): ReturnType<F> {
    return this.storage.run(current, () => callback.apply(receiver, args));
  }
  bind<T>(_current: Context, target: T): T { return target; }
  enable(): this { return this; }
  disable(): this { this.storage.disable(); return this; }
}

function fail(): never { throw new Error('private reporter'); }
function reject() { return Promise.reject(new Error('private async reporter')); }

let provider: BasicTracerProvider | undefined;
function installTelemetry(sampled = true) {
  const exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ ...(sampled ? {} : { sampler: new AlwaysOffSampler() }), spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new TestContextManager());
  return exporter;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  context.disable();
  trace.disable();
  await provider?.shutdown();
  provider = undefined;
});

it('needs no SDK and preserves successes and canonical refusal identity', async () => {
  const Refused = defineFailure('test.refused');
  const refused = Refused();
  const value = { private: 'payload' };
  expect(await noop.execute(() => value)).toBe(value);
  expect(await createResiliencePolicy().execute(() => refused)).toBe(refused);
});

it('parents one logical call, attempts, waits and engines without duplicating composed execution', async () => {
  const exporter = installTelemetry();
  const caller = trace.getTracer('test').startSpan('caller');
  const clock = new MockClock();
  const policy = createResiliencePolicy({ retry: backoff.constant(5).upTo(1), clock, bulkhead: { maxConcurrent: 1 } });
  const activeIds: (string | undefined)[] = [];
  const run = context.with(trace.setSpan(context.active(), caller), () => policy.execute(async ({ attempt }) => {
    await Promise.resolve();
    activeIds.push(trace.getSpan(context.active())?.spanContext().spanId);
    if (attempt === 0) throw new Error('private provider response');
    return 'private success payload';
  }));
  await clock.advanceAsync(20);
  expect(await run).toBe('private success payload');
  const spans = exporter.getFinishedSpans();
  expect(spans.map(span => span.name).toSorted()).toEqual([
    'resilience.execute', 'resilience.bulkhead', 'resilience.attempt', 'resilience.attempt',
    'resilience.wait', 'resilience.circuit_breaker', 'resilience.circuit_breaker',
    'resilience.timeout', 'resilience.timeout',
  ].toSorted());
  const execution = spans.find(span => span.name === 'resilience.execute');
  const bulkhead = spans.find(span => span.name === 'resilience.bulkhead');
  expect(execution?.parentSpanContext?.spanId).toBe(caller.spanContext().spanId);
  expect(bulkhead?.parentSpanContext?.spanId).toBe(execution?.spanContext().spanId);
  const attempts = spans.filter(span => span.name === 'resilience.attempt');
  expect(attempts.map(span => span.attributes['resilience.attempt'])).toEqual([0, 1]);
  for (const span of attempts) expect(span.parentSpanContext?.spanId).toBe(bulkhead?.spanContext().spanId);
  const breakers = spans.filter(span => span.name === 'resilience.circuit_breaker');
  const timeouts = spans.filter(span => span.name === 'resilience.timeout');
  for (let i = 0; i < 2; i++) {
    expect(breakers[i]?.parentSpanContext?.spanId).toBe(attempts[i]?.spanContext().spanId);
    expect(timeouts[i]?.parentSpanContext?.spanId).toBe(breakers[i]?.spanContext().spanId);
    expect(activeIds[i]).toBe(timeouts[i]?.spanContext().spanId);
  }
  const wait = spans.find(span => span.name === 'resilience.wait');
  expect(wait?.attributes).toEqual({ 'resilience.attempt': 1, 'resilience.delay_ms': 5 });
  expect(wait?.parentSpanContext?.spanId).toBe(bulkhead?.spanContext().spanId);
  expect(execution?.status.code).toBe(SpanStatusCode.UNSET);
  expect(attempts[0]?.attributes['failure.code']).toBe(UnexpectedDefect.code);
  for (const span of spans) {
    expect(span.events).toEqual([]);
    expect(Object.keys(span.attributes).every(key => ['failure.code', 'resilience.attempt', 'resilience.delay_ms'].includes(key))).toBe(true);
    expect(JSON.stringify({ attributes: span.attributes, status: span.status })).not.toContain('private');
  }
});

it('preserves raw throws for fallback and reports its final answer only once', async () => {
  const exporter = installTelemetry();
  const raw = new Error('private raw throw');
  const fallback = vi.fn((error: unknown) => { expect(error).toBe(raw); return 'cached'; });
  expect(await withFallback(createRetryPolicy({ backoff: backoff.constant(0).upTo(0) }), fallback)
    .execute(() => { throw raw; })).toBe('cached');
  expect(fallback).toHaveBeenCalledTimes(1);
  const executions = exporter.getFinishedSpans().filter(span => span.name === 'resilience.execute');
  expect(executions).toHaveLength(1);
  expect(executions[0]?.status.code).toBe(SpanStatusCode.UNSET);
});

it('records actual refusal codes and never invokes pre-cancelled work', async () => {
  const exporter = installTelemetry();
  const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1 });
  await breaker.execute(() => { throw new Error('private cause'); });
  expect(CircuitOpen.is(await breaker.execute(() => 'unused'))).toBe(true);
  const controller = new AbortController(); controller.abort('private reason');
  const work = vi.fn(() => 'unused');
  expect(Cancelled.is(await createResiliencePolicy().execute(work, controller.signal))).toBe(true);
  expect(work).not.toHaveBeenCalled();
  expect(exporter.getFinishedSpans().filter(span => span.name === 'resilience.execute').map(span => span.attributes['failure.code']))
    .toEqual([UnexpectedDefect.code, CircuitOpen.code, Cancelled.code]);
  expect(exporter.getFinishedSpans().filter(span => span.name === 'resilience.circuit_breaker').map(span => span.attributes['failure.code']))
    .toEqual([UnexpectedDefect.code, CircuitOpen.code]);
});

it('ends deadline and capacity spans when owned execution settles, without waiting for abandoned work', async () => {
  vi.useFakeTimers();
  const exporter = installTelemetry();
  const deadline = createTimeoutPolicy({ timeoutMs: 5 }).execute(() => new Promise<never>(() => { /* Abandoned foreign work. */ }));
  await vi.advanceTimersByTimeAsync(10);
  expect(Timeout.is(await deadline)).toBe(true);
  const bulkhead = createBulkheadPolicy({ maxConcurrent: 1, maxQueue: 0 });
  const work = Promise.withResolvers<string>();
  const first = bulkhead.execute(() => work.promise);
  expect(BulkheadRejected.is(await bulkhead.execute(() => 'unused'))).toBe(true);
  work.resolve('done'); expect(await first).toBe('done');
  expect(exporter.getFinishedSpans().find(span => span.name === 'resilience.timeout')?.attributes['failure.code']).toBe(Timeout.code);
  const capacity = exporter.getFinishedSpans().filter(span => span.name === 'resilience.bulkhead');
  expect(capacity).toHaveLength(2);
  expect(capacity[0]?.attributes['failure.code']).toBe(BulkheadRejected.code);
  expect(capacity[1]?.status.code).toBe(SpanStatusCode.UNSET);
});

it.each(['omit', 'repeat', 'throw-before', 'throw-after', 'reject', 'pending', 'delayed'] as const)(
  'context %s cannot duplicate attempts, replace outcomes or block settlement', async mode => {
    installTelemetry();
    let later: (() => unknown) | undefined;
    vi.spyOn(context, 'with').mockImplementation((_current, callback) => {
      if (mode === 'throw-before') throw new Error('private context');
      if (mode === 'omit') return;
      if (mode === 'delayed') { later = callback; return; }
      const result = callback();
      if (mode === 'repeat') callback();
      if (mode === 'throw-after') throw new Error('private context');
      if (mode === 'reject') return Promise.reject(new Error('private reporter'));
      if (mode === 'pending') return new Promise(() => { /* Broken reporting never settles. */ });
      return result;
    });
    const Refused = defineFailure('test.refused'); const refusal = Refused();
    const run = vi.fn(() => refusal);
    expect(await createResiliencePolicy().execute(run)).toBe(refusal);
    await later?.();
    expect(run).toHaveBeenCalledTimes(1);
  },
);

it.each(['active', 'tracer', 'start', 'setSpan', 'attribute', 'status', 'end'] as const)(
  'synchronous %s faults cannot hide a refusal', async fault => {
    installTelemetry();

    const tracer = trace.getTracer('@arki/resilience');
    const start = tracer.startSpan.bind(tracer);
    vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
      if (fault === 'start') return fail();
      const span = start(...args);
      if (fault === 'attribute') vi.spyOn(span, 'setAttribute').mockImplementation(fail);
      if (fault === 'status') vi.spyOn(span, 'setStatus').mockImplementation(fail);
      if (fault === 'end') vi.spyOn(span, 'end').mockImplementation(fail);
      return span;
    });
    if (fault === 'active') vi.spyOn(context, 'active').mockImplementation(fail);
    if (fault === 'tracer') vi.spyOn(trace, 'getTracer').mockImplementation(fail);
    if (fault === 'setSpan') vi.spyOn(trace, 'setSpan').mockImplementation(fail);
    const failure = CircuitOpen(); const run = vi.fn(() => failure);
    expect(await noop.execute(run)).toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  },
);

it.each(['active', 'tracer', 'start', 'setSpan', 'attribute', 'status', 'end'] as const)(
  'rejected foreign %s reports are observed without becoming execution failures', async fault => {
    installTelemetry();

    const tracer = trace.getTracer('@arki/resilience');
    const start = tracer.startSpan.bind(tracer);
    vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
      const span = start(...args);
      if (fault === 'attribute') Object.defineProperty(span, 'setAttribute', { value: reject });
      if (fault === 'status') Object.defineProperty(span, 'setStatus', { value: reject });
      if (fault === 'end') Object.defineProperty(span, 'end', { value: reject });
      return span;
    });
    // Deliberately violate the foreign API without weakening production types.
    if (fault === 'active') { vi.spyOn(context, 'active'); Object.defineProperty(context, 'active', { configurable: true, value: reject }); }
    if (fault === 'tracer') { vi.spyOn(trace, 'getTracer'); Object.defineProperty(trace, 'getTracer', { configurable: true, value: reject }); }
    if (fault === 'start') Object.defineProperty(tracer, 'startSpan', { configurable: true, value: reject });
    if (fault === 'setSpan') { vi.spyOn(trace, 'setSpan'); Object.defineProperty(trace, 'setSpan', { configurable: true, value: reject }); }
    const failure = CircuitOpen(); const run = vi.fn(() => failure);
    expect(await noop.execute(run)).toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  },
);

it('keeps exact raw rejection even when context repeats and span end rejects', async () => {
  installTelemetry();
  const tracer = trace.getTracer('@arki/resilience');
  const start = tracer.startSpan.bind(tracer);
  vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
    const span = start(...args);
    Object.defineProperty(span, 'end', { value: () => Promise.reject(new Error('private exporter')) });
    return span;
  });
  const cause = new Error('private raw');
  const run = vi.fn(() => Promise.reject(cause));
  vi.spyOn(context, 'with').mockImplementation((_current, callback) => { callback(); return callback(); });
  await expect(withPolicySpan('resilience.attempt', run)).rejects.toBe(cause);
  expect(run).toHaveBeenCalledTimes(1);
});


it('propagates nonrecording contexts without exporting discarded spans', async () => {
  const exporter = installTelemetry(false);
  const caller = trace.getTracer('test').startSpan('caller');
  let childTraceId: string | undefined;
  await context.with(trace.setSpan(context.active(), caller), () => noop.execute(async () => {
    await Promise.resolve();
    childTraceId = trace.getSpan(context.active())?.spanContext().traceId;
  }));
  expect(childTraceId).toBe(caller.spanContext().traceId);
  expect(childTraceId).not.toBe('00000000000000000000000000000000');
  expect(exporter.getFinishedSpans()).toEqual([]);
});

it('repeated context callbacks preserve retry counts and attempt context', async () => {
  installTelemetry();
  vi.spyOn(context, 'with').mockImplementation((_current, callback) => { callback(); return callback(); });
  const clock = new MockClock();
  const attempts: number[] = [];
  const result = createResiliencePolicy({ retry: backoff.constant(1).upTo(1), clock }).execute(({ attempt }) => {
    attempts.push(attempt);
    if (attempt === 0) throw new Error('private retry');
    return 'done';
  });
  await clock.advanceAsync(10);
  expect(await result).toBe('done');
  expect(attempts).toEqual([0, 1]);
});

it('does not start an attempt when instrumentation synchronously cancels the caller', async () => {
  installTelemetry();
  const controller = new AbortController();
  const tracer = trace.getTracer('@arki/resilience');
  const start = tracer.startSpan.bind(tracer);
  vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
    if (args[0] === 'resilience.attempt') controller.abort('instrumentation');
    return start(...args);
  });
  const work = vi.fn(() => 'unused');
  const result = await createRetryPolicy().execute(work, controller.signal);
  expect(Cancelled.is(result)).toBe(true);
  expect(work).not.toHaveBeenCalled();
});

it.each(['throw', 'failure'] as const)('cancellation during wait reporting preserves the %s outcome before calling the clock', async kind => {
  installTelemetry();
  const clock = new MockClock();
  const sleep = vi.spyOn(clock, 'sleep');
  const controller = new AbortController();
  const tracer = trace.getTracer('@arki/resilience');
  const start = tracer.startSpan.bind(tracer);
  vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
    if (args[0] === 'resilience.wait') controller.abort('instrumentation');
    return start(...args);
  });
  const Refused = defineFailure('test.refused'); const failure = Refused();
  const selected = kind === 'failure' ? backoff.constant(5).upTo(1).while(Refused) : backoff.constant(5).upTo(1);
  const work = vi.fn(() => { if (kind === 'throw') throw new Error('private callback'); return failure; });
  const result = await createRetryPolicy({ clock, backoff: selected }).execute(work, controller.signal);
  if (kind === 'failure') expect(result).toBe(failure);
  else expect(Cancelled.is(result)).toBe(true);
  expect(work).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

it.each([false, true])('never lets failure inspection reject an opaque successful object with SDK=%s', async sdk => {
  if (sdk) installTelemetry();
  const value = new Proxy({}, { getPrototypeOf() { throw new Error('private inspection'); } });
  expect(await noop.execute(() => value)).toBe(value);
});

it.each([false, true])('keeps synchronous callback dispatch ordering with SDK=%s', async sdk => {
  if (sdk) installTelemetry();
  const calls: number[] = [];
  const result = createResiliencePolicy().execute(() => { calls.push(1); return 'done'; });
  expect(calls).toEqual([1]);
  expect(await result).toBe('done');
});

const onThrow = (error: unknown): never => { throw error; };

it.each(['retry', 'composed'] as const)('keeps the %s owner when a never-returning onThrow remains composable', async kind => {
  const exporter = installTelemetry();
  const schedule = backoff.constant(0).upTo(0);
  const policy = kind === 'retry'
    ? createRetryPolicy({ backoff: schedule, onThrow })
    : createResiliencePolicy({ retry: schedule, onThrow });
  expect(await wrap(noop, policy).execute(() => 'done')).toBe('done');
  expect(exporter.getFinishedSpans().filter(span => span.name === 'resilience.execute')).toHaveLength(1);
  exporter.reset();
  const raw = new Error('private callback');
  const fallback = vi.fn((error: unknown) => { expect(error).toBe(raw); return 'cached'; });
  expect(await withFallback(wrap(noop, policy), fallback).execute(() => { throw raw; })).toBe('cached');
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(exporter.getFinishedSpans().filter(span => span.name === 'resilience.execute')).toHaveLength(1);
});
