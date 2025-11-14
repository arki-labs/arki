/**
 * Job-specific types
 */

import type { Job as BullMQJob, JobsOptions, Queue, Worker, WorkerOptions } from 'bullmq';

import type { z } from '@arki/contracts';

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
 * Retry backoff strategies
 */
export type BackoffStrategy =
  | {
      /**
       * Fixed delay between retries
       * Example: 1000ms, 1000ms, 1000ms
       */
      type: 'fixed';
      /** Delay in milliseconds */
      delay: number;
    }
  | {
      /**
       * Exponential backoff: delay * (base ^ attempt)
       * Example with base=2: 1000ms, 2000ms, 4000ms, 8000ms
       */
      type: 'exponential';
      /** Initial delay in milliseconds */
      delay: number;
      /** Base for exponential calculation (default: 2) */
      base?: number;
    }
  | {
      /**
       * Linear backoff: delay * attempt
       * Example: 1000ms, 2000ms, 3000ms, 4000ms
       */
      type: 'linear';
      /** Base delay in milliseconds */
      delay: number;
    }
  | {
      /**
       * Polynomial backoff: delay * (attempt ^ power)
       * Example with power=2: 1000ms, 4000ms, 9000ms, 16000ms
       */
      type: 'polynomial';
      /** Base delay in milliseconds */
      delay: number;
      /** Power for polynomial calculation (default: 2) */
      power?: number;
    }
  | {
      /**
       * Exponential backoff with jitter to prevent thundering herd
       * Adds randomness: delay * (base ^ attempt) * (1 + random * jitter)
       * Example with base=2, jitter=0.3: 1000-1300ms, 2000-2600ms, 4000-5200ms
       */
      type: 'exponential-jitter';
      /** Initial delay in milliseconds */
      delay: number;
      /** Base for exponential calculation (default: 2) */
      base?: number;
      /** Jitter factor (0-1, default: 0.1) */
      jitter?: number;
    }
  | {
      /**
       * Fibonacci backoff: Uses Fibonacci sequence multiplied by delay
       * Example: 1s, 1s, 2s, 3s, 5s, 8s, 13s, 21s
       * Less aggressive than exponential, more than linear
       */
      type: 'fibonacci';
      /** Base delay in milliseconds */
      delay: number;
    }
  | {
      /**
       * Decorrelated jitter (AWS recommended)
       * Random between base_delay and previous_delay * 3
       * Best distribution to prevent thundering herd
       */
      type: 'decorrelated-jitter';
      /** Base delay in milliseconds */
      delay: number;
      /** Multiplier for previous delay (default: 3) */
      multiplier?: number;
    }
  | {
      /**
       * Full jitter (AWS strategy)
       * Random between 0 and exponential_delay
       * Maximum randomness to prevent synchronized retries
       */
      type: 'full-jitter';
      /** Initial delay in milliseconds */
      delay: number;
      /** Base for exponential calculation (default: 2) */
      base?: number;
    }
  | {
      /**
       * Equal jitter (AWS strategy)
       * Half fixed + half random: (delay/2) + random(0, delay/2)
       * Balances predictability with randomness
       */
      type: 'equal-jitter';
      /** Initial delay in milliseconds */
      delay: number;
      /** Base for exponential calculation (default: 2) */
      base?: number;
    }
  | {
      /**
       * Constant then exponential hybrid
       * Initial constant delays, then switches to exponential
       * Ensures minimum retry interval before aggressive backoff
       */
      type: 'constant-then-exponential';
      /** Delay for constant phase in milliseconds */
      constantDelay: number;
      /** Number of attempts with constant delay */
      constantAttempts: number;
      /** Initial delay for exponential phase in milliseconds */
      exponentialDelay: number;
      /** Base for exponential calculation (default: 2) */
      base?: number;
    }
  | {
      /**
       * Stepped/tiered backoff
       * Different delays for different ranges of attempts
       * Provides fine-grained control over retry timing
       */
      type: 'stepped';
      /** Tier definitions with max attempt and delay */
      tiers: Array<{
        /** Maximum attempt number for this tier (use Infinity for last tier) */
        maxAttempt: number;
        /** Delay in milliseconds for this tier */
        delay: number;
      }>;
    }
  | {
      /**
       * Custom backoff function
       * Provides full control over retry delay calculation
       */
      type: 'custom';
      /**
       * Custom function to calculate delay
       * @param attemptsMade - Number of attempts already made (0-indexed)
       * @param type - The type of the failed job (optional)
       * @param error - The error that caused the retry (optional)
       * @returns Delay in milliseconds before next retry, can be async
       */
      strategy: (attemptsMade: number, type?: string, error?: Error) => number | Promise<number>;
    };

/**
 * Retry configuration
 */
export type RetryConfig = {
  /** Maximum number of retry attempts */
  attempts: number;
  /** Backoff strategy for retries (optional, defaults to exponential) */
  backoff?: BackoffStrategy;
  /** Maximum delay cap in milliseconds (optional) */
  maxDelay?: number;
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
