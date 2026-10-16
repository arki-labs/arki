/**
 * oRPC Core Setup
 *
 * This file provides the oRPC procedure builders and middleware.
 * It replaces the tRPC setup with oRPC's simpler, plain-object-based API.
 */
import { ORPCError, os } from '@orpc/server';

import { ZodError } from '@arki/contracts';
import { RateLimitExceededError } from '@arki/kv/errors';

import type { RestrictedResource, UserId, UserModel, UserPermission, UserRole } from '../features/auth';
import type { ORPCContext } from './context';
import { env } from '../env';
import { ADMIN_ROLE_NAME } from '../features/auth/constants';

/**
 * Base oRPC instance with typed context
 */
const o = os.$context<ORPCContext>();

/**
 * Timing middleware — logs execution time and adds artificial delay in development.
 */
const timingMiddleware = o.middleware(async ({ next, path }) => {
  const start = Date.now();
  const routePath = Array.isArray(path) ? path.join('.') : String(path ?? 'unknown');

  if (process.env.NODE_ENV === 'development') {
    const waitMs = Math.floor(Math.random() * 400) + 100;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  const result = await next();
  const end = Date.now();
  console.log(`[oRPC] ${routePath} took ${end - start}ms to execute`);

  return result;
});

/**
 * Error handling middleware
 *
 * Catches errors during procedure execution. Handles rate limiting and wraps
 * unknown errors in a generic INTERNAL_SERVER_ERROR response.
 */
const errorHandlingMiddleware = o.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
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

    console.error('Unhandled error in oRPC procedure:', error);

    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: 'An unexpected internal server error occurred.',
      cause: env.NODE_ENV === 'development' ? error : undefined,
    });
  }
});

/**
 * Authentication middleware — ensures the user is logged in.
 */
const authMiddleware = o.middleware(async ({ context, next }) => {
  if (!context.session?.user) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'You must be logged in to access this resource',
    });
  }

  return next({
    context: {
      session: { ...context.session, user: context.session.user as UserModel },
      user: context.session.user as UserModel,
    },
  });
});

/**
 * Authorization middleware factory — checks if user has a required permission.
 */
const createAuthorizeMiddleware = (resource: RestrictedResource, action: UserPermission) => {
  return o.middleware(async ({ context, next }) => {
    if (!context.session?.user) {
      throw new ORPCError('UNAUTHORIZED', {
        message: 'You must be logged in to access this resource',
      });
    }

    const hasPermission = await context.repo.auth.hasPermission(context.session.user.id as UserId, resource, action);

    if (!hasPermission) {
      throw new ORPCError('FORBIDDEN', {
        message: `Insufficient permissions. Required: ${action} on ${resource}`,
      });
    }

    return next({
      context: {
        session: { ...context.session, user: context.session.user as UserModel },
        user: context.session.user as UserModel,
      },
    });
  });
};

/**
 * Role authorization middleware factory — checks if user has at least one of the given roles.
 */
const createRoleMiddleware = (roles: readonly string[]) => {
  return o.middleware(async ({ context, next }) => {
    if (!context.session?.user) {
      throw new ORPCError('UNAUTHORIZED', {
        message: 'You must be logged in to access this resource',
      });
    }

    const userRoles = await context.repo.auth.getUserRoles(context.session.user.id as UserId);
    const userRoleNames = new Set(userRoles.map(r => r?.name).filter(Boolean));
    const hasRole = roles.some(role => userRoleNames.has(role));

    if (!hasRole) {
      throw new ORPCError('FORBIDDEN', {
        message: 'You do not have the required role to access this resource',
      });
    }

    return next({
      context: {
        session: { ...context.session, user: context.session.user as UserModel },
        user: context.session.user as UserModel,
      },
    });
  });
};

/**
 * Admin middleware — checks if user has the seeded "Admin" role.
 */
const adminMiddleware = createRoleMiddleware([ADMIN_ROLE_NAME]);

// ---------------------------------------------------------------------------
// Procedure builders
// ---------------------------------------------------------------------------

/**
 * Public (unauthed) procedure
 *
 * The base piece for building queries and mutations.
 * Does not guarantee the user is authenticated, but session data is available if present.
 */
export const publicProcedure = o.use(timingMiddleware).use(errorHandlingMiddleware);

/**
 * Protected (authenticated) procedure
 *
 * Use this for procedures that require a logged-in user.
 * Guarantees `context.session.user` is non-null.
 */
export const protectedProcedure = o.use(timingMiddleware).use(errorHandlingMiddleware).use(authMiddleware);

/**
 * Admin procedure
 *
 * Use this for procedures accessible only to admin users.
 */
export const adminProcedure = o
  .use(timingMiddleware)
  .use(errorHandlingMiddleware)
  .use(authMiddleware)
  .use(adminMiddleware);

/**
 * Permission-based procedure factory
 *
 * Creates a procedure that requires the user to have a specific permission.
 */
export const permissionProcedure = (resource: RestrictedResource, action: UserPermission) => {
  return protectedProcedure.use(createAuthorizeMiddleware(resource, action));
};

/**
 * Role-based procedure factory
 *
 * Creates a procedure that requires the user to have at least one of the specified roles.
 */
export const roleProcedure = (roles: UserRole[]) => {
  return protectedProcedure.use(createRoleMiddleware(roles));
};

// ---------------------------------------------------------------------------
// Notes on patterns that differ from tRPC
// ---------------------------------------------------------------------------

/**
 * Transaction-wrapped procedures
 *
 * Use `transactionalProcedure` from `@arki/db/orpc`. It opens one SERIALIZABLE
 * transaction per call, hands the handler `tx` and repositories bound with
 * `withTx(tx)`, and reruns the handler on a serialization failure or deadlock:
 *
 * ```typescript
 * const transact = transactionalProcedure(db, { repos: () => repositories });
 * export const createWithRelated = implement(contract, transactionalProcedureConfig)
 *   .createWithRelated.use(transact) // always the last `.use()`
 *   .handler(({ context: { repos }, input }) => createItemWithRelated(repos, input));
 * ```
 *
 * See "Transactional procedures" in the `@arki/db` README.
 */

/**
 * Owner-based procedures
 *
 * oRPC middleware does not have access to procedure input (there is no `getRawInput` equivalent).
 * Move ownership checks into the procedure handler body:
 *
 * ```typescript
 * export const updateItem = protectedProcedure
 *   .input(schema)
 *   .handler(async ({ context, input }) => {
 *     const item = await context.repo.items.findById(input.itemId);
 *     if (!item || item.userId !== context.user.id) {
 *       throw new ORPCError('FORBIDDEN', { message: 'Not authorized' });
 *     }
 *     return await context.repo.items.update(input.itemId, input);
 *   });
 * ```
 */

/**
 * Helper to re-throw Zod validation errors as oRPC BAD_REQUEST errors.
 */
export function handleValidationError(error: unknown): never {
  if (error instanceof ZodError) {
    throw new ORPCError('BAD_REQUEST', {
      message: 'Validation failed',
      cause: error.flatten(),
    });
  }
  throw error;
}

export { ORPCError } from '@orpc/server';
