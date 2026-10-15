import { CronPattern } from 'croner';

import { SCHEDULE_ERROR_CODES, ScheduleError } from './errors.js';

export type ScheduleInterval = `${number}${'s' | 'm' | 'h'}`;
export type ScheduleOverlap = 'skip' | 'concurrent';

type BaseScheduleOptions = {
  readonly name: string;
  readonly timezone?: string;
  readonly overlap?: ScheduleOverlap;
  /**
   * `true` hands this schedule to a durable backend (a BullMQ job scheduler
   * through `@arki/queue`): each tick runs once across replicas, and a tick
   * that fell due while no worker ran still runs once when one comes back.
   * Default `false`: an in-process timer that skips ticks missed while down.
   */
  readonly durable?: boolean;
};

/**
 * What a handler learns about the lock it runs under. Present only when the
 * schedule declared a `lock`. `signal` aborts when the lock is known lost, so a
 * long job can stop; `fence` is the store's fencing token (`undefined` on a
 * store that hands none out).
 */
export type ScheduleLock = {
  readonly signal: AbortSignal;
  readonly fence: bigint | undefined;
};

/**
 * The second handler argument. `lock` is optional (not tied to the schedule's
 * declaration) because a schedule's handler type is shared by locked and
 * unlocked schedules.
 */
export type ScheduleRun = { readonly lock?: ScheduleLock };

/** The handler's resolved value is kept on a `ran` result (`ScheduleRunResult`). */
type ScheduleHandler<TContext> = (ctx: TContext, run: ScheduleRun) => Promise<unknown>;

type BaseScheduleOptionsWithContext<TContext> = BaseScheduleOptions & {
  readonly handler: ScheduleHandler<TContext>;
};

export type DefineScheduleOptions<TContext = undefined> =
  | (BaseScheduleOptionsWithContext<TContext> & {
      readonly cron: string;
      readonly every?: never;
    })
  | (BaseScheduleOptionsWithContext<TContext> & {
      readonly every: ScheduleInterval;
      readonly cron?: never;
    });

/** A number of milliseconds, or a string with unit `ms`, `s`, `m` or `h`: the same shape `@arki/lock` takes. */
export type LockDuration = number | `${number}${'ms' | 's' | 'm' | 'h'}`;

/** `{ ran: true; value }` when the callback ran, `{ ran: false }` when another holder had the key. */
export type LockerRun<T> = { readonly ran: true; readonly value: T } | { readonly ran: false };

/**
 * The lock port, and all a `lock:` schedule needs: `mutex(key).tryRun` runs
 * `fn` only if nobody holds `key`, holds `key` until `fn` settles (and at least
 * `holdAtLeast`), and resolves after the release. Structural, so this package
 * needs no lock library: the `Locks` returned by `createLocks` or the `locks`
 * service of `locks(...)` from `@arki/lock/dot` fits with any store.
 * `namespace` and `store` are optional: when present they put the key space and
 * the store's promises into the manifest text.
 */
export type Locker = {
  mutex(key: string): {
    tryRun<T>(
      fn: (lock: ScheduleLock) => T | Promise<T>,
      opts?: { readonly holdAtLeast?: LockDuration },
    ): Promise<LockerRun<Awaited<T>>>;
  };
  readonly namespace?: string;
  readonly store?: {
    readonly name: string;
    readonly guarantees: {
      readonly kind: string;
      readonly scope: string;
      readonly fence: string | false;
      readonly releasedOnCrash: string;
    };
  };
};

/** How long a lock stays held after the job started, when the schedule does not say. See `holdAtLeast` on feature schedules. */
export const DEFAULT_LOCK_HOLD_MS = 1000;

/** Milliseconds in a {@link LockDuration}. */
export function lockDurationMs(value: LockDuration): number {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0) return value;
  } else {
    const match = /^(.+?)(ms|[smh])$/.exec(value);
    const amount = Number(match?.[1]);
    if (match !== null && Number.isFinite(amount) && amount >= 0) {
      const unit = match[2];
      if (unit === 'ms') return amount;
      if (unit === 's') return amount * 1000;
      if (unit === 'm') return amount * 60_000;
      return amount * 3_600_000;
    }
  }
  throw invalid(
    `[schedule] holdAtLeast must be a non-negative number of milliseconds or a string like "500ms", "1s", "2m", "1h"; received ${String(value)}.`,
  );
}

export type ScheduleDef<TContext = undefined> = {
  readonly name: string;
  readonly cron?: string;
  readonly every?: ScheduleInterval;
  readonly timezone?: string;
  readonly overlap: ScheduleOverlap;
  readonly durable: boolean;
  readonly handler: ScheduleHandler<TContext>;
  /**
   * Run only while holding `key` in `locks`; a run that finds it held is
   * `skipped-lock`. Bound by `schedules(core, [{ lock }])` at boot. The key is
   * held while the handler runs, however long, and for at least
   * `holdAtLeastMs` after it started (default {@link DEFAULT_LOCK_HOLD_MS}).
   */
  readonly lock?: { readonly key: string; readonly locks: Locker; readonly holdAtLeastMs?: number };
};

function invalid(message: string, cause?: unknown): ScheduleError {
  return new ScheduleError({
    code: SCHEDULE_ERROR_CODES.invalidDefinition,
    message,
    remediation:
      'Define each schedule with a non-empty name, exactly one of cron or every, and a valid cron expression or positive interval.',
    cause,
  });
}

export function parseEveryInterval(value: ScheduleInterval): number {
  const match = /^([1-9]\d*)([smh])$/.exec(value);
  if (match === null) {
    throw invalid(`[schedule] every must use a positive interval like "30s", "5m", or "1h"; received "${value}".`);
  }

  const amount = Number.parseInt(match[1] ?? '', 10);
  const unit = match[2];
  if (unit === 's') return amount * 1000;
  if (unit === 'm') return amount * 60_000;
  return amount * 3_600_000;
}

export function defineSchedule<TContext = undefined>(options: DefineScheduleOptions<TContext>): ScheduleDef<TContext> {
  const name = options.name.trim();
  if (name === '') {
    throw invalid('[schedule] schedule name must be a non-empty string.');
  }

  const durable = options.durable ?? false;
  if (durable && name.includes(':')) {
    throw new ScheduleError({
      code: SCHEDULE_ERROR_CODES.invalidDefinition,
      message: `[schedule] durable schedule "${name}" cannot contain ":" in its name.`,
      remediation:
        'Rename the schedule without ":" (use "." or "-"). The durable backend uses the name as a queue name.',
    });
  }

  const hasCron = 'cron' in options && options.cron !== undefined;
  const hasEvery = 'every' in options && options.every !== undefined;
  if (hasCron === hasEvery) {
    throw invalid(`[schedule] "${name}" must define exactly one of cron or every.`);
  }

  if (hasCron) {
    try {
      new CronPattern(options.cron, options.timezone);
    } catch (error) {
      throw invalid(`[schedule] "${name}" has an invalid cron expression.`, error);
    }
    return {
      name,
      cron: options.cron,
      ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
      overlap: options.overlap ?? 'skip',
      durable,
      handler: options.handler,
    };
  }

  parseEveryInterval(options.every);
  return {
    name,
    every: options.every,
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
    overlap: options.overlap ?? 'skip',
    durable,
    handler: options.handler,
  };
}

export { ScheduleError, SCHEDULE_ERROR_CODES } from './errors.js';
export type {
  DurableScheduleRegistration,
  DurableScheduler,
  ScheduleClock,
  ScheduleOutcome,
  ScheduleRunResult,
  ScheduleRunStatus,
} from './runtime.js';

export type ScheduleBuilder<TContext> = {
  define(options: DefineScheduleOptions<TContext>): ScheduleDef<TContext>;
};

export const initSchedule = {
  context<TContext>() {
    return {
      create(): ScheduleBuilder<TContext> {
        return {
          define: defineSchedule<TContext>,
        };
      },
    };
  },
  create(): ScheduleBuilder<undefined> {
    return {
      define: defineSchedule,
    };
  },
};
