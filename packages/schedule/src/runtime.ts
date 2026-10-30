import { Cron } from 'croner';
import { z } from 'zod';

import type { Failure, FailureIn } from '@arki/failure';
import { isFailure, UnexpectedDefect } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { SCHEDULE_RUNTIME_FAILURES } from './errors.js';
import type { ScheduleDef, ScheduleLock } from './index.js';
import {
  lockCodeSchema,
  SCHEDULE_ERROR_CODES,
  ScheduleDurableStartFailed,
  ScheduleError,
  ScheduleLockFailed,
} from './errors.js';
import { DEFAULT_LOCK_HOLD_MS, parseEveryInterval } from './index.js';
import { observe, observeSchedule } from './telemetry.js';

const debugSchedule = getLogger('arki:schedule');
const log = getLogger('arki:schedule');

type TimerHandle = ReturnType<typeof setTimeout>;
type UnrefHandle = { unref(): void };

/**
 * One durable schedule handed to a {@link DurableScheduler}. Exactly one of
 * `cron` or `everyMs` is set. `run` executes the handler with the schedule's
 * context and resolves the same result `trigger` reports.
 */
export type DurableScheduleRegistration =
  | {
      readonly name: string;
      readonly cron: string;
      readonly timezone?: string;
      readonly run: () => Promise<ScheduleRunResult>;
    }
  | {
      readonly name: string;
      readonly everyMs: number;
      readonly run: () => Promise<ScheduleRunResult>;
    };

/**
 * The port a durable backend implements (`@arki/queue` ships the BullMQ one).
 * `start` registers every durable schedule and begins running them; `stop`
 * stops running them and must be safe to call more than once.
 */
export type DurableScheduler = {
  readonly start: (schedules: readonly DurableScheduleRegistration[]) => Promise<void>;
  readonly stop: () => Promise<void>;
};

/**
 * Who fires the schedules. `internal` (default): in-process timers, plus the
 * durable backend for `durable: true` schedules. `host`: nothing fires on its
 * own — the host (a platform cron, an HTTP endpoint) calls `trigger`.
 */
export type ScheduleClock = 'internal' | 'host';

type ScheduleRuntimeBaseOptions<TContext> = {
  readonly schedules: readonly ScheduleDef<TContext>[];
  readonly jitterMs?: number;
  /** Backend for schedules declared with `durable: true`. Required when any exists. */
  readonly durable?: DurableScheduler;
  /** Default `'internal'`. `'host'` arms no timers and allows no durable schedule or backend. */
  readonly clock?: ScheduleClock;
};

type ScheduleRuntimeContextOptions<TContext> =
  | {
      readonly createContext: () => TContext | Promise<TContext>;
    }
  | ([TContext] extends [undefined]
      ? {
          readonly createContext?: () => TContext | Promise<TContext>;
        }
      : never);

export type ScheduleRuntimeOptions<TContext = undefined> = ScheduleRuntimeBaseOptions<TContext> &
  ScheduleRuntimeContextOptions<TContext>;

/**
 * What one run reports. `ran` keeps the handler's resolved value; a failure
 * keeps its cause; `unavailable` means the runtime was already stopped.
 */
export type ScheduleRefusal<T> = Exclude<FailureIn<T>, ReturnType<typeof UnexpectedDefect>>;

export type ScheduleRunResult<T = unknown> =
  | { readonly name: string; readonly status: 'ran'; readonly value: Exclude<T, Failure> }
  | { readonly name: string; readonly status: 'refused'; readonly failure: ScheduleRefusal<T> }
  | { readonly name: string; readonly status: 'skipped-overlap' | 'skipped-lock' }
  | { readonly name: string; readonly status: 'handler-failed'; readonly cause: ReturnType<typeof UnexpectedDefect> }
  | {
      readonly name: string;
      readonly status: 'lock-failed';
      readonly cause: ReturnType<(typeof SCHEDULE_RUNTIME_FAILURES)[keyof typeof SCHEDULE_RUNTIME_FAILURES]>;
    }
  | { readonly name: string; readonly status: 'unavailable' };

/** A run result, or `unknown` when no schedule has that name (the `scheduler` service's `trigger`). */
export type ScheduleOutcome<T> = ScheduleRunResult<T> | { readonly name: string; readonly status: 'unknown' };

export type ScheduleRunStatus = ScheduleRunResult['status'];

/** A named definition is the sole source of its resolved handler result. */
type RuntimeValueOf<
  TDefinitions extends readonly ScheduleDef<never>[],
  TName extends string,
> = TDefinitions[number] extends infer TDefinition
  ? TDefinition extends ScheduleDef<never>
    ? TName extends TDefinition['name']
      ? Awaited<ReturnType<TDefinition['handler']>>
      : never
    : never
  : never;

export type ScheduleRuntime<TDefinitions extends readonly ScheduleDef<never>[] = readonly ScheduleDef<never>[]> = {
  /**
   * Arm the in-process timers, then register the durable schedules. Resolves
   * `schedule.durable_start_failed` when the durable backend refuses, so the
   * caller (the Dot `start` hook) fails at start instead of running without
   * its durable schedules. In-process timers are armed before the first await.
   */
  start(): Promise<ReturnType<typeof ScheduleDurableStartFailed> | undefined>;
  /** Stop firing, refuse new triggers (`unavailable`) and wait for accepted runs to finish. */
  stop(): Promise<void>;
  /** Returned business refusals and supervised handler defects. Scheduling skips do not increment this. */
  readonly handlerFailures: number;
  /** Runs skipped because another holder had the lock (`skipped-lock`). */
  readonly lockContention: number;
  /** Runs that never started: the lock store failed taking the lock. */
  readonly lockFailures: number;
  /**
   * Runs whose lock was lost during the run or the hold. Lost while the
   * handler ran: `lock-failed`. Lost after it finished, during the hold: the
   * handler's outcome stands.
   */
  readonly lockLost: number;
  // A failed release is not counted here: `createLocks` logs it and counts it
  // in its own `Locks.counters.releaseErrors` (and calls `onReleaseError`).
} & (string extends TDefinitions[number]['name']
  ? { trigger(name: string): Promise<ScheduleRunResult> }
  : {
      /** Runs before start, refuses after stop, and rejects undeclared names at compile time. */
      trigger<TName extends TDefinitions[number]['name']>(
        name: TName,
      ): Promise<ScheduleRunResult<RuntimeValueOf<TDefinitions, TName>>>;
    });

/** A `LockError`-like failure: only its string `code` is read, without importing the lock library. */
const lockErrorSchema = z.object({ code: z.string() });

/** The `code` of a `LockError`-like failure, or `undefined` when the value has none. */
function lockErrorCode(error: unknown): string | undefined {
  const parsed = lockErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}

function hasUnref(value: TimerHandle): value is TimerHandle & UnrefHandle {
  return 'unref' in value;
}

function unref(timer: TimerHandle): void {
  if (hasUnref(timer)) timer.unref();
}

function randomDelay(max: number): number {
  if (max <= 0) return 0;
  return Math.floor(Math.random() * (max + 1));
}

/** What `start()` resolves when there is nothing to report. */
// eslint-disable-next-line unicorn/no-useless-undefined -- the resolved value is the `undefined` half of start()'s result type
const STARTED_CLEAN: Promise<undefined> = Promise.resolve(undefined);

function ignorePromiseSettlement(): void {
  return;
}

function assertUniqueSchedules<TContext>(schedules: readonly ScheduleDef<TContext>[]): void {
  const seen = new Set<string>();
  for (const schedule of schedules) {
    if (seen.has(schedule.name)) {
      throw new ScheduleError({
        code: SCHEDULE_ERROR_CODES.duplicateSchedule,
        message: `[schedule] schedule "${schedule.name}" is declared more than once.`,
        remediation: 'Schedule names must be unique within one schedule(...) plugin.',
      });
    }
    seen.add(schedule.name);
  }
}

/**
 * A durable schedule needs a durable backend. Thrown at Dot boot by the
 * `schedule()` plugin and at `start()` by a bare runtime.
 */
export function assertDurableBackend<TContext>(
  schedules: readonly ScheduleDef<TContext>[],
  durable: DurableScheduler | undefined,
): void {
  if (durable !== undefined) return;
  const first = schedules.find(schedule => schedule.durable);
  if (first === undefined) return;
  throw new ScheduleError({
    code: SCHEDULE_ERROR_CODES.durableBackendMissing,
    message: `[schedule] schedule "${first.name}" is durable, but no durable backend is available.`,
    remediation:
      'Mount durableScheduler({ connection }) from @arki/queue/dot before schedule(...) and pass durable: DurableSchedules to schedule(...), or drop durable: true from the schedule.',
  });
}

/**
 * A host clock and a durable backend would both fire the same schedule.
 * Thrown at Dot boot by the `schedule()` plugin and at construction by a
 * bare runtime.
 */
export function assertSingleClock<TContext>(
  schedules: readonly ScheduleDef<TContext>[],
  durable: DurableScheduler | undefined,
  clock: ScheduleClock,
): void {
  if (clock !== 'host') return;
  const first = schedules.find(schedule => schedule.durable);
  if (first === undefined && durable === undefined) return;
  throw new ScheduleError({
    code: SCHEDULE_ERROR_CODES.durableWithHostClock,
    message:
      first === undefined
        ? `[schedule] clock: 'host' was given a durable backend; the host and the backend would both fire schedules.`
        : `[schedule] schedule "${first.name}" is durable, but clock: 'host' lets only the host fire schedules.`,
    remediation:
      "With clock: 'host', drop durable: true from every schedule and do not pass a durable backend. Use the internal clock to run durable schedules.",
  });
}

export function createScheduleRuntime<const TDefinitions extends readonly ScheduleDef<undefined>[]>(
  options: ScheduleRuntimeOptions<undefined> & { readonly schedules: TDefinitions },
): ScheduleRuntime<TDefinitions>;
export function createScheduleRuntime<
  TContext,
  const TDefinitions extends readonly ScheduleDef<TContext>[] = readonly ScheduleDef<TContext>[],
>(options: ScheduleRuntimeOptions<TContext> & { readonly schedules: TDefinitions }): ScheduleRuntime<TDefinitions>;
export function createScheduleRuntime<TContext>(options: ScheduleRuntimeOptions<TContext>): ScheduleRuntime {
  assertUniqueSchedules(options.schedules);
  const clock = options.clock ?? 'internal';
  assertSingleClock(options.schedules, options.durable, clock);

  const byName = new Map(options.schedules.map(schedule => [schedule.name, schedule]));
  const running = new Map<string, number>();
  const cronJobs: Cron[] = [];
  const timers: TimerHandle[] = [];
  const inflight = new Set<Promise<void>>();
  let stopped = false;
  let handlerFailures = 0;
  let lockContention = 0;
  let lockFailures = 0;
  let lockLost = 0;
  let durableStarted = false;

  /**
   * A schedule with its own lock (`lock:` in `schedules(core, …)`): the lock
   * is held for the whole handler, however long it runs, and for at least
   * `holdAtLeastMs` (the store releases only after that). `tryRun` resolves
   * after the release, so this run, and a shutdown drain waiting on it, end
   * only then.
   */
  async function runExclusive(
    schedule: ScheduleDef<TContext>,
    lock: NonNullable<ScheduleDef<TContext>['lock']>,
  ): Promise<ScheduleRunResult> {
    // Set once the handler has finished: from then on its outcome stands, even if the lock is lost in the hold.
    let finished: ScheduleRunResult | undefined;
    try {
      const locked = await lock.locks.mutex(lock.key).tryRun(
        async held => {
          finished = await runHandler(schedule, held);
          return finished;
        },
        { holdAtLeast: lock.holdAtLeastMs ?? DEFAULT_LOCK_HOLD_MS },
      );
      if (!isFailure(locked)) return locked;
      // Only explicit contention may skip work. Store failure and lost ownership are never busy.
      if (locked.code !== 'lock.held') {
        if (locked.code === 'lock.lost' && finished !== undefined) { lockLost += 1; return finished; }
        if (locked.code === 'lock.lost') lockLost += 1;
        else lockFailures += 1;
        const parsed = lockCodeSchema.safeParse(locked.code.startsWith('lock.') ? locked.code.slice(5) : undefined);
        const cause = UnexpectedDefect.is(locked) ? locked : parsed.success
          ? ScheduleLockFailed({ lockCode: parsed.data }, { cause: locked })
          : UnexpectedDefect({ cause: locked });
        return { name: schedule.name, status: 'lock-failed', cause };
      }
      lockContention += 1;
      observe(() =>
        debugSchedule.debug('[{scheduleName}] lock {lockKey} is held elsewhere; skipped', {
          scheduleName: schedule.name,
          lockKey: lock.key,
        }),
      );
      return { name: schedule.name, status: 'skipped-lock' };
    } catch (error) {
      // runHandler reports handler errors as `handler-failed` and never throws,
      // so whatever lands here came from taking, keeping or releasing the lock.
      const code = observe(() => lockErrorCode(error));
      if (code === 'lost' && finished !== undefined) {
        lockLost += 1;
        observe(() =>
          log.warn('lock lost during the hold — another replica may run this tick', {
            schedule: schedule.name,
            lock: lock.key,
          }),
        );
        return finished;
      }
      if (code === 'lost') lockLost += 1;
      else lockFailures += 1;
      const lockCode = lockCodeSchema.safeParse(code);
      const cause = lockCode.success
        ? ScheduleLockFailed({ lockCode: lockCode.data }, { cause: error })
        : UnexpectedDefect({ cause: error });
      observe(() => log.error('schedule lock failed', { schedule: schedule.name, code: cause.code }));
      return { name: schedule.name, status: 'lock-failed', cause };
    }
  }

  function run(schedule: ScheduleDef<TContext>): Promise<ScheduleRunResult> {
    return observeSchedule(schedule.name, () => execute(schedule));
  }

  async function execute(schedule: ScheduleDef<TContext>): Promise<ScheduleRunResult> {
    if (stopped) return { name: schedule.name, status: 'unavailable' };

    const active = running.get(schedule.name) ?? 0;
    if (schedule.overlap === 'skip' && active > 0) {
      return { name: schedule.name, status: 'skipped-overlap' };
    }

    // Reserve the slot before the first await: a second trigger arriving
    // while the lock call is pending must see this run as active.
    running.set(schedule.name, active + 1);
    try {
      if (schedule.lock !== undefined) return await runExclusive(schedule, schedule.lock);
      return await runHandler(schedule);
    } finally {
      const nextActive = (running.get(schedule.name) ?? 1) - 1;
      if (nextActive <= 0) {
        running.delete(schedule.name);
      } else {
        running.set(schedule.name, nextActive);
      }
    }
  }

  async function runHandler(schedule: ScheduleDef<TContext>, held?: ScheduleLock): Promise<ScheduleRunResult> {
    try {
      const scheduleContext =
        options.createContext === undefined ? (undefined as TContext) : await options.createContext();
      const value = await schedule.handler(
        scheduleContext,
        held === undefined ? {} : { lock: { signal: held.signal, fence: held.fence } },
      );
      if (UnexpectedDefect.is(value)) return recordHandlerFailure(schedule.name, value);
      if (isFailure(value)) {
        handlerFailures += 1;
        return { name: schedule.name, status: 'refused', failure: value };
      }
      return { name: schedule.name, status: 'ran', value };
    } catch (error) {
      return recordHandlerFailure(schedule.name, error);
    }
  }

  function recordHandlerFailure(scheduleName: string, error: unknown): ScheduleRunResult {
    handlerFailures += 1;
    const cause = UnexpectedDefect.is(error) ? error : UnexpectedDefect({ cause: error });
    observe(() => debugSchedule.debug('[{scheduleName}] handler failed', { scheduleName }));
    observe(() => log.error('schedule handler failed', { schedule: scheduleName, code: cause.code }));
    return { name: scheduleName, status: 'handler-failed', cause };
  }

  function trackPromise<T>(promise: Promise<T>): Promise<T> {
    const drained = promise.then(ignorePromiseSettlement, ignorePromiseSettlement);
    inflight.add(drained);
    void drained.finally(() => {
      inflight.delete(drained);
    });
    return promise;
  }

  function track(schedule: ScheduleDef<TContext>): void {
    void trackPromise(run(schedule));
  }

  function armEvery(schedule: ScheduleDef<TContext>): void {
    const every = schedule.every;
    if (every === undefined) return;
    const intervalMs = parseEveryInterval(every);
    const armNext = (): void => {
      if (stopped) return;
      const timer = setTimeout(
        () => {
          track(schedule);
          armNext();
        },
        intervalMs + randomDelay(options.jitterMs ?? 0),
      );
      unref(timer);
      timers.push(timer);
    };
    armNext();
  }

  function durableRegistration(schedule: ScheduleDef<TContext>): readonly DurableScheduleRegistration[] {
    const runOnce = (): Promise<ScheduleRunResult> => trackPromise(run(schedule));
    if (schedule.cron !== undefined) {
      return [
        {
          name: schedule.name,
          cron: schedule.cron,
          ...(schedule.timezone === undefined ? {} : { timezone: schedule.timezone }),
          run: runOnce,
        },
      ];
    }
    if (schedule.every !== undefined) {
      return [{ name: schedule.name, everyMs: parseEveryInterval(schedule.every), run: runOnce }];
    }
    return [];
  }

  async function startDurable(
    durable: DurableScheduler,
    schedules: readonly ScheduleDef<TContext>[],
  ): Promise<ReturnType<typeof ScheduleDurableStartFailed> | undefined> {
    durableStarted = true;
    try {
      await trackPromise(durable.start(schedules.flatMap(schedule => durableRegistration(schedule))));
      return undefined;
    } catch (error) {
      const failure = ScheduleDurableStartFailed({ cause: error });
      observe(() =>
        log.error('schedule durable registration failed', {
          schedules: schedules.map(schedule => schedule.name).join(','),
          code: failure.code,
        }),
      );
      return failure;
    }
  }

  return {
    start() {
      if (stopped) return STARTED_CLEAN;
      // The host owns the clock: nothing is armed; runs come only from trigger.
      if (clock === 'host') return STARTED_CLEAN;
      assertDurableBackend(options.schedules, options.durable);
      const durableSchedules = options.schedules.filter(schedule => schedule.durable);
      const durableStart =
        options.durable !== undefined && durableSchedules.length > 0
          ? startDurable(options.durable, durableSchedules)
          : STARTED_CLEAN;
      for (const schedule of options.schedules) {
        if (schedule.durable) continue;
        if (schedule.cron === undefined) {
          armEvery(schedule);
          continue;
        }
        cronJobs.push(
          new Cron(
            schedule.cron,
            {
              name: schedule.name,
              timezone: schedule.timezone,
              unref: true,
            },
            () => {
              track(schedule);
            },
          ),
        );
      }
      return durableStart;
    },
    async stop() {
      stopped = true;
      for (const job of cronJobs) job.stop();
      for (const timer of timers) clearTimeout(timer);
      // Closing the backend waits for an active durable run and cancels a
      // registration still waiting on the store, so inflight can drain.
      if (durableStarted) await options.durable?.stop();
      await Promise.allSettled(inflight);
    },
    async trigger(name: string) {
      const schedule = byName.get(name);
      if (schedule === undefined) {
        throw new ScheduleError({
          code: SCHEDULE_ERROR_CODES.invalidDefinition,
          message: `[schedule] schedule "${name}" is not registered.`,
          remediation: 'Trigger only schedules listed in this runtime.',
        });
      }
      return trackPromise(run(schedule));
    },
    get handlerFailures() {
      return handlerFailures;
    },
    get lockContention() {
      return lockContention;
    },
    get lockFailures() {
      return lockFailures;
    },
    get lockLost() {
      return lockLost;
    },
  };
}
