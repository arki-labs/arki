/**
 * Queue initialization - inspired by tRPC's initTRPC pattern
 *
 * @example
 * ```typescript
 * // 1. Create context
 * const createContext = () => ({
 *   db: database,
 *   repo: repositories,
 *   kv: kvStore,
 * });
 *
 * // 2. Initialize queue
 * const q = initQueue
 *   .context<typeof createContext>()
 *   .create({
 *     transformer: superjson,
 *   });
 *
 * // 3. Create job builders with middleware
 * const baseJob = q.job.use(errorHandling).use(logging);
 * const authJob = baseJob.use(authMiddleware);
 * ```
 */

import superjson from 'superjson';

import type { QueueInstanceOptions } from './create-queue.ts';
import { CronPatterns } from './cron-patterns.ts';
import { createQueueInstance } from './create-queue.ts';
import { createFlowBuilder } from './flow-builder.ts';
import { createJobBuilder } from './job-builder.ts';
import { createScheduleBuilder } from './schedule-builder.ts';
import type {
  FlowBuilderFactory,
  QueueBuilder,
  ScheduleBuilderFactory,
} from './types/builder.ts';
import type { JobContext } from './types/index.ts';
import type { JobMiddleware, MiddlewareFunction } from './types/middleware.ts';
import type { DataTransformer, QueueConfig, QueueMeta } from './types/queue.ts';

/**
 * Initialize queue system
 * This is the entry point, similar to tRPC's initTRPC
 */
export const initQueue = {
  /**
   * Configure context type for the queue
   */
  context<TContext>() {
    return {
      /**
       * Configure metadata type for the queue
       */
      meta<TMeta extends QueueMeta>() {
        return {
          /**
           * Create the queue builder with configuration
           */
          create(config?: Partial<QueueConfig>): QueueBuilder<TContext, TMeta> {
            const fullConfig: QueueConfig = {
              transformer: config?.transformer ?? (superjson as DataTransformer),
              errorFormatter: config?.errorFormatter ?? (error => error),
              isDev: config?.isDev ?? process.env['NODE_ENV'] === 'development',
            };

            return createQueueBuilder<TContext, TMeta>(fullConfig);
          },
        };
      },

      /**
       * Create the queue builder without metadata
       */
      create(config?: Partial<QueueConfig>): QueueBuilder<TContext, QueueMeta> {
        return this.meta<QueueMeta>().create(config);
      },
    };
  },

  /**
   * Create the queue builder without context or metadata
   */
  create<TContext = Record<string, never>>(
    config?: Partial<QueueConfig>,
  ): QueueBuilder<TContext, QueueMeta> {
    return this.context<TContext>().create(config);
  },
};

/**
 * Create the queue builder implementation
 * @internal
 */
function createQueueBuilder<TContext, TMeta extends QueueMeta>(
  config: QueueConfig,
): QueueBuilder<TContext, TMeta> {
  // Create base job builder with empty middleware
  // Output context is JobContext<TContext> because runtime wraps user context with framework utilities
  const baseJobBuilder = createJobBuilder<TContext, JobContext<TContext>, TMeta>({
    config,
    middlewares: [],
  });

  // Middleware factory
  // By default, middleware maintains JobContext<TContext> as both input and output
  const middlewareFactory = <TContextIn = JobContext<TContext>, TContextOut = TContextIn>(
    fn: MiddlewareFunction<TContextIn, TContextOut, TMeta>,
  ): JobMiddleware<TContextIn, TContextOut, TMeta> => ({
    _type: 'middleware',
    _fn: fn,
  });

  // Registry factory (simple pass-through for now)
  const registryFactory = <TRegistry extends Record<string, unknown>>(jobs: TRegistry): TRegistry => {
    return jobs;
  };

  // Schedule builder factory
  const scheduleBuilderFactory: ScheduleBuilderFactory<TContext, TMeta> = {
    // Core Schedule Types
    cron: (pattern, options) => createScheduleBuilder<TContext, JobContext<TContext>, TMeta>('cron', pattern, options, config, []),
    interval: milliseconds => createScheduleBuilder<TContext, JobContext<TContext>, TMeta>('interval', milliseconds, undefined, config, []),
    timeout: milliseconds => createScheduleBuilder<TContext, JobContext<TContext>, TMeta>('timeout', milliseconds, undefined, config, []),

    // Time-Based Helpers
    everySeconds: n => createScheduleBuilder<TContext, JobContext<TContext>, TMeta>('cron', CronPatterns.everySeconds(n), undefined, config, []),
    everyMinutes: n => createScheduleBuilder<TContext, JobContext<TContext>, TMeta>('cron', CronPatterns.everyMinutes(n), undefined, config, []),
    everyHours: n => createScheduleBuilder<TContext, JobContext<TContext>, TMeta>('cron', CronPatterns.everyHours(n), undefined, config, []),

    // Daily Schedules
    daily: (time, options) => createScheduleBuilder<TContext, JobContext<TContext>, TMeta>('cron', CronPatterns.daily(time), options, config, []),
    weekdays: (time, options) => createScheduleBuilder<TContext, JobContext<TContext>, TMeta>('cron', CronPatterns.weekdays(time), options, config, []),
    weekends: (time, options) => createScheduleBuilder<TContext, JobContext<TContext>, TMeta>('cron', CronPatterns.weekends(time), options, config, []),

    // Weekly/Monthly Schedules
    weekly: (day, time, options) => createScheduleBuilder<TContext, JobContext<TContext>, TMeta>('cron', CronPatterns.weekly(day, time), options, config, []),
    monthly: (day, time, options) => createScheduleBuilder<TContext, JobContext<TContext>, TMeta>('cron', CronPatterns.monthly(day, time), options, config, []),
  };

  // Flow builder factory
  const flowBuilderFactory: FlowBuilderFactory<TContext, TMeta> = {
    name: (name: string) => createFlowBuilder<TContext, TMeta>(name, config),
  };

  return {
    _config: config,
    job: baseJobBuilder,
    middleware: middlewareFactory,
    registry: registryFactory,
    schedule: scheduleBuilderFactory,
    flow: flowBuilderFactory,
    createQueue: (options: QueueInstanceOptions<TContext>) => {
      return createQueueInstance<TContext>(options);
    },
  };
}
