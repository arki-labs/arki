/**
 * tRPC middleware for authentication and authorization
 */

import { TRPCError } from '@trpc/server';
import type { AnyRouter, inferRouterContext } from '@trpc/server';

import type { DotRBACManager } from './rbac';
import type { DotSessionManager } from './session';
import type { DotSession, DotUser } from './types';

/**
 * Context with auth
 */
export interface AuthContext {
  session: DotSession | null;
  user: DotUser | null;
  auth?: {
    sessionManager: DotSessionManager;
    rbac: DotRBACManager;
  };
}

/**
 * Create auth middleware factories
 */
export function createAuthMiddleware<TContext extends AuthContext>(
  _sessionManager: DotSessionManager,
  rbac: DotRBACManager
) {
  return {
    /**
     * Require authentication
     */
    requireAuth: () => {
      return async ({ ctx, next }: { ctx: TContext; next: any }) => {
        if (!ctx.session?.user) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'You must be logged in to access this resource',
          });
        }

        return next({
          ctx: {
            ...ctx,
            session: ctx.session as DotSession,
            user: ctx.session.user as DotUser,
          },
        });
      };
    },

    /**
     * Require specific role(s)
     */
    requireRole: (roles: string | string[]) => {
      const requiredRoles = Array.isArray(roles) ? roles : [roles];

      return async ({ ctx, next }: { ctx: TContext; next: any }) => {
        if (!ctx.session?.user) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'You must be logged in to access this resource',
          });
        }

        const userRoles = await rbac.getUserRoleNames(ctx.session.user.id!);
        const hasRequiredRole = requiredRoles.some(role => userRoles.includes(role));

        if (!hasRequiredRole) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `You need one of these roles: ${requiredRoles.join(', ')}`,
          });
        }

        return next({
          ctx: {
            ...ctx,
            session: ctx.session as DotSession,
            user: ctx.session.user as DotUser,
          },
        });
      };
    },

    /**
     * Require specific permission
     */
    requirePermission: (resource: string, action: string) => {
      return async ({ ctx, next }: { ctx: TContext; next: any }) => {
        if (!ctx.session?.user) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'You must be logged in to access this resource',
          });
        }

        const hasPermission = await rbac.hasPermission(
          ctx.session.user.id!,
          resource,
          action
        );

        if (!hasPermission) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `You do not have permission to ${action} ${resource}`,
          });
        }

        return next({
          ctx: {
            ...ctx,
            session: ctx.session as DotSession,
            user: ctx.session.user as DotUser,
          },
        });
      };
    },

    /**
     * Require any of the specified permissions
     */
    requireAnyPermission: (permissions: Array<{ resource: string; action: string }>) => {
      return async ({ ctx, next }: { ctx: TContext; next: any }) => {
        if (!ctx.session?.user) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'You must be logged in to access this resource',
          });
        }

        const hasPermission = await rbac.hasAnyPermission(
          ctx.session.user.id!,
          permissions
        );

        if (!hasPermission) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have the required permissions',
          });
        }

        return next({
          ctx: {
            ...ctx,
            session: ctx.session as DotSession,
            user: ctx.session.user as DotUser,
          },
        });
      };
    },

    /**
     * Require all of the specified permissions
     */
    requireAllPermissions: (permissions: Array<{ resource: string; action: string }>) => {
      return async ({ ctx, next }: { ctx: TContext; next: any }) => {
        if (!ctx.session?.user) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'You must be logged in to access this resource',
          });
        }

        const hasPermissions = await rbac.hasAllPermissions(
          ctx.session.user.id!,
          permissions
        );

        if (!hasPermissions) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have all the required permissions',
          });
        }

        return next({
          ctx: {
            ...ctx,
            session: ctx.session as DotSession,
            user: ctx.session.user as DotUser,
          },
        });
      };
    },

    /**
     * Check ownership of a resource
     */
    requireOwnership: <TInput>(
      getResourceOwnerId: (input: TInput, ctx: TContext) => Promise<string> | string
    ) => {
      return async ({ ctx, next, input }: { ctx: TContext; next: any; input: TInput }) => {
        if (!ctx.session?.user) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'You must be logged in to access this resource',
          });
        }

        const ownerId = await getResourceOwnerId(input, ctx);

        if (ownerId !== ctx.session.user.id) {
          // Check if user is admin (can access any resource)
          const isAdmin = await rbac.hasRole(ctx.session.user.id!, 'admin');

          if (!isAdmin) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'You do not own this resource',
            });
          }
        }

        return next({
          ctx: {
            ...ctx,
            session: ctx.session as DotSession,
            user: ctx.session.user as DotUser,
          },
        });
      };
    },

    /**
     * Optional authentication - doesn't require auth but adds user to context if authenticated
     */
    optionalAuth: () => {
      return async ({ ctx, next }: { ctx: TContext; next: any }) => {
        return next({
          ctx: {
            ...ctx,
            session: ctx.session || null,
            user: ctx.session?.user || null,
          },
        });
      };
    },

    /**
     * Rate limiting middleware
     */
    rateLimit: (options: {
      limit: number;
      window: number; // in seconds
      key?: (ctx: TContext) => string;
    }) => {
      const attempts = new Map<string, { count: number; resetAt: number }>();

      return async ({ ctx, next }: { ctx: TContext; next: any }) => {
        const key = options.key
          ? options.key(ctx)
          : ctx.session?.user?.id || ctx.session?.id || 'anonymous';

        const now = Date.now();
        const attempt = attempts.get(key);

        if (attempt) {
          if (now > attempt.resetAt) {
            // Reset the window
            attempts.set(key, {
              count: 1,
              resetAt: now + options.window * 1000,
            });
          } else if (attempt.count >= options.limit) {
            throw new TRPCError({
              code: 'TOO_MANY_REQUESTS',
              message: `Rate limit exceeded. Try again in ${Math.ceil(
                (attempt.resetAt - now) / 1000
              )} seconds`,
            });
          } else {
            attempt.count++;
          }
        } else {
          attempts.set(key, {
            count: 1,
            resetAt: now + options.window * 1000,
          });
        }

        // Clean up old entries periodically
        if (Math.random() < 0.01) {
          for (const [k, v] of attempts.entries()) {
            if (now > v.resetAt) {
              attempts.delete(k);
            }
          }
        }

        return next({ ctx });
      };
    },

    /**
     * Audit logging middleware
     */
    auditLog: (action: string) => {
      return async ({ ctx, next, input }: { ctx: TContext; next: any; input: any }) => {
        const startTime = Date.now();
        let success = false;
        let error: any = null;

        try {
          const result = await next({ ctx });
          success = true;
          return result;
        } catch (err) {
          error = err;
          throw err;
        } finally {
          const duration = Date.now() - startTime;

          // Log the audit entry
          console.log('Audit Log:', {
            action,
            userId: ctx.session?.user?.id,
            sessionId: ctx.session?.id,
            input: JSON.stringify(input),
            success,
            error: error?.message,
            duration,
            timestamp: new Date().toISOString(),
          });

          // In production, you'd save this to a database
        }
      };
    },
  };
}

/**
 * Create auth-aware procedure builders
 */
export function createAuthProcedures<TRouter extends AnyRouter>(
  t: any,
  sessionManager: DotSessionManager,
  rbac: DotRBACManager
) {
  const middleware = createAuthMiddleware<inferRouterContext<TRouter>>(sessionManager, rbac);

  return {
    /**
     * Public procedure - no auth required
     */
    public: t.procedure,

    /**
     * Protected procedure - requires authentication
     */
    protected: t.procedure.use(middleware.requireAuth()),

    /**
     * Admin procedure - requires admin role
     */
    admin: t.procedure.use(middleware.requireAuth()).use(middleware.requireRole('admin')),

    /**
     * Moderator procedure - requires moderator or admin role
     */
    moderator: t.procedure
      .use(middleware.requireAuth())
      .use(middleware.requireRole(['moderator', 'admin'])),

    /**
     * Create a procedure that requires specific permission
     */
    withPermission: (resource: string, action: string) => {
      return t.procedure
        .use(middleware.requireAuth())
        .use(middleware.requirePermission(resource, action));
    },

    /**
     * Create a procedure that requires specific role(s)
     */
    withRole: (roles: string | string[]) => {
      return t.procedure.use(middleware.requireAuth()).use(middleware.requireRole(roles));
    },

    /**
     * Create a procedure that requires resource ownership
     */
    withOwnership: <TInput>(
      getResourceOwnerId: (input: TInput, ctx: any) => Promise<string> | string
    ) => {
      return t.procedure
        .use(middleware.requireAuth())
        .use(middleware.requireOwnership(getResourceOwnerId));
    },

    /**
     * Create a rate-limited procedure
     */
    withRateLimit: (limit: number, window: number) => {
      return t.procedure.use(middleware.rateLimit({ limit, window }));
    },

    /**
     * Create an audited procedure
     */
    withAudit: (action: string) => {
      return t.procedure.use(middleware.auditLog(action));
    },

    /**
     * Get the middleware object for custom use
     */
    middleware,
  };
}