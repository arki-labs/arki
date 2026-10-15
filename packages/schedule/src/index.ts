import { CronPattern } from 'croner';

import { ScheduleError, SCHEDULE_ERROR_CODES } from './errors.js';

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

/** The handler's resolved value is kept on a `ran` result (`ScheduleRunResult`). */
type ScheduleHandler<TContext> = (ctx: TContext) => Promise<unknown>;

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

export type ScheduleDef<TContext = undefined> = {
  readonly name: string;
  readonly cron?: string;
  readonly every?: ScheduleInterval;
  readonly timezone?: string;
  readonly overlap: ScheduleOverlap;
  readonly durable: boolean;
  readonly handler: ScheduleHandler<TContext>;
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
      remediation: 'Rename the schedule without ":" (use "." or "-"). The durable backend uses the name as a queue name.',
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
  KvLike,
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
