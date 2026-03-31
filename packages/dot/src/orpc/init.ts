import { ORPCError, os } from '@orpc/server';
import { ZodError } from '@arki/contracts';
import { RateLimitExceededError } from '@arki/kv/errors';

import { debugRPC } from '../debug.ts';
import type { DotContext } from './types';

/**
 * Initialize standard Dot oRPC procedures.
 *
 * This function creates an oRPC instance with standard middleware and procedures
 * that plugins can use. It provides:
 * - publicProcedure: For unauthenticated endpoints
 * - protectedProcedure: For authenticated endpoints
 * - o: The oRPC instance for creating custom middleware
 *
 * Apps can provide custom middleware to extend behavior while maintaining
 * compatibility with plugins.
 *
 * @param options Configuration options
 * @returns Dot procedures object with standard procedures
 *
 * @example
 * ```ts
 * const procedures = createDotProcedures({
 *   isDevelopment: process.env.NODE_ENV === 'development',
 * });
 * ```
 */
export function createDotProcedures(options?: {
  isDevelopment?: boolean;
  env?: Record<string, unknown>;
}) {
  const isDevelopment = options?.isDevelopment ?? options?.env?.['NODE_ENV'] === 'development';

  debugRPC('[init] Creating Dot procedures (isDevelopment: %s)', isDevelopment);

  // Initialize oRPC with context type
  const o = os.$context<DotContext>();

  debugRPC('[init] oRPC instance created');

  // Standard error handling middleware
  const defaultErrorMiddleware = o.middleware(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      // Handle rate limit errors
      if (error instanceof RateLimitExceededError) {
        debugRPC('[middleware:error] Rate limit exceeded: %s', error.message);
        // Add a random delay to obscure timing differences
        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

        throw new ORPCError('TOO_MANY_REQUESTS', {
          message: 'Rate limit exceeded. Try again later.',
          cause: isDevelopment ? error : undefined,
        });
      }

      // Re-throw known oRPC errors
      if (error instanceof ORPCError) {
        debugRPC('[middleware:error] oRPC error: %s (code: %s)', error.message, error.code);
        throw error;
      }

      // Handle Zod validation errors
      if (error instanceof ZodError) {
        debugRPC('[middleware:error] Validation error: %s', error.message);
        throw new ORPCError('BAD_REQUEST', {
          message: 'Validation failed',
          cause: error,
        });
      }

      // Log unknown errors for debugging
      debugRPC('[middleware:error] Unhandled error: %s', error instanceof Error ? error.message : String(error));

      // Throw a generic server error
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: 'An unexpected internal server error occurred.',
        cause: isDevelopment ? error : undefined,
      });
    }
  });

  // Standard timing middleware
  const defaultTimingMiddleware = o.middleware(async ({ next, path }) => {
    const start = Date.now();
    const routePath = Array.isArray(path) ? path.join('.') : String(path ?? 'unknown');

    // Add artificial delay in development to catch waterfalls
    if (isDevelopment) {
      const waitMs = Math.floor(Math.random() * 400) + 100;
      debugRPC('[middleware:timing] Adding %dms artificial delay for %s (development mode)', waitMs, routePath);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    const result = await next();

    const end = Date.now();
    const duration = end - start;
    debugRPC('[middleware:timing] %s took %dms to execute', routePath, duration);

    return result;
  });

  // Standard auth middleware
  const authMiddleware = o.middleware(({ context, next }) => {
    if (!context.session?.user) {
      debugRPC('[middleware:auth] No authenticated user session found, throwing UNAUTHORIZED');
      throw new ORPCError('UNAUTHORIZED', {
        message: 'You must be logged in to access this resource',
      });
    }

    debugRPC('[middleware:auth] Authenticated user: %s', context.session.user.id);

    return next({
      context: {
        // Type-narrow session to non-nullable
        session: context.session,
        user: context.session.user,
      },
    });
  });

  // Build procedure chains with default middleware
  const publicProcedure = o.use(defaultErrorMiddleware).use(defaultTimingMiddleware);

  const protectedProcedure = o
    .use(defaultErrorMiddleware)
    .use(defaultTimingMiddleware)
    .use(authMiddleware);

  debugRPC('[init] Dot procedures created successfully (publicProcedure, protectedProcedure)');

  // Return procedures object that plugins can use
  return {
    publicProcedure,
    protectedProcedure,
    o,
  };
}

/**
 * Export the inferred return type of createDotProcedures as ORPCKitWithO
 * This preserves all type information without using 'any'
 */
export type ORPCKitWithO = ReturnType<typeof createDotProcedures>;

/**
 * Export ORPCKit without the internal 'o' instance
 */
export type ORPCKit = Omit<ORPCKitWithO, 'o'>;

import type { EventStore, MessageBus } from '@event-driven-io/emmett';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { KV } from '@arki/kv';
import type { SchemaInterface } from '../types';

/**
 * Context available to plugins during setup.
 * Plugins receive this during initialization and can use it
 * to set up their routers and other components.
 */
export type PluginSetupContext<TSchema extends SchemaInterface = SchemaInterface> = {
  /** oRPC procedures for building routers — fully typed from createDotProcedures */
  procedures: ORPCKitWithO;

  /** Database instance (if configured) */
  db?: NodePgDatabase<TSchema>;

  /** Key-value store instance (if configured) */
  kv?: KV;

  /** Event store instance (if configured) */
  eventStore?: EventStore;

  /** Message bus instance (if configured) */
  messageBus?: MessageBus;
}

/**
 * Re-export context types
 */
export type { DotContext } from './types';
