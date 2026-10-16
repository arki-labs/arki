// A function can fail in two ways: it throws (a bug, or a broken dependency), or it returns
// a failure from `@arki/failure` (an expected outcome, such as "card declined"). Retrying an
// expected outcome only repeats it: the card stays declined, and the customer may be charged
// three times. So retry never repeats a returned failure, unless the backoff's `while` asks
// for that failure by name, such as a database timeout that a second try may get past.

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Failure } from '@arki/failure';
import { MockClock } from '@arki/clock';
import { defineFailure, isFailure } from '@arki/failure';

import type { Backoff, FailureReason } from './index.js';
import { backoff, createResiliencePolicy, createRetryPolicy, InvalidBackoffError, withRetry } from './index.js';

const CardDeclined = defineFailure('card.declined', { status: 402 });
const DbTimeout = defineFailure('db.timeout', { status: 503 });

/** Retries a database timeout, and nothing else. */
const timeouts = backoff
  .constant(1000)
  .upTo(3)
  .while(reason => isFailure(reason) && reason.code === 'db.timeout');

describe('backoff and returned failures', () => {
  it('a backoff without while() retries thrown errors but never returned failures', () => {
    const plain = backoff.constant(10).upTo(3);
    expect(plain.delay(1, new Error('connection reset'))).toBe(10);
    expect(plain.delay(1, CardDeclined())).toBeUndefined();
  });

  it('while() decides for returned failures: it retries the ones its predicate accepts', () => {
    expect(timeouts.delay(1, DbTimeout())).toBe(1000);
    expect(timeouts.delay(1, CardDeclined())).toBeUndefined();
    // The predicate also sees thrown errors, and this one says no to them.
    expect(timeouts.delay(1, new Error('connection reset'))).toBeUndefined();
  });

  it('a second while() still narrows what the first accepted', () => {
    const never = timeouts.while(reason => reason instanceof Error);
    expect(never.delay(1, DbTimeout())).toBeUndefined();
  });
});

// An export to an upstream service: "unavailable" may pass on a later try, "unauthorized"
// (the service refused the token) never will. `.while(ExportUnavailable)` names the one
// worth retrying, and thrown errors (a dropped connection) keep retrying as by default.
const ExportUnavailable = defineFailure('export.unavailable', { status: 503 });
const ExportUnauthorized = defineFailure('export.unauthorized', { status: 422 });

describe('while(...definitions)', () => {
  const exportRetry = backoff.exponential({ base: 1 }).while(ExportUnavailable);

  /** Runs `attempt` under `exportRetry` on a MockClock and counts the calls. */
  async function run<T>(attempt: (call: number) => T) {
    const clock = new MockClock();
    let calls = 0;
    const result = withRetry(() => attempt(++calls), { backoff: exportRetry, clock });
    await clock.advanceAsync(100);
    return { result: await result, calls };
  }

  it('retries a thrown network error, as a backoff without while() does', async () => {
    const outcome = await run(call => {
      if (call < 3) throw new TypeError('fetch failed');
      return 'exported';
    });
    expect(outcome).toEqual({ result: 'exported', calls: 3 });
  });

  it('retries a returned failure of a listed definition, so a busy service gets another try', async () => {
    const outcome = await run(call => (call < 3 ? ExportUnavailable() : 'exported'));
    expect(outcome).toEqual({ result: 'exported', calls: 3 });
  });

  it('does not retry a failure it was not given, so a refused token is not sent again', async () => {
    const refused = ExportUnauthorized();
    const outcome = await run(() => refused);
    expect(outcome).toEqual({ result: refused, calls: 1 });
  });

  it('takes several definitions, and a later while() still narrows', () => {
    const both = backoff.constant(10).while(ExportUnavailable, DbTimeout);
    expect(both.delay(1, ExportUnavailable())).toBe(10);
    expect(both.delay(1, DbTimeout())).toBe(10);
    expect(both.delay(1, CardDeclined())).toBeUndefined();
    const errorsOnly = both.while(reason => !isFailure(reason));
    expect(errorsOnly.delay(1, new Error('connection reset'))).toBe(10);
    expect(errorsOnly.delay(1, DbTimeout())).toBeUndefined();
  });

  it('needs at least one definition, so an empty while() cannot silently mean "retry nothing"', () => {
    // @ts-expect-error -- while() takes a predicate or one or more definitions
    expect(() => backoff.constant(10).while()).toThrow(InvalidBackoffError);
  });
});

describe('retry with returned failures', () => {
  it('returns an expected failure at once: a declined card is tried once, not three times', async () => {
    let calls = 0;
    const policy = createRetryPolicy({ backoff: backoff.constant(1000).upTo(3), clock: new MockClock() });
    const events: string[] = [];
    policy.onRetry(() => events.push('retry'));
    policy.onGiveUp(() => events.push('give up'));
    const declined = CardDeclined();

    const result = await policy.execute(() => {
      calls += 1;
      return declined;
    });

    expect(result).toBe(declined);
    expect(calls).toBe(1);
    // Nothing ran out: the failure was the answer from the first try.
    expect(events).toEqual([]);
  });

  it('retries a failure that while() accepts, and the call ends well when a later try works', async () => {
    const clock = new MockClock();
    const calledAt: number[] = [];
    const result = withRetry(
      () => {
        calledAt.push(clock.now().getTime());
        return calledAt.length <= 2 ? DbTimeout() : 'saved';
      },
      { backoff: timeouts, clock },
    );

    await clock.advanceAsync(5000);

    await expect(result).resolves.toBe('saved');
    expect(calledAt).toEqual([0, 1000, 2000]);
  });

  it('when retries run out on a failure, the last failure comes back as a value, not thrown', async () => {
    const clock = new MockClock();
    const returned: Failure[] = [];
    const policy = createRetryPolicy({ backoff: timeouts, clock });
    const reasons: FailureReason[] = [];
    policy.onGiveUp(reason => reasons.push(reason));

    const result = policy.execute(() => {
      const timeout = DbTimeout();
      returned.push(timeout);
      return timeout;
    });
    await clock.advanceAsync(10_000);

    const last = await result;
    expect(returned).toHaveLength(4);
    expect(last).toBe(returned[3]);
    expect(reasons).toEqual([{ value: returned[3] }]);
  });

  it('reports a returned failure in onFailure and onRetry as a value, not an error', async () => {
    const clock = new MockClock();
    const policy = createRetryPolicy({ backoff: timeouts.upTo(1), clock });
    const handled: boolean[] = [];
    const retried: string[] = [];
    policy.onFailure(event => handled.push(event.handled));
    policy.onRetry(event => retried.push('value' in event ? 'value' : 'error'));

    const result = policy.execute(() => DbTimeout());
    await clock.advanceAsync(5000);
    const last = await result;

    expect(handled).toEqual([true, false]);
    expect(retried).toEqual(['value']);
    expect(isFailure(last)).toBe(true);
  });

  it('a composed policy passes a returned failure through untouched', async () => {
    let calls = 0;
    const declined = CardDeclined();
    const policy = createResiliencePolicy({ retry: backoff.constant(10).upTo(3), clock: new MockClock() });

    await expect(
      policy.execute(() => {
        calls += 1;
        return declined;
      }),
    ).resolves.toBe(declined);
    expect(calls).toBe(1);
  });

  it('keeps failures in the result type, so the caller must still check for them', () => {
    const charge = () => (Math.random() > 2 ? 'charged' : CardDeclined());
    expectTypeOf(withRetry(charge)).toEqualTypeOf<Promise<'charged' | ReturnType<typeof CardDeclined>>>();
    // The predicate sees both kinds of reason, so it can narrow to a failure by code.
    expectTypeOf<Parameters<Parameters<Backoff['while']>[0]>[0]>().toBeUnknown();
  });
});
