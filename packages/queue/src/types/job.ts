/**
 * Job-specific types
 */

import type { JobsOptions, Queue, Worker, WorkerOptions } from 'bullmq';

import type { z } from '@arki/contracts';
import type { Backoff } from '@arki/resilience';

import type { JobMiddleware } from './middleware.ts';
import type { QueueMeta } from './queue.ts';

/**
 * What a handler and its middleware see of the job that runs. A BullMQ `Job` fits, and so
 * do the runtime-local queue's job and an outbox row (`@arki/queue/outbox`).
 */
export type JobLike = {
  /** The job id. Stable across retries: pass it on as an idempotency key. */
  readonly id?: string;
  readonly name: string;
  /** The stored input, before the schema parsed it. */
  readonly data: unknown;
  /** Tries that failed before this one: 0 on the first try. */
  readonly attemptsMade: number;
  updateProgress(progress: number): Promise<unknown>;
  log(message: string): Promise<unknown>;
};

/**
 * Context provided to job handlers
 *
 * @template TDeps - Custom dependencies injected into the context
 */
export type JobContext<TDeps = Record<string, never>> = {
  /**
   * Update job progress (0-100)
   */
  updateProgress: (progress: number) => Promise<void>;

  /**
   * Log a message for this job
   */
  log: (message: string) => Promise<void>;

  /**
   * The job that runs: a BullMQ `Job`, or the same shape from another lane
   */
  job: JobLike;
} & TDeps;

/**
 * Handler function for processing jobs
 */
export type JobHandler<TInput, TOutput, TDeps = Record<string, never>> = (
  data: TInput,
  ctx: JobContext<TDeps>,
) => Promise<TOutput>;

/**
 * Options for job definitions
 */
export type JobOptions = {
  maxParallelism?: number;
  /**
   * When a failed job runs again, and how long it waits first: a `backoff` from
   * `@arki/resilience` (re-exported here). Default: `backoff.exponential({ base: 1000 }).upTo(2)`,
   * so 3 tries in all, 1 s and then 2 s apart.
   */
  retry?: Backoff;
  bullmqOptions?: Partial<JobsOptions>;
  workerOptions?: Partial<WorkerOptions>;
};

/**
 * Internal job definition structure
 */
export type InternalJobDefinition<TInput, TOutput, TDeps = Record<string, never>> = {
  name: string;
  inputSchema: z.ZodType<TInput>;
  handler: JobHandler<TInput, TOutput, TDeps>;
  options?: JobOptions;
  middlewares: readonly JobMiddleware<unknown, unknown, QueueMeta>[];
  _queue?: Queue;
  _worker?: Worker;
};

/**
 * Options for triggering a job
 */
export type TriggerOptions = {
  /** Job priority (lower number = higher priority) */
  priority?: QueuePriority;
  /** Delay in milliseconds before processing */
  delay?: number;
  /** Custom job ID (defaults to auto-generated) */
  jobId?: string;
  /** Additional BullMQ job options */
  bullmqOptions?: Partial<JobsOptions>;
};

/**
 * Job definition created by job builder
 */
export type JobDefinition<TInput, TOutput, TDeps = Record<string, never>> = {
  _type: 'job';
  _internal: InternalJobDefinition<TInput, TOutput, TDeps>;
  /**
   * Trigger a job with the given input data
   * @param data - Input data for the job
   * @param options - Optional trigger options (priority, delay, etc.)
   * @returns Promise resolving to the job ID
   */
  trigger: (data: TInput, options?: TriggerOptions) => Promise<string>;
};

/**
 * Any job definition, whatever its input, output and context types.
 *
 * Input and context sit in parameter positions, so `JobDefinition<I, O, C>` is
 * not assignable to `JobDefinition<unknown, unknown, unknown>`. Typing those
 * parameters `never` makes every built job assignable here; use it to store
 * jobs of different types side by side (e.g. flow steps), never to call them.
 */
export type AnyJobDefinition = {
  _type: 'job';
  _internal: Omit<InternalJobDefinition<unknown, unknown>, 'handler'> & {
    handler: (data: never, ctx: never) => Promise<unknown>;
  };
  trigger: (data: never, options?: TriggerOptions) => Promise<string>;
};

/**
 * Standard priority levels for jobs
 */
export const QUEUE_PRIORITIES = {
  CRITICAL: 1,
  HIGH: 3,
  NORMAL: 5,
  LOW: 7,
  BACKGROUND: 10,
} as const;

export type QueuePriority = (typeof QUEUE_PRIORITIES)[keyof typeof QUEUE_PRIORITIES];
