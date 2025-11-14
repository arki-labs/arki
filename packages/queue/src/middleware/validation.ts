/**
 * Validation middleware
 * Validates job input data with Zod schemas
 */

import type { z } from '@arki/contracts';

import type { MiddlewareFunction } from '../types/middleware.ts';
import type { QueueMeta } from '../types/queue.ts';

/**
 * Validation error for job input
 */
export class JobValidationError extends Error {
  constructor(
    message: string,
    public readonly jobName: string,
    public readonly errors: unknown,
  ) {
    super(message);
    this.name = 'JobValidationError';
  }
}

/**
 * Validation middleware
 * Automatically validates input data using the job's input schema
 * Note: This is typically handled automatically by the job builder,
 * but can be used explicitly if needed
 *
 * @example
 * ```typescript
 * const baseJob = q.job.use(validationMiddleware());
 * ```
 */
export function validationMiddleware<TContext>(): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next }) => {
    // Validation is typically handled by the job builder
    // This middleware is a no-op placeholder for now
    return await next();
  };
}

/**
 * Custom validation middleware
 * Validates data with a custom schema
 *
 * @example
 * ```typescript
 * const baseJob = q.job.use(
 *   customValidationMiddleware({
 *     schema: z.object({
 *       userId: z.string(),
 *       email: z.email(),
 *     }),
 *   })
 * );
 * ```
 */
export function customValidationMiddleware<TContext, TInput>(options: {
  schema: z.ZodType<TInput>;
  onError?: (error: z.ZodError, jobName: string) => void;
}): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next, data, job }) => {
    try {
      // Validate input data
      options.schema.parse(data);
      return await next();
    } catch (error) {
      if (error instanceof Error && 'issues' in error) {
        const zodError = error as z.ZodError;

        // Custom error handler
        if (options.onError) {
          options.onError(zodError, job.name);
        }

        // Throw validation error
        throw new JobValidationError(`Validation failed for job ${job.name}`, job.name, zodError.issues);
      }

      throw error;
    }
  };
}

/**
 * Output validation middleware
 * Validates the job's output/result
 *
 * @example
 * ```typescript
 * const baseJob = q.job.use(
 *   outputValidationMiddleware({
 *     schema: z.object({
 *       success: z.boolean(),
 *       message: z.string(),
 *     }),
 *   })
 * );
 * ```
 */
export function outputValidationMiddleware<TContext, TOutput>(_options: {
  schema: z.ZodType<TOutput>;
  onError?: (error: z.ZodError, jobName: string, output: unknown) => void;
}): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next }) => {
    const result = await next();

    // Note: We'd need to capture the handler's return value here
    // This is a simplified version - actual implementation would need
    // to be integrated with the job execution engine

    return result;
  };
}
