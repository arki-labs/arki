import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import type { Clock } from '@arki/clock';
import type { z } from 'zod';
import type { clockSleepOutcomeSchema, retryDelaySchema } from './retry.js';
import type { Backoff, CircuitBreakerPolicyOptions, TimeoutPolicyOptions, BulkheadPolicyOptions } from './index.js';
import type { circuitBreakerOptionsSchema, timeoutOptionsSchema, bulkheadOptionsSchema } from './policies.js';
import { AssertError } from '@arki/schema';
import { MockClock, SleepCancelled } from '@arki/clock';
import { defineFailure, UnexpectedDefect } from '@arki/failure';
import { backoff, createRetryPolicy, createCircuitBreakerPolicy, createTimeoutPolicy, createBulkheadPolicy } from './index.js';
import type { SuccessEvent } from './index.js';

afterEach(() => { vi.restoreAllMocks(); });

it('unavailable observer timing cannot repeat an already completed effect', async () => {
  let calls = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    if (calls > 0) throw new Error('private timing defect');
    return 1;
  });
  const clock = new MockClock();
  const policy = createRetryPolicy({ backoff: backoff.constant(0).upTo(2), clock });
  const events: SuccessEvent[] = [];
  policy.onSuccess(event => events.push(event));
  const value = { private: 'completed' };
  const run = policy.execute(() => { calls++; return value; });
  await clock.advanceAsync(1);
  expect(await run).toBe(value);
  expect(calls).toBe(1);
  expect(events).toEqual([]);
});

it('observer timing before dispatch cannot prevent work or replace a returned failure', async () => {
  vi.spyOn(performance, 'now').mockImplementation(() => { throw new Error('private timing defect'); });
  const refused = defineFailure('test.refused')();
  const policy = createRetryPolicy();
  const observed = vi.fn();
  policy.onFailure(observed);
  const run = vi.fn(() => refused);
  expect(await policy.execute(run)).toBe(refused);
  expect(run).toHaveBeenCalledTimes(1);
  expect(observed).not.toHaveBeenCalled();
});

it('opaque successful objects do not become retryable callback defects', async () => {
  const value = new Proxy({}, { getPrototypeOf() { throw new Error('private inspection'); } });
  const clock = new MockClock();
  const policy = createRetryPolicy({ backoff: backoff.constant(0).upTo(2), clock });
  let calls = 0;
  const run = policy.execute(() => { calls++; return value; });
  await clock.advanceAsync(1);
  expect(Object.is(await run, value)).toBe(true);
  expect(calls).toBe(1);
});

for (const [caseIndex, invalid] of [null, 'not a clock result', false, 1, {}, defineFailure('test.foreign')()].entries()) {
  it(`rejects a foreign Clock outcome (case ${caseIndex}) before another effect`, async () => {
    const clock = new MockClock();
    Object.defineProperty(clock, 'sleep', { value: () => Promise.resolve(invalid) });
    const call = vi.fn(() => { throw new Error('callback'); });
    const result = await createRetryPolicy({ backoff: backoff.constant(0).upTo(2), clock }).execute(call);
    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });
}

it('retains canonical Clock refusal identity and receiver', async () => {
  const refusal = SleepCancelled();
  class RefusingClock extends MockClock {
    readonly refusal = refusal;
    override sleep() { return Promise.resolve(this.refusal); }
  }
  const result = await createRetryPolicy({ backoff: backoff.constant(0).upTo(2), clock: new RefusingClock() }).execute(() => { throw new Error('callback'); });
  expect(result).toBe(refusal);
});

for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '0', null]) {
  it(`refuses malformed backoff delay (${String(invalid)}) before a foreign Clock is called`, async () => {
    const schedule = backoff.constant(0).upTo(2);
    Object.defineProperty(schedule, 'delay', { value: () => invalid });
    const clock = new MockClock();
    const sleep = vi.spyOn(clock, 'sleep');
    const call = vi.fn(() => { throw new Error('callback'); });
    const result = await createRetryPolicy({ backoff: schedule, clock }).execute(call);
    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
}

it('observes an illegal rejected asynchronous backoff without waiting or retrying', async () => {
  const schedule = backoff.constant(0).upTo(2);
  Object.defineProperty(schedule, 'delay', { value: () => Promise.reject(new Error('private backoff')) });
  const call = vi.fn(() => { throw new Error('callback'); });
  expect(UnexpectedDefect.is(await createRetryPolicy({ backoff: schedule }).execute(call))).toBe(true);
  expect(call).toHaveBeenCalledTimes(1);
});

it('protocol schemas are exactly inferred from the source contracts', () => {
  expectTypeOf<z.output<typeof clockSleepOutcomeSchema>>().toEqualTypeOf<Awaited<ReturnType<Clock['sleep']>>>();
  expectTypeOf<z.output<typeof retryDelaySchema>>().toEqualTypeOf<ReturnType<Backoff['delay']>>();
});


it('static schemas preserve the exact original option contracts', () => {
  expectTypeOf<z.output<typeof circuitBreakerOptionsSchema>>().toEqualTypeOf<CircuitBreakerPolicyOptions>();
  expectTypeOf<z.output<typeof timeoutOptionsSchema>>().toEqualTypeOf<TimeoutPolicyOptions>();
  expectTypeOf<z.output<typeof bulkheadOptionsSchema>>().toEqualTypeOf<BulkheadPolicyOptions>();
});

for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
  it(`rejects unusable static timing (${String(invalid)}) at construction`, () => {
    expect(() => createTimeoutPolicy({ timeoutMs: invalid })).toThrow(AssertError);
    expect(() => createCircuitBreakerPolicy({ halfOpenAfter: invalid })).toThrow(AssertError);
  });
}
for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  it(`rejects unusable static capacities (${String(invalid)}) at construction`, () => {
    expect(() => createBulkheadPolicy({ maxConcurrent: invalid })).toThrow(AssertError);
    expect(() => createCircuitBreakerPolicy({ consecutiveFailures: invalid })).toThrow(AssertError);
  });
}
it('accepts zero timer/queue windows but refuses timer overflow and negative queues', () => {
  expect(() => createTimeoutPolicy({ timeoutMs: 0 })).not.toThrow();
  expect(() => createCircuitBreakerPolicy({ halfOpenAfter: 0 })).not.toThrow();
  expect(() => createBulkheadPolicy({ maxConcurrent: 1, maxQueue: 0 })).not.toThrow();
  expect(() => createTimeoutPolicy({ timeoutMs: 2_147_483_648 })).toThrow(AssertError);
  expect(() => createBulkheadPolicy({ maxQueue: -1 })).toThrow(AssertError);
});
it('uses a validated snapshot instead of rereading a changing configuration getter', () => {
  let reads = 0;
  createBulkheadPolicy({ get maxConcurrent() { return ++reads === 1 ? 1 : 0; } });
  expect(reads).toBe(1);
});


for (const [caseIndex, invalid] of [Symbol('private'), 1n, {}, 'bad', Number.NaN, -1].entries()) {
  it(`malformed timing sample ${caseIndex} cannot repeat completed effects or reject execution`, async () => {
    let calls = 0;
    const clock = new MockClock();
    const policy = createRetryPolicy({ backoff: backoff.constant(0).upTo(2), clock });
    vi.spyOn(performance, 'now');
    Object.defineProperty(performance, 'now', { configurable: true, value: () => calls > 0 ? invalid : 1 });
    const run = policy.execute(() => { calls++; return 'completed'; });
    await clock.advanceAsync(1);
    expect(await run).toBe('completed');
    expect(calls).toBe(1);
  });
}

it('a rejected asynchronous observation clock stays observed and cannot reject a successful call', async () => {
  vi.spyOn(performance, 'now');
  Object.defineProperty(performance, 'now', { configurable: true, value: () => Promise.reject(new Error('private clock')) });
  let calls = 0;
  expect(await createRetryPolicy().execute(() => ++calls)).toBe(1);
  expect(calls).toBe(1);
});


it('retains the timing receiver and origin across an awaited effect', async () => {
  const clock = { tick: 10, now() { return this.tick++; } };
  vi.stubGlobal('performance', clock);
  const policy = createRetryPolicy();
  const events: SuccessEvent[] = [];
  policy.onSuccess(event => events.push(event));
  try {
    expect(await policy.execute(async () => {
      await Promise.resolve();
      vi.stubGlobal('performance', { now: () => 9_000_000 });
      return 'completed';
    })).toBe('completed');
    expect(events[0]?.duration).toBeLessThan(10);
  } finally { vi.unstubAllGlobals(); }
});
