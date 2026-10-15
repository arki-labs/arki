
import { Cron } from 'croner';

import { getLogger } from '@arki/log';

import type { ScheduleDef } from './index.js';
import { SCHEDULE_ERROR_CODES, ScheduleError } from './errors.js';
import { parseEveryInterval } from './index.js';

const debugSchedule = getLogger('arki:schedule');
const log = getLogger('arki:schedule');

type TimerHandle = ReturnType<typeof setTimeout>;
type UnrefHandle = { unref(): void };

export type KvLike = {
  setIfNotExists<T = unknown>(key: string, value: T, expirationSeconds: number): Promise<boolean>;
};

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
  readonly lock?: KvLike;
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
export type ScheduleRunResult<T = unknown> =
  | { readonly name: string; readonly status: 'ran'; readonly value: T }
  | { readonly name: string; readonly status: 'skipped-overlap' | 'skipped-lock' }
  | { readonly name: string; readonly status: 'handler-failed' | 'lock-failed'; readonly cause: unknown }
  | { readonly name: string; readonly status: 'unavailable' };

/** A run result, or `unknown` when no schedule has that name (the `scheduler` service's `trigger`). */
export type ScheduleOutcome<T> = ScheduleRunResult<T> | { readonly name: string; readonly status: 'unknown' };

export type ScheduleRunStatus = ScheduleRunResult['status'];

export type ScheduleRuntime = {
  start(): void;
  /** Stop firing, refuse new triggers (`unavailable`) and wait for accepted runs to finish. */
  stop(): Promise<void>;
  /**
   * Run one schedule now. Works before `start()` (the runtime is built, so
   * the run is real) and reports `unavailable` after `stop()`. Throws a
   * coded `ScheduleError` for a name this runtime does not hold.
   */
  trigger(name: string): Promise<ScheduleRunResult>;
  readonly handlerFailures: number;
  readonly lockSkips: number;
  readonly lockErrors: number;
};

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

function lockTtlSeconds<TContext>(schedule: ScheduleDef<TContext>): number {
  if (schedule.every !== undefined) {
    return Math.max(1, Math.ceil(parseEveryInterval(schedule.every) / 1000));
  }
  return 60;
}

export function createScheduleRuntime<TContext = undefined>(
  options: ScheduleRuntimeOptions<TContext>,
): ScheduleRuntime {
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
  let lockSkips = 0;
  let lockErrors = 0;
  let durableStarted = false;

  type LockOutcome = { readonly kind: 'acquired' | 'held' } | { readonly kind: 'failed'; readonly cause: unknown };

  async function acquireLock(schedule: ScheduleDef<TContext>): Promise<LockOutcome> {
    // Durable runs need no lock: the backend hands each tick to one worker.
    if (options.lock === undefined || schedule.durable) return { kind: 'acquired' };

    try {
      const acquired = await options.lock.setIfNotExists(
        `schedule:lock:${schedule.name}`,
        { acquiredAt: new Date().toISOString() },
        lockTtlSeconds(schedule),
      );
      if (acquired) return { kind: 'acquired' };
      lockSkips += 1;
      return { kind: 'held' };
    } catch (error) {
      lockErrors += 1;
      const message = error instanceof Error ? error.message : String(error);
      debugSchedule.debug('[{scheduleName}] lock acquire failed: {failed}', {
        scheduleName: schedule.name,
        failed: message,
      });
      log.error('schedule lock acquire failed', { schedule: schedule.name, error: message });
      return { kind: 'failed', cause: error };
    }
  }

  /**
   * A schedule with its own lock (`lock:` in `schedules(core, …)`): the lock
   * is held for the whole handler, however long it runs. No KV lease here —
   * a 60 s lease would expire under a long job and let a second replica in.
   */
  async function runExclusive(
    schedule: ScheduleDef<TContext>,
    lock: NonNullable<ScheduleDef<TContext>['lock']>,
  ): Promise<ScheduleRunResult> {
    try {
      const locked = await lock.locks.tryRun(lock.key, () => runHandler(schedule));
      if (locked.ran) return locked.value;
      lockSkips += 1;
      debugSchedule.debug('[{scheduleName}] lock {lockKey} is held elsewhere; skipped', {
        scheduleName: schedule.name,
        lockKey: lock.key,
      });
      return { name: schedule.name, status: 'skipped-lock' };
    } catch (error) {
      // runHandler reports handler errors as `handler-failed` and never throws,
      // so whatever lands here came from taking or releasing the lock.
      lockErrors += 1;
      const message = error instanceof Error ? error.message : String(error);
      log.error('schedule lock failed', { schedule: schedule.name, lock: lock.key, error: message });
      return { name: schedule.name, status: 'lock-failed', cause: error };
    }
  }

  async function run(schedule: ScheduleDef<TContext>): Promise<ScheduleRunResult> {
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
      const lock = await acquireLock(schedule);
      if (lock.kind === 'held') {
        return { name: schedule.name, status: 'skipped-lock' };
      }
      if (lock.kind === 'failed') {
        return { name: schedule.name, status: 'lock-failed', cause: lock.cause };
      }
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

  async function runHandler(schedule: ScheduleDef<TContext>): Promise<ScheduleRunResult> {
    try {
      const scheduleContext =
        options.createContext === undefined ? (undefined as TContext) : await options.createContext();
      const value = await schedule.handler(scheduleContext);
      return { name: schedule.name, status: 'ran', value };
    } catch (error) {
      handlerFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      debugSchedule.debug('[{scheduleName}] handler failed: {failed}', {
        scheduleName: schedule.name,
        failed: message,
      });
      log.error('schedule handler failed', { schedule: schedule.name, error: message });
      return { name: schedule.name, status: 'handler-failed', cause: error };
    }
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

  function startDurable(durable: DurableScheduler, schedules: readonly ScheduleDef<TContext>[]): void {
    durableStarted = true;
    void trackPromise(durable.start(schedules.flatMap(schedule => durableRegistration(schedule)))).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        debugSchedule.debug('durable registration failed: {failed}', { failed: message });
        log.error('schedule durable registration failed', {
          schedules: schedules.map(schedule => schedule.name).join(','),
          error: message,
        });
      },
    );
  }

  return {
    start() {
      if (stopped) return;
      // The host owns the clock: nothing is armed; runs come only from trigger.
      if (clock === 'host') return;
      assertDurableBackend(options.schedules, options.durable);
      const durableSchedules = options.schedules.filter(schedule => schedule.durable);
      if (options.durable !== undefined && durableSchedules.length > 0) {
        startDurable(options.durable, durableSchedules);
      }
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
    get lockSkips() {
      return lockSkips;
    },
    get lockErrors() {
      return lockErrors;
    },
  };
}
