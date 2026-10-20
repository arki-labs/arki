/**
 * Middleware types for @arki/queue
 * Inspired by tRPC's middleware system
 */

import type { JobLike } from './job.ts';
import type { QueueMeta } from './queue.ts';

/**
 * Middleware function signature
 * Similar to tRPC middleware but adapted for job processing
 */
export type MiddlewareFunction<TContextOut1, TContextOut2, TMeta extends QueueMeta, TFailure = never> = (opts: {
  /**
   * Current context (from previous middleware or base context)
   */
  ctx: TContextOut1;

  /**
   * Job data
   */
  data: unknown;

  /**
   * The job that runs: a BullMQ `Job`, or the same shape from another lane
   */
  job: JobLike;

  /**
   * Metadata (can be used for tracking, logging, etc.)
   */
  meta: TMeta;

  /**
   * Call the next middleware, or the handler after the last one.
   * Resolves only once everything inside has finished, handler included, and
   * rejects with the handler's error, so `try { return await next() } finally { ... }`
   * wraps the handler. Can optionally replace the context for what follows.
   */
  next: (opts?: { ctx?: TContextOut2 }) => Promise<MiddlewareResult<TContextOut2>>;
}) => Promise<MiddlewareResult<TContextOut2> | TFailure>;

/**
 * Result from middleware execution
 */
export type MiddlewareResult<TContext> = {
  /**
   * The context to pass to the next middleware/handler
   */
  ctx: TContext;

  /**
   * What the handler returned, as seen from `await next()`.
   * Unset when a middleware returns without calling `next()`.
   */
  readonly output?: unknown;
};

/**
 * Job middleware wrapper
 * Contains the middleware function and type information
 */
export type JobMiddleware<TContextOut1, TContextOut2, TMeta extends QueueMeta, TFailure = never> = {
  _type: 'middleware';
  _fn: MiddlewareFunction<TContextOut1, TContextOut2, TMeta, TFailure>;
};

/**
 * Helper type to extract context type from middleware
 */
export type MiddlewareContext<T> = T extends JobMiddleware<unknown, infer TContextOut, QueueMeta> ? TContextOut : never;

/**
 * Helper type for middleware chain
 * Computes the final context type after applying a chain of middleware
 */
export type MiddlewareChainContext<
  TContext,
  TMiddlewares extends readonly JobMiddleware<unknown, unknown, QueueMeta>[],
> = TMiddlewares extends readonly [infer First, ...infer Rest]
  ? First extends JobMiddleware<unknown, infer TOut, QueueMeta>
    ? Rest extends readonly JobMiddleware<unknown, unknown, QueueMeta>[]
      ? MiddlewareChainContext<TOut, Rest>
      : TOut
    : TContext
  : TContext;

/**
 * Compute the final context type from a middleware chain
 * This type helper recursively processes middleware to determine the final output context
 *
 * @template TInitialContext - The starting context type (before any middleware)
 * @template TMiddlewares - Tuple of middleware in the chain
 *
 * @example
 * type MyMiddlewares = [
 *   JobMiddleware<BaseCtx, BaseCtx & { user: User }, Meta>,
 *   JobMiddleware<BaseCtx & { user: User }, BaseCtx & { user: User, db: DB }, Meta>
 * ];
 * type FinalCtx = ComputeFinalContext<BaseCtx, MyMiddlewares>;
 * // Result: BaseCtx & { user: User, db: DB }
 */
export type ComputeFinalContext<TInitialContext, TMiddlewares extends readonly unknown[]> =
  // If empty array, return initial context
  TMiddlewares extends readonly []
    ? TInitialContext
    : // If has elements, process first middleware
      TMiddlewares extends readonly [infer First, ...infer Rest]
      ? // Check if First is a middleware and extract its output type
        First extends JobMiddleware<unknown, infer TOut, QueueMeta>
        ? // Recursively process remaining middleware with the output of this one
          ComputeFinalContext<TOut, Rest>
        : // If not a valid middleware, just use initial context
          TInitialContext
      : // Fallback to initial context
        TInitialContext;
