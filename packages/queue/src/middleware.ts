/**
 * Middleware execution engine
 * Handles running a chain of middleware with context transformations
 */

import type { Job as BullMQJob } from 'bullmq';

import type { JobContext } from './types/job.ts';
import type { JobMiddleware, MiddlewareResult } from './types/middleware.ts';
import type { QueueMeta } from './types/queue.ts';

/**
 * Execute a chain of middleware
 * Similar to tRPC's middleware execution but adapted for jobs
 *
 * @param middlewares - Array of middleware to execute
 * @param initialContext - The starting context (from createContext)
 * @param data - Job data
 * @param job - BullMQ job instance
 * @param meta - Queue metadata
 * @returns The final context after all middleware have executed
 */
export async function executeMiddlewareChain<TContext, TContextOut>(
  middlewares: readonly JobMiddleware<unknown, unknown, QueueMeta>[],
  initialContext: TContext,
  data: unknown,
  job: BullMQJob,
  meta: QueueMeta,
): Promise<TContextOut> {
  let currentContext: unknown = initialContext;
  let currentIndex = 0;

  // Create the next function that will be passed to middleware
  const createNext = (index: number) => {
    return async (opts?: { ctx?: unknown }): Promise<MiddlewareResult<unknown>> => {
      // If context was provided, use it
      if (opts?.ctx !== undefined) {
        currentContext = opts.ctx;
      }

      // If we've reached the end of the middleware chain, return current context
      if (index >= middlewares.length) {
        return { ctx: currentContext };
      }

      // Execute the next middleware in the chain
      const middleware = middlewares[index]!;
      currentIndex = index + 1;

      const result = await middleware._fn({
        ctx: currentContext,
        data,
        job,
        meta,
        next: createNext(currentIndex),
      });

      currentContext = result.ctx;
      return result;
    };
  };

  // Start the middleware chain
  if (middlewares.length > 0) {
    const result = await createNext(0)();
    return result.ctx as TContextOut;
  }

  // No middleware, return initial context
  return currentContext as TContextOut;
}

/**
 * Create a job context with utility methods
 * Wraps the base context with updateProgress, log, and job instance
 *
 * @param baseContext - The context from middleware chain
 * @param job - BullMQ job instance
 * @returns JobContext with utility methods
 */
export function createJobContext<TContext>(baseContext: TContext, job: BullMQJob): JobContext<TContext> {
  return {
    ...baseContext,
    updateProgress: async (progress: number) => {
      await job.updateProgress(progress);
    },
    log: async (message: string) => {
      await job.log(message);
    },
    job,
  } as JobContext<TContext>;
}
