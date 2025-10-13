/**
 * Job-specific types
 */

import type { Job as BullMQJob, JobsOptions, Queue, Worker, WorkerOptions } from 'bullmq';
import type { z } from 'zod/v4';

import type { JobMiddleware } from './middleware.ts';
import type { QueueMeta } from './queue.ts';

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
   * The underlying BullMQ job instance
   */
  job: BullMQJob;
} & TDeps;

/**
 * Handler function for processing jobs
 */
export type JobHandler<TInput, TOutput, TDeps = Record<string, never>> = (
  data: TInput,
  ctx: JobContext<TDeps>,
) => Promise<TOutput>;

/**
 * Retry configuration
 */
export type RetryConfig = {
  attempts: number;
  backoff:
    | {
        type: 'exponential';
        delay: number;
        base?: number;
      }
    | {
        type: 'fixed';
        delay: number;
      };
};

/**
 * Options for job definitions
 */
export type JobOptions = {
  maxParallelism?: number;
  retry?: RetryConfig;
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
 * Job definition created by job builder
 */
export type JobDefinition<TInput, TOutput, TDeps = Record<string, never>> = {
  _type: 'job';
  _internal: InternalJobDefinition<TInput, TOutput, TDeps>;
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
