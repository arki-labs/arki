/**
 * Milliseconds for measuring durations. `performance.now()` where the runtime has it (a monotonic clock);
 * `Date.now()` where it does not (bare Hermes). Checked at call time, never at import.
 */
export function nowMs(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}
