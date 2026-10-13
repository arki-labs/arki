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
 * Run a job's middleware chain around its handler (onion order).
 * Similar to tRPC's middleware execution but adapted for jobs
 *
 * The handler is the innermost `next()`: each middleware's `next()` resolves
 * only after everything inside it, handler included, has finished, and
 * rejects with the handler's error. `next({ ctx })` replaces the context for
 * what follows. Both the BullMQ and the runtime-local queue run jobs here.
 *
 * @param middlewares - Array of middleware to execute
 * @param initialContext - The starting context (from createContext)
 * @param data - Job data
 * @param job - BullMQ job instance
 * @param meta - Queue metadata
 * @param handler - The job handler, called with the context the last middleware passed on
 * @returns What the handler returned, or `undefined` when a middleware returned without calling `next()`
 */
export async function executeMiddlewareChain<TContext, TContextOut, TOutput>(
  middlewares: readonly JobMiddleware<unknown, unknown, QueueMeta>[],
  initialContext: TContext,
  data: unknown,
  job: BullMQJob,
  meta: QueueMeta,
  handler: (ctx: TContextOut) => Promise<TOutput>,
): Promise<TOutput | undefined> {
  debugMiddleware('[Job %s] Starting middleware chain with %d middleware', job.id, middlewares.length);

  let output: TOutput | undefined;

  // Create the next function that will be passed to middleware
  const createNext = (index: number, ctx: unknown) => {
    return async (opts?: { ctx?: unknown }): Promise<MiddlewareResult<unknown>> => {
      // If context was provided, use it
      const currentContext = opts?.ctx === undefined ? ctx : opts.ctx;

      // Past the last middleware: run the handler inside every middleware's next()
      if (index >= middlewares.length) {
        debugMiddleware('[Job %s] Reached end of middleware chain, running handler', job.id);
        output = await handler(currentContext as TContextOut);
        return { ctx: currentContext, output };
      }

      // Execute the next middleware in the chain
      const middleware = middlewares[index]!;

      debugMiddleware('[Job %s] Executing middleware %d/%d', job.id, index + 1, middlewares.length);

      const result = await middleware._fn({
        ctx: currentContext,
        data,
        job,
        meta,
        next: createNext(index + 1, currentContext),
      });

      debugMiddleware('[Job %s] Middleware %d/%d completed', job.id, index + 1, middlewares.length);

      return result;
    };
  };

  await createNext(0, initialContext)();
  debugMiddleware('[Job %s] Middleware chain completed successfully', job.id);
  return output;
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
