import type { Clock } from '@arki/clock';

import type { Outcome } from './signal.js';
import { abortedError, assertWait, invalidConcurrency, isValidConcurrency, timedOut } from './errors.js';
import { attempt, unwrap } from './signal.js';
import { systemClock } from './system-clock.js';

/** Options of {@link race}; {@link timeout} takes them too. */
export type SignalOptions = {
  /** Aborting it aborts the tasks' signals and rejects with `ARKI_ASYNC_E002`; `cause` is `signal.reason`. */
  readonly signal?: AbortSignal;
};

/** Options of {@link timeout}. */
export type TimeoutOptions = SignalOptions & {
  /** Whose timer measures the deadline. Default: the system clock. Pass a `MockClock` to make tests instant. */
  readonly clock?: Clock;
};

/** Options of {@link all} and {@link mapConcurrent}. */
export type ConcurrencyOptions = SignalOptions & {
  /** Most tasks in flight at once: a positive integer, or `Infinity` (the default) for no limit. Else `ARKI_ASYNC_E005`. */
  readonly concurrency?: number;
};

/**
 * The engine of {@link mapConcurrent} and {@link all}. One shared controller
 * per call: the first failure (or an outer abort) aborts it, so every sibling
 * sees it; nothing new starts; the promise settles only once every started
 * task has settled, so no task outlives the call.
 */
async function pool<I, O>(
  name: string,
  items: Iterable<I>,
  fn: (item: I, signal: AbortSignal, index: number) => Promise<O>,
  options: ConcurrencyOptions,
): Promise<O[]> {
  const { concurrency = Number.POSITIVE_INFINITY, signal: outer } = options;
  if (!isValidConcurrency(concurrency)) throw invalidConcurrency(name, concurrency);
  // Read up front: a lazy iterator could not be closed cleanly mid-failure.
  const pending = [...items].entries();
  if (outer?.aborted) throw abortedError(`${name}()`, outer.reason);

  const outcome = await new Promise<Outcome<O[]>>(resolve => {
    const controller = new AbortController();
    const results: O[] = [];
    let active = 0;
    let exhausted = false;
    let failed = false;
    let failure: unknown;

    function fail(error: unknown): void {
      if (failed) return;
      failed = true;
      failure = error;
      controller.abort(error);
    }

    function onAbort(): void {
      fail(abortedError(`${name}()`, outer?.reason));
      settleIfDone();
    }

    function settleIfDone(): void {
      if (active > 0 || !(failed || exhausted)) return;
      outer?.removeEventListener('abort', onAbort);
      resolve(failed ? { ok: false, error: failure } : { ok: true, value: results });
    }

    // One call per function invocation, never a closure over a loop variable:
    // Hermes (React Native) scopes `const` in a loop body to the function by
    // default, so every closure made in the loop would see the last item.
    function run(index: number, item: I): void {
      active++;
      void attempt(() => fn(item, controller.signal, index))
        .then(
          value => {
            results[index] = value;
          },
          (error: unknown) => {
            fail(error);
          },
        )
        .then(() => {
          active--;
          launch();
        });
    }

    function launch(): void {
      while (!failed && active < concurrency) {
        const step = pending.next();
        if (step.done === true) {
          exhausted = true;
          break;
        }
        run(step.value[0], step.value[1]);
      }
      settleIfDone();
    }

    outer?.addEventListener('abort', onAbort, { once: true });
    launch();
  });
  return unwrap(outcome);
}

/**
 * Maps `items` through `fn` with at most `concurrency` calls in flight, and
 * resolves with the results in input order.
 *
 * Structured: every call gets the same `signal`. On the first rejection that
 * signal aborts (its reason is the error), no further item starts, and the
 * promise waits for the calls already in flight to settle before it rejects
 * with that first error. Aborting `options.signal` does the same and rejects
 * with `ARKI_ASYNC_E002`. On success the signal is left alone, so a result
 * tied to it (a `fetch` response body) stays readable.
 *
 * `items` is read in full before the first call. Never throws synchronously:
 * an invalid `concurrency` (`ARKI_ASYNC_E005`) or an already-aborted signal
 * rejects the returned promise.
 */
export function mapConcurrent<I, O>(
  items: Iterable<I>,
  fn: (item: I, signal: AbortSignal, index: number) => Promise<O>,
  options: ConcurrencyOptions = {},
): Promise<O[]> {
  return pool('mapConcurrent', items, fn, options);
}

/**
 * `Promise.all` for tasks that take an `AbortSignal`, typed per position like
 * `Promise.all`. Same contract as {@link mapConcurrent}: at most `concurrency`
 * in flight, the first rejection aborts the siblings, nothing new starts, and
 * in-flight tasks are awaited before the promise rejects with that error.
 */
export function all<const T extends readonly ((signal: AbortSignal) => Promise<unknown>)[]>(
  tasks: T,
  options?: ConcurrencyOptions,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }>;
export function all(
  tasks: readonly ((signal: AbortSignal) => Promise<unknown>)[],
  options: ConcurrencyOptions = {},
): Promise<unknown[]> {
  return pool('all', tasks, (task, signal) => task(signal), options);
}

/**
 * The first task to FULFILL wins, like `Promise.any`, and unlike
 * `Promise.race`, where the first task to settle (even by rejecting) decides.
 *
 * Each task gets its own signal. When one fulfills, every other task's signal
 * aborts, and the promise waits for those losers to settle before it resolves,
 * so none outlives the call. The winner's signal is never aborted. When every
 * task rejects, the promise rejects with an `AggregateError` of their errors in
 * input order (an empty list rejects the same way). Aborting `options.signal`
 * aborts every task, waits for them, and rejects with `ARKI_ASYNC_E002`.
 */
export async function race<T>(
  tasks: readonly ((signal: AbortSignal) => Promise<T>)[],
  options: SignalOptions = {},
): Promise<T> {
  const { signal: outer } = options;
  if (outer?.aborted) throw abortedError('race()', outer.reason);
  if (tasks.length === 0) throw new AggregateError([], 'race() got no tasks, so none could fulfill');
  const outcome = await new Promise<Outcome<T>>(resolve => {
    const entries = tasks.map(task => ({ task, controller: new AbortController() }));
    const errors: unknown[] = [];
    let remaining = entries.length;
    let winner: { readonly value: T } | undefined;
    let abortFailure: unknown;
    let abortedByOuter = false;

    function onAbort(): void {
      if (winner !== undefined || abortedByOuter) return;
      abortedByOuter = true;
      abortFailure = abortedError('race()', outer?.reason);
      for (const { controller } of entries) controller.abort(outer?.reason);
    }

    function settle(): void {
      if (--remaining > 0) return;
      outer?.removeEventListener('abort', onAbort);
      if (winner !== undefined) resolve({ ok: true, value: winner.value });
      else if (abortedByOuter) resolve({ ok: false, error: abortFailure });
      else resolve({ ok: false, error: new AggregateError(errors, 'race() failed: every task rejected') });
    }

    // One call per function invocation, not a closure over a loop variable: see `run` in `pool`.
    function start(index: number, task: (signal: AbortSignal) => Promise<T>, controller: AbortController): void {
      void attempt(() => task(controller.signal))
        .then(
          value => {
            if (winner !== undefined || abortedByOuter) return;
            winner = { value };
            for (const other of entries) if (other.controller !== controller) other.controller.abort();
          },
          (error: unknown) => {
            errors[index] = error;
          },
        )
        .then(settle);
    }

    outer?.addEventListener('abort', onAbort, { once: true });
    for (const [index, { task, controller }] of entries.entries()) start(index, task, controller);
  });
  return unwrap(outcome);
}

/**
 * Runs `task` with a deadline. At `ms` milliseconds the task's signal aborts
 * (its reason is the error) and the promise rejects at once with
 * `ARKI_ASYNC_E004`.
 *
 * Cancellation is cooperative: `timeout` does not wait for a task that ignores
 * its signal, so such a task may keep running after the rejection. Inside
 * {@link scoped}, pass `scope.signal` as `options.signal`; the scope still
 * owns that work and aborts it when the scope ends. Aborting `options.signal`
 * aborts the task and rejects with `ARKI_ASYNC_E002`. Settling clears the timer
 * and the abort listener. An invalid `ms` rejects with `ARKI_ASYNC_E001`.
 */
export async function timeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms: number,
  options: TimeoutOptions = {},
): Promise<T> {
  assertWait('timeout', 'ms', ms);
  const { signal: outer, clock = systemClock } = options;
  if (outer?.aborted) throw abortedError('timeout()', outer.reason);
  const outcome = await new Promise<Outcome<T>>(resolve => {
    const controller = new AbortController();
    let settled = false;

    /** Marks the call settled once; returns false when it already was. */
    function finish(): boolean {
      if (settled) return false;
      settled = true;
      cancelTimer();
      outer?.removeEventListener('abort', onAbort);
      return true;
    }

    function onAbort(): void {
      if (!finish()) return;
      controller.abort(outer?.reason);
      resolve({ ok: false, error: abortedError('timeout()', outer?.reason) });
    }

    const cancelTimer = clock.setTimer(() => {
      if (!finish()) return;
      const error = timedOut(ms);
      controller.abort(error);
      resolve({ ok: false, error });
    }, ms);
    outer?.addEventListener('abort', onAbort, { once: true });
    void attempt(() => task(controller.signal)).then(
      value => {
        if (finish()) resolve({ ok: true, value });
      },
      (error: unknown) => {
        if (finish()) resolve({ ok: false, error });
      },
    );
  });
  return unwrap(outcome);
}
