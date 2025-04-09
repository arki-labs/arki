import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

import { createCallerFactory, createTRPCRouter } from './core/trpc';

/**
 * This is the primary router for your server.
 * All routers are merged together to form a single router.
 */
export const appRouter = createTRPCRouter({});

// Export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.post.all();
 *       ^? Post[]
 */
const createCaller = createCallerFactory(appRouter);

/**
 * Inference helpers for input types
 * @example
 * type PostByIdInput = RouterInputs['post']['byId']
 *      ^? { id: number }
 **/
type RouterInputs = inferRouterInputs<AppRouter>;

/**
 * Inference helpers for output types
 * @example
 * type AllPostsOutput = RouterOutputs['post']['all']
 *      ^? Post[]
 **/
type RouterOutputs = inferRouterOutputs<AppRouter>;

export { createCaller };
export type { RouterInputs, RouterOutputs };

export { createTRPCContext } from './core/trpc';
