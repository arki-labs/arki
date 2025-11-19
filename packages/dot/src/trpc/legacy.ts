import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

// Session type is provided by our auth module
import { ZodError } from '@arki/contracts';
import { RateLimitExceededError } from '@arki/kv/errors';

import type { DotAuth, DotSession } from '../auth';
import type { AuthConfig, BaseTRPCContext, RouterRecord, SchemaInterface, SessionUser, TRPCOptions } from '../types';
import { authFeatures } from '../auth';
import { debugTRPC } from '../debug';

/**
 * @deprecated This is legacy API - use `createDotProcedures` from './init' instead
 * This module is kept for backward compatibility only.
 */

/**
 * TRPC functionality for the Dot framework.
 * Contains methods for setting up and interacting with tRPC.
 */
export const trpcFeatures = {
  /**
   * @internal Creates a TRPC context factory function
   * @param dbConfig The database configuration
   * @param initDrizzleFn Function to initialize the database
   * @param initKvFn Function to initialize the key-value store
   * @param initEventSourcingFn Function to initialize the event store
   * @param initMessageBusFn Function to initialize the message bus
   * @param authConfig The authentication configuration
   * @param trpcOptions The tRPC options
   */
  createRPCContextFactory<TSchema extends SchemaInterface>(
    dbConfig: { url?: string; schema: TSchema; debug?: boolean; repositories?: Record<string, any> } | null,
    initDrizzleFn: () => any,
    initKvFn: () => any,
    initEventSourcingFn: () => any,
    initMessageBusFn: (eventStore: any) => any,
    authConfig: AuthConfig | null,
    trpcOptions?: TRPCOptions<TSchema> | null,
  ) {
    debugTRPC('[legacy] Creating RPC context factory (hasAuth: %s, hasDb: %s)', !!authConfig, !!dbConfig);

    // Return a context creation function that will be called by tRPC
    return async (opts: { headers: Headers; session: DotSession | null }) => {
      debugTRPC('[legacy] Creating request context');
      const { headers, session } = opts;
      const authToken = headers.get('Authorization') ?? null;
      const source = headers.get('x-rpc-source') ?? 'unknown';
      debugTRPC('[legacy] Request source: %s, hasToken: %s, hasSession: %s', source, !!authToken, !!session);

      const db = initDrizzleFn();

      // Initialize auth module if configured
      let dotAuth: DotAuth | undefined;
      if (authConfig) {
        debugTRPC('[legacy] Initializing auth module');
        dotAuth = await authFeatures.initAuth(authConfig, db);
        debugTRPC('[legacy] Auth module initialized');
      }

      // Get session from token if not provided
      let resolvedSession = session;

      // Try to get session from DotAuth first
      if (!resolvedSession && dotAuth && authToken) {
        debugTRPC('[legacy] Attempting to validate token with DotAuth');
        try {
          resolvedSession = await dotAuth.session.validateToken(authToken);
          debugTRPC('[legacy] Session validated via DotAuth');
        } catch (error) {
          debugTRPC(
            '[legacy] DotAuth token validation failed: %s',
            error instanceof Error ? error.message : 'unknown error',
          );
          console.error('Error validating session token:', error);
        }
      }

      // Fall back to legacy validateSession if available
      if (!resolvedSession && authToken && authConfig?.validateSession) {
        debugTRPC('[legacy] Attempting legacy session validation');
        try {
          resolvedSession = await authConfig.validateSession(authToken);
          debugTRPC('[legacy] Session validated via legacy method');
        } catch (error) {
          debugTRPC(
            '[legacy] Legacy session validation failed: %s',
            error instanceof Error ? error.message : 'unknown error',
          );
          console.error('Error validating session token:', error);
        }
      }

      // Attempt to get session from cookies if still not resolved
      if (!resolvedSession && !authToken) {
        debugTRPC('[legacy] Attempting to get session from cookies');
        try {
          resolvedSession = await (dotAuth ? dotAuth.getSession(headers) : authFeatures.getSessionFromCookies());
          if (resolvedSession) {
            debugTRPC('[legacy] Session retrieved from cookies');
          }
        } catch {
          debugTRPC('[legacy] Failed to get session from cookies (expected in non-Next.js context)');
          // Silently ignore - this is expected when not in a Next.js context
        }
      }

      // Log request source and user if available
      if (resolvedSession?.user) {
        debugTRPC(
          '[legacy] Request context created for user: %s (source: %s)',
          resolvedSession.user.id || resolvedSession.user.email,
          source,
        );
        console.log('>>> tRPC Request from', source, 'by', resolvedSession.user);
      } else {
        debugTRPC('[legacy] Request context created without session');
      }

      // Create base context with initialized components
      const baseContext: BaseTRPCContext<TSchema> = {
        session: resolvedSession,
        token: authToken,
        user: resolvedSession?.user as SessionUser | undefined,
        db,
        repo: dbConfig?.repositories ?? {},
        kv: initKvFn(),
        messageBus: initMessageBusFn(initEventSourcingFn()),
        runInTransaction: db?.transaction.bind(db),
        // Add auth-related properties
        auth: dotAuth,
        sessionManager: dotAuth?.session,
        rbac: dotAuth?.rbac,
      };

      // Extend context with custom properties if extension function is provided
      if (trpcOptions?.extendContext) {
        const extendedProps = await trpcOptions.extendContext(baseContext, opts);
        return { ...baseContext, ...extendedProps };
      }

      return baseContext;
    };
  },

  /**
   * @internal Initialize the TRPC instance with middlewares and procedures.
   * @param routers The tRPC routers
   * @param trpcOptions The tRPC options
   * @param createContextFn A function to create the tRPC context
   * @param env The environment configuration
   */
  initTrpc<TSchema extends SchemaInterface, TRouters extends RouterRecord = RouterRecord>(
    routers: TRouters | null,
    trpcOptions: TRPCOptions<TSchema> | null,
    env: Record<string, unknown>,
  ) {
    debugTRPC('[legacy] Initializing tRPC (hasRouters: %s)', !!routers);
    if (!routers || Object.keys(routers).length === 0) {
      debugTRPC('[legacy] No routers provided, skipping initialization');
      return;
    }

    const routerCount = Object.keys(routers).length;
    debugTRPC('[legacy] Initializing tRPC with %d router(s)', routerCount);

    // Initialize tRPC with context and transformer
    const t = initTRPC.context<BaseTRPCContext<TSchema>>().create({
      transformer: trpcOptions?.transformer ?? superjson,
      errorFormatter: ({ shape, error }) => ({
        ...shape,
        data: {
          ...shape.data,
          zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
        },
      }),
    });

    // Create error handling middleware
    const errorHandlingMiddleware = t.middleware(async ({ next }) => {
      try {
        return await next();
      } catch (error) {
        // Handle RateLimitExceededError specifically
        if (error instanceof RateLimitExceededError) {
          // Add a random delay to obscure timing differences
          await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: `Rate limit exceeded. Try again later.`,
            cause: env.NODE_ENV === 'development' ? error : undefined,
          });
        }

        if (error instanceof TRPCError) {
          // Re-throw known tRPC errors
          throw error;
        }

        // Log unknown errors for debugging
        console.error('Unhandled error in tRPC procedure:', error);

        // Throw a generic server error
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected internal server error occurred.',
          cause: env.NODE_ENV === 'development' ? error : undefined,
        });
      }
    });

    // Create timing middleware
    const timingMiddleware = t.middleware(async ({ next, path }) => {
      const start = Date.now();

      // Add artificial delay in development
      if (env.NODE_ENV === 'development') {
        // artificial delay in dev 100-500ms
        const waitMs = Math.floor(Math.random() * 400) + 100;
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }

      const result = await next();

      const end = Date.now();
      console.log(`[TRPC] ${path} took ${end - start}ms to execute`);

      return result;
    });

    // Create base procedures
    const publicProcedure = t.procedure.use(errorHandlingMiddleware).use(timingMiddleware);

    // Create protected procedure that requires authentication
    const protectedProcedure = t.procedure
      .use(errorHandlingMiddleware)
      .use(timingMiddleware)
      .use(({ ctx, next }) => {
        if (!ctx.session?.user) {
          throw new TRPCError({ code: 'UNAUTHORIZED' });
        }
        return next({
          ctx: {
            // infers the `session` as non-nullable
            session: { ...ctx.session, user: ctx.session.user },
          },
        });
      });

    // Create admin procedure that requires admin role
    const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
      if (!ctx.user?.roles?.includes('admin')) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
      }

      return next({ ctx });
    });

    // Create factory function for permission-based procedures
    const createPermissionProcedure = (resource: string, action: string) => {
      return protectedProcedure.use(async ({ ctx, next }) => {
        // Implementation depends on your repository structure
        // Check permissions based on user roles or explicit permissions
        const hasPermission = await checkPermission(ctx, resource, action);

        if (!hasPermission) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have permission to access this resource',
          });
        }

        return next();
      });
    };

    // Create factory function for role-based procedures
    const createRoleProcedure = (roles: string[]) => {
      return protectedProcedure.use(async ({ ctx, next }) => {
        // Check if the user has any of the required roles
        const hasRole = await checkRoles(ctx, roles);

        if (!hasRole) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have the required role to access this resource',
          });
        }

        return next();
      });
    };

    // Create factory function for ownership-based procedures
    const createOwnerProcedure = <TInput, M>(
      resourceIdParam: keyof TInput,
      checkOwnership: (ctx: BaseTRPCContext<TSchema>, resourceId: M) => Promise<boolean>,
    ) => {
      return protectedProcedure.use(async ({ ctx, next, getRawInput }) => {
        if (!ctx.user) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'You must be logged in to access this resource',
          });
        }

        const input = getRawInput() as TInput;
        const resourceId = input[resourceIdParam] as M;
        if (!resourceId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Resource ID parameter '${String(resourceIdParam)}' is required`,
          });
        }

        const isOwner = await checkOwnership(ctx, resourceId);

        if (!isOwner) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have permission to access this resource',
          });
        }

        return next();
      });
    };

    // Merge routers
    debugTRPC('[legacy] Merging %d router(s)', routerCount);
    const router = t.router(routers);
    debugTRPC('[legacy] tRPC initialization complete');

    // Return an object with all TRPC components
    // Cast router to preserve the specific router names for autocomplete
    return {
      t,
      router: router as typeof router & TRouters,
      createCaller: t.createCallerFactory(router),
      procedures: {
        public: publicProcedure,
        protected: protectedProcedure,
        admin: adminProcedure,
        withPermission: createPermissionProcedure,
        withRole: createRoleProcedure,
        withOwnership: createOwnerProcedure,
      },
    };
  },
};

/**
 * Checks if a user has a specific permission using the RBAC system
 */
async function checkPermission<TSchema extends SchemaInterface>(
  ctx: BaseTRPCContext<TSchema>,
  resource: string,
  action: string,
): Promise<boolean> {
  debugTRPC(
    '[legacy] Checking permission (resource: %s, action: %s, userId: %s)',
    resource,
    action,
    ctx.user?.id || 'none',
  );

  // Check if user is authenticated
  if (!ctx.user?.id) {
    debugTRPC('[legacy] Permission denied: user not authenticated');
    return false;
  }

  // Use RBAC manager if available
  if (ctx.rbac) {
    debugTRPC('[legacy] Using RBAC manager for permission check');
    try {
      const hasPermission = await ctx.rbac.hasPermission(ctx.user.id, resource, action);
      debugTRPC('[legacy] RBAC permission check result: %s', hasPermission);
      return hasPermission;
    } catch (error) {
      debugTRPC('[legacy] RBAC permission check failed: %s', error instanceof Error ? error.message : 'unknown error');
      console.error('Error checking permission:', error);
      return false;
    }
  }

  // Fallback: For admin users, grant all permissions by default
  if (ctx.user.roles?.includes('admin')) {
    debugTRPC('[legacy] Permission granted: user has admin role');
    return true;
  }

  // If you have a user repository with permission checking, use it here
  // Example: return await ctx.repo.user.hasPermission(ctx.user.id, resource, action);

  debugTRPC('[legacy] Permission denied: no RBAC manager and not admin');
  return false;
}

/**
 * Checks if a user has any of the specified roles using the RBAC system
 */
async function checkRoles<TSchema extends SchemaInterface>(
  ctx: BaseTRPCContext<TSchema>,
  requiredRoles: string[],
): Promise<boolean> {
  debugTRPC('[legacy] Checking roles (required: %s, userId: %s)', requiredRoles.join(', '), ctx.user?.id || 'none');

  // Check if user is authenticated
  if (!ctx.user?.id) {
    debugTRPC('[legacy] Role check failed: user not authenticated');
    return false;
  }

  // Use RBAC manager if available
  if (ctx.rbac) {
    debugTRPC('[legacy] Using RBAC manager for role check');
    try {
      for (const role of requiredRoles) {
        const hasRole = await ctx.rbac.hasRole(ctx.user.id, role);
        if (hasRole) {
          debugTRPC('[legacy] Role check passed: user has role "%s"', role);
          return true;
        }
      }
      debugTRPC('[legacy] Role check failed: user has none of the required roles');
      return false;
    } catch (error) {
      debugTRPC(
        '[legacy] RBAC role check failed: %s, falling back to user.roles',
        error instanceof Error ? error.message : 'unknown error',
      );
      console.error('Error checking roles:', error);
      // Fall back to user.roles if RBAC fails
    }
  }

  // Fallback: Check roles directly on the user object
  if (ctx.user?.roles) {
    debugTRPC('[legacy] Checking roles from user object (roles: %s)', ctx.user.roles.join(', '));
    const hasRole = requiredRoles.some(role => ctx.user?.roles?.includes(role));
    debugTRPC('[legacy] Role check result from user object: %s', hasRole);
    return hasRole;
  }

  debugTRPC('[legacy] Role check failed: no RBAC manager and no user.roles');
  return false;
}
