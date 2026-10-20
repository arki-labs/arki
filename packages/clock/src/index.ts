/** A clock you inject instead of calling `Date` and `setTimeout`: `SystemClock` for production, `MockClock` for tests. */
export { type Clock, MAX_TIMER_MS, MockClock, SystemClock } from './clock.js';
export { CLOCK_ERROR_CODES, ClockError, type ClockErrorCode } from './errors.js';
export { SleepCancelled, SLEEP_FAILURES, type SleepFailure } from './errors.js';
