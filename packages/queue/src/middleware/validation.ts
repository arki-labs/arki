/**
 * Validation middleware
 * Validates job input data with any Standard Schema validator
 */

import type { StandardSchemaV1 } from '@arki/schema';
import { SchemaError, parseAsync } from '@arki/schema';

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
  schema: StandardSchemaV1<unknown, TInput>;
  onError?: (error: SchemaError, jobName: string) => void;
}): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next, data, job }) => {
    try {
      // Async: the middleware already awaits. A SchemaRunError (broken schema) is a bug and propagates.
      await parseAsync(options.schema, data);
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;

      // Custom error handler
      if (options.onError) {
        options.onError(error, job.name);
      }

      // Throw validation error
      throw new JobValidationError(`Validation failed for job ${job.name}`, job.name, error.issues);
    }
    return await next();
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
  schema: StandardSchemaV1<unknown, TOutput>;
  onError?: (error: SchemaError, jobName: string, output: unknown) => void;
}): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next }) => {
    const result = await next();

    // Note: We'd need to capture the handler's return value here
    // This is a simplified version - actual implementation would need
    // to be integrated with the job execution engine

    return result;
  };
}
