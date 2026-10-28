import type { Clock } from '@arki/clock';
import type { FailureOf } from '@arki/failure';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import { assertWait, Cancelled, Deadline, invalidConcurrency, isValidConcurrency } from './errors.js';
import { operationTelemetry } from './operation-telemetry.js';
import { sleep } from './sleep.js';
import { watchSignal } from './watch-signal.js';

/** Cancellation for concurrency operations. */
export type SignalOptions = { readonly signal?: AbortSignal };
/** Deadline timer configuration. */
export type TimeoutOptions = SignalOptions & { readonly clock?: Clock };
/** Admission limit for ordered concurrent work. */
export type ConcurrencyOptions = SignalOptions & { readonly concurrency?: number };

async function pool<I, O>(
  name: string,
  items: Iterable<I>,
  fn: (item: I, signal: AbortSignal, index: number) => Promise<O>,
  options: ConcurrencyOptions,
) {
  const { concurrency = Number.POSITIVE_INFINITY, signal } = options;
  if (!isValidConcurrency(concurrency)) throw invalidConcurrency(name, concurrency);
  const telemetry = operationTelemetry(`async.${name}`);
  const controller = new AbortController();
  let cancelled: ReturnType<typeof Cancelled> | undefined;
  let defect: ReturnType<typeof UnexpectedDefect> | undefined;
  const results: O[] = [];
  const stopped = () => cancelled !== undefined || defect !== undefined;
  const fail = (failure: ReturnType<typeof UnexpectedDefect>) => {
    defect ??= failure;
    controller.abort(failure);
  };
  const unwatch = watchSignal(
    signal,
    reason => {
      if (stopped()) return;
      cancelled = Cancelled({ cause: reason });
      controller.abort(cancelled);
    },
    fail,
  );
  try {
    if (!stopped()) {
      // Materialize before admission: iterator defects cannot orphan started work.
      const pending = [...items];
      const next = pending.entries();
      const worker = async () => {
        while (!stopped()) {
          const step = next.next();
          if (step.done) return;
          const [index, item] = step.value;
          try {
            results[index] = await telemetry.run(() => fn(item, controller.signal, index));
          } catch (error) {
            fail(UnexpectedDefect.is(error) ? error : UnexpectedDefect({ cause: error }));
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
    }
  } catch (error) {
    fail(UnexpectedDefect.is(error) ? error : UnexpectedDefect({ cause: error }));
  }
  const cleanup = await unwatch();
  if (cleanup !== undefined) defect = cleanup;
  const outcome = defect ?? cancelled ?? results;
  telemetry.end(outcome);
  return outcome;
}

/** Ordered concurrent mapping. Fulfilled Failure values remain explicit result elements. Started work is joined. */
export function mapConcurrent<
  Item,
  Mapper extends (item: Item, signal: AbortSignal, index: number) => Promise<unknown>,
>(
  items: Iterable<Item>,
  fn: Mapper,
  options?: ConcurrencyOptions,
): Promise<Awaited<ReturnType<Mapper>>[] | FailureOf<typeof pool>>;
export function mapConcurrent<Item>(
  items: Iterable<Item>,
  fn: (item: Item, signal: AbortSignal, index: number) => Promise<unknown>,
  options: ConcurrencyOptions = {},
) {
  return pool('mapConcurrent', items, fn, options);
}

/** Per-position Promise values, with owned cancellation and callback defects returned separately. */
export function all<const Tasks extends readonly ((signal: AbortSignal) => Promise<unknown>)[]>(
  tasks: Tasks,
  options?: ConcurrencyOptions,
): Promise<{ -readonly [Key in keyof Tasks]: Awaited<ReturnType<Tasks[Key]>> } | FailureOf<typeof pool>>;
export function all(tasks: readonly ((signal: AbortSignal) => Promise<unknown>)[], options: ConcurrencyOptions = {}) {
  return pool('all', tasks, (task, signal) => task(signal), options);
}

/** First fulfilled Promise value wins; losing tasks are cancelled and joined. An empty race is static misuse. */
export function race<const Tasks extends readonly ((signal: AbortSignal) => Promise<unknown>)[]>(
  tasks: Tasks,
  options?: SignalOptions,
): Promise<Awaited<ReturnType<Tasks[number]>> | FailureOf<typeof raceRuntime>>;
export async function race(tasks: readonly ((signal: AbortSignal) => Promise<unknown>)[], options: SignalOptions = {}) {
  const outcome = await raceRuntime(tasks, options);
  return isFailure(outcome) ? outcome : outcome?.value;
}
async function raceRuntime(tasks: readonly ((signal: AbortSignal) => Promise<unknown>)[], options: SignalOptions) {
  if (tasks.length === 0) throw new AggregateError([], 'race() requires at least one task');
  const telemetry = operationTelemetry('async.race');
  const entries = tasks.map(task => ({ task, controller: new AbortController() }));
  const errors: unknown[] = [];
  let winner: { value: unknown } | undefined;
  let cancelled: ReturnType<typeof Cancelled> | undefined;
  let defect: ReturnType<typeof UnexpectedDefect> | undefined;
  const stop = () => {
    for (const entry of entries) entry.controller.abort(cancelled ?? defect);
  };
  const unwatch = watchSignal(
    options.signal,
    reason => {
      if (winner !== undefined || cancelled !== undefined || defect !== undefined) return;
      cancelled = Cancelled({ cause: reason });
      stop();
    },
    failure => {
      defect = failure;
      stop();
    },
  );
  if (cancelled === undefined && defect === undefined) {
    await Promise.all(
      entries.map(async ({ task, controller }, index) => {
        try {
          const value = await telemetry.run(() => task(controller.signal));
          if (winner === undefined && cancelled === undefined && defect === undefined) {
            winner = { value };
            for (const other of entries) if (other.controller !== controller) other.controller.abort();
          }
        } catch (error) {
          errors[index] = error;
        }
      }),
    );
  }
  const cleanup = await unwatch();
  if (cleanup !== undefined) defect = cleanup;
  if (winner === undefined && cancelled === undefined && defect === undefined)
    defect = UnexpectedDefect({ cause: new AggregateError(errors, 'Every race task rejected') });
  const outcome = defect ?? cancelled ?? winner ?? UnexpectedDefect({ cause: new Error('Race lost its outcome') });
  telemetry.end(isFailure(outcome) ? outcome : outcome?.value);
  return outcome;
}

/** Returns the task value or an owned deadline/cancellation/defect. Uncooperative late task settlement is observed. */
export function timeout<Task extends (signal: AbortSignal) => Promise<unknown>>(
  task: Task,
  ms: number,
  options?: TimeoutOptions,
): Promise<Awaited<ReturnType<Task>> | FailureOf<typeof timeoutRuntime>>;
export async function timeout(
  task: (signal: AbortSignal) => Promise<unknown>,
  ms: number,
  options: TimeoutOptions = {},
) {
  const outcome = await timeoutRuntime(task, ms, options);
  return isFailure(outcome) ? outcome : outcome.value;
}
async function timeoutRuntime<T>(task: (signal: AbortSignal) => Promise<T>, ms: number, options: TimeoutOptions) {
  assertWait('timeout', 'ms', ms);
  const telemetry = operationTelemetry('async.timeout');
  const controller = new AbortController();
  const timer = new AbortController();
  let result: { value: T } | undefined;
  let cancelled: ReturnType<typeof Cancelled> | undefined;
  let deadline: ReturnType<typeof Deadline> | undefined;
  let defect: ReturnType<typeof UnexpectedDefect> | undefined;
  let settled = false;
  let resolveCompletion: () => void;
  const completion = new Promise<void>(resolve => {
    resolveCompletion = resolve;
  });
  const finish = () => {
    if (settled) return false;
    settled = true;
    resolveCompletion();
    return true;
  };
  const unwatch = watchSignal(
    options.signal,
    reason => {
      if (!finish()) return;
      cancelled = Cancelled({ cause: reason });
      controller.abort(cancelled);
    },
    failure => {
      if (!finish()) return;
      defect = failure;
      controller.abort(failure);
    },
  );
  let timing: Promise<void> | undefined;
  if (!settled) {
    timing = sleep(ms, { clock: options.clock, signal: timer.signal }).then(outcome => {
      if (timer.signal.aborted) {
        if (UnexpectedDefect.is(outcome)) defect = outcome;
        return;
      }
      if (!finish()) return;
      if (UnexpectedDefect.is(outcome)) defect = outcome;
      else if (Cancelled.is(outcome)) cancelled = outcome;
      else deadline = Deadline();
      controller.abort(defect ?? cancelled ?? deadline);
    });
    if (!settled)
      void (async () => {
        try {
          const value = await telemetry.run(() => task(controller.signal));
          if (finish()) result = { value };
        } catch (error) {
          if (finish()) defect = UnexpectedDefect.is(error) ? error : UnexpectedDefect({ cause: error });
        }
      })();
  }
  await completion;
  timer.abort();
  await timing;
  const cleanup = await unwatch();
  if (cleanup !== undefined) defect = cleanup;
  const outcome =
    defect ?? cancelled ?? deadline ?? result ?? UnexpectedDefect({ cause: new Error('Timeout lost its outcome') });
  telemetry.end(isFailure(outcome) ? outcome : outcome.value);
  return outcome;
}
