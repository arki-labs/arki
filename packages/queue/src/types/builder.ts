/**
 * Core builder types for @arki/queue
 * Inspired by tRPC's builder pattern
 */

import type { JobsOptions, Queue } from 'bullmq';

import type { StandardSchemaV1 } from '@arki/schema';

import type { QueueConnection } from '../redis-connection.ts';
import type { JobContext, JobDefinition, JobOptions, TriggerOptions } from './job.ts';
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
    connection: QueueConnection;
    keyPrefix?: string;
    createContext: () => TContext | Promise<TContext>;
  }) => BullMQQueueInstance;
};

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
  name(name: string): JobBuilderNeedsInput<TContext, TContextOut, TMeta>;
};

/**
 * Job builder after name is set, before input is set.
 * Has no `.handler()`: calling it here is a compile error ("Call .input() first").
 *
 * @template TContext - The base context type provided by createContext
 * @template TContextOut - The current output context type (after middleware chain)
 * @template TMeta - Metadata type for the queue
 */
export type JobBuilderNeedsInput<TContext, TContextOut, TMeta extends QueueMeta> = {
  /**
   * Set input schema (unlocks `.handler()`)
   */
  input<TNewInput>(schema: StandardSchemaV1<unknown, TNewInput>): JobBuilderChain<TContext, TContextOut, TMeta, TNewInput, never>;

  /**
   * Set job options
   */
  options(options: JobOptions): JobBuilderNeedsInput<TContext, TContextOut, TMeta>;
};

/**
 * Job builder chain - after name and input are set
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
  input<TNewInput>(schema: StandardSchemaV1<unknown, TNewInput>): JobBuilderChain<TContext, TContextOut, TMeta, TNewInput, TOutput>;

  /**
   * Set job options
   */
  options(options: JobOptions): JobBuilderChain<TContext, TContextOut, TMeta, TInput, TOutput>;

  /**
   * Set handler function (completes the builder)
   */
  handler<TResult>(
    handler: (data: TInput, ctx: TContextOut) => Promise<TResult>,
  ): JobDefinition<TInput, TResult, TContextOut>;
};

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
  monthly(
    day: number,
    time: string,
    options?: { timezone?: string },
  ): ScheduleBuilderDef<TContext, JobContext<TContext>, TMeta>;
};

/**
 * Schedule builder definition
 *
 * A schedule is a trigger: `.job(j).data(d)` adds `d` to `j`'s own queue on
 * each tick, the same as `j.trigger(d)`, and `j`'s worker runs it with `j`'s
 * own middleware. An inline schedule (`.name().input().handler()`) is an
 * anonymous job; its `.use()` chain is that job's middleware.
 */
export type ScheduleBuilderDef<TContext, TContextOut, TMeta extends QueueMeta> = {
  /**
   * Add middleware to the inline schedule's handler. A schedule that wraps a
   * job has no middleware of its own, so the builder this returns has no `.job()`.
   */
  use<TContextOut2>(
    middleware: JobMiddleware<TContextOut, TContextOut2, TMeta>,
  ): ScheduleBuilderWithMiddleware<TContext, TContextOut2, TMeta>;

  /**
   * Wrap an existing job: each tick adds `.data()` to the job's own queue.
   * Any built job fits: its own worker runs it, with its own middleware and context.
   */
  job<TInput>(job: JobDefinition<TInput, unknown, never>): ScheduleJobWrapper<TInput>;

  /**
   * Name the schedule (defaults to `<job name>-schedule` for `.job()`; required for an inline handler)
   */
  name(name: string): ScheduleBuilderNamed<TContext, TContextOut, TMeta>;
};

/**
 * Schedule builder after `.use()`: only an inline handler can follow.
 * Has no `.job()`: wrapping a job here is a compile error (the job's own middleware applies).
 */
export type ScheduleBuilderWithMiddleware<TContext, TContextOut, TMeta extends QueueMeta> = {
  /**
   * Add more middleware to the inline schedule's handler
   */
  use<TContextOut2>(
    middleware: JobMiddleware<TContextOut, TContextOut2, TMeta>,
  ): ScheduleBuilderWithMiddleware<TContext, TContextOut2, TMeta>;

  /**
   * Set name for inline handler
   */
  name(name: string): ScheduleBuilderNeedsInput<TContext, TContextOut, TMeta>;
};

/**
 * Schedule builder after `.name()` with no middleware: wrap a job, or set
 * the input of an inline handler. Has no `.handler()` until `.input()` runs.
 */
export type ScheduleBuilderNamed<TContext, TContextOut, TMeta extends QueueMeta> = {
  /**
   * Wrap an existing job under this schedule name
   */
  job<TInput>(job: JobDefinition<TInput, unknown, never>): ScheduleJobWrapper<TInput>;

  /**
   * Set input schema (unlocks `.handler()`)
   */
  input<TNewInput>(
    schema: StandardSchemaV1<unknown, TNewInput>,
  ): ScheduleBuilderChain<TContext, TContextOut, TMeta, TNewInput, never>;
};

/**
 * Schedule builder after name is set, before input is set.
 * Has no `.handler()`: calling it here is a compile error ("Call .input() first").
 */
export type ScheduleBuilderNeedsInput<TContext, TContextOut, TMeta extends QueueMeta> = {
  /**
   * Set input schema (unlocks `.handler()`)
   */
  input<TNewInput>(
    schema: StandardSchemaV1<unknown, TNewInput>,
  ): ScheduleBuilderChain<TContext, TContextOut, TMeta, TNewInput, never>;
};

/**
 * Schedule job wrapper - for setting data
 */
export type ScheduleJobWrapper<TInput> = {
  /**
   * Set the data to pass to the job
   */
  data(data: TInput): ScheduleDefinition;
};

/**
 * Schedule builder chain - after name and input are set
 */
export type ScheduleBuilderChain<TContext, TContextOut, TMeta extends QueueMeta, TInput, TOutput> = {
  /**
   * Set input schema
   */
  input<TNewInput>(
    schema: StandardSchemaV1<unknown, TNewInput>,
  ): ScheduleBuilderChain<TContext, TContextOut, TMeta, TNewInput, TOutput>;

  /**
   * Set handler function (completes the builder)
   */
  handler<TResult>(handler: (data: TInput, ctx: TContextOut) => Promise<TResult>): ScheduleDefinition;
};

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
  input<TInput>(schema: StandardSchemaV1<unknown, TInput>): FlowBuilderNeedsStep<TContext, TMeta, TInput>;
};

/**
 * Flow builder after input is set, before the first step.
 * Has no `.build()`: building a flow with no steps is a compile error.
 */
export type FlowBuilderNeedsStep<TContext, TMeta extends QueueMeta, TInput> = {
  /**
   * Add the first step to the flow (unlocks `.build()`)
   */
  step<const TId extends string, TStepInput>(
    id: TId,
    config: {
      /** Any built job: a step job runs on its own worker, with its own middleware and context. */
      job: JobDefinition<TStepInput, unknown, never>;
      /** Maps the flow input to the step job's input. */
      data: (input: TInput) => NoInfer<TStepInput>;
      /** BullMQ options for this step's job, over the job's own defaults (retry, `bullmqOptions`). */
      opts?: FlowStepOptions;
      /** Steps that must finish first. Each step may be in the `dependsOn` of at most one other step. */
      dependsOn?: readonly string[];
    },
  ): FlowBuilderWithInput<TContext, TMeta, TInput>;
};

/**
 * Flow builder with input and at least one step - can add steps and build.
 * Flows have no `.use()`: each step runs in its own job's worker, with that job's middleware.
 */
export type FlowBuilderWithInput<TContext, TMeta extends QueueMeta, TInput> = {
  /**
   * Add a step to the flow
   */
  step<const TId extends string, TStepInput>(
    id: TId,
    config: {
      /** Any built job: a step job runs on its own worker, with its own middleware and context. */
      job: JobDefinition<TStepInput, unknown, never>;
      /** Maps the flow input to the step job's input. */
      data: (input: TInput) => NoInfer<TStepInput>;
      /** BullMQ options for this step's job, over the job's own defaults (retry, `bullmqOptions`). */
      opts?: FlowStepOptions;
      /** Steps that must finish first. Each step may be in the `dependsOn` of at most one other step. */
      dependsOn?: readonly string[];
    },
  ): FlowBuilderWithInput<TContext, TMeta, TInput>;

  /**
   * Build the final flow definition
   */
  build(): FlowDefinition<TInput>;
};

/**
 * BullMQ options of one flow step's job. `parent` and `repeat` are owned by
 * the flow (the tree sets parents; a flow step does not repeat).
 */
export type FlowStepOptions = Omit<JobsOptions, 'parent' | 'repeat' | 'deduplication'>;

/**
 * Flow definition. Start one with `enqueue(flow, input)`.
 */
export type FlowDefinition<TInput = unknown> = {
  _type: 'flow';
  _internal: unknown;
  /** Type-only: carries the input type so `enqueue(flow, input)` infers it. Never set at runtime. */
  readonly _input?: TInput;
};

/** What `enqueue(flow, input)` created: the BullMQ job id of every step, by step id. */
export type FlowEnqueueResult = {
  readonly flow: string;
  readonly jobIds: Readonly<Record<string, string>>;
};

/**
 * Add one job to its queue (returns its BullMQ job id), or start one flow
 * (validates `input` with the flow's schema, then adds every step's job).
 */
export type QueueEnqueue = {
  <TInput, TOutput, TContext>(
    job: JobDefinition<TInput, TOutput, TContext>,
    data: TInput,
    options?: TriggerOptions,
  ): Promise<string>;
  <TInput>(flow: FlowDefinition<TInput>, input: NoInfer<TInput>): Promise<FlowEnqueueResult>;
};

/**
 * Options of `QueueInstance.register()`.
 */
export type RegisterOptions = {
  /**
   * The services each top-level branch of the registry runs with, by its key. `queueWorker()`
   * keys the registry by feature name, so a feature's jobs see its own services as `ctx.services`.
   */
  readonly services?: Readonly<Record<string, object>>;
};

/**
 * Queue instance that can register and run jobs
 */
export type QueueInstance = {
  /**
   * Register a job registry
   */
  register(registry: Record<string, unknown>, options?: RegisterOptions): Promise<void>;

  /**
   * Start all registered workers
   */
  start(): Promise<void>;

  /**
   * Stop all workers and close connections
   */
  stop(): Promise<void>;
};

/**
 * The BullMQ-backed queue instance. Adds a read-only view of its BullMQ queues, for tools that read job state
 * (for example the Foreman failed-job source). The runtime-local instance is a plain `QueueInstance`.
 */
export type BullMQQueueInstance = QueueInstance & {
  /** The BullMQ `Queue` of every registered job, by queue name. Empty until `register()` runs. */
  queues(): ReadonlyMap<string, Queue>;
  /** Add a registered job (like its `trigger()`), or start a flow. */
  enqueue: QueueEnqueue;
};
