import type { LockRunFailure } from '@arki/lock';
import { CronPattern } from 'croner';

import type { Failure } from '@arki/failure';

import type { CheckedStages, ContextAfter, StageRefusals, WideStage } from './with.js';
import { SCHEDULE_ERROR_CODES, ScheduleError } from './errors.js';
import { foldStages } from './with.js';

export type ScheduleInterval = `${number}${'s' | 'm' | 'h'}`;
export type ScheduleOverlap = 'skip' | 'concurrent';

type BaseScheduleOptions = {
  readonly name: string;
  readonly timezone?: string;
  readonly overlap?: ScheduleOverlap;
  /**
   * `true` hands this schedule to a durable backend (a BullMQ job scheduler
   * through `@arki/queue`): workers distribute ticks across replicas. A tick
   * missed while down runs when a worker comes back. Delivery is at least once;
   * handlers must make external effects idempotent.
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
type ScheduleHandler<TContext, TResult> = (ctx: TContext, run: ScheduleRun) => Promise<TResult>;

type BaseScheduleOptionsWithContext<TContext, TResult, TName extends string> = Omit<BaseScheduleOptions, 'name'> & {
  readonly name: TName;
  readonly handler: ScheduleHandler<TContext, TResult>;
};

/** The definition options for a handler that receives `THandlerContext`. */
type ScheduleOptionsOf<THandlerContext, TResult, TName extends string> =
  | (BaseScheduleOptionsWithContext<THandlerContext, TResult, TName> & {
      readonly cron: string;
      readonly every?: never;
    })
  | (BaseScheduleOptionsWithContext<THandlerContext, TResult, TName> & {
      readonly every: ScheduleInterval;
      readonly cron?: never;
    });

export type DefineScheduleOptions<
  TContext = undefined,
  TResult = unknown,
  TName extends string = string,
> = ScheduleOptionsOf<TContext, TResult, TName> & {
  /** Steps and arounds to run before the handler. See the `with` overload of {@link defineSchedule}. */
  readonly with?: never;
};

/** A number of milliseconds, or a string with unit `ms`, `s`, `m` or `h`: the same shape `@arki/lock` takes. */
export type LockDuration = number | `${number}${'ms' | 's' | 'm' | 'h'}`;

/** The callback value or the lock provider's canonical failure protocol. The runtime distinguishes contention from failed ownership. */
export type LockerRun<T, F extends Failure = LockRunFailure> = T | F;

/**
 * The lock port, and all a `lock:` schedule needs: `mutex(key).tryRun` runs
 * `fn` only if nobody holds `key`, holds `key` until `fn` settles (and at least
 * `holdAtLeast`), and resolves after the release. Structural, so this package
 * needs no lock library: the `Locks` returned by `createLocks` or the `locks`
 * service of `locks(...)` from `@arki/lock/dot` fits with any store.
 * `namespace` and `store` are optional: when present they put the key space and
 * the store's promises into the manifest text.
 */
export type Locker<F extends Failure = LockRunFailure> = {
  mutex(key: string): {
    tryRun<T>(
      fn: (lock: ScheduleLock) => T | Promise<T>,
      opts?: { readonly holdAtLeast?: LockDuration },
    ): Promise<LockerRun<Awaited<T>, F>>;
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

export type ScheduleDef<TContext = undefined, TResult = unknown, TName extends string = string> = {
  readonly name: TName;
  readonly cron?: string;
  readonly every?: ScheduleInterval;
  readonly timezone?: string;
  readonly overlap: ScheduleOverlap;
  readonly durable: boolean;
  readonly handler: ScheduleHandler<TContext, TResult>;
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

export function defineSchedule<TContext = undefined, TResult = unknown, const TName extends string = string>(
  options: DefineScheduleOptions<TContext, TResult, TName>,
): ScheduleDef<TContext, TResult, TName>;
/**
 * With `with: [...]`: steps and arounds, plain functions listed directly, run in
 * declaration order before the handler (an around wraps everything after it and
 * the handler). Each element is checked against the context built so far; the
 * handler's context is `TContext` plus every step's additions. A step that
 * returns a `Failure` refuses the run: the handler does not run and the run is
 * `refused`, with that failure, like a handler that returned it.
 */
export function defineSchedule<
  TContext = undefined,
  TResult = unknown,
  const TName extends string = string,
  const TWith extends readonly unknown[] = readonly [],
>(
  options: ScheduleOptionsOf<ContextAfter<TContext, TWith>, TResult, TName> & {
    readonly with: TWith & CheckedStages<TContext, TWith>;
  },
): ScheduleDef<TContext, TResult | StageRefusals<TWith>, TName>;
// Erasure seam: the fold's types depend on the tuple `TWith`, which a runtime loop cannot
// follow, so the body is written against the widest shapes and the overloads carry the types.
export function defineSchedule(
  options: ScheduleOptionsOf<object | undefined, unknown, string> & { readonly with?: readonly WideStage[] },
): ScheduleDef<object | undefined, unknown, string> {
  const name = options.name;
  const handler = options.with === undefined ? options.handler : foldStages(options.with, options.handler);
  if (name.trim() === '' || name !== name.trim()) {
    throw invalid('[schedule] schedule name must be a non-empty string without surrounding spaces.');
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
      handler,
    };
  }

  parseEveryInterval(options.every);
  return {
    name,
    every: options.every,
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
    overlap: options.overlap ?? 'skip',
    durable,
    handler,
  };
}

export { ScheduleError, ScheduleLockFailed, SCHEDULE_ERROR_CODES, SCHEDULE_RUNTIME_FAILURES } from './errors.js';
export type {
  DurableScheduleRegistration,
  DurableScheduler,
  ScheduleClock,
  ScheduleOutcome,
  ScheduleRefusal,
  ScheduleRunResult,
  ScheduleRunStatus,
} from './runtime.js';

export type { ScheduleAround, ScheduleStage, ScheduleStep } from './with.js';

export type ScheduleBuilder<TContext> = {
  define<TResult, const TName extends string>(
    options: DefineScheduleOptions<TContext, TResult, TName>,
  ): ScheduleDef<TContext, TResult, TName>;
  define<TResult, const TName extends string, const TWith extends readonly unknown[]>(
    options: ScheduleOptionsOf<ContextAfter<TContext, TWith>, TResult, TName> & {
      readonly with: TWith & CheckedStages<TContext, TWith>;
    },
  ): ScheduleDef<TContext, TResult | StageRefusals<TWith>, TName>;
};

export const initSchedule = {
  context<TContext>() {
    return {
      create(): ScheduleBuilder<TContext> {
        return {
          define: defineSchedule,
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
