/**
 * Middleware types for @arki/queue
 * Inspired by tRPC's middleware system
 */

import type { Job as BullMQJob } from 'bullmq';

import type { QueueMeta } from './queue.ts';

/**
 * Middleware function signature
 * Similar to tRPC middleware but adapted for job processing
 */
export type MiddlewareFunction<TContextOut1, TContextOut2, TMeta extends QueueMeta> = (opts: {
  /**
   * Current context (from previous middleware or base context)
   */
  ctx: TContextOut1;

  /**
   * Job data
   */
  data: unknown;

  /**
   * The underlying BullMQ job instance
   */
  job: BullMQJob;

  /**
   * Metadata (can be used for tracking, logging, etc.)
   */
  meta: TMeta;

  /**
   * Call the next middleware or handler
   * Can optionally transform the context
   */
  next: (opts?: { ctx?: TContextOut2 }) => Promise<MiddlewareResult<TContextOut2>>;
}) => Promise<MiddlewareResult<TContextOut2>>;

/**
 * Result from middleware execution
 */
export type MiddlewareResult<TContext> = {
  /**
   * The context to pass to the next middleware/handler
   */
  ctx: TContext;
};

/**
 * Job middleware wrapper
 * Contains the middleware function and type information
 */
export type JobMiddleware<TContextOut1, TContextOut2, TMeta extends QueueMeta> = {
  _type: 'middleware';
  _fn: MiddlewareFunction<TContextOut1, TContextOut2, TMeta>;
};

/**
 * Helper type to extract context type from middleware
 */
export type MiddlewareContext<T> =
  T extends JobMiddleware<unknown, infer TContextOut, QueueMeta>
    ? TContextOut
    : never;

/**
 * Helper type for middleware chain
 * Computes the final context type after applying a chain of middleware
 */
export type MiddlewareChainContext<
  TContext,
  TMiddlewares extends readonly JobMiddleware<unknown, unknown, QueueMeta>[]
> =
  TMiddlewares extends readonly [infer First, ...infer Rest]
    ? First extends JobMiddleware<unknown, infer TOut, QueueMeta>
      ? Rest extends readonly JobMiddleware<unknown, unknown, QueueMeta>[]
        ? MiddlewareChainContext<TOut, Rest>
        : TOut
      : TContext
    : TContext;
