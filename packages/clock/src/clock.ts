import { UnexpectedDefect } from '@arki/failure';

import type { SleepFailure } from './errors.js';
import { CLOCK_ERROR_CODES, ClockError, SleepCancelled } from './errors.js';

/** The longest delay every runtime's `setTimeout` honors (2^31 - 1 ms, about 24.8 days). */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Time-source abstraction — the single boundary where
 * "what time is it?" and "wake me later" are answered.
 *
 * Inject a `Clock` wherever code needs the current time or a timer, so tests can
 * swap in `MockClock` and run long waits (retry delays, cooling windows, daily
 * crons) instantly and deterministically.
 */
export type Clock = {
  now(): Date;
  /**
   * Calls `callback` once, `ms` milliseconds from now. Returns a function that
   * cancels the timer; calling it after the timer fired does nothing. Throws
   * `ClockError` (`ARKI_CLOCK_E002`) when `ms` is negative, not finite, or above
   * {@link MAX_TIMER_MS}.
   */
  setTimer(callback: () => void, ms: number): () => void;
  /**
   * Resolves `ms` milliseconds from now. Aborting `signal` clears the timer and
   * returns `SleepCancelled` whose private `cause` is `signal.reason`;
   * an already-aborted signal returns it at once. An invalid `ms` rejects with
   * `ClockError` (`ARKI_CLOCK_E002`).
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void | SleepFailure>;
};

function assertDelay(method: string, ms: number): void {
  if (Number.isFinite(ms) && ms >= 0 && ms <= MAX_TIMER_MS) return;
  throw new ClockError(
    CLOCK_ERROR_CODES.invalidDelay,
    `${method} requires a finite delay from 0 to ${String(MAX_TIMER_MS)} milliseconds, received ${String(ms)}`,
    'Pass a finite number of milliseconds that is zero or more and fits in a timer.',
  );
}

/** One `sleep` for every clock, built on its `setTimer`. */
async function sleepOn(clock: Clock, ms: number, signal: AbortSignal | undefined): Promise<void | SleepFailure> {
  // Invalid timer definitions are programmer misuse; operational provider faults below are owned here.
  assertDelay('Clock.sleep', ms);
  return new Promise<void | SleepFailure>(resolve => {
    let cancel: (() => void) | undefined;
    const state = { settled: false, registering: false, pending: false };
    let listenerAttached = false;
    let pendingOutcome: SleepFailure | undefined;
    const finish = (outcome?: SleepFailure): void => {
      if (state.settled) return;
      if (state.registering) {
        if (!state.pending) pendingOutcome = outcome;
        state.pending = true;
        return;
      }
      state.settled = true;
      let result = outcome;
      const pendingCleanup: Promise<void>[] = [];
      const observeCleanup = (cleanup: unknown): void => {
        if (cleanup === undefined) return;
        pendingCleanup.push(Promise.resolve(cleanup).then(
          () => { /* Successful cleanup keeps the current outcome. */ },
          (error: unknown) => { result = UnexpectedDefect({ cause: error }); },
        ));
      };
      try {
        if (listenerAttached) observeCleanup(signal?.removeEventListener('abort', onAbort));
      } catch (error) {
        result = UnexpectedDefect({ cause: error });
      }
      try {
        observeCleanup(cancel?.());
      } catch (error) {
        result = UnexpectedDefect({ cause: error });
      }
      if (pendingCleanup.length === 0) resolve(result);
      else void Promise.all(pendingCleanup).then(() => resolve(result));
    };
    const onAbort = (): void => {
      try {
        finish(SleepCancelled({ cause: signal?.reason }));
      } catch (error) {
        finish(UnexpectedDefect({ cause: error }));
      }
    };
    try {
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (signal !== undefined) {
        listenerAttached = true;
        const registration: unknown = signal.addEventListener('abort', onAbort, { once: true });
        if (registration !== undefined) {
          // A late registration rejection is observed, but cannot undo completed sleep.
          void Promise.resolve(registration).catch((error: unknown) => finish(UnexpectedDefect({ cause: error })));
        }
        if (signal.aborted) onAbort();
      }
      if (state.settled) return;
      state.registering = true;
      const registered = clock.setTimer(() => finish(), ms);
      if (typeof registered !== 'function') {
        // A malformed JS provider may return a rejecting promise instead of a handle.
        void Promise.resolve(registered).catch(() => { /* The invalid handle is reported below. */ });
        throw new TypeError('Clock.setTimer must return a cancellation function');
      }
      cancel = registered;
      state.registering = false;
      // A foreign clock may invoke the callback synchronously before returning its cancellation handle.
      if (state.pending) finish(pendingOutcome);
    } catch (error) {
      state.registering = false;
      finish(UnexpectedDefect({ cause: error }));
    }
  });
}

/**
 * Default production `Clock`, backed by the runtime `Date` and `setTimeout`.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  setTimer(callback: () => void, ms: number): () => void {
    assertDelay('SystemClock.setTimer', ms);
    const id = setTimeout(callback, ms);
    return () => {
      clearTimeout(id);
    };
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void | SleepFailure> {
    return sleepOn(this, ms, signal);
  }
}

/** A timer waiting on a `MockClock`. `order` breaks ties between timers due at the same time. */
type MockTimer = { readonly due: number; readonly order: number; readonly callback: () => void };

/**
 * Controllable `Clock` for tests.
 *
 * Design choices:
 * - `now()` returns a fresh `Date` on every call so callers mutating the
 *   returned value cannot corrupt clock state (`Date` is mutable in JS).
 * - Timers never fire on their own. `advance(ms)` moves time forward and fires
 *   every timer that comes due, in time order, at its own due time.
 * - `advance(ms)` moves time forward only; negative or non-finite values
 *   throw `ClockError` (`ARKI_CLOCK_E001`). Silent backward drift tends to mask test bugs.
 * - `setNow(date)` sets absolute time and is allowed to go backward — this
 *   is the escape hatch for tests that need to arrange a past scenario. It
 *   fires no timers.
 */
export class MockClock implements Clock {
  #currentMs: number;
  #timers: MockTimer[] = [];
  #nextOrder = 0;

  constructor(initialNow: Date = new Date(0)) {
    this.#currentMs = initialNow.getTime();
  }

  now(): Date {
    return new Date(this.#currentMs);
  }

  setTimer(callback: () => void, ms: number): () => void {
    assertDelay('MockClock.setTimer', ms);
    const timer: MockTimer = { due: this.#currentMs + ms, order: this.#nextOrder++, callback };
    this.#timers.push(timer);
    return () => {
      const index = this.#timers.indexOf(timer);
      if (index !== -1) this.#timers.splice(index, 1);
    };
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void | SleepFailure> {
    return sleepOn(this, ms, signal);
  }

  /**
   * Moves time forward by `ms` and fires, in time order, every timer due by
   * then, each at its own due time. A timer that a firing callback sets is
   * fired too when it comes due within the step. Synchronous: code that resumes
   * after an `await` runs only after `advance` returns, so use
   * {@link MockClock.advanceAsync} for timers that async code sets.
   */
  advance(ms: number): void {
    const target = this.#target('advance', ms);
    for (let timer = this.#takeDue(target); timer !== undefined; timer = this.#takeDue(target)) {
      this.#fire(timer);
    }
    this.#currentMs = target;
  }

  /**
   * Like {@link MockClock.advance}, but lets state.pending promise callbacks run
   * before the first timer and after each fired timer. So a timer that async
   * code sets after an `await` (a retry loop's next `sleep`, say) also fires
   * when it comes due within the step. To let them run it waits for one real
   * macrotask (`setTimeout(0)`) each time, so do not combine it with fake timers
   * that replace `setTimeout`.
   */
  async advanceAsync(ms: number): Promise<void> {
    const target = this.#target('advanceAsync', ms);
    await nextMacrotask();
    for (let timer = this.#takeDue(target); timer !== undefined; timer = this.#takeDue(target)) {
      this.#fire(timer);
      await nextMacrotask();
    }
    this.#currentMs = target;
  }

  setNow(date: Date): void {
    this.#currentMs = date.getTime();
  }

  #target(method: string, ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new ClockError(
        CLOCK_ERROR_CODES.invalidAdvance,
        `MockClock.${method} requires a finite non-negative number of milliseconds, received ${String(ms)}`,
        'Pass a finite number of milliseconds that is zero or more. To go back in time, call setNow.',
      );
    }
    return this.#currentMs + ms;
  }

  /** Removes and returns the earliest timer due by `target`, or `undefined` when none is. */
  #takeDue(target: number): MockTimer | undefined {
    let earliest: MockTimer | undefined;
    for (const timer of this.#timers) {
      if (timer.due > target) continue;
      if (
        earliest === undefined ||
        timer.due < earliest.due ||
        (timer.due === earliest.due && timer.order < earliest.order)
      )
        earliest = timer;
    }
    if (earliest !== undefined) this.#timers.splice(this.#timers.indexOf(earliest), 1);
    return earliest;
  }

  #fire(timer: MockTimer): void {
    if (timer.due > this.#currentMs) this.#currentMs = timer.due;
    timer.callback();
  }
}

/** Resolves after one real macrotask, so every state.pending promise callback has run. */
function nextMacrotask(): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}
