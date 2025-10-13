/**
 * Error handling middleware
 * Catches and formats errors during job execution
 */

import type { MiddlewareFunction } from '../types/middleware.ts';
import type { QueueMeta } from '../types/queue.ts';

/**
 * Standard error handling middleware
 * Catches errors and formats them consistently
 *
 * @example
 * ```typescript
 * const baseJob = q.job.use(errorHandlingMiddleware());
 * ```
 */
export function errorHandlingMiddleware<TContext>(): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next, job }) => {
    try {
      return await next();
    } catch (error) {
      // Log the error with job context
      console.error(`[${job.name}] Job failed:`, {
        jobId: job.id,
        jobName: job.name,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Re-throw the error so BullMQ can handle retries
      throw error;
    }
  };
}

/**
 * Custom error class for job failures
 */
export class JobError extends Error {
  constructor(
    message: string,
    public readonly jobName: string,
    public readonly jobId: string | undefined,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'JobError';
  }
}

/**
 * Error handling middleware with custom formatter
 *
 * @example
 * ```typescript
 * const baseJob = q.job.use(
 *   errorHandlingMiddleware({
 *     formatter: (error) => ({
 *       message: error.message,
 *       code: error.code,
 *     }),
 *   })
 * );
 * ```
 */
export function errorHandlingMiddlewareWithFormatter<TContext>(options: {
  formatter?: (error: Error) => unknown;
  onError?: (error: Error, jobName: string, jobId: string | undefined) => void | Promise<void>;
}): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next, job }) => {
    try {
      return await next();
    } catch (error) {
      const formattedError = options.formatter && error instanceof Error ? options.formatter(error) : error;

      // Custom error handler
      if (options.onError && error instanceof Error) {
        await options.onError(error, job.name, job.id);
      }

      // Log formatted error
      console.error(`[${job.name}] Job failed:`, {
        jobId: job.id,
        jobName: job.name,
        error: formattedError,
      });

      // Re-throw original error
      throw error;
    }
  };
}
