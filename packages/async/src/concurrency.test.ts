import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { AsyncError } from './errors.js';
import { all, mapConcurrent, race, timeout } from './concurrency.js';
import { sleep } from './sleep.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Settles `promise` into a value or the error it rejected with, so a test can inspect either. */
async function settled<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  );
}

/** A task that ignores its signal: it always runs `ms` to the end, then sets `done`. Models uncooperative work. */
function stubborn(ms: number, done: { value: boolean }): () => Promise<void> {
  return async () => {
    await sleep(ms);
    done.value = true;
  };
}

describe('mapConcurrent', () => {
  it('resolves in input order, not completion order', async () => {
    const promise = mapConcurrent([30, 10, 20], async (ms, signal) => {
      await sleep(ms, { signal });
      return ms;
    });
    await vi.advanceTimersByTimeAsync(30);
    await expect(promise).resolves.toEqual([30, 10, 20]);
  });

  it('never has more than `concurrency` calls in flight, and still uses every slot', async () => {
    let active = 0;
    let peak = 0;
    const promise = mapConcurrent(
      Array.from({ length: 10 }, (_, index) => index),
      async (index, signal) => {
        active++;
        peak = Math.max(peak, active);
        await sleep(10 + (index % 3) * 5, { signal });
        active--;
        return index;
      },
      { concurrency: 3 },
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toHaveLength(10);
    expect(peak).toBe(3);
  });

  it('on the first failure: aborts siblings, starts nothing new, and waits for in-flight work before rejecting', async () => {
    const boom = new Error('boom');
    const started: number[] = [];
    const seenReasons: unknown[] = [];
    const slowFinished = { value: false };
    const promise = settled(
      mapConcurrent(
        [0, 1, 2, 3, 4],
        async (index, signal) => {
          started.push(index);
          signal.addEventListener('abort', () => seenReasons.push(signal.reason));
          if (index === 0) {
            await sleep(10);
            throw boom;
          }
          // The sibling ignores the abort for 50 ms: the call must not settle before it does.
          await stubborn(50, slowFinished)();
          return index;
        },
        { concurrency: 2 },
      ),
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(seenReasons).toEqual([boom, boom]);
    let done = false;
    void promise.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(39);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await promise).toEqual({ error: boom });
    expect(slowFinished.value).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  it('keeps only the first error when several tasks fail', async () => {
    const first = new Error('first');
    const promise = settled(
      mapConcurrent([10, 20], async (ms, signal) => {
        await sleep(ms);
        throw ms === 10 ? first : new Error(signal.aborted ? 'after abort' : 'second');
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(await promise).toEqual({ error: first });
  });

  it('treats a synchronous throw in `fn` as a failure, not a crash', async () => {
    const boom = new Error('sync');
    const result = await settled(
      mapConcurrent([1], () => {
        throw boom;
      }),
    );
    expect(result).toEqual({ error: boom });
  });

  it('an outer abort stops new work, waits for in-flight tasks, and rejects with E002 (cause = reason)', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const finished = { value: false };
    const promise = settled(
      mapConcurrent(
        [0, 1, 2],
        async index => {
          started.push(index);
          await stubborn(40, finished)();
        },
        { concurrency: 1, signal: controller.signal },
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    controller.abort('stop');
    let done = false;
    void promise.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(29);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(result).toMatchObject({ error: { code: 'ARKI_ASYNC_E002', cause: 'stop' } });
    expect(finished.value).toBe(true);
    expect(started).toEqual([0]);
  });

  it('an already-aborted signal rejects with E002 and calls nothing', async () => {
    const fn = vi.fn(() => Promise.resolve(1));
    const result = await settled(mapConcurrent([1, 2], fn, { signal: AbortSignal.abort('gone') }));
    expect(result).toMatchObject({ error: { code: 'ARKI_ASYNC_E002', cause: 'gone' } });
    expect(fn).not.toHaveBeenCalled();
  });

  it('leaves the signal alone on success, so results tied to it (a fetch body) stay usable', async () => {
    let shared: AbortSignal | undefined;
    await mapConcurrent([1], (_, signal) => {
      shared = signal;
      return Promise.resolve(1);
    });
    expect(shared?.aborted).toBe(false);
  });

  it('resolves an empty input with an empty list', async () => {
    await expect(mapConcurrent([], () => Promise.resolve(1))).resolves.toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY])(
    'rejects concurrency %s with E005 and calls nothing',
    async concurrency => {
      const fn = vi.fn(() => Promise.resolve(1));
      const result = await settled(mapConcurrent([1], fn, { concurrency }));
      expect(result).toMatchObject({ error: { code: 'ARKI_ASYNC_E005' } });
      expect((result as { error: AsyncError }).error.remediation).not.toBe('');
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it('accepts Infinity as "no limit"', async () => {
    await expect(
      mapConcurrent([1, 2], n => Promise.resolve(n), { concurrency: Number.POSITIVE_INFINITY }),
    ).resolves.toEqual([1, 2]);
  });
});

describe('all', () => {
  it('is typed per position like Promise.all', async () => {
    const promise = all([() => Promise.resolve(1), () => Promise.resolve('two'), () => Promise.resolve(true)] as const);
    expectTypeOf(promise).toEqualTypeOf<Promise<[number, string, boolean]>>();
    await expect(promise).resolves.toEqual([1, 'two', true]);
  });

  it('aborts the siblings on the first rejection and rejects with that error once they settle', async () => {
    const boom = new Error('boom');
    const sibling = { value: false };
    let siblingSignal: AbortSignal | undefined;
    const promise = settled(
      all([
        async () => {
          await sleep(5);
          throw boom;
        },
        async signal => {
          siblingSignal = signal;
          await stubborn(20, sibling)();
        },
      ]),
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(siblingSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(15);
    expect(await promise).toEqual({ error: boom });
    expect(sibling.value).toBe(true);
  });
});

describe('race', () => {
  it('the first task to FULFILL wins, even when another rejects first (unlike Promise.race)', async () => {
    const promise = race([
      async () => {
        await sleep(5);
        throw new Error('fast failure');
      },
      async signal => {
        await sleep(10, { signal });
        return 'winner';
      },
    ]);
    await vi.advanceTimersByTimeAsync(10);
    await expect(promise).resolves.toBe('winner');
  });

  it('aborts the losers, leaves the winner alone, and waits for losers to settle before resolving', async () => {
    const loserDone = { value: false };
    const signals: AbortSignal[] = [];
    const promise = settled(
      race([
        async signal => {
          signals.push(signal);
          await sleep(10);
          return 'fast';
        },
        async signal => {
          signals.push(signal);
          await stubborn(30, loserDone)();
          return 'slow';
        },
      ]),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(signals.map(signal => signal.aborted)).toEqual([false, true]);
    let done = false;
    void promise.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(19);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toEqual({ value: 'fast' });
    expect(loserDone.value).toBe(true);
  });

  it('when every task rejects, rejects with an AggregateError in input order, not completion order', async () => {
    const late = new Error('late');
    const early = new Error('early');
    const promise = settled(
      race([
        async () => {
          await sleep(20);
          throw late;
        },
        async () => {
          await sleep(5);
          throw early;
        },
      ]),
    );
    await vi.advanceTimersByTimeAsync(20);
    const result = await promise;
    expect(result).toMatchObject({ error: expect.any(AggregateError) });
    expect((result as { error: AggregateError }).error.errors).toEqual([late, early]);
  });

  it('rejects an empty list with an AggregateError, like Promise.any', async () => {
    const result = await settled(race([]));
    expect(result).toMatchObject({ error: expect.any(AggregateError) });
  });

  it('an outer abort aborts every task, waits for them, and rejects with E002', async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const promise = settled(
      race(
        [1, 2].map(n => async (signal: AbortSignal) => {
          signals.push(signal);
          await sleep(100, { signal });
          return n;
        }),
        { signal: controller.signal },
      ),
    );
    controller.abort('cancel');
    await vi.advanceTimersByTimeAsync(0);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(await promise).toMatchObject({ error: { code: 'ARKI_ASYNC_E002', cause: 'cancel' } });
  });
});

describe('timeout', () => {
  it('resolves with the value when the task beats the deadline, leaves its signal alone and clears the timer', async () => {
    let seen: AbortSignal | undefined;
    const promise = timeout(async signal => {
      seen = signal;
      await sleep(10, { signal });
      return 'ok';
    }, 50);
    await vi.advanceTimersByTimeAsync(10);
    await expect(promise).resolves.toBe('ok');
    expect(seen?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('at the deadline aborts the task signal with E004 and rejects at once, without waiting for an uncooperative task', async () => {
    let seen: AbortSignal | undefined;
    const finished = { value: false };
    const promise = settled(
      timeout(async signal => {
        seen = signal;
        await stubborn(1000, finished)();
      }, 50),
    );
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;
    expect(result).toMatchObject({ error: { code: 'ARKI_ASYNC_E004' } });
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe((result as { error: unknown }).error);
    expect(finished.value).toBe(false);
  });

  it('rejects with the task error when the task fails before the deadline', async () => {
    const boom = new Error('boom');
    const result = await settled(timeout(() => Promise.reject(boom), 50));
    expect(result).toEqual({ error: boom });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid deadline (%s) with E001', async ms => {
    const task = vi.fn(() => Promise.resolve(1));
    expect(await settled(timeout(task, ms))).toMatchObject({ error: { code: 'ARKI_ASYNC_E001' } });
    expect(task).not.toHaveBeenCalled();
  });

  it('an outer abort aborts the task and rejects with E002', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const promise = settled(
      timeout(
        async signal => {
          seen = signal;
          await sleep(100, { signal });
        },
        50,
        { signal: controller.signal },
      ),
    );
    controller.abort('user');
    expect(await promise).toMatchObject({ error: { code: 'ARKI_ASYNC_E002', cause: 'user' } });
    expect(seen?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
