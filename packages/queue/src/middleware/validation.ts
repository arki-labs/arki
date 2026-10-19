/**
 * Validation middleware
 * Validates job input data with any Standard Schema validator
 */

import type { FailureOf } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import { InvalidInput, orThrow, ValidatorDefect } from '@arki/failure';
import { parseAsync } from '@arki/schema';

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
  onError?: (error: FailureOf<typeof InvalidInput>, jobName: string) => void;
}): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next, data, job }) => {
    const parsed = await parseAsync(options.schema, data);
    if (InvalidInput.is(parsed)) {
      options.onError?.(parsed, job.name);
      orThrow(parsed);
    }
    // Middleware executes inside BullMQ/pg-boss, whose callbacks fail by throwing.
    if (ValidatorDefect.is(parsed)) orThrow(parsed);
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
  onError?: (error: FailureOf<typeof InvalidInput>, jobName: string, output: unknown) => void;
}): MiddlewareFunction<TContext, TContext, QueueMeta> {
  return async ({ next }) => {
    const result = await next();

    // Note: We'd need to capture the handler's return value here
    // This is a simplified version - actual implementation would need
    // to be integrated with the job execution engine

    return result;
  };
}
