/**
 * oRPC middleware for authentication and authorization
 */

import { ORPCError } from '@orpc/server';

import type { DotRBACManager } from './rbac.js';
import type { DotSessionManager } from './session.js';
import type { DotSession, DotUser } from './types.js';
import { debugAuth } from '../debug.js';

/**
 * Context with auth
 */
export type AuthContext = {
  session: DotSession | null;
  user: DotUser | null;
  auth?: {
    sessionManager: DotSessionManager;
    rbac: DotRBACManager;
  };
};

/**
 * Create auth middleware factories
 */
export function createAuthMiddleware<TContext extends AuthContext>(
  _sessionManager: DotSessionManager,
  rbac: DotRBACManager,
) {
  return {
    /**
     * Require authentication
     */
    requireAuth: () => {
      return async ({ ctx, next }: { ctx: TContext; next: (opts?: { ctx: unknown }) => Promise<unknown> }) => {
        debugAuth('[middleware] Checking authentication (session: %s, user: %s)', !!ctx.session, !!ctx.session?.user);

        if (!ctx.session?.user) {
          debugAuth('[middleware] Authentication check failed: no user session');
          throw new ORPCError('UNAUTHORIZED', {
            message: 'You must be logged in to access this resource',
          });
        }

        debugAuth('[middleware] Authentication check passed (userId: %s)', ctx.session.user.id);
        return next({
          ctx: {
            ...ctx,
            session: ctx.session,
            user: ctx.session.user,
          },
        });
      };
    },

    /**
     * Require specific role(s)
     */
    requireRole: (roles: string | string[]) => {
      const requiredRoles = Array.isArray(roles) ? roles : [roles];

      return async ({ ctx, next }: { ctx: TContext; next: (opts?: { ctx: unknown }) => Promise<unknown> }) => {
        debugAuth('[middleware] Checking roles (required: %s)', requiredRoles.join(', '));

        if (!ctx.session?.user) {
          debugAuth('[middleware] Role check failed: no user session');
          throw new ORPCError('UNAUTHORIZED', {
            message: 'You must be logged in to access this resource',
          });
        }

        const userRoles = await rbac.getUserRoleNames(ctx.session.user.id);
        debugAuth('[middleware] User roles: %s', userRoles.join(', '));
        const hasRequiredRole = requiredRoles.some(role => userRoles.includes(role));

        if (!hasRequiredRole) {
          debugAuth('[middleware] Role check failed: user lacks required role(s)');
          throw new ORPCError('FORBIDDEN', {
            message: `You need one of these roles: ${requiredRoles.join(', ')}`,
          });
        }

        debugAuth('[middleware] Role check passed');
        return next({
          ctx: {
            ...ctx,
            session: ctx.session,
            user: ctx.session.user,
          },
        });
      };
    },

    /**
     * Require specific permission
     */
    requirePermission: (resource: string, action: string) => {
      return async ({ ctx, next }: { ctx: TContext; next: (opts?: { ctx: unknown }) => Promise<unknown> }) => {
        debugAuth('[middleware] Checking permission (resource: %s, action: %s)', resource, action);

        if (!ctx.session?.user) {
          debugAuth('[middleware] Permission check failed: no user session');
          throw new ORPCError('UNAUTHORIZED', {
            message: 'You must be logged in to access this resource',
          });
        }

        const hasPermission = await rbac.hasPermission(ctx.session.user.id, resource, action);

        if (!hasPermission) {
          debugAuth('[middleware] Permission check failed: user lacks %s permission on %s', action, resource);
          throw new ORPCError('FORBIDDEN', {
            message: `You do not have permission to ${action} ${resource}`,
          });
        }

        debugAuth('[middleware] Permission check passed');
        return next({
          ctx: {
            ...ctx,
            session: ctx.session,
            user: ctx.session.user,
          },
        });
      };
    },

    /**
     * Require any of the specified permissions
     */
    requireAnyPermission: (permissions: { resource: string; action: string }[]) => {
      return async ({ ctx, next }: { ctx: TContext; next: (opts?: { ctx: unknown }) => Promise<unknown> }) => {
        debugAuth('[middleware] Checking any of %d permission(s)', permissions.length);

        if (!ctx.session?.user) {
          debugAuth('[middleware] Any permission check failed: no user session');
          throw new ORPCError('UNAUTHORIZED', {
            message: 'You must be logged in to access this resource',
          });
        }

        const hasPermission = await rbac.hasAnyPermission(ctx.session.user.id, permissions);

        if (!hasPermission) {
          debugAuth('[middleware] Any permission check failed: user lacks all required permissions');
          throw new ORPCError('FORBIDDEN', {
            message: 'You do not have the required permissions',
          });
        }

        debugAuth('[middleware] Any permission check passed');
        return next({
          ctx: {
            ...ctx,
            session: ctx.session,
            user: ctx.session.user,
          },
        });
      };
    },

    /**
     * Require all of the specified permissions
     */
    requireAllPermissions: (permissions: { resource: string; action: string }[]) => {
      return async ({ ctx, next }: { ctx: TContext; next: (opts?: { ctx: unknown }) => Promise<unknown> }) => {
        debugAuth('[middleware] Checking all %d permission(s)', permissions.length);

        if (!ctx.session?.user) {
          debugAuth('[middleware] All permissions check failed: no user session');
          throw new ORPCError('UNAUTHORIZED', {
            message: 'You must be logged in to access this resource',
          });
        }

        const hasPermissions = await rbac.hasAllPermissions(ctx.session.user.id, permissions);

        if (!hasPermissions) {
          debugAuth('[middleware] All permissions check failed: user lacks some required permissions');
          throw new ORPCError('FORBIDDEN', {
            message: 'You do not have all the required permissions',
          });
        }

        debugAuth('[middleware] All permissions check passed');
        return next({
          ctx: {
            ...ctx,
            session: ctx.session,
            user: ctx.session.user,
          },
        });
      };
    },

    /**
     * Check ownership of a resource
     */
    requireOwnership: <TInput>(getResourceOwnerId: (input: TInput, ctx: TContext) => Promise<string> | string) => {
      return async ({ ctx, next, input }: { ctx: TContext; next: (opts?: { ctx: unknown }) => Promise<unknown>; input: TInput }) => {
        debugAuth('[middleware] Checking resource ownership');

        if (!ctx.session?.user) {
          debugAuth('[middleware] Ownership check failed: no user session');
          throw new ORPCError('UNAUTHORIZED', {
            message: 'You must be logged in to access this resource',
          });
        }

        const ownerId = await getResourceOwnerId(input, ctx);
        debugAuth('[middleware] Resource owner: %s, current user: %s', ownerId, ctx.session.user.id);

        if (ownerId === ctx.session.user.id) {
          debugAuth('[middleware] Ownership check passed: user is owner');
        } else {
          debugAuth('[middleware] User is not owner, checking admin role');
          const isAdmin = await rbac.hasRole(ctx.session.user.id, 'admin');

          if (!isAdmin) {
            debugAuth('[middleware] Ownership check failed: user is not owner and not admin');
            throw new ORPCError('FORBIDDEN', {
              message: 'You do not own this resource',
            });
          }

          debugAuth('[middleware] Ownership check passed: user is admin');
        }

        return next({
          ctx: {
            ...ctx,
            session: ctx.session,
            user: ctx.session.user,
          },
        });
      };
    },

    /**
     * Optional authentication - doesn't require auth but adds user to context if authenticated
     */
    optionalAuth: () => {
      return async ({ ctx, next }: { ctx: TContext; next: (opts?: { ctx: unknown }) => Promise<unknown> }) => {
        debugAuth('[middleware] Optional auth (authenticated: %s)', !!ctx.session?.user);
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

      return async ({ ctx, next }: { ctx: TContext; next: (opts?: { ctx: unknown }) => Promise<unknown> }) => {
        const key = options.key ? options.key(ctx) : ctx.session?.user?.id || ctx.session?.id || 'anonymous';

        debugAuth('[middleware] Rate limit check for key: %s (limit: %d/%ds)', key, options.limit, options.window);

        const now = Date.now();
        const attempt = attempts.get(key);

        if (attempt) {
          if (now > attempt.resetAt) {
            debugAuth('[middleware] Rate limit window reset for key: %s', key);
            attempts.set(key, {
              count: 1,
              resetAt: now + options.window * 1000,
            });
          } else if (attempt.count >= options.limit) {
            const retrySeconds = Math.ceil((attempt.resetAt - now) / 1000);
            debugAuth('[middleware] Rate limit exceeded for key: %s (retry in %ds)', key, retrySeconds);
            throw new ORPCError('TOO_MANY_REQUESTS', {
              message: `Rate limit exceeded. Try again in ${retrySeconds} seconds`,
            });
          } else {
            attempt.count++;
            debugAuth('[middleware] Rate limit attempt %d/%d for key: %s', attempt.count, options.limit, key);
          }
        } else {
          debugAuth('[middleware] First rate limit attempt for key: %s', key);
          attempts.set(key, {
            count: 1,
            resetAt: now + options.window * 1000,
          });
        }

        // Clean up old entries periodically
        if (Math.random() < 0.01) {
          debugAuth('[middleware] Cleaning up old rate limit entries');
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
      return async ({ ctx, next, input }: { ctx: TContext; next: (opts?: { ctx: unknown }) => Promise<unknown>; input: unknown }) => {
        debugAuth(
          '[middleware] Audit log starting for action: %s (user: %s)',
          action,
          ctx.session?.user?.id || 'anonymous',
        );
        const startTime = Date.now();
        let success = false;
        let error: Error | undefined = undefined;

        try {
          const result = await next({ ctx });
          success = true;
          debugAuth('[middleware] Audit log: action %s succeeded', action);
          return result;
        } catch (error_) {
          error = error_ instanceof Error ? error_ : new Error(String(error_));
          debugAuth(
            '[middleware] Audit log: action %s failed (error: %s)',
            action,
            error.message,
          );
          throw error_;
        } finally {
          const duration = Date.now() - startTime;

          debugAuth(
            '[middleware] Audit log complete (action: %s, success: %s, duration: %dms)',
            action,
            success,
            duration,
          );

          // Log the audit entry
          debugAuth('Audit Log: %o', {
            action,
            userId: ctx.session?.user?.id,
            sessionId: ctx.session?.id,
            input: JSON.stringify(input),
            success,
            error: error?.message,
            duration,
            timestamp: new Date().toISOString(),
          });
        }
      };
    },
  };
}

/**
 * Create auth-aware procedure builders
 */
export function createAuthProcedures(
  t: { procedure: unknown },
  sessionManager: DotSessionManager,
  rbac: DotRBACManager,
) {
  const middleware = createAuthMiddleware<AuthContext>(sessionManager, rbac);

  return {
    /** Public procedure - no auth required */
    public: (t as Record<string, unknown>).procedure,

    /** Protected procedure - requires authentication */
    protected: ((t as Record<string, unknown>).procedure as { use: (mw: unknown) => unknown }).use(middleware.requireAuth()),

    /**
     * Get the middleware object for custom use
     */
    middleware,
  };
}
