/**
 * Time-source abstraction — the single boundary where
 * "what time is it?" is answered.
 *
 * Inject a `Clock` wherever code needs the current time so tests can swap in
 * `MockClock` and deterministically simulate long waits (cooling windows,
 * delayed gates, daily crons, regime-shift detection).
 */
export type Clock = {
  now(): Date;
};

/**
 * Default production `Clock`, backed by the runtime `Date`.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Controllable `Clock` for tests.
 *
 * Design choices:
 * - `now()` returns a fresh `Date` on every call so callers mutating the
 *   returned value cannot corrupt clock state (`Date` is mutable in JS).
 * - `advance(ms)` moves time forward only; negative or non-finite values
 *   throw `RangeError`. Silent backward drift tends to mask test bugs.
 * - `setNow(date)` sets absolute time and is allowed to go backward — this
 *   is the escape hatch for tests that need to arrange a past scenario.
 */
export class MockClock implements Clock {
  #currentMs: number;

  constructor(initialNow: Date = new Date(0)) {
    this.#currentMs = initialNow.getTime();
  }

  now(): Date {
    return new Date(this.#currentMs);
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(
        `MockClock.advance requires a finite non-negative number of milliseconds, received ${String(ms)}`,
      );
    }
    this.#currentMs += ms;
  }

  setNow(date: Date): void {
    this.#currentMs = date.getTime();
  }
}
