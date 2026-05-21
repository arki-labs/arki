import { createRouterClient } from '@orpc/server';

import { authRouter } from './features/auth';

import type { ORPCContext } from './core/context';

/**
 * The primary router for the application.
 * All feature routers are composed here as a plain object.
 * No wrapper function needed — oRPC routers are just plain objects.
 */
export const appRouter = {
  auth: authRouter,
};

export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for direct procedure invocation (no HTTP round-trip).
 * Useful in server functions and other server-side contexts.
 *
 * @example
 * const caller = createCaller(() => createRPCContext({ headers, auth }));
 * const profile = await caller.auth.getProfile();
 */
export const createCaller = (context: () => ORPCContext | Promise<ORPCContext>) =>
  createRouterClient(appRouter, { context });

export { createRPCContext } from './core/context';
export type { ORPCContext } from './core/context';
