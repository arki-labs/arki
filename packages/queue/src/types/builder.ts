/**
 * Core builder types for @arki/queue
 * Inspired by tRPC's builder pattern
 */

import type { z } from '@arki/contracts';

import type { JobContext, JobDefinition, JobOptions } from './job.ts';
import type { JobMiddleware, MiddlewareFunction } from './middleware.ts';
import type { QueueConfig, QueueMeta } from './queue.ts';

/**
 * Queue builder returned by initQueue
 * Similar to tRPC's initTRPC builder
 */
export type QueueBuilder<TContext, TMeta extends QueueMeta = QueueMeta> = {
  /**
   * The configuration used to create this builder
   */
  readonly _config: QueueConfig;

  /**
   * Base job builder with no middleware
   * Similar to tRPC's base procedure
   * Output context is JobContext<TContext> because runtime wraps user context
   */
  readonly job: JobBuilderDef<TContext, JobContext<TContext>, TMeta>;

  /**
   * Create middleware for jobs
   *
   * By default, middleware maintains JobContext<TContext> as both input and output.
   * Provide explicit type parameters to transform context:
   * - middleware<MyContextIn, MyContextOut>(...) for full control
   * - middleware<MyContext>(...) to use same type for input and output
   */
  middleware: <TContextIn = JobContext<TContext>, TContextOut = TContextIn>(
    fn: MiddlewareFunction<TContextIn, TContextOut, TMeta>,
  ) => JobMiddleware<TContextIn, TContextOut, TMeta>;

  /**
   * Create a job registry for organizing jobs by feature
   */
  registry: <TRegistry extends Record<string, unknown>>(jobs: TRegistry) => TRegistry;

  /**
   * Create a schedule builder
   */
  schedule: ScheduleBuilderFactory<TContext, TMeta>;

  /**
   * Create a flow builder
   */
  flow: FlowBuilderFactory<TContext, TMeta>;

  /**
   * Create a queue instance that can register and run jobs
   */
  createQueue: (options: {
    connection: string | { host: string; port: number; password?: string };
    keyPrefix?: string;
    createContext: () => TContext | Promise<TContext>;
  }) => QueueInstance;
}

/**
 * Job builder definition - chainable builder for creating jobs
 * Similar to tRPC's procedure builder
 *
 * @template TContext - The base context type provided by createContext
 * @template TContextOut - The current output context type (after middleware chain)
 * @template TMeta - Metadata type for the queue
 */
export type JobBuilderDef<TContext, TContextOut, TMeta extends QueueMeta> = {
  /**
   * Add middleware to this job builder
   * Middleware can transform context, add logging, handle errors, etc.
   */
  use<TContextOut2>(
    middleware: JobMiddleware<TContextOut, TContextOut2, TMeta>,
  ): JobBuilderDef<TContext, TContextOut2, TMeta>;

  /**
   * Set the job name (starts the chainable builder)
   */
  name(name: string): JobBuilderChain<TContext, TContextOut, TMeta, never, never>;
}

/**
 * Job builder chain - after name is set
 *
 * @template TContext - The base context type provided by createContext
 * @template TContextOut - The current output context type (after middleware chain)
 * @template TMeta - Metadata type for the queue
 * @template TInput - Input data type for the job
 * @template TOutput - Output/return type for the job
 */
export type JobBuilderChain<TContext, TContextOut, TMeta extends QueueMeta, TInput, TOutput> = {
  /**
   * Set input schema
   */
  input<TNewInput>(schema: z.ZodType<TNewInput>): JobBuilderChain<TContext, TContextOut, TMeta, TNewInput, TOutput>;

  /**
   * Set job options
   */
  options(options: JobOptions): JobBuilderChain<TContext, TContextOut, TMeta, TInput, TOutput>;

  /**
   * Set handler function (completes the builder)
   */
  handler<THandlerInput = TInput, THandlerOutput = TOutput>(
    handler: (
      data: THandlerInput extends never ? TInput : THandlerInput,
      ctx: TContextOut,
    ) => Promise<THandlerOutput extends never ? TOutput : THandlerOutput>,
  ): JobDefinition<THandlerInput extends never ? TInput : THandlerInput, THandlerOutput extends never ? TOutput : THandlerOutput, TContextOut>;
}

/**
 * Schedule builder factory
 */
export type ScheduleBuilderFactory<TContext, TMeta extends QueueMeta> = {
  // ============================================
  // Core Schedule Types
  // ============================================

  /**
   * Create a cron-based schedule
   * Output context is JobContext<TContext> because runtime wraps user context
   */
  cron(pattern: string, options?: { timezone?: string }): ScheduleBuilderDef<TContext, JobContext<TContext>, TMeta>;

  /**
   * Create an interval-based schedule (repeating)
   * Output context is JobContext<TContext> because runtime wraps user context
   */
  interval(milliseconds: number): ScheduleBuilderDef<TContext, JobContext<TContext>, TMeta>;

  /**
   * Create a timeout-based schedule (one-time execution after delay)
   * Output context is JobContext<TContext> because runtime wraps user context
   *
   * @example
   * ```typescript
   * // Send reminder email once after 24 hours
   * const reminder = q.schedule
   *   .timeout(24 * 60 * 60 * 1000)
   *   .job(sendReminderJob)
   *   .data({ userId: 'usr_123' });
   * ```
   */
  timeout(milliseconds: number): ScheduleBuilderDef<TContext, JobContext<TContext>, TMeta>;

  // ============================================
  // Time-Based Helpers
  // ============================================

  /**
   * Every N seconds (requires 6-field cron support in BullMQ)
   *
   * @example
   * ```typescript
   * q.schedule.everySeconds(5).job(task).data({})  // Every 5 seconds
   * q.schedule.everySeconds(30).job(task).data({}) // Every 30 seconds
   * ```
   */
  everySeconds(n: number): ScheduleBuilderDef<TContext, JobContext<TContext>, TMeta>;

  /**
   * Every N minutes
   *
   * @example
   * ```typescript
   * q.schedule.everyMinutes(5).job(task).data({})  // Every 5 minutes
   * q.schedule.everyMinutes(15).job(task).data({}) // Every 15 minutes
   * ```
   */
  everyMinutes(n: number): ScheduleBuilderDef<TContext, JobContext<TContext>, TMeta>;

  /**
   * Every N hours
   *
   * @example
   * ```typescript
   * q.schedule.everyHours(2).job(task).data({})  // Every 2 hours
   * q.schedule.everyHours(6).job(task).data({})  // Every 6 hours
   * ```
   */
  everyHours(n: number): ScheduleBuilderDef<TContext, JobContext<TContext>, TMeta>;

  // ============================================
  // Daily Schedules
  // ============================================

  /**
   * Daily at specified time (HH:mm format)
   *
   * @example
   * ```typescript
   * q.schedule.daily('09:00').job(task).data({})                              // Every day at 9am
   * q.schedule.daily('14:30', { timezone: 'America/New_York' }).job(task).data({})  // Every day at 2:30pm ET
   * ```
   */
  daily(time: string, options?: { timezone?: string }): ScheduleBuilderDef<TContext, JobContext<TContext>, TMeta>;

  /**
   * Weekdays (Monday-Friday) at specified time
   *
   * @example
   * ```typescript
   * q.schedule.weekdays('09:00').job(task).data({})  // Weekdays at 9am
   * q.schedule.weekdays('17:30').job(task).data({})  // Weekdays at 5:30pm
   * ```
   */
  weekdays(time: string, options?: { timezone?: string }): ScheduleBuilderDef<TContext, JobContext<TContext>, TMeta>;

  /**
   * Weekends (Saturday-Sunday) at specified time
   *
   * @example
   * ```typescript
   * q.schedule.weekends('10:00').job(task).data({})  // Weekends at 10am
   * q.schedule.weekends('14:00').job(task).data({})  // Weekends at 2pm
   * ```
   */
  weekends(time: string, options?: { timezone?: string }): ScheduleBuilderDef<TContext, JobContext<TContext>, TMeta>;

  // ============================================
  // Weekly/Monthly Schedules
  // ============================================

  /**
   * Weekly on specific day at specified time
   *
   * @example
   * ```typescript
   * q.schedule.weekly('monday', '09:00').job(task).data({})  // Mondays at 9am
   * q.schedule.weekly('friday', '17:00').job(task).data({})  // Fridays at 5pm
   * ```
   */
  weekly(
    day: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday',
    time: string,
    options?: { timezone?: string },
  ): ScheduleBuilderDef<TContext, JobContext<TContext>, TMeta>;

  /**
   * Monthly on specific day at specified time
   *
   * @example
   * ```typescript
   * q.schedule.monthly(1, '09:00').job(task).data({})   // First day of month at 9am
   * q.schedule.monthly(15, '12:00').job(task).data({})  // 15th of month at noon
   * ```
   */
  monthly(day: number, time: string, options?: { timezone?: string }): ScheduleBuilderDef<TContext, JobContext<TContext>, TMeta>;
};

/**
 * Schedule builder definition
 */
export type ScheduleBuilderDef<TContext, TContextOut, TMeta extends QueueMeta> = {
  /**
   * Add middleware to this schedule
   */
  use<TContextOut2>(
    middleware: JobMiddleware<TContextOut, TContextOut2, TMeta>,
  ): ScheduleBuilderDef<TContext, TContextOut2, TMeta>;

  /**
   * Wrap an existing job
   */
  job<TInput>(job: JobDefinition<TInput, unknown, unknown>): ScheduleJobWrapper<TInput>;

  /**
   * Set name for inline handler
   */
  name(name: string): ScheduleBuilderChain<TContext, TContextOut, TMeta, never, never>;
}

/**
 * Schedule job wrapper - for setting data
 */
export type ScheduleJobWrapper<TInput> = {
  /**
   * Set the data to pass to the job
   */
  data(data: TInput): ScheduleDefinition;
}

/**
 * Schedule builder chain - after name is set
 */
export type ScheduleBuilderChain<TContext, TContextOut, TMeta extends QueueMeta, TInput, TOutput> = {
  /**
   * Set input schema
   */
  input<TNewInput>(schema: z.ZodType<TNewInput>): ScheduleBuilderChain<TContext, TContextOut, TMeta, TNewInput, TOutput>;

  /**
   * Set handler function (completes the builder)
   */
  handler<THandlerInput = TInput, THandlerOutput = TOutput>(
    handler: (
      data: THandlerInput extends never ? TInput : THandlerInput,
      ctx: TContextOut,
    ) => Promise<THandlerOutput extends never ? TOutput : THandlerOutput>,
  ): ScheduleDefinition;
}

/**
 * Schedule definition (opaque type for now)
 */
export type ScheduleDefinition = {
  _type: 'schedule';
  _internal: unknown;
};

/**
 * Flow builder factory
 */
export type FlowBuilderFactory<TContext, TMeta extends QueueMeta> = {
  /**
   * Create a new flow builder
   */
  name(name: string): FlowBuilderStart<TContext, TMeta>;
};

/**
 * Flow builder start - after name is set
 */
export type FlowBuilderStart<TContext, TMeta extends QueueMeta> = {
  /**
   * Set input schema
   */
  input<TInput>(schema: z.ZodType<TInput>): FlowBuilderWithInput<TContext, TMeta, TInput>;
}

/**
 * Flow builder with input - can add middleware and steps
 */
export type FlowBuilderWithInput<TContext, TMeta extends QueueMeta, TInput> = {
  /**
   * Add middleware to all steps
   */
  use(middleware: JobMiddleware<unknown, unknown, TMeta>): FlowBuilderWithInput<TContext, TMeta, TInput>;

  /**
   * Add a step to the flow
   */
  step<const TId extends string>(
    id: TId,
    config: {
      job: JobDefinition<unknown, unknown, unknown>;
      data: (input: TInput) => unknown;
      queueName?: string;
      opts?: unknown;
      dependsOn?: readonly string[];
    },
  ): FlowBuilderWithInput<TContext, TMeta, TInput>;

  /**
   * Build the final flow definition
   */
  build(): FlowDefinition;
}

/**
 * Flow definition (opaque type for now)
 */
export type FlowDefinition = {
  _type: 'flow';
  _internal: unknown;
};

/**
 * Queue instance that can register and run jobs
 */
export type QueueInstance = {
  /**
   * Register a job registry
   */
  register(registry: Record<string, unknown>): Promise<void>;

  /**
   * Start all registered workers
   */
  start(): Promise<void>;

  /**
   * Stop all workers and close connections
   */
  stop(): Promise<void>;
}
