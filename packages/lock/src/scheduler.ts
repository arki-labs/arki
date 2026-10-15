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
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
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
            void cb();
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
