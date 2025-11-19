/**
 * Middleware execution engine
 * Handles running a chain of middleware with context transformations
 */

import type { Job as BullMQJob } from 'bullmq';

import { debugMiddleware } from './debug.ts';
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
  debugMiddleware('[Job %s] Starting middleware chain with %d middleware', job.id, middlewares.length);

  let currentContext: unknown = initialContext;
  let currentIndex = 0;

  // Create the next function that will be passed to middleware
  const createNext = (index: number) => {
    return async (opts?: { ctx?: unknown }): Promise<MiddlewareResult<unknown>> => {
      // If context was provided, use it
      if (opts?.ctx !== undefined) {
        debugMiddleware('[Job %s] Context updated at middleware %d', job.id, index);
        currentContext = opts.ctx;
      }

      // If we've reached the end of the middleware chain, return current context
      if (index >= middlewares.length) {
        debugMiddleware('[Job %s] Reached end of middleware chain', job.id);
        return { ctx: currentContext };
      }

      // Execute the next middleware in the chain
      const middleware = middlewares[index]!;
      currentIndex = index + 1;

      debugMiddleware('[Job %s] Executing middleware %d/%d', job.id, index + 1, middlewares.length);

      const result = await middleware._fn({
        ctx: currentContext,
        data,
        job,
        meta,
        next: createNext(currentIndex),
      });

      debugMiddleware('[Job %s] Middleware %d/%d completed', job.id, index + 1, middlewares.length);

      currentContext = result.ctx;
      return result;
    };
  };

  // Start the middleware chain
  if (middlewares.length > 0) {
    const result = await createNext(0)();
    debugMiddleware('[Job %s] Middleware chain completed successfully', job.id);
    return result.ctx as TContextOut;
  }

  // No middleware, return initial context
  debugMiddleware('[Job %s] No middleware to execute, returning initial context', job.id);
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
  debugMiddleware('[Job %s] Creating job context with utility methods', job.id);

  return {
    ...baseContext,
    updateProgress: async (progress: number) => {
      debugMiddleware('[Job %s] Updating progress to %d%%', job.id, progress);
      await job.updateProgress(progress);
    },
    log: async (message: string) => {
      debugMiddleware('[Job %s] Logging message: %s', job.id, message);
      await job.log(message);
    },
    job,
  } as JobContext<TContext>;
}
