import { UnexpectedDefect, UnexpectedFailure } from '@arki/failure';
import { clockValueSchema } from './schemas.js';
import { z } from 'zod';
import { is } from '@arki/schema';
import { report } from './telemetry.js';

/**
 * The one seam for time and timers. Renewal and deadline timers pass
 * `ref: false` (they must not keep a process alive); a `wait` the caller
 * awaits passes `ref: true` (a CLI waiting for a lock must not exit).
 * Tests inject `manualScheduler()` from `@arki/lock/testing`.
 */

/** Opaque token for a pending timer. */
export type SchedulerHandle = { readonly id: number };

export type Scheduler = {
  /** Milliseconds on a monotonic clock. Only differences mean anything. */
  now(): number;
  /** Run `cb` after `ms`. `ref: true` keeps the process alive where the runtime supports it; default `false`. */
  setTimeout(cb: () => unknown, ms: number, opts?: { readonly ref?: boolean }): SchedulerHandle;
  clearTimeout(handle: SchedulerHandle): void;
};

/** Node and Bun timers have `unref()`; browsers and Deno return a number. */
function unref(timer: unknown): void {
  const timerSchema = z.object({ unref: z.custom<() => void>(value => typeof value === 'function') });
  if (is(timer, timerSchema)) timer.unref();
}

/**
 * The longest delay a runtime timer honours (2^31-1 ms, about 24.8 days).
 * Node and browsers fire anything longer almost at once.
 */
const MAX_TIMER_MS = 2_147_483_647;

function createDefaultScheduler(): Scheduler {
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 0;
  return {
    now: () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
    setTimeout(cb, ms, opts) {
      const id = nextId++;
      // A longer delay runs as a chain of timers under one handle, so it never fires early.
      const arm = (left: number): void => {
        const timer = setTimeout(
          () => {
            if (left > MAX_TIMER_MS) {
              arm(left - MAX_TIMER_MS);
              return;
            }
            pending.delete(id);
            report(cb);
          },
          Math.min(left, MAX_TIMER_MS),
        );
        if (opts?.ref !== true) unref(timer);
        pending.set(id, timer);
      };
      arm(ms);
      return { id };
    },
    clearTimeout(handle) {
      const timer = pending.get(handle.id);
      if (timer === undefined) return;
      pending.delete(handle.id);
      clearTimeout(timer);
    },
  };
}

/** Global timers (unref'd unless `ref: true`) and `performance.now()`. */
export const defaultScheduler: Scheduler = createDefaultScheduler();

const schedulerHandleShape = z.object({ id: z.number().int() });
const schedulerHandleSchema = z.custom<SchedulerHandle>(value => is(value, schedulerHandleShape));

/** A caller-provided synchronous scheduler is a foreign boundary, including rejected invalid returns. */
export function supervisedScheduler(scheduler: Scheduler): Scheduler {
  return {
    now() {
      return readClock(() => scheduler.now());
    },
    setTimeout(callback, ms, options) {
      try {
        const handle = scheduler.setTimeout(callback, ms, options);
        report(() => handle);
        return schedulerHandleSchema.parse(handle);
      } catch (error) { throw new UnexpectedFailure(UnexpectedDefect({ cause: error })); }
    },
    clearTimeout(handle) {
      const result = scheduler.clearTimeout(handle);
      report(() => result);
    },
  };
}

/** The synchronous clock protocol is foreign; preserve rejected/throwing provider defects privately. */
export function readClock(read: Scheduler['now']): number {
  try {
    const value = read();
    report(() => value);
    return clockValueSchema.parse(value);
  } catch (error) {
    throw new UnexpectedFailure(UnexpectedDefect({ cause: error }));
  }
}
