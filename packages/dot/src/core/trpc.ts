/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1)
 * 2. You want to create a new middleware or type of procedure (see Part 3)
 *
 * tl;dr - this is where all the tRPC server stuff is created and plugged in.
 * The pieces you will need to use are documented accordingly near the end
 */
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

import type { Session } from '@arki/auth';
import { RateLimitExceededError } from '@arki/kv/errors';
import { ZodError } from '@arki/schema';

import type { RestrictedResource, UserModel, UserPermission, UserRole } from '../features/auth';
import { db, repositories } from '../db';
import { env } from '../env';
import { kv } from '../kv';
import { auth, validateSessionToken } from './auth';

/**
 * Isomorphic Session getter for API requests
 * - Expo requests will have a session token in the Authorization header
 * - Next.js requests will have a session token in cookies
 */
const isomorphicGetSession = async (headers: Headers) => {
  const authToken = headers.get('Authorization') ?? null;
  if (authToken) return validateSessionToken(authToken);
  return auth();
};

/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API.
 *
 * These allow you to access things when processing a request, like the database, the session, etc.
 *
 * This helper generates the "internals" for a tRPC context. The API handler and RSC clients each
 * wrap this and provides the required context.
 *
 * @see https://trpc.io/docs/server/context
 */
export const createTRPCContext = async (opts: { headers: Headers; session: Session | null }) => {
  const authToken = opts.headers.get('Authorization') ?? null;
  const session = await isomorphicGetSession(opts.headers);

  const source = opts.headers.get('x-trpc-source') ?? 'unknown';
  console.log('>>> tRPC Request from', source, 'by', session?.user);

  return {
    session,
    runInTransaction: db.transaction.bind(db),
    repo: repositories,
    kv,
    token: authToken,
    user: session?.user as UserModel | undefined,
    messageBus,
  };
};

// Export the context type for use in middlewares
export type Context = Awaited<ReturnType<typeof createTRPCContext>>;

/**
 * 2. INITIALIZATION
 *
 * This is where the trpc api is initialized, connecting the context and
 * transformer
 */
const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
    },
  }),
});

/**
 * Error Handling Middleware
 *
 * Catches errors during procedure execution. If the error is a TRPCError,
 * it's re-thrown. Otherwise, logs the error and throws a generic
 * INTERNAL_SERVER_ERROR.
 */
const errorHandlingMiddleware = t.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    // Handle RateLimitExceededError specifically
    if (error instanceof RateLimitExceededError) {
      // Add a random delay to obscure timing differences
      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

      // Optionally, include retry information if needed by the client
      // const retryAfterSeconds = Math.ceil((error.reset - Date.now()) / 1000);
      // Set headers like 'Retry-After' in your HTTP layer

      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Rate limit exceeded. Try again later.`,
        // Optionally pass reset time if client needs it
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
      // Optionally include the original error, but be cautious about leaking details
      cause: env.NODE_ENV === 'development' ? error : undefined,
    });
  }
});

/**
 * Create a server-side caller
 * @see https://trpc.io/docs/server/server-side-calls
 */
export const createCallerFactory = t.createCallerFactory;

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these
 * a lot in the /src/server/api/routers folder
 */

/**
 * This is how you create new routers and subrouters in your tRPC API
 * @see https://trpc.io/docs/router
 */
export const createTRPCRouter = t.router;

export const mergeRouters = t.mergeRouters;

/**
 * Middleware for timing procedure execution and adding an articifial delay in development.
 *
 * You can remove this if you don't like it, but it can help catch unwanted waterfalls by simulating
 * network latency that would occur in production but not in local development.
 */
const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = Date.now();

  if (t._config.isDev) {
    // artificial delay in dev 100-500ms
    const waitMs = Math.floor(Math.random() * 400) + 100;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  const result = await next();

  const end = Date.now();
  console.log(`[TRPC] ${path} took ${end - start}ms to execute`);

  return result;
});

/**
 * Authorization middleware that checks if the user has the required permission
 * @param resource The resource being accessed
 * @param action The action being performed
 */
export const authorizeMiddleware = (resource: string, action: string) => {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You must be logged in to access this resource',
      });
    }

    const userRepo = ctx.repo.auth.user;
    const hasPermission = await userRepo.hasPermission(ctx.user.id, resource, action);

    if (!hasPermission) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You do not have permission to access this resource',
      });
    }

    return next();
  });
};

/**
 * Authorization middleware that checks if the user has at least one of the specified roles
 * @param roles Array of role names to check
 */
export const authorizeRoleMiddleware = (roles: UserRole[]) => {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You must be logged in to access this resource',
      });
    }

    const userRepo = ctx.repo.auth.user;
    const userRoles = await userRepo.getUserRoles(ctx.user.id);
    const userRoleNames = new Set(userRoles.map(role => role.name));

    const hasRole = roles.some(role => userRoleNames.has(role));

    if (!hasRole) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You do not have the required role to access this resource',
      });
    }

    return next();
  });
};

/**
 * Authorization middleware that checks if the user is an admin
 */
export const authorizeAdminMiddleware = () => {
  return authorizeRoleMiddleware(['admin']);
};

/**
 * Authorization middleware that validates resource ownership
 * @param resourceIdParam Name of the input parameter containing the resource ID
 * @param checkOwnership Function that checks if the user owns the resource
 */
export const authorizeOwnerMiddleware = <TInput, M>(
  resourceIdParam: keyof TInput,
  checkOwnership: (ctx: Context, resourceId: M) => Promise<boolean>,
) => {
  return t.middleware(async ({ ctx, next, getRawInput }) => {
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

/**
 * Public (unauthed) procedure
 *
 * This is the base piece you use to build new queries and mutations on your
 * tRPC API. It does not guarantee that a user querying is authorized, but you
 * can still access user session data if they are logged in
 */
export const publicProcedure = t.procedure.use(errorHandlingMiddleware).use(timingMiddleware);

/**
 * Protected (authenticated) procedure
 *
 * If you want a query or mutation to ONLY be accessible to logged in users, use this. It verifies
 * the session is valid and guarantees `ctx.session.user` is not null.
 *
 * @see https://trpc.io/docs/procedures
 */
export const protectedProcedure = t.procedure
  .use(errorHandlingMiddleware)
  .use(timingMiddleware)
  .use(({ ctx, next }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    return next({
      ctx: {
        // infers the `session` as non-nullable
        session: { ...ctx.session, user: ctx.session.user as UserModel },
      },
    });
  });

/**
 * Admin procedure
 *
 * If you want a query or mutation to ONLY be accessible to admin users, use this. It verifies
 * the session is valid and guarantees `ctx.session.user` is not null.
 */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!ctx.session.user.roles?.includes('admin')) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return next({ ctx });
});

/**
 * Create a procedure that requires a specific permission
 * @param resource The resource being accessed
 * @param action The action being performed on the resource
 */
export const permissionProcedure = (resource: RestrictedResource, action: UserPermission) => {
  return protectedProcedure.use(authorizeMiddleware(resource, action));
};

/**
 * Create a procedure that requires a specific role
 * @param roles Array of role names, any one of which grants access
 */
export const roleProcedure = (roles: UserRole[]) => {
  return protectedProcedure.use(authorizeRoleMiddleware(roles));
};

/**
 * Create a procedure that requires resource ownership
 * @param resourceIdParam Name of the input parameter containing the resource ID
 * @param checkOwnership Function that checks if the user owns the resource
 */
export const ownerProcedure = <TInput, M>(
  resourceIdParam: keyof TInput,
  checkOwnership: (ctx: Context, resourceId: M) => Promise<boolean>,
) => {
  return protectedProcedure.use(authorizeOwnerMiddleware<TInput, M>(resourceIdParam, checkOwnership));
};
