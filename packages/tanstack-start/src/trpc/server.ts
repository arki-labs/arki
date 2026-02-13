/**
 * tRPC Server Setup for TanStack Start
 *
 * Provides server-side tRPC configuration using server functions.
 */

import type { AnyTRPCRouter } from '@trpc/server';
import type { FetchHandlerOptions } from '@trpc/server/adapters/fetch';
import { createServerFn } from '@tanstack/react-start/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

export type TRPCServerConfig<TRouter extends AnyTRPCRouter> = {
  /**
   * The tRPC router
   */
  router: TRouter;

  /**
   * Create context function
   */
  createContext: FetchHandlerOptions<TRouter>['createContext'];

  /**
   * API endpoint path
   * @default '/api/trpc'
   */
  endpoint?: string;

  /**
   * Custom error handler
   */
  onError?: FetchHandlerOptions<TRouter>['onError'];

  /**
   * Response meta handler for caching headers
   */
  responseMeta?: FetchHandlerOptions<TRouter>['responseMeta'];
}

/**
 * Creates a tRPC handler for TanStack Start server functions
 *
 * @example
 * ```ts
 * // api/trpc.ts
 * import { createTRPCHandler } from '@arki/tanstack-start/trpc/server';
 * import { appRouter } from '@app/backend/api';
 * import { createContext } from './context';
 *
 * export const { handler, caller } = createTRPCHandler({
 *   router: appRouter,
 *   createContext,
 *   endpoint: '/api/trpc',
 * });
 * ```
 */
export function createTRPCHandler<TRouter extends AnyTRPCRouter>(config: TRPCServerConfig<TRouter>) {
  const { router, createContext, endpoint = '/api/trpc', onError, responseMeta } = config;

  /**
   * Fetch handler for tRPC requests
   */
  async function handler(request: Request): Promise<Response> {
    return fetchRequestHandler({
      endpoint,
      req: request,
      router,
      createContext,
      onError:
        onError ??
        (({ error, path }) => {
          console.error(`tRPC error on '${path}':`, error);
        }),
      responseMeta,
    });
  }

  /**
   * Server-side caller for invoking tRPC procedures directly
   */
  const caller = router.createCaller;

  return {
    handler,
    caller,
  };
}

/**
 * Creates a server function wrapper for tRPC-style procedure calls
 *
 * @example
 * ```ts
 * // features/users/server.ts
 * import { createServerProcedure } from '@arki/tanstack-start/trpc/server';
 *
 * export const getUser = createServerProcedure(async (id: string) => {
 *   const user = await db.users.findById(id);
 *   return user;
 * });
 * ```
 */
export function createServerProcedure<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
): (input: TInput) => Promise<TOutput> {
  return createServerFn({
    method: 'POST',
  }).handler(async ctx => {
    const input = (await ctx.request.json()) as TInput;
    return fn(input);
  }) as unknown as (input: TInput) => Promise<TOutput>;
}

/**
 * CORS headers for tRPC API routes
 */
export function getCorsHeaders(origin = '*'): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}



export {fetchRequestHandler} from '@trpc/server/adapters/fetch';
export {createServerFn} from '@tanstack/react-start/server';