import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from '@arki/contracts';
import { RateLimitExceededError } from '@arki/kv/errors';

import { debugTRPC } from '../debug.ts';
import type { DotContext } from './types';

/**
 * Initialize standard Dot tRPC procedures.
 *
 * This function creates a tRPC instance with standard middleware and procedures
 * that plugins can use. It provides:
 * - publicProcedure: For unauthenticated endpoints
 * - protectedProcedure: For authenticated endpoints
 * - router: For building routers
 * - mergeRouters: For combining routers
 * - middleware: For creating custom middleware
 *
 * Apps can provide custom middleware to extend behavior while maintaining
 * compatibility with plugins.
 *
 * @template TContext The context type (must extend DotContext)
 * @param options Configuration options
 * @returns Dot procedures object with standard procedures
 *
 * @example
 * ```ts
 * const procedures = createDotProcedures<AppContext>({
 *   isDevelopment: process.env.NODE_ENV === 'development',
 *   customMiddleware: {
 *     afterAuth: customRateLimitMiddleware,
 *   },
 * });
 * ```
 */
export function createDotProcedures(options?: {
  isDevelopment?: boolean;
  env?: Record<string, unknown>;
}) {
  const isDevelopment = options?.isDevelopment ?? options?.env?.['NODE_ENV'] === 'development';

  debugTRPC('[init] Creating Dot procedures (isDevelopment: %s)', isDevelopment);

  // Initialize tRPC with context type
  const t = initTRPC
    .context<DotContext>()
    .create({
      transformer: superjson,
      errorFormatter: ({ shape, error }) => ({
        ...shape,
        data: {
          ...shape.data,
          zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
        },
      }),
    });

  debugTRPC('[init] tRPC instance created with superjson transformer and error formatter');

  // Standard error handling middleware
  const defaultErrorMiddleware = t.middleware(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      // Handle rate limit errors
      if (error instanceof RateLimitExceededError) {
        debugTRPC('[middleware:error] Rate limit exceeded: %s', error.message);
        // Add a random delay to obscure timing differences
        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Rate limit exceeded. Try again later.',
          cause: isDevelopment ? error : undefined,
        });
      }

      // Re-throw known tRPC errors
      if (error instanceof TRPCError) {
        debugTRPC('[middleware:error] tRPC error: %s (code: %s)', error.message, error.code);
        throw error;
      }

      // Log unknown errors for debugging
      debugTRPC('[middleware:error] Unhandled error: %s', error instanceof Error ? error.message : String(error));
      console.error('Unhandled error in tRPC procedure:', error);

      // Throw a generic server error
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal server error occurred.',
        cause: isDevelopment ? error : undefined,
      });
    }
  });

  // Standard timing middleware
  const defaultTimingMiddleware = t.middleware(async ({ next, path }) => {
    const start = Date.now();

    // Add artificial delay in development to catch waterfalls
    if (isDevelopment) {
      const waitMs = Math.floor(Math.random() * 400) + 100;
      debugTRPC('[middleware:timing] Adding %dms artificial delay for %s (development mode)', waitMs, path);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    const result = await next();

    const end = Date.now();
    const duration = end - start;
    debugTRPC('[middleware:timing] %s took %dms to execute', path, duration);

    return result;
  });

  // Standard auth middleware
  const authMiddleware = t.middleware(({ ctx, next }) => {
    if (!ctx.session?.user) {
      debugTRPC('[middleware:auth] No authenticated user session found, throwing UNAUTHORIZED');
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You must be logged in to access this resource',
      });
    }

    debugTRPC('[middleware:auth] Authenticated user: %s', ctx.session.user.id);

    return next({
      ctx: {
        ...ctx,
        // Type-narrow session to non-nullable
        session: ctx.session,
        user: ctx.session.user,
      },
    });
  });

  // Build procedure chains with default middleware
  // Note: Custom middleware is not currently supported due to TypeScript limitations
  // with tRPC's complex middleware builder types
  const publicProcedure = t.procedure.use(defaultErrorMiddleware).use(defaultTimingMiddleware);

  const protectedProcedure = t.procedure
    .use(defaultErrorMiddleware)
    .use(defaultTimingMiddleware)
    .use(authMiddleware);

  debugTRPC('[init] Dot procedures created successfully (publicProcedure, protectedProcedure, router, mergeRouters)');

  // Return procedures object that plugins can use
  // No explicit type annotation - let TypeScript infer the full types to preserve
  // procedure builder methods (.input(), .mutation(), .query()) for IDE autocomplete
  return {
    publicProcedure,
    protectedProcedure,
    router: t.router,
    mergeRouters: t.mergeRouters,
    middleware: t.middleware,
    t,
    createCallerFactory: t.createCallerFactory,
  };
}

/**
 * Export the inferred return type of createDotProcedures as TRPCKitWithT
 * This preserves all type information without using 'any'
 */
export type TRPCKitWithT = ReturnType<typeof createDotProcedures>;

/**
 * Export TRPCKit without the internal 't' and 'createCallerFactory'
 */
export type TRPCKit = Omit<TRPCKitWithT, 't' | 'createCallerFactory'>;

/**
 * Re-export context types
 */
export type { DotContext, PluginSetupContext } from './types';
