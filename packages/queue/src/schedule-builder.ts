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
 * Schedules can either:
 * 1. Wrap an existing job: `q.schedule.cron('0 0 * * *').job(existingJob).data({ ... })`
 * 2. Define inline: `q.schedule.interval(60000).name('my-schedule').input(schema).handler(fn)`
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

import type { z } from 'zod/v4';

import type {
  ScheduleBuilderChain,
  ScheduleBuilderDef,
  ScheduleDefinition,
  ScheduleJobWrapper,
} from './types/builder.ts';
import type { JobDefinition, JobHandler } from './types/job.ts';
import type { JobMiddleware } from './types/middleware.ts';
import type { QueueConfig, QueueMeta } from './types/queue.ts';

/**
 * Schedule type
 */
type ScheduleType = 'cron' | 'interval' | 'timeout';

/**
 * Internal schedule definition structure
 * This is what gets stored in ScheduleDefinition._internal
 */
export type InternalScheduleDefinition<TInput = unknown, TOutput = unknown, TContext = unknown> = {
  /**
   * Type of schedule (cron or interval)
   */
  type: ScheduleType;

  /**
   * Schedule value (cron pattern or interval in ms)
   */
  value: string | number;

  /**
   * Schedule options (timezone for cron)
   */
  options?: { timezone?: string };

  /**
   * Schedule name
   */
  name: string;

  /**
   * Job variant - either wrapping existing job or inline handler
   */
  jobVariant:
    | {
        type: 'existing';
        job: JobDefinition<TInput, TOutput, TContext>;
        data: TInput;
      }
    | {
        type: 'inline';
        inputSchema: z.ZodType<TInput>;
        handler: JobHandler<TInput, TOutput, TContext>;
      };

  /**
   * Middleware chain for this schedule
   */
  middlewares: readonly JobMiddleware<unknown, unknown, QueueMeta>[];

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
  inputSchema?: z.ZodType<TInput>;
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
  const state: ScheduleBuilderState<never> = {
    config,
    middlewares,
    scheduleType,
    scheduleValue,
    scheduleOptions,
  };

  return {
    use<TContextOut2>(middleware: JobMiddleware<TContextOut, TContextOut2, TMeta>) {
      return createScheduleBuilder<TContext, TContextOut2, TMeta>(
        scheduleType,
        scheduleValue,
        scheduleOptions,
        config,
        [...middlewares, middleware as JobMiddleware<unknown, unknown, QueueMeta>],
      );
    },

    job<TInput>(job: JobDefinition<TInput, unknown, unknown>): ScheduleJobWrapper<TInput> {
      return {
        data(data: TInput): ScheduleDefinition {
          // Generate name from job if not explicitly set
          const scheduleName = state.name ?? `${job._internal.name}-schedule`;

          const internal: InternalScheduleDefinition<TInput, unknown, TContextOut> = {
            type: scheduleType,
            value: scheduleValue,
            options: scheduleOptions,
            name: scheduleName,
            jobVariant: {
              type: 'existing',
              job,
              data,
            },
            middlewares,
            config,
          };

          return {
            _type: 'schedule',
            _internal: internal,
          };
        },
      };
    },

    name(name: string) {
      return createScheduleBuilderChain<TContext, TContextOut, TMeta, never, never>({
        ...state,
        name,
      });
    },
  };
}

/**
 * Create a schedule builder chain (after name is set)
 * @internal
 */
function createScheduleBuilderChain<TContext, TContextOut, TMeta extends QueueMeta, TInput, TOutput>(
  state: ScheduleBuilderState<TInput>,
): ScheduleBuilderChain<TContext, TContextOut, TMeta, TInput, TOutput> {
  return {
    input<TNewInput>(schema: z.ZodType<TNewInput>) {
      return createScheduleBuilderChain<TContext, TContextOut, TMeta, TNewInput, TOutput>({
        ...state,
        inputSchema: schema,
      });
    },

    handler<THandlerInput = TInput, THandlerOutput = TOutput>(
      handler: (
        data: THandlerInput extends never ? TInput : THandlerInput,
        ctx: TContextOut,
      ) => Promise<THandlerOutput extends never ? TOutput : THandlerOutput>,
    ): ScheduleDefinition {
      if (!state.name) {
        throw new Error('Schedule name is required. Call .name() first.');
      }

      if (!state.inputSchema) {
        throw new Error('Input schema is required. Call .input() before .handler().');
      }

      type ActualInput = THandlerInput extends never ? TInput : THandlerInput;
      type ActualOutput = THandlerOutput extends never ? TOutput : THandlerOutput;

      const internal: InternalScheduleDefinition<ActualInput, ActualOutput, TContextOut> = {
        type: state.scheduleType,
        value: state.scheduleValue,
        options: state.scheduleOptions,
        name: state.name,
        jobVariant: {
          type: 'inline',
          inputSchema: state.inputSchema as z.ZodType<ActualInput>,
          handler: handler as JobHandler<ActualInput, ActualOutput, TContextOut>,
        },
        middlewares: state.middlewares,
        config: state.config,
      };

      return {
        _type: 'schedule',
        _internal: internal,
      };
    },
  };
}
