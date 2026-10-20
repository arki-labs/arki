/**
 * Schedule builder implementation
 * Provides chainable API for creating scheduled jobs
 *
 * ## Schedule Types
 *
 * - **CRON**: Recurring schedule based on cron pattern (e.g., '0 0 * * *' for daily at midnight)
 * - **INTERVAL**: Recurring schedule at fixed intervals (e.g., every 60000ms)
 * - **TIMEOUT**: One-time execution after a delay (e.g., run once after 60000ms)
 *
 * ## Usage Patterns
 *
 * A schedule is a trigger, not a runner. It can either:
 * 1. Wrap an existing job: `q.schedule.cron('0 0 * * *').job(existingJob).data({ ... })`.
 *    Each tick adds the data to the job's own queue, the same as `existingJob.trigger(data)`;
 *    the job's worker runs it with the job's own middleware, retries and concurrency.
 * 2. Define inline: `q.schedule.interval(60000).name('my-schedule').input(schema).handler(fn)`.
 *    This is an anonymous job named after the schedule; `.use()` before `.name()` is its middleware.
 *
 * @example
 * ```typescript
 * // CRON: Daily report at midnight
 * const dailyReport = q.schedule
 *   .cron('0 0 * * *', { timezone: 'America/New_York' })
 *   .job(generateReportJob)
 *   .data({ reportType: 'daily' });
 *
 * // INTERVAL: Health check every 30 seconds (repeating)
 * const healthCheck = q.schedule
 *   .interval(30000)
 *   .job(pingServiceJob)
 *   .data({});
 *
 * // TIMEOUT: Send reminder email once after 24 hours
 * const reminderEmail = q.schedule
 *   .timeout(24 * 60 * 60 * 1000)
 *   .job(sendReminderJob)
 *   .data({ userId: 'usr_123' });
 *
 * // Inline handler
 * const customSchedule = q.schedule
 *   .interval(60000)
 *   .name('custom-task')
 *   .input(z.object({ value: z.number() }))
 *   .handler(async (data, ctx) => {
 *     console.log('Running custom task with value:', data.value);
 *   });
 * ```
 */

import type { StandardSchemaV1 } from '@arki/schema';

import type {
  ScheduleBuilderChain,
  ScheduleBuilderDef,
  ScheduleBuilderNamed,
  ScheduleDefinition,
  ScheduleJobWrapper,
} from './types/builder.ts';
import type { AnyJobDefinition, JobDefinition } from './types/job.ts';
import type { JobMiddleware } from './types/middleware.ts';
import type { QueueConfig, QueueMeta } from './types/queue.ts';
import { debugBuilder, observeQueue } from './debug.ts';
import { QUEUE_DEFINITION_ERROR_CODES, QueueDefinitionError } from './errors.ts';
import { createJobBuilder } from './job-builder.ts';

/**
 * Schedule type
 */
type ScheduleType = 'cron' | 'interval' | 'timeout';

/**
 * Internal schedule definition structure
 * This is what gets stored in ScheduleDefinition._internal
 *
 * A schedule is a trigger: on each tick it adds `data` to `job`'s own queue,
 * and the job's worker runs it. The builder stores the job as
 * `AnyJobDefinition`; the queue reads `_internal` back with the default
 * `TJob`, the same erasure boundary flow steps use.
 */
export type InternalScheduleDefinition<TJob = JobDefinition<unknown, unknown, unknown>> = {
  /**
   * Type of schedule (cron, interval or timeout)
   */
  type: ScheduleType;

  /**
   * Schedule value (cron pattern, or interval/delay in ms)
   */
  value: string | number;

  /**
   * Schedule options (timezone for cron)
   */
  options?: { timezone?: string };

  /**
   * Schedule name (the job scheduler id on the job's queue)
   */
  name: string;

  /**
   * The job each tick adds to: the wrapped job, or for an inline schedule an
   * anonymous job named after the schedule, whose middleware is the schedule's `.use()` chain
   */
  job: TJob;

  /**
   * Whether `job` is the inline schedule's own anonymous job (only this package writes to its queue)
   */
  inline: boolean;

  /**
   * The data each tick adds (`{}` for an inline schedule)
   */
  data: unknown;

  /**
   * Queue configuration
   */
  config: QueueConfig;
};

/**
 * Internal state for schedule builder
 */
type ScheduleBuilderState<TInput> = {
  config: QueueConfig;
  middlewares: readonly JobMiddleware<unknown, unknown, QueueMeta>[];
  scheduleType: ScheduleType;
  scheduleValue: string | number;
  scheduleOptions?: { timezone?: string };
  name?: string;
  inputSchema?: StandardSchemaV1<unknown, TInput>;
};

/**
 * Create a schedule builder
 * @internal
 */
export function createScheduleBuilder<TContext, TContextOut, TMeta extends QueueMeta>(
  scheduleType: ScheduleType,
  scheduleValue: string | number,
  scheduleOptions: { timezone?: string } | undefined,
  config: QueueConfig,
  middlewares: readonly JobMiddleware<unknown, unknown, QueueMeta>[],
): ScheduleBuilderDef<TContext, TContextOut, TMeta> {
  observeQueue(() =>
    debugBuilder.debug('Creating schedule builder (type: {type}, value: {value}, middleware: {middleware})', {
      type: scheduleType,
      value: scheduleValue,
      middleware: middlewares.length,
    }),
  );

  const state: ScheduleBuilderState<never> = {
    config,
    middlewares,
    scheduleType,
    scheduleValue,
    scheduleOptions,
  };

  return {
    use<TContextOut2>(middleware: JobMiddleware<TContextOut, TContextOut2, TMeta>) {
      observeQueue(() =>
        debugBuilder.debug('Adding middleware to schedule (total: {total})', { total: middlewares.length + 1 }),
      );

      // One runtime object serves both typestates: the ScheduleBuilderWithMiddleware
      // type hides `.job()` after `.use()`; the throw in scheduleJob() backs it up.
      return createScheduleBuilder<TContext, TContextOut2, TMeta>(
        scheduleType,
        scheduleValue,
        scheduleOptions,
        config,
        [...middlewares, middleware as JobMiddleware<unknown, unknown, QueueMeta>],
      );
    },

    job<TInput>(job: JobDefinition<TInput, unknown, never>): ScheduleJobWrapper<TInput> {
      return scheduleJob(state, job);
    },

    name(name: string) {
      observeQueue(() => debugBuilder.debug('Setting schedule name: {name}', { name }));

      // One runtime object serves every named typestate: ScheduleBuilderNamed
      // offers `.job()` and `.input()`, ScheduleBuilderNeedsInput hides `.job()`
      // after `.use()`, and both hide `.handler()` until `.input()` runs; the
      // throws below back them up.
      return createScheduleBuilderChain<TContext, TContextOut, TMeta, never, never>({
        ...state,
        name,
      });
    },
  };
}

/**
 * Wrap an existing job: each tick adds `data` to the job's own queue.
 * @internal
 */
function scheduleJob<TInput>(
  state: ScheduleBuilderState<unknown>,
  job: JobDefinition<TInput, unknown, never>,
): ScheduleJobWrapper<TInput> {
  if (state.middlewares.length > 0) {
    throw new QueueDefinitionError({
      code: QUEUE_DEFINITION_ERROR_CODES.scheduleMiddlewareWithJob,
      message: `A schedule that wraps a job has no middleware of its own. Remove .use() before .job(${job._internal.name}).`,
      remediation:
        'Add the middleware to the job instead (q.job.use(mw)...); its worker runs it on every scheduled run.',
    });
  }

  observeQueue(() => debugBuilder.debug('Wrapping existing job: {job}', { job: job._internal.name }));

  return {
    data(data: TInput): ScheduleDefinition {
      // Generate name from job if not explicitly set
      const scheduleName = state.name ?? `${job._internal.name}-schedule`;

      observeQueue(() =>
        debugBuilder.debug('[{scheduleName}] Creating schedule definition (type: {type}, triggers: {triggers})', {
          scheduleName,
          type: state.scheduleType,
          triggers: job._internal.name,
        }),
      );

      const internal: InternalScheduleDefinition<AnyJobDefinition> = {
        type: state.scheduleType,
        value: state.scheduleValue,
        options: state.scheduleOptions,
        name: scheduleName,
        job,
        inline: false,
        data,
        config: state.config,
      };

      return {
        _type: 'schedule',
        _internal: internal,
      };
    },
  };
}

/**
 * Create a schedule builder chain (after name is set)
 * @internal
 */
function createScheduleBuilderChain<TContext, TContextOut, TMeta extends QueueMeta, TInput, TOutput>(
  state: ScheduleBuilderState<TInput>,
): ScheduleBuilderChain<TContext, TContextOut, TMeta, TInput, TOutput> &
  Pick<ScheduleBuilderNamed<TContext, TContextOut, TMeta>, 'job'> {
  return {
    job<TJobInput>(job: JobDefinition<TJobInput, unknown, never>): ScheduleJobWrapper<TJobInput> {
      return scheduleJob(state, job);
    },

    input<TNewInput>(schema: StandardSchemaV1<unknown, TNewInput>) {
      observeQueue(() =>
        debugBuilder.debug('[{value1}] Setting input schema for schedule', { value1: state.name ?? 'unnamed' }),
      );

      return createScheduleBuilderChain<TContext, TContextOut, TMeta, TNewInput, TOutput>({
        ...state,
        inputSchema: schema,
      });
    },

    handler<TResult>(handler: (data: TInput, ctx: TContextOut) => Promise<TResult>): ScheduleDefinition {
      if (!state.name) {
        throw new QueueDefinitionError({
          code: QUEUE_DEFINITION_ERROR_CODES.missingName,
          message: 'Schedule name is required. Call .name() first.',
          remediation: 'Call .name("feature:task") on the schedule before .handler().',
        });
      }

      if (!state.inputSchema) {
        throw new QueueDefinitionError({
          code: QUEUE_DEFINITION_ERROR_CODES.missingInput,
          message: 'Input schema is required. Call .input() before .handler().',
          remediation: 'Add .input(schema) before .handler(); use z.object({}) for a schedule that takes no data.',
        });
      }

      observeQueue(() =>
        debugBuilder.debug(
          '[{stateName}] Creating inline schedule definition (type: {type}, value: {value}, middleware: {middleware})',
          {
            stateName: state.name,
            type: state.scheduleType,
            value: state.scheduleValue,
            middleware: state.middlewares.length,
          },
        ),
      );

      // An inline schedule is an anonymous job named after the schedule: its
      // `.use()` chain is that job's middleware, and it runs on the job path.
      const job = createJobBuilder<TContext, TContextOut, TMeta>({
        config: state.config,
        middlewares: state.middlewares,
      })
        .name(state.name)
        .input(state.inputSchema)
        .handler(handler);

      const internal: InternalScheduleDefinition<AnyJobDefinition> = {
        type: state.scheduleType,
        value: state.scheduleValue,
        options: state.scheduleOptions,
        name: state.name,
        job,
        inline: true,
        data: {},
        config: state.config,
      };

      return {
        _type: 'schedule',
        _internal: internal,
      };
    },
  };
}
