/* eslint-disable drizzle/enforce-delete-with-where */

import { Cron } from 'croner';
import { debug } from '@arki/log/debug';

import type { ScheduleDef } from './index.js';
import { parseEveryInterval } from './index.js';
import { ScheduleError, SCHEDULE_ERROR_CODES } from './errors.js';

const debugSchedule = debug('arki:schedule');

type TimerHandle = ReturnType<typeof setTimeout>;
type UnrefHandle = { unref(): void };

export type KvLike = {
  setIfNotExists<T = unknown>(key: string, value: T, expirationSeconds: number): Promise<boolean>;
};

type ScheduleRuntimeBaseOptions<TContext> = {
  readonly schedules: readonly ScheduleDef<TContext>[];
  readonly lock?: KvLike;
  readonly jitterMs?: number;
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

export type ScheduleRuntimeOptions<TContext = undefined> =
  & ScheduleRuntimeBaseOptions<TContext>
  & ScheduleRuntimeContextOptions<TContext>;

export type ScheduleRunStatus = 'ran' | 'skipped-overlap' | 'skipped-lock' | 'handler-failed';

export type ScheduleRunResult = {
  readonly name: string;
  readonly status: ScheduleRunStatus;
};

export type ScheduleRuntime = {
  start(): void;
  stop(): Promise<void>;
  trigger(name: string): Promise<ScheduleRunResult>;
  readonly handlerFailures: number;
  readonly lockSkips: number;
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
        remediation: 'Schedule names must be unique within one schedule(...) pip.',
      });
    }
    seen.add(schedule.name);
  }
}

function lockTtlSeconds<TContext>(schedule: ScheduleDef<TContext>): number {
  if (schedule.every !== undefined) {
    return Math.max(1, Math.ceil(parseEveryInterval(schedule.every) / 1000));
  }
  return 60;
}

export function createScheduleRuntime<TContext = undefined>(options: ScheduleRuntimeOptions<TContext>): ScheduleRuntime {
  assertUniqueSchedules(options.schedules);

  const byName = new Map(options.schedules.map(schedule => [schedule.name, schedule]));
  const running = new Map<string, number>();
  const cronJobs: Cron[] = [];
  const timers: TimerHandle[] = [];
  const inflight = new Set<Promise<void>>();
  let stopped = false;
  let handlerFailures = 0;
  let lockSkips = 0;

  async function acquireLock(schedule: ScheduleDef<TContext>): Promise<boolean> {
    if (options.lock === undefined) return true;

    try {
      const acquired = await options.lock.setIfNotExists(
        `schedule:lock:${schedule.name}`,
        { acquiredAt: new Date().toISOString() },
        lockTtlSeconds(schedule),
      );
      if (!acquired) lockSkips += 1;
      return acquired;
    } catch (error) {
      lockSkips += 1;
      debugSchedule(
        '[%s] lock acquire failed: %s',
        schedule.name,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  async function run(schedule: ScheduleDef<TContext>): Promise<ScheduleRunResult> {
    if (stopped) return { name: schedule.name, status: 'skipped-lock' };

    const active = running.get(schedule.name) ?? 0;
    if (schedule.overlap === 'skip' && active > 0) {
      return { name: schedule.name, status: 'skipped-overlap' };
    }

    const acquired = await acquireLock(schedule);
    if (!acquired) {
      return { name: schedule.name, status: 'skipped-lock' };
    }

    running.set(schedule.name, active + 1);
    try {
      const scheduleContext = options.createContext === undefined ? (undefined as TContext) : await options.createContext();
      await schedule.handler(scheduleContext);
      return { name: schedule.name, status: 'ran' };
    } catch (error) {
      handlerFailures += 1;
      debugSchedule(
        '[%s] handler failed: %s',
        schedule.name,
        error instanceof Error ? error.message : String(error),
      );
      return { name: schedule.name, status: 'handler-failed' };
    } finally {
      const nextActive = (running.get(schedule.name) ?? 1) - 1;
      if (nextActive <= 0) {
        running.delete(schedule.name);
      } else {
        running.set(schedule.name, nextActive);
      }
    }
  }

  function trackPromise<T>(promise: Promise<T>): Promise<T> {
    const drained = promise.then(
      ignorePromiseSettlement,
      ignorePromiseSettlement,
    );
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
      const timer = setTimeout(() => {
        track(schedule);
        armNext();
      }, intervalMs + randomDelay(options.jitterMs ?? 0));
      unref(timer);
      timers.push(timer);
    };
    armNext();
  }

  return {
    start() {
      if (stopped) return;
      for (const schedule of options.schedules) {
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
  };
}
