import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { isFailure, UnexpectedDefect } from '@arki/failure';

import type { SleepFailure } from './errors.js';
import { MAX_TIMER_MS, MockClock, SystemClock } from './clock.js';
import { CLOCK_ERROR_CODES, ClockError, SLEEP_FAILURES, SleepCancelled } from './errors.js';

describe('ClockError', () => {
  it('exposes only live configuration codes after sleep cancellation moved to failure values', () => {
    expect(Object.values(CLOCK_ERROR_CODES)).toEqual(['ARKI_CLOCK_E001', 'ARKI_CLOCK_E002']);
    // @ts-expect-error The obsolete abort exception code is deliberately retired.
    expect(CLOCK_ERROR_CODES.aborted).toBeUndefined();
  });

  it('carries a stable code and a remediation, so callers match on the code and not the message', () => {
    const clock = new MockClock();
    try {
      clock.advance(-5);
      expect.unreachable('advance(-5) should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ClockError);
      expect(error).toMatchObject({ code: CLOCK_ERROR_CODES.invalidAdvance, name: 'ClockError' });
      expect(error instanceof ClockError && error.remediation.length > 0).toBe(true);
    }
    expect(CLOCK_ERROR_CODES.invalidAdvance).toBe('ARKI_CLOCK_E001');
  });
});

describe('SystemClock', () => {
  it('returns the current system time within a tight window', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const observed = clock.now().getTime();
    const after = Date.now();
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });

  it('returns Date instances', () => {
    expect(new SystemClock().now()).toBeInstanceOf(Date);
  });
});

describe('MockClock', () => {
  it('defaults to the Unix epoch when no initial date is provided', () => {
    const clock = new MockClock();
    expect(clock.now().getTime()).toBe(0);
  });

  it('starts at the provided initial date', () => {
    const initial = new Date('2026-01-01T00:00:00.000Z');
    const clock = new MockClock(initial);
    expect(clock.now().getTime()).toBe(initial.getTime());
  });

  it('advances by the given number of milliseconds', () => {
    const clock = new MockClock(new Date('2026-01-01T00:00:00.000Z'));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('accumulates sequential advances', () => {
    const clock = new MockClock(new Date(0));
    clock.advance(1000);
    clock.advance(2000);
    expect(clock.now().getTime()).toBe(3000);
  });

  it('treats advance(0) as a no-op', () => {
    const clock = new MockClock(new Date(0));
    clock.advance(0);
    expect(clock.now().getTime()).toBe(0);
  });

  it('rejects negative advances so tests cannot silently rewind time', () => {
    const clock = new MockClock();
    expect(() => clock.advance(-1)).toThrowError(/ARKI_CLOCK_E001/);
  });

  it('rejects non-finite advances', () => {
    const clock = new MockClock();
    expect(() => clock.advance(Number.NaN)).toThrowError(/ARKI_CLOCK_E001/);
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrowError(/ARKI_CLOCK_E001/);
  });

  it('returns a fresh Date on every call so callers cannot mutate clock state', () => {
    const clock = new MockClock(new Date('2026-01-01T00:00:00.000Z'));
    const first = clock.now();
    first.setFullYear(1990);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it('allows setNow to jump to any absolute time, including backward', () => {
    const clock = new MockClock(new Date('2026-06-01T00:00:00.000Z'));
    clock.setNow(new Date('2026-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('supports advancing across a 72h window deterministically', () => {
    const start = new Date('2026-04-21T12:00:00.000Z');
    const clock = new MockClock(start);
    const sevenTwoHoursMs = 72 * 60 * 60 * 1000;
    clock.advance(sevenTwoHoursMs);
    expect(clock.now().toISOString()).toBe('2026-04-24T12:00:00.000Z');
  });
});

// Timers are why `MockClock` exists beyond `now()`: code that waits (retry
// delays, debounce, sleeps) must finish instantly in tests, in the same order
// it would in production.
describe('MockClock timers', () => {
  it('fires nothing until advance reaches the due time', () => {
    const clock = new MockClock();
    const fired: number[] = [];
    clock.setTimer(() => fired.push(clock.now().getTime()), 1000);
    clock.advance(999);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([1000]);
  });

  it('fires due timers in time order, each at its own due time, then lands on the target', () => {
    const clock = new MockClock();
    const fired: string[] = [];
    clock.setTimer(() => fired.push(`b@${String(clock.now().getTime())}`), 300);
    clock.setTimer(() => fired.push(`a@${String(clock.now().getTime())}`), 100);
    clock.setTimer(() => fired.push(`c@${String(clock.now().getTime())}`), 300);
    clock.advance(1000);
    // Equal due times keep the order they were set in.
    expect(fired).toEqual(['a@100', 'b@300', 'c@300']);
    expect(clock.now().getTime()).toBe(1000);
  });

  it('fires a timer set by a firing timer when it comes due within the same advance', () => {
    const clock = new MockClock();
    const fired: number[] = [];
    clock.setTimer(() => {
      fired.push(clock.now().getTime());
      clock.setTimer(() => fired.push(clock.now().getTime()), 500);
    }, 200);
    clock.advance(800);
    expect(fired).toEqual([200, 700]);
  });

  it('leaves a chained timer that is due after the target for the next advance', () => {
    const clock = new MockClock();
    const fired: number[] = [];
    clock.setTimer(() => clock.setTimer(() => fired.push(clock.now().getTime()), 500), 200);
    clock.advance(600);
    expect(fired).toEqual([]);
    clock.advance(100);
    expect(fired).toEqual([700]);
  });

  it('never fires a cancelled timer, and cancelling twice is harmless', () => {
    const clock = new MockClock();
    const callback = vi.fn();
    const cancel = clock.setTimer(callback, 10);
    cancel();
    cancel();
    clock.advance(100);
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects a delay a real timer could not hold, so tests and production agree', () => {
    const clock = new MockClock();
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMER_MS + 1]) {
      expect(() => clock.setTimer(vi.fn(), ms)).toThrowError(/ARKI_CLOCK_E002/);
    }
  });

  it('resolves sleep only when advance reaches it', async () => {
    const clock = new MockClock();
    let done = false;
    const sleeping = clock.sleep(5000).then(outcome => {
      if (isFailure(outcome)) throw new Error('unexpected sleep failure');
      done = true;
    });
    clock.advance(4999);
    await Promise.resolve();
    expect(done).toBe(false);
    clock.advance(1);
    await sleeping;
    expect(done).toBe(true);
  });

  it('returns cancellation with the private abort reason without rejecting', async () => {
    const clock = new MockClock();
    const controller = new AbortController();
    const reason = new Error('stop');
    const sleeping = clock.sleep(5000, controller.signal);
    controller.abort(reason);
    await expect(sleeping).resolves.toMatchObject({ code: SleepCancelled.code, cause: reason });
    const already = new AbortController();
    already.abort(reason);
    await expect(clock.sleep(10, already.signal)).resolves.toMatchObject({ code: SleepCancelled.code, cause: reason });
  });

  it('advanceAsync fires timers that async code sets after each await', async () => {
    const clock = new MockClock();
    const wokeAt: number[] = [];
    const loop = async (): Promise<void> => {
      if (isFailure(await clock.sleep(1000))) throw new Error('unexpected cancellation');
      wokeAt.push(clock.now().getTime());
      if (isFailure(await clock.sleep(2000))) throw new Error('unexpected cancellation');
      wokeAt.push(clock.now().getTime());
      if (isFailure(await clock.sleep(4000))) throw new Error('unexpected cancellation');
      wokeAt.push(clock.now().getTime());
    };
    const running = loop();
    await clock.advanceAsync(10_000);
    await running;
    expect(wokeAt).toEqual([1000, 3000, 7000]);
    expect(clock.now().getTime()).toBe(10_000);
  });

  it('advanceAsync rejects a bad step like advance does', async () => {
    await expect(new MockClock().advanceAsync(-1)).rejects.toThrow(/ARKI_CLOCK_E001/);
  });
});

describe('SystemClock timers', () => {
  it('fires a real timer and can cancel one', async () => {
    const clock = new SystemClock();
    const cancelled = vi.fn();
    clock.setTimer(cancelled, 1)();
    if (isFailure(await clock.sleep(5))) throw new Error('unexpected cancellation');
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('rejects an invalid delay', async () => {
    await expect(new SystemClock().sleep(-1)).rejects.toThrow(/ARKI_CLOCK_E002/);
  });
});

describe.each([SystemClock, MockClock])('%s cancellation ownership', ClockClass => {
  it('clears its timer before returning cancellation', async () => {
    const clock = new ClockClass();
    const controller = new AbortController();
    const cancel = vi.fn();
    vi.spyOn(clock, 'setTimer').mockReturnValue(cancel);
    const sleeping = clock.sleep(100, controller.signal);
    controller.abort('stop');
    expect(cancel).toHaveBeenCalledOnce();
    expect(SleepCancelled.is(await sleeping)).toBe(true);
  });

  it('does not allocate a timer or listener for an already cancelled wait', async () => {
    const clock = new ClockClass();
    const controller = new AbortController();
    controller.abort('stop');
    const timer = vi.spyOn(clock, 'setTimer');
    const listener = vi.spyOn(controller.signal, 'addEventListener');
    expect(SleepCancelled.is(await clock.sleep(100, controller.signal))).toBe(true);
    expect(timer).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});

it('exposes exactly the canonical cancellation outcome alongside ordinary void success', () => {
  expectTypeOf<Awaited<ReturnType<SystemClock['sleep']>>>().toEqualTypeOf<void | SleepFailure>();
  expectTypeOf<Awaited<ReturnType<MockClock['sleep']>>>().toEqualTypeOf<void | ReturnType<
    (typeof SLEEP_FAILURES)[number]
  >>();
  expect(SLEEP_FAILURES).toEqual([SleepCancelled, UnexpectedDefect]);
});

it('supervises timer registration and cleanup defects without rejecting', async () => {
  const clock = new MockClock();
  const cause = new Error('timer provider failed');
  const timer = vi.spyOn(clock, 'setTimer').mockImplementation(() => {
    throw cause;
  });
  await expect(clock.sleep(1)).resolves.toMatchObject({ code: UnexpectedDefect.code, cause });
  timer.mockReturnValue(() => {
    throw cause;
  });
  const controller = new AbortController();
  const sleeping = clock.sleep(1, controller.signal);
  controller.abort();
  await expect(sleeping).resolves.toMatchObject({ code: UnexpectedDefect.code, cause });
});

it('settles when a foreign timer calls back synchronously and cleans the handle', async () => {
  const clock = new MockClock();
  const cancel = vi.fn();
  vi.spyOn(clock, 'setTimer').mockImplementation(callback => {
    callback();
    return cancel;
  });
  await expect(clock.sleep(1, new AbortController().signal)).resolves.toBeUndefined();
  expect(cancel).toHaveBeenCalledOnce();
});

it('removes the abort listener after a successful wait', async () => {
  const clock = new MockClock();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const sleeping = clock.sleep(1, controller.signal);
  clock.advance(1);
  await expect(sleeping).resolves.toBeUndefined();
  expect(remove).toHaveBeenCalledOnce();
});

it('owns cancellation that happens while a foreign timer is registering', async () => {
  const clock = new MockClock();
  const controller = new AbortController();
  const cancel = vi.fn();
  vi.spyOn(clock, 'setTimer').mockImplementation(() => {
    controller.abort('stop');
    return cancel;
  });
  await expect(clock.sleep(1, controller.signal)).resolves.toMatchObject({ code: SleepCancelled.code });
  expect(cancel).toHaveBeenCalledOnce();
});

it('supervises abort listener registration and removal faults', async () => {
  const clock = new MockClock();
  const cause = new Error('signal provider failed');
  const registration = new AbortController();
  vi.spyOn(registration.signal, 'addEventListener').mockImplementation(() => {
    throw cause;
  });
  const timer = vi.spyOn(clock, 'setTimer');
  await expect(clock.sleep(1, registration.signal)).resolves.toMatchObject({ code: UnexpectedDefect.code, cause });
  expect(timer).not.toHaveBeenCalled();
  const cleanup = new AbortController();
  vi.spyOn(cleanup.signal, 'removeEventListener').mockImplementation(() => {
    throw cause;
  });
  const sleeping = clock.sleep(1, cleanup.signal);
  clock.advance(1);
  await expect(sleeping).resolves.toMatchObject({ code: UnexpectedDefect.code, cause });
});

it('supervises cleanup faults after synchronous foreign timer completion', async () => {
  const clock = new MockClock();
  const cause = new Error('cleanup failed');
  const cancel = (): void => {
    throw cause;
  };
  vi.spyOn(clock, 'setTimer').mockImplementation(callback => {
    callback();
    return cancel;
  });
  await expect(clock.sleep(1)).resolves.toMatchObject({ code: UnexpectedDefect.code, cause });
});


it.each(['timer', 'listener'] as const)('waits for asynchronous %s cleanup and owns its rejection', async provider => {
  const clock = new MockClock();
  const controller = new AbortController();
  const cause = new Error('async cleanup failed');
  let rejectCleanup: ((reason: unknown) => void) | undefined;
  const cleanup = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
  // Property descriptors model async functions at a JavaScript provider boundary.
  const cancel = () => cleanup;
  const timerProvider = () => cancel;
  if (provider === 'timer') Reflect.set(clock, 'setTimer', timerProvider);
  else Object.defineProperty(controller.signal, 'removeEventListener', { value: cancel });
  let settled = false;
  const sleeping = clock.sleep(1, controller.signal).then(result => { settled = true; return result; });
  controller.abort('stop');
  await Promise.resolve();
  expect(settled).toBe(false);
  if (rejectCleanup === undefined) throw new Error('missing cleanup gate');
  rejectCleanup(cause);
  const result = await sleeping;
  expect(UnexpectedDefect.is(result)).toBe(true);
  expect(result?.cause).toBe(cause);
  expect(JSON.stringify(result)).not.toContain(cause.message);
});

it('owns async cleanup after synchronous foreign completion', async () => {
  const clock = new MockClock();
  const cause = new Error('async cleanup failed');
  const cancel = () => Promise.reject(cause);
  const timerProvider = (callback: () => void) => {
    callback();
    return cancel;
  };
  Reflect.set(clock, 'setTimer', timerProvider);
  const result = await clock.sleep(1);
  expect(UnexpectedDefect.is(result)).toBe(true);
  expect(result?.cause).toBe(cause);
});

it('rejects a malformed promise registration handle without leaking its rejection or hanging', async () => {
  const clock = new MockClock();
  const cause = new Error('async registration failed');
  // Reflect models a JavaScript provider without asserting an invalid TypeScript type.
  Reflect.set(clock, 'setTimer', () => Promise.reject(cause));
  const result = await clock.sleep(1);
  expect(UnexpectedDefect.is(result)).toBe(true);
});


it('owns async listener registration rejection while the timer is pending', async () => {
  const clock = new MockClock();
  const controller = new AbortController();
  const cause = new Error('listener registration rejected');
  const register = () => Promise.reject(cause);
  Object.defineProperty(controller.signal, 'addEventListener', { value: register });
  const result = await clock.sleep(1000, controller.signal);
  expect(UnexpectedDefect.is(result)).toBe(true);
  expect(result?.cause).toBe(cause);
  expect(JSON.stringify(result)).not.toContain(cause.message);
});

it('observes late async listener rejection without changing a completed sleep', async () => {
  const clock = new MockClock();
  const controller = new AbortController();
  const cause = new Error('late listener rejection');
  let rejectRegistration: ((reason: unknown) => void) | undefined;
  const registration = new Promise<void>((_resolve, reject) => { rejectRegistration = reject; });
  const register = () => registration;
  Object.defineProperty(controller.signal, 'addEventListener', { value: register });
  const sleeping = clock.sleep(1, controller.signal);
  clock.advance(1);
  expect(await sleeping).toBeUndefined();
  if (rejectRegistration === undefined) throw new Error('missing registration gate');
  rejectRegistration(cause);
  await Promise.resolve();
  expect(await sleeping).toBeUndefined();
});
