import type { Clock } from '../src/index.js';

// #region cooldown-gate
/** Lets one action through per window, for example one password-reset email per 15 minutes. */
export function createCooldownGate(clock: Clock, windowMs: number) {
  const lastAllowed = new Map<string, number>();
  return {
    /** True when the key may act now. A true answer starts a new window for that key. */
    tryAcquire(key: string): boolean {
      const now = clock.now().getTime();
      const last = lastAllowed.get(key);
      if (last !== undefined && now - last < windowMs) return false;
      lastAllowed.set(key, now);
      return true;
    },
  };
}
// #endregion
