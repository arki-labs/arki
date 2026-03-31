import { createRouterClient, ORPCError, os } from '@orpc/server';
import { ZodError } from '@arki/contracts';

// Session type is provided by our auth module
import { RateLimitExceededError } from '@arki/kv/errors';

import type { DotAuth, DotSession, DotUser } from '../auth';
import type { AuthConfig, RouterRecord, SchemaInterface, RPCOptions } from '../types';
import type { DotContext } from './types';
import { authFeatures } from '../auth';
import { debugRPC } from '../debug';

/**
 * RPC functionality for the Dot framework.
 * Contains methods for setting up and interacting with oRPC.
 */
export const rpcFeatures = {
  /**
   * @internal Creates an RPC context factory function
   * @param dbConfig The database configuration
   * @param initDrizzleFn Function to initialize the database
   * @param initKvFn Function to initialize the key-value store
   * @param initEventSourcingFn Function to initialize the event store
   * @param initMessageBusFn Function to initialize the message bus
   * @param authConfig The authentication configuration
   * @param rpcOptions The RPC options
   */
  createRPCContextFactory<TSchema extends SchemaInterface>(
    dbConfig: { url?: string; schema: TSchema; debug?: boolean; repositories?: Record<string, unknown> } | null,
    initDrizzleFn: () => unknown,
    initKvFn: () => unknown,
    initEventSourcingFn: () => unknown,
    initMessageBusFn: (eventStore: unknown) => unknown,
    authConfig: AuthConfig | null,
    rpcOptions?: RPCOptions<TSchema> | null,
  ) {
    debugRPC('[legacy] Creating RPC context factory (hasAuth: %s, hasDb: %s)', !!authConfig, !!dbConfig);

    // Return a context creation function that will be called by oRPC
    return async (opts: { headers: Headers; session: DotSession | null }) => {
      debugRPC('[legacy] Creating request context');
      const { headers, session } = opts;
      const authToken = headers.get('Authorization') ?? null;
      const source = headers.get('x-rpc-source') ?? 'unknown';
      debugRPC('[legacy] Request source: %s, hasToken: %s, hasSession: %s', source, !!authToken, !!session);

      const db = initDrizzleFn();

      // Initialize auth module if configured
      let dotAuth: DotAuth | undefined;
      if (authConfig) {
        debugRPC('[legacy] Initializing auth module');
        dotAuth = await authFeatures.initAuth(authConfig, db);
        debugRPC('[legacy] Auth module initialized');
      }

      // Get session from token if not provided
      let resolvedSession = session;

      // Try to get session from DotAuth first
      if (!resolvedSession && dotAuth && authToken) {
        debugRPC('[legacy] Attempting to validate token with DotAuth');
        try {
          resolvedSession = await dotAuth.session.validateToken(authToken);
          debugRPC('[legacy] Session validated via DotAuth');
        } catch (error) {
          debugRPC(
            '[legacy] DotAuth token validation failed: %s',
            error instanceof Error ? error.message : 'unknown error',
          );
        }
      }

      // Fall back to legacy validateSession if available
      if (!resolvedSession && authToken && authConfig?.validateSession) {
        debugRPC('[legacy] Attempting legacy session validation');
        try {
          resolvedSession = await authConfig.validateSession(authToken);
          debugRPC('[legacy] Session validated via legacy method');
        } catch (error) {
          debugRPC(
            '[legacy] Legacy session validation failed: %s',
            error instanceof Error ? error.message : 'unknown error',
          );
        }
      }

      // Attempt to get session from cookies if still not resolved
      if (!resolvedSession && !authToken) {
        debugRPC('[legacy] Attempting to get session from cookies');
        try {
          resolvedSession = await (dotAuth ? dotAuth.getSession(headers) : authFeatures.getSessionFromCookies());
          if (resolvedSession) {
            debugRPC('[legacy] Session retrieved from cookies');
          }
        } catch {
          debugRPC('[legacy] Failed to get session from cookies (expected in non-Next.js context)');
        }
      }

      // Log request source and user if available
      if (resolvedSession?.user) {
        debugRPC(
          '[legacy] Request context created for user: %s (source: %s)',
          resolvedSession.user.id || resolvedSession.user.email,
          source,
        );
      } else {
        debugRPC('[legacy] Request context created without session');
      }

      // Create base context with initialized components
      const baseContext: DotContext = {
        session: resolvedSession,
        token: authToken,
        user: resolvedSession?.user as DotUser | undefined,
        db: db as DotContext['db'],
        repo: dbConfig?.repositories ?? {},
        kv: initKvFn() as DotContext['kv'],
        messageBus: initMessageBusFn(initEventSourcingFn()) as DotContext['messageBus'],
        runInTransaction: (db as { transaction?: { bind: (thisArg: unknown) => unknown } })?.transaction?.bind(db) as DotContext['runInTransaction'],
        // Add auth-related properties
        auth: dotAuth,
        sessionManager: dotAuth?.session,
        rbac: dotAuth?.rbac,
      };

      // Extend context with custom properties if extension function is provided
      if (rpcOptions?.extendContext) {
        const extendedProps = await rpcOptions.extendContext(baseContext as Parameters<typeof rpcOptions.extendContext>[0], opts);
        return { ...baseContext, ...extendedProps };
      }

      return baseContext;
    };
  },

  /**
   * @internal Initialize the oRPC instance with middlewares and procedures.
   * @param routers The oRPC routers (plain objects)
   * @param rpcOptions The RPC options
   * @param env The environment configuration
   */
  initRPC<TRouters extends RouterRecord = RouterRecord>(
    routers: TRouters | null,
    _rpcOptions: RPCOptions<SchemaInterface> | null,
    env: Record<string, unknown>,
  ) {
    debugRPC('[legacy] Initializing oRPC (hasRouters: %s)', !!routers);
    if (!routers || Object.keys(routers).length === 0) {
      debugRPC('[legacy] No routers provided, skipping initialization');
      return;
    }

    const routerCount = Object.keys(routers).length;
    debugRPC('[legacy] Initializing oRPC with %d router(s)', routerCount);

    // Initialize oRPC with context
    const o = os.$context<DotContext>();

    // Create error handling middleware
    const errorHandlingMiddleware = o.middleware(async ({ next }) => {
      try {
        return await next();
      } catch (error) {
        // Handle RateLimitExceededError specifically
        if (error instanceof RateLimitExceededError) {
          await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

          throw new ORPCError('TOO_MANY_REQUESTS', {
            message: 'Rate limit exceeded. Try again later.',
            cause: env.NODE_ENV === 'development' ? error : undefined,
          });
        }

        if (error instanceof ORPCError) {
          throw error;
        }

        if (error instanceof ZodError) {
          throw new ORPCError('BAD_REQUEST', {
            message: 'Validation failed',
            cause: error,
          });
        }

        // Throw a generic server error
        throw new ORPCError('INTERNAL_SERVER_ERROR', {
          message: 'An unexpected internal server error occurred.',
          cause: env.NODE_ENV === 'development' ? error : undefined,
        });
      }
    });

    // Create timing middleware
    const timingMiddleware = o.middleware(async ({ next, path }) => {
      const start = Date.now();
      const routePath = Array.isArray(path) ? path.join('.') : String(path ?? 'unknown');

      // Add artificial delay in development
      if (env.NODE_ENV === 'development') {
        const waitMs = Math.floor(Math.random() * 400) + 100;
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }

      const result = await next();

      const end = Date.now();
      debugRPC('[legacy] %s took %dms to execute', routePath, end - start);

      return result;
    });

    // Auth middleware
    const authMiddleware = o.middleware(({ context, next }) => {
      if (!context.session?.user) {
        throw new ORPCError('UNAUTHORIZED', {
          message: 'You must be logged in to access this resource',
        });
      }
      return next({
        context: {
          session: { ...context.session, user: context.session.user },
        },
      });
    });

    // Create base procedures
    const publicProcedure = o.use(errorHandlingMiddleware).use(timingMiddleware);

    // Create protected procedure that requires authentication
    const protectedProcedure = o
      .use(errorHandlingMiddleware)
      .use(timingMiddleware)
      .use(authMiddleware);

    // In oRPC, routers are plain objects - just use them directly
    const router = routers;
    debugRPC('[legacy] oRPC initialization complete');

    // Return an object with all RPC components
    return {
      o,
      router,
      createCaller: (context: DotContext) =>
        createRouterClient(router as Record<string, never>, { context } as never),
      procedures: {
        public: publicProcedure,
        protected: protectedProcedure,
      },
    };
  },
};
