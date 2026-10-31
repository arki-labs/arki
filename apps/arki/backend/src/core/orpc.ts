/**
 * oRPC Core Setup
 *
 * This file provides the oRPC procedure builders and middleware.
 * It replaces the tRPC setup with oRPC's simpler, plain-object-based API.
 */
import { ORPCError, os } from '@orpc/server';

import { AccessDenied, authed, AuthenticationRequired } from '@arki/auth';
import { ZodError } from '@arki/contracts';
import { step } from '@arki/dot/orpc';
import { errorMap } from '@arki/failure/orpc';
import { RateLimiterRes } from '@arki/kv';

import type { RestrictedResource, UserPermission, UserRole } from '../features/auth';
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
    if (error instanceof RateLimiterRes) {
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

/** What a step after `protectedProcedure` reads: the signed-in caller and the repositories. */
type SignedInContext = Pick<ORPCContext, 'repo'> & { readonly principal: NonNullable<ORPCContext['principal']> };

/**
 * Step: the caller holds `action` on `resource` (the permission tables), or `auth.forbidden` (403).
 */
const permitted = (resource: RestrictedResource, action: UserPermission) => async (ctx: SignedInContext) =>
  (await ctx.repo.auth.hasPermission(ctx.principal.user.id, resource, action))
    ? { principal: ctx.principal }
    : AccessDenied();

/**
 * Step: the caller has at least one of `roles` (the role tables), or `auth.forbidden` (403).
 */
const anyRole = (roles: readonly string[]) => async (ctx: SignedInContext) => {
  const userRoles = await ctx.repo.auth.getUserRoles(ctx.principal.user.id);
  const userRoleNames = new Set(userRoles.map(r => r?.name).filter(Boolean));
  return roles.some(role => userRoleNames.has(role)) ? { principal: ctx.principal } : AccessDenied();
};

/**
 * Step: the caller has the seeded "Admin" role.
 */
const admin = anyRole([ADMIN_ROLE_NAME]);

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
 * Guarantees `context.principal` and `context.user` are non-null; `context.user.id` is the
 * branded `UserId`.
 */
export const protectedProcedure = o
  .use(timingMiddleware)
  .use(errorHandlingMiddleware)
  .errors(errorMap(AuthenticationRequired))
  .use(step(authed))
  .use(({ context, next }) => next({ context: { user: context.principal.user } }));

/**
 * Admin procedure
 *
 * Use this for procedures accessible only to admin users.
 */
export const adminProcedure = protectedProcedure.errors(errorMap(AccessDenied)).use(step(admin));

/**
 * Permission-based procedure factory
 *
 * Creates a procedure that requires the user to have a specific permission.
 */
export const permissionProcedure = (resource: RestrictedResource, action: UserPermission) => {
  return protectedProcedure.errors(errorMap(AccessDenied)).use(step(permitted(resource, action)));
};

/**
 * Role-based procedure factory
 *
 * Creates a procedure that requires the user to have at least one of the specified roles.
 */
export const roleProcedure = (roles: UserRole[]) => {
  return protectedProcedure.errors(errorMap(AccessDenied)).use(step(anyRole(roles)));
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
