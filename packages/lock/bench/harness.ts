// Shared checks for the @arki/lock benchmarks.
//
// Every library, ours or a competitor's, is wrapped as a `Runner`: "take the lock
// on this name, run this section, give the lock back". The section is the same
// for everyone. It counts how many callers are inside at once (`maxActive`).
// The contract of every group is built from three checks that run before timing:
//   1. the run itself: every caller finished, and never more than `limit` were inside;
//   2. an exclusion probe: a fresh key, many callers, a 3 ms section, so a lock that
//      grants twice has time to be caught (the timed sections are too short for that);
//   3. the backend is clean: Redis keys, advisory locks, lease rows or lock files left behind.

import { randomUUID } from 'node:crypto';

/** Takes the lock on `name` (waiting if held), runs `section`, gives the lock back. */
export type Runner = (name: string, section: () => Promise<void>) => Promise<void>;

/** Reads the backend directly, never through the library under test. */
export type Backend = {
  /** What is still held or left over for this exact name. Empty = clean. */
  problems(name: string): Promise<readonly string[]>;
  /** The longest time-to-live (ms) the backend shows for this name right now. Lease stores only. */
  ttlMs?(name: string): Promise<number>;
  /** Is the lock really held right now, read from the backend and not asked of the library? Called inside the probe's section. */
  held?(name: string): Promise<boolean>;
  /** Checks everything under `prefix` (and the `recent` names used), then removes what the run left, so the next case starts clean. */
  sweep(prefix: string, recent: readonly string[]): Promise<readonly string[]>;
};

export type Impl = {
  readonly runner: Runner;
  readonly backend: Backend;
  /** 1 for a mutex, the permit count for a semaphore. */
  readonly limit: number;
  /** `true` for a `tryRun`: a caller that finds the lock held skips its section. At least one caller must still run. */
  readonly mayskip?: boolean;
  /** Closes what `setup` opened (connections, store). */
  dispose(): Promise<void>;
};

export type Meter = {
  active: number;
  max: number;
  done: number;
  /** Caller indexes in the order they entered. Only when tracing. */
  readonly order: number[];
  /** `performance.now()` at entry and at the moment before release. Only when tracing. */
  readonly enters: number[];
  readonly exits: number[];
  readonly trace: boolean;
};

export function createMeter(trace: boolean): Meter {
  return { active: 0, max: 0, done: 0, order: [], enters: [], exits: [], trace };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** The critical section: count who is inside. `holdMs` 0 yields once; more sleeps. */
export async function inside(
  meter: Meter,
  index: number,
  holdMs: number,
  onInside?: () => Promise<void>,
): Promise<void> {
  meter.active += 1;
  if (meter.active > meter.max) meter.max = meter.active;
  if (meter.trace) {
    meter.order.push(index);
    meter.enters.push(performance.now());
  }
  try {
    await (holdMs > 0 ? sleep(holdMs) : Promise.resolve());
    if (onInside !== undefined) await onInside();
  } finally {
    meter.active -= 1;
    meter.done += 1;
    if (meter.trace) meter.exits.push(performance.now());
  }
}

/** Waits `ms` and tries again until `attempt` says it got the lock. For raw baselines that have no wake-up. */
export async function spin(attempt: () => Promise<boolean>, retryMs: number): Promise<void> {
  while (!(await attempt())) await sleep(retryMs);
}

/** The probe: many callers on one fresh key, each holding 3 ms. Returns what went wrong. */
export async function exclusionProbe(impl: Impl, prefix: string): Promise<readonly string[]> {
  const callers = impl.limit === 1 ? 12 : impl.limit * 3;
  const name = `${prefix}:probe-${randomUUID()}`;
  const meter = createMeter(false);
  let ttlSeen = 0;
  let notHeld = 0;
  const { backend } = impl;
  await Promise.all(
    Array.from({ length: callers }, (_, index) =>
      impl.runner(name, () =>
        inside(meter, index, 3, async () => {
          if (backend.ttlMs !== undefined) ttlSeen = Math.max(ttlSeen, await backend.ttlMs(name));
          if (backend.held !== undefined && !(await backend.held(name))) notHeld += 1;
        }),
      ),
    ),
  );
  const problems: string[] = [];
  if (meter.max > impl.limit) problems.push(`probe: ${meter.max} callers inside at once, limit is ${impl.limit}`);
  if (impl.limit > 1 && meter.max < impl.limit)
    problems.push(`probe: only ${meter.max} callers were ever inside, the limit is ${impl.limit}`);
  if (impl.mayskip === true ? meter.done < 1 : meter.done !== callers)
    problems.push(`probe: ${meter.done} of ${callers} callers ran`);
  if (notHeld > 0) problems.push(`probe: the backend did not show the lock held in ${notHeld} sections`);
  if (backend.ttlMs !== undefined && ttlSeen <= 0) problems.push('probe: no time-to-live above 0 was seen while held');
  problems.push(...(await impl.backend.problems(name)));
  return problems;
}

/** What one timed run hands to `normalize`. */
export type Outcome = {
  readonly callers: number;
  readonly done: number;
  readonly max: number;
  readonly limit: number;
  /** `true`/`false` when order was traced, `undefined` when it was not asked for. */
  readonly fifo: boolean | undefined;
  readonly name: string;
  readonly mayskip: boolean;
  readonly meter: Meter;
  /** Untimed checks: the exclusion probe and the backend. */
  verify(): Promise<readonly string[]>;
};

/** The per-case state: the implementation, a unique prefix, and the watermark over every timed run. */
export type ImplState = {
  readonly impl: Impl;
  readonly prefix: string;
  max: number;
  /** The last names used, so the final sweep can look at them directly. */
  readonly recent: string[];
};

export function newState(impl: Impl): ImplState {
  return { impl, prefix: `bench-${randomUUID()}`, max: 0, recent: [] };
}

export type RunOptions = { readonly trace?: boolean };

/** Starts `callers` callers in order on one fresh key and waits for all of them. */
export async function runConcurrent(state: ImplState, callers: number, options: RunOptions = {}): Promise<Outcome> {
  const trace = options.trace === true;
  const name = `${state.prefix}:${randomUUID()}`;
  const meter = createMeter(trace);
  remember(state, name);
  await Promise.all(
    Array.from({ length: callers }, (_, index) => state.impl.runner(name, () => inside(meter, index, 0))),
  );
  if (meter.max > state.max) state.max = meter.max;
  return outcomeOf(state, name, callers, meter);
}

/** One caller after another on keys from `names`, cycling. For the uncontended groups. */
export async function runSequential(
  state: ImplState,
  names: readonly string[],
  cursor: { next: number },
): Promise<Outcome> {
  const name = names[cursor.next % names.length] ?? '';
  cursor.next += 1;
  remember(state, name);
  const meter = createMeter(false);
  await state.impl.runner(name, () => inside(meter, 0, 0));
  if (meter.max > state.max) state.max = meter.max;
  return outcomeOf(state, name, 1, meter);
}

function remember(state: ImplState, name: string): void {
  state.recent.push(name);
  if (state.recent.length > 256) state.recent.shift();
}

function outcomeOf(state: ImplState, name: string, callers: number, meter: Meter): Outcome {
  const fifo = meter.trace ? meter.order.every((value, position) => value === position) : undefined;
  return {
    callers,
    done: meter.done,
    max: meter.max,
    limit: state.impl.limit,
    fifo,
    name,
    mayskip: state.impl.mayskip === true,
    meter,
    verify: async () => [
      ...(await exclusionProbe(state.impl, state.prefix)),
      ...(await state.impl.backend.problems(name)),
    ],
  };
}

export type Expectation = { readonly fifo?: boolean };

/** The normalized value a case must return. Equal to `expectedFor(callers)` when every check passed. */
export async function judge(outcome: Outcome, expectation: Expectation = {}): Promise<string> {
  const problems: string[] = [];
  if (outcome.max > outcome.limit) problems.push(`${outcome.max} callers inside at once, limit is ${outcome.limit}`);
  if (outcome.mayskip ? outcome.done < 1 : outcome.done !== outcome.callers)
    problems.push(`${outcome.done} of ${outcome.callers} callers ran`);
  if (expectation.fifo === true && outcome.fifo === false) problems.push('callers did not enter in call order');
  problems.push(...(await outcome.verify()));
  return problems.length === 0 ? expectedFor(outcome.callers) : `FAILED: ${problems.join('; ')}`;
}

export const expectedFor = (callers: number): string => `ok callers=${callers}`;

/** Teardown: the watermark over every timed run, the backend sweep, then close. Throws on the first problem. */
export async function finish(state: ImplState): Promise<void> {
  const problems: string[] = [];
  if (state.max > state.impl.limit)
    problems.push(`${state.max} callers were inside at once, limit is ${state.impl.limit}`);
  try {
    problems.push(...(await state.impl.backend.sweep(state.prefix, state.recent)));
  } finally {
    await state.impl.dispose();
  }
  if (problems.length > 0) throw new Error(`contract broken after timing: ${problems.join('; ')}`);
}

/** The p-th percentile (0-1) of a list, by rank. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = Float64Array.from(values).toSorted();
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? Number.NaN;
}

/** Release-to-next-acquire gaps of one traced run, in ms. Entries are in the order callers entered. */
export function handoffGaps(meter: Meter): readonly number[] {
  const gaps: number[] = [];
  for (let index = 1; index < meter.enters.length; index += 1) {
    const enter = meter.enters[index];
    const previousExit = meter.exits[index - 1];
    if (enter !== undefined && previousExit !== undefined) gaps.push(enter - previousExit);
  }
  return gaps;
}
