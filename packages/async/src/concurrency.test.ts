import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { FailureOf } from '@arki/failure';
import { MockClock } from '@arki/clock';
import { defineFailure, UnexpectedDefect } from '@arki/failure';

import { all, mapConcurrent, race, timeout } from './concurrency.js';
import { Cancelled, Deadline } from './errors.js';
import { sleep } from './sleep.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const Refused = defineFailure('concurrency_test.refused');

describe('ordered admission and joining', () => {
  it('preserves input order and fills every available slot', async () => {
    let active = 0;
    let peak = 0;
    const pending = mapConcurrent(
      [30, 10, 20, 1],
      async ms => {
        active++;
        peak = Math.max(peak, active);
        const waited = await sleep(ms);
        active--;
        return waited ?? ms;
      },
      { concurrency: 2 },
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual([30, 10, 20, 1]);
    expect(peak).toBe(2);
  });

  it('normalizes the first throw, aborts siblings, closes admission and joins uncooperative work', async () => {
    const cause = new Error('private provider error');
    const started: number[] = [];
    const signals: AbortSignal[] = [];
    let finished = false;
    const pending = mapConcurrent(
      [0, 1, 2],
      async (index, signal) => {
        started.push(index);
        signals.push(signal);
        const waited = await sleep(index === 0 ? 10 : 50);
        if (waited !== undefined) return waited;
        if (index === 0) throw cause;
        finished = true;
        return index;
      },
      { concurrency: 2 },
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    const result = await pending;
    expect(UnexpectedDefect.is(result)).toBe(true);
    if (!UnexpectedDefect.is(result)) throw new Error('expected owned defect');
    expect(result.cause).toBe(cause);
    expect(JSON.stringify(result)).not.toContain(cause.message);
    expect(finished).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  it('returns cancellation only after every admitted task settles', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const pending = all(
      [
        async () => {
          started.push(1);
          return sleep(40);
        },
        async () => {
          started.push(2);
        },
      ],
      { concurrency: 1, signal: controller.signal },
    );
    let done = false;
    void pending.then(() => {
      done = true;
    });
    controller.abort('private reason');
    await vi.advanceTimersByTimeAsync(39);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ code: Cancelled.code, cause: 'private reason' });
    expect(started).toEqual([1]);
  });

  it('starts no tasks for a preaborted signal and leaves a successful signal usable', async () => {
    const task = vi.fn(async () => 42);
    await expect(mapConcurrent([1], task, { signal: AbortSignal.abort('stop') })).resolves.toMatchObject({
      code: Cancelled.code,
    });
    expect(task).not.toHaveBeenCalled();
    let seen: AbortSignal | undefined;
    expect(
      await all([
        async signal => {
          seen = signal;
          return 42;
        },
      ]),
    ).toEqual([42]);
    expect(seen?.aborted).toBe(false);
    expect(await mapConcurrent([], async () => 42)).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, -Infinity])(
    'rejects static concurrency misuse %s before admission',
    async concurrency => {
      const task = vi.fn(async () => 42);
      await expect(mapConcurrent([1], task, { concurrency })).rejects.toMatchObject({ code: 'ARKI_ASYNC_E005' });
      expect(task).not.toHaveBeenCalled();
    },
  );

  it('keeps Failure values as explicit array and heterogeneous tuple elements', async () => {
    const refused = Refused();
    expect(await mapConcurrent([1], async () => refused)).toEqual([refused]);
    const operation = () => all([async () => 42, async () => 'two', async () => refused] as const);
    expectTypeOf<Awaited<ReturnType<typeof operation>>>().toEqualTypeOf<
      [number, string, typeof refused] | ReturnType<typeof Cancelled> | ReturnType<typeof UnexpectedDefect>
    >();
    expect(await operation()).toEqual([42, 'two', refused]);
  });
});

describe('race', () => {
  it('keeps first-fulfillment semantics, joins losers, and preserves the winner signal', async () => {
    const signals: AbortSignal[] = [];
    const pending = race([
      async () => {
        throw new Error('early rejection');
      },
      async signal => {
        signals.push(signal);
        const waited = await sleep(10);
        return waited ?? 'winner';
      },
      async signal => {
        signals.push(signal);
        const waited = await sleep(30);
        return waited ?? 'loser';
      },
    ]);
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(signals.map(signal => signal.aborted)).toEqual([false, true]);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toBe('winner');
  });

  it('keeps heterogeneous value/failure inference exact without hoisting or narrowing', async () => {
    const refused = Refused();
    const _operation = () => race([async () => 42, async () => 'two', async () => refused] as const);
    expectTypeOf<Awaited<ReturnType<typeof _operation>>>().toEqualTypeOf<
      number | string | typeof refused | ReturnType<typeof Cancelled> | ReturnType<typeof UnexpectedDefect>
    >();
    expectTypeOf<string extends FailureOf<typeof _operation>['code'] ? true : false>().toEqualTypeOf<false>();
    expect(await race([async () => refused])).toBe(refused);
  });

  it('owns aggregate rejection causes privately in input order', async () => {
    const causes = [new Error('first'), new Error('second')];
    const result = await race(
      causes.map(cause => async () => {
        throw cause;
      }),
    );
    if (!UnexpectedDefect.is(result)) throw new Error('expected owned aggregate defect');
    expect(result.cause).toBeInstanceOf(AggregateError);
    expect(result.cause).toMatchObject({ errors: causes });
    expect(JSON.stringify(result)).not.toContain('first');
    await expect(race([])).rejects.toBeInstanceOf(AggregateError);
  });
});

describe('timeout', () => {
  it('keeps success usable and cleans the deadline before returning', async () => {
    const clock = new MockClock();
    let seen: AbortSignal | undefined;
    expect(
      await timeout(
        async signal => {
          seen = signal;
          return 'ok';
        },
        100,
        { clock },
      ),
    ).toBe('ok');
    expect(seen?.aborted).toBe(false);
    const callback = vi.fn();
    clock.setTimer(callback, 200);
    clock.advance(200);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('returns deadline before an uncooperative task and observes its late rejection', async () => {
    const clock = new MockClock();
    let rejectLate: ((cause: unknown) => void) | undefined;
    let signal: AbortSignal | undefined;
    const pending = timeout(
      owned => {
        signal = owned;
        return new Promise<never>((_resolve, reject) => {
          rejectLate = reject;
        });
      },
      10,
      { clock },
    );
    clock.advance(10);
    const result = await pending;
    expect(Deadline.is(result)).toBe(true);
    expect(signal?.reason).toBe(result);
    if (rejectLate === undefined) throw new Error('missing late task');
    rejectLate(new Error('late private cause'));
    await Promise.resolve();
    expect(await pending).toBe(result);
  });

  it('owns callback throws and invalid definition misuse separately', async () => {
    const cause = new Error('task defect');
    await expect(
      timeout(async () => {
        throw cause;
      }, 50),
    ).resolves.toMatchObject({ code: UnexpectedDefect.code, cause });
    await expect(timeout(async () => 42, -1)).rejects.toMatchObject({ code: 'ARKI_ASYNC_E001' });
  });

  it('retains exactly value, cancellation, deadline and defect outcomes', () => {
    const _operation = () => timeout(async () => 42, 10);
    expectTypeOf<Awaited<ReturnType<typeof _operation>>>().toEqualTypeOf<
      number | ReturnType<typeof Cancelled> | ReturnType<typeof Deadline> | ReturnType<typeof UnexpectedDefect>
    >();
  });
});

it.each(['addEventListener', 'removeEventListener'] as const)(
  'supervises foreign signal %s faults at each managed operation',
  async method => {
    for (const run of [
      (signal: AbortSignal) => all([async () => 42], { signal }),
      (signal: AbortSignal) => race([async () => 42], { signal }),
      (signal: AbortSignal) => timeout(async () => 42, 10, { signal }),
    ]) {
      const controller = new AbortController();
      const cause = new Error(`${method} defect`);
      Object.defineProperty(controller.signal, method, {
        value: () => {
          throw cause;
        },
      });
      await expect(run(controller.signal)).resolves.toMatchObject({ code: UnexpectedDefect.code, cause });
    }
  },
);

it('handles synchronous timer callbacks and cancellation during timer registration without leaking the handle', async () => {
  const clock = new MockClock();
  const cancel = vi.fn();
  vi.spyOn(clock, 'setTimer').mockImplementation(callback => {
    callback();
    return cancel;
  });
  const result = await timeout(
    () =>
      new Promise<never>(() => {
        /* Intentionally uncooperative foreign work. */
      }),
    10,
    { clock },
  );
  expect(Deadline.is(result)).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  const controller = new AbortController();
  vi.spyOn(clock, 'setTimer').mockImplementation(() => {
    controller.abort('during registration');
    return cancel;
  });
  await expect(sleep(10, { clock, signal: controller.signal })).resolves.toMatchObject({
    code: Cancelled.code,
    cause: 'during registration',
  });
  expect(cancel).toHaveBeenCalledTimes(2);
});

it('preserves an injected clock cancellation instead of narrowing it to success', async () => {
  const clock = new MockClock();
  const { SleepCancelled } = await import('@arki/clock');
  const cause = new Error('provider cancelled its wait');
  vi.spyOn(clock, 'sleep').mockResolvedValue(SleepCancelled({ cause }));
  await expect(sleep(10, { clock })).resolves.toMatchObject({ code: Cancelled.code, cause });
});

it('owns rejected signal registration, observes late registration rejection, and cleans asynchronous removal', async () => {
  const controller = new AbortController();
  const cause = new Error('registration rejected');
  const register = () => Promise.reject(cause);
  Object.defineProperty(controller.signal, 'addEventListener', { value: register });
  await expect(all([async () => 42], { signal: controller.signal })).resolves.toMatchObject({
    code: UnexpectedDefect.code,
    cause,
  });
  const late = new AbortController();
  let rejectLate: ((cause: unknown) => void) | undefined;
  const registerLate = () =>
    new Promise<void>((_resolve, reject) => {
      rejectLate = reject;
    });
  Object.defineProperty(late.signal, 'addEventListener', { value: registerLate });
  expect(await all([async () => 42], { signal: late.signal })).toEqual([42]);
  if (rejectLate === undefined) throw new Error('missing registration');
  rejectLate(cause);
  await Promise.resolve();
  const removal = new AbortController();
  const remove = () => Promise.reject(cause);
  Object.defineProperty(removal.signal, 'removeEventListener', { value: remove });
  await expect(race([async () => 42], { signal: removal.signal })).resolves.toMatchObject({
    code: UnexpectedDefect.code,
    cause,
  });
});

it('infers heterogeneous mapping and exact default/injected wait outcomes from their callbacks', () => {
  const _mapped = () => mapConcurrent([true], input => (input ? Promise.resolve(42) : Promise.resolve('value')));
  expectTypeOf<Awaited<ReturnType<typeof _mapped>>>().toEqualTypeOf<
    (number | string)[] | ReturnType<typeof Cancelled> | ReturnType<typeof UnexpectedDefect>
  >();
  const _timeout = (flag: boolean) => timeout(() => (flag ? Promise.resolve(42) : Promise.resolve('value')), 10);
  expectTypeOf<Awaited<ReturnType<typeof _timeout>>>().toEqualTypeOf<
    number | string | ReturnType<typeof Cancelled> | ReturnType<typeof Deadline> | ReturnType<typeof UnexpectedDefect>
  >();
  const _defaultWait = () => sleep(1);
  const _providedWait = () => sleep(1, { clock: new MockClock() });
  expectTypeOf<Awaited<ReturnType<typeof _defaultWait>>>().toEqualTypeOf<void | ReturnType<typeof UnexpectedDefect>>();
  expectTypeOf<Awaited<ReturnType<typeof _providedWait>>>().toEqualTypeOf<
    void | ReturnType<typeof Cancelled> | ReturnType<typeof UnexpectedDefect>
  >();
});

it('does not admit a task after cancellation during deadline registration', async () => {
  const controller = new AbortController();
  const clock = new MockClock();
  const cancel = vi.fn();
  vi.spyOn(clock, 'setTimer').mockImplementation(() => {
    controller.abort('during registration');
    return cancel;
  });
  const task = vi.fn(() => Promise.resolve(42));
  await expect(timeout(task, 10, { clock, signal: controller.signal })).resolves.toMatchObject({
    code: Cancelled.code,
    cause: 'during registration',
  });
  expect(task).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

it('retains an injected timer provider cancellation at the timeout boundary', async () => {
  const clock = new MockClock();
  const { SleepCancelled } = await import('@arki/clock');
  const cause = new Error('clock provider cancelled');
  vi.spyOn(clock, 'sleep').mockResolvedValue(SleepCancelled({ cause }));
  const result = await timeout(
    () =>
      new Promise<never>(() => {
        /* Noncooperative task must not hold cancellation. */
      }),
    10,
    { clock },
  );
  expect(Cancelled.is(result)).toBe(true);
  expect(result).toMatchObject({ code: Cancelled.code, cause });
});
