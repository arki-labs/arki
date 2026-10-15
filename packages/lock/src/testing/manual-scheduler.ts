/**
 * A scheduler you drive by hand. It is the one seam for time and timers, so a
 * test moves the clock with `advance` and nothing else moves it.
 * An instance you do not advance is a paused process: its timers never fire.
 */
import type { Scheduler } from '../scheduler.js';
import type { Duration } from '../types.js';
import { parseDuration } from '../wait.js';

export type ManualScheduler = Scheduler & {
  /**
   * Move the clock forward. Fires every timer due on the way, in order, each
   * at its own time. Awaits a promise a callback returns (a renewal in flight),
   * then lets pending microtasks settle. The target is fixed when you call it.
   * Do not await it when a callback hangs on purpose.
   */
  advance(duration: Duration): Promise<void>;
  /** How many timers are waiting to fire. */
  readonly pendingTimers: number;
};

type Timer = { readonly at: number; readonly cb: () => unknown };

async function settle(): Promise<void> {
  for (let tick = 0; tick < 200; tick++) await Promise.resolve();
}

/** `ref` is accepted and ignored: nothing here keeps a process alive. */
export function manualScheduler(start = 0): ManualScheduler {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, Timer>();

  /** The earliest timer due by `target`; ties go to the one set first. */
  function nextDue(target: number): { id: number; timer: Timer } | undefined {
    let found: { id: number; timer: Timer } | undefined;
    for (const [id, timer] of timers) {
      if (timer.at > target) continue;
      if (found === undefined || timer.at < found.timer.at) found = { id, timer };
    }
    return found;
  }

  return {
    now: () => now,
    setTimeout(cb, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), cb });
      return { id };
    },
    clearTimeout(handle) {
      timers.delete(handle.id);
    },
    get pendingTimers() {
      return timers.size;
    },
    async advance(duration) {
      const target = now + parseDuration(duration);
      for (;;) {
        await settle();
        const due = nextDue(target);
        if (due === undefined) break;
        timers.delete(due.id);
        now = Math.max(now, due.timer.at);
        await due.timer.cb();
      }
      await settle();
      now = Math.max(now, target);
    },
  };
}
