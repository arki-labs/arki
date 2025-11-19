/**
 * Session management wrapper for better-auth
 */

import type { betterAuth } from 'better-auth';

import type { DotSession, DotUser } from './types';
import { debugAuth } from '../debug.ts';

/**
 * Session manager interface for comprehensive session management
 *
 * Provides methods for creating, validating, refreshing, and invalidating sessions
 */
export type DotSessionManager = {
  /**
   * Get current session from headers
   */
  getSession(headers: Headers): Promise<DotSession | null>;

  /**
   * Create a new session for a user
   */
  createSession(userId: string, metadata?: Record<string, any>): Promise<DotSession>;

  /**
   * Invalidate a specific session
   */
  invalidateSession(sessionId: string): Promise<void>;

  /**
   * Invalidate all sessions for a user
   */
  invalidateAllUserSessions(userId: string): Promise<void>;

  /**
   * Get all active sessions for a user
   */
  getActiveSessions(userId: string): Promise<DotSession[]>;

  /**
   * Validate a session token
   */
  validateToken(token: string): Promise<DotSession | null>;

  /**
   * Refresh a session
   */
  refreshSession(sessionId: string): Promise<DotSession>;

  /**
   * Update session metadata
   */
  updateSessionMetadata(sessionId: string, metadata: Record<string, any>): Promise<void>;
};

/**
 * Create session manager wrapper around better-auth
 *
 * @param auth - The better-auth instance
 * @param db - Optional database connection for direct session operations
 * @returns A session manager with comprehensive session management capabilities
 */
export function createSessionManager(auth: ReturnType<typeof betterAuth>, db?: any): DotSessionManager {
  debugAuth('[session] Creating session manager (db: %s)', db ? 'provided' : 'not provided');

  return {
    async getSession(headers: Headers): Promise<DotSession | null> {
      debugAuth('[session] Getting session from headers');

      if (!headers || !(headers instanceof Headers)) {
        debugAuth('[session] Invalid headers provided to getSession');
        console.warn('Invalid headers provided to getSession');
        return null;
      }

      try {
        const result = await auth.api.getSession({ headers });

        if (!result) {
          debugAuth('[session] No session found in headers');
          return null;
        }

        // Better-auth returns an object with session and user properties
        const { session, user } = result;

        if (!session || !user) {
          debugAuth('[session] Invalid session structure received from better-auth');
          console.warn('Invalid session structure received from better-auth');
          return null;
        }

        // Check if session is expired
        if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
          debugAuth('[session] Session expired (sessionId: %s)', session.id);
          console.debug('Session expired');
          return null;
        }

        // Map to DotSession structure
        const dotSession: DotSession = {
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          userId: session.userId,
          expiresAt: session.expiresAt,
          token: session.token,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
            image: user.image,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            roles: (user as any).roles || [],
          },
        };

        debugAuth(
          '[session] Session retrieved successfully (sessionId: %s, userId: %s)',
          dotSession.id,
          dotSession.userId,
        );
        return dotSession;
      } catch (error) {
        debugAuth('[session] Error getting session: %s', error instanceof Error ? error.message : 'unknown error');
        console.error('Error getting session:', error);
        return null;
      }
    },

    async createSession(userId: string, metadata?: Record<string, any>): Promise<DotSession> {
      debugAuth('[session] Creating session (userId: %s, hasMetadata: %s)', userId, !!metadata);

      if (!userId || typeof userId !== 'string') {
        debugAuth('[session] Invalid userId provided: %s', userId);
        throw new Error('Valid user ID is required to create a session');
      }

      // Create session through better-auth
      // This would typically be done through the sign-in flow
      // For direct session creation, we'd need to interact with the database
      if (!db) {
        debugAuth('[session] Database connection required but not available');
        throw new Error('Database connection is required for direct session creation');
      }

      try {
        // Create secure session token
        const sessionToken = crypto.randomUUID();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

        debugAuth('[session] Inserting session into database (userId: %s, expiresIn: 30 days)', userId);

        // Insert session into database
        const [session] = await db
          .insert('sessions')
          .values({
            id: `sess_${crypto.randomUUID()}`,
            userId,
            token: sessionToken,
            expiresAt,
            createdAt: now,
            updatedAt: now,
            ipAddress: metadata?.ipAddress,
            userAgent: metadata?.userAgent,
            ...metadata,
          })
          .returning();

        if (!session) {
          debugAuth('[session] Failed to create session in database');
          throw new Error('Failed to create session in database');
        }

        debugAuth('[session] Session created in database (sessionId: %s)', session.id);

        // Get user data
        const [user] = await db.select().from('users').where({ id: userId }).limit(1);

        if (!user) {
          debugAuth('[session] User not found, cleaning up session (userId: %s, sessionId: %s)', userId, session.id);
          // Clean up session if user not found
          await db.delete('sessions').where({ id: session.id });
          throw new Error('User not found for session creation');
        }

        debugAuth('[session] Session created successfully (sessionId: %s, userId: %s)', session.id, userId);
        return {
          ...session,
          user,
        } as DotSession;
      } catch (error) {
        debugAuth('[session] Failed to create session: %s', error instanceof Error ? error.message : 'unknown error');
        console.error('Failed to create session:', error);
        throw new Error(`Session creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },

    async invalidateSession(sessionId: string): Promise<void> {
      debugAuth('[session] Invalidating session (sessionId: %s)', sessionId);

      if (!sessionId || typeof sessionId !== 'string') {
        debugAuth('[session] Invalid sessionId provided: %s', sessionId);
        throw new Error('Valid session ID is required for invalidation');
      }

      try {
        // Invalidate through better-auth API if available
        // Otherwise, delete from database
        if (!db) {
          debugAuth('[session] No database connection - session invalidation may not persist');
          console.warn('No database connection - session invalidation may not persist');
          return;
        }

        const result = await db.delete('sessions').where({ id: sessionId }).returning();

        if (!result || result.length === 0) {
          debugAuth('[session] Session not found or already invalidated (sessionId: %s)', sessionId);
          console.debug(`Session ${sessionId} not found or already invalidated`);
        } else {
          debugAuth('[session] Session invalidated successfully (sessionId: %s)', sessionId);
        }
      } catch (error) {
        debugAuth('[session] Error invalidating session: %s', error instanceof Error ? error.message : 'unknown error');
        console.error('Error invalidating session:', error);
        throw new Error(`Failed to invalidate session: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },

    async invalidateAllUserSessions(userId: string): Promise<void> {
      debugAuth('[session] Invalidating all user sessions (userId: %s)', userId);

      try {
        if (!db) {
          debugAuth('[session] Database required but not available');
          throw new Error('Database is required for session invalidation');
        }

        // Delete all sessions for the user
        await db.delete('sessions').where({ userId });

        debugAuth('[session] All user sessions invalidated (userId: %s)', userId);
      } catch (error) {
        debugAuth(
          '[session] Error invalidating user sessions: %s',
          error instanceof Error ? error.message : 'unknown error',
        );
        console.error('Error invalidating user sessions:', error);
        throw error;
      }
    },

    async getActiveSessions(userId: string): Promise<DotSession[]> {
      debugAuth('[session] Getting active sessions (userId: %s)', userId);

      try {
        if (!db) {
          debugAuth('[session] Database required but not available');
          throw new Error('Database is required to get active sessions');
        }

        // Get all non-expired sessions for the user
        const sessions = await db.select().from('sessions').where({ userId }).where('expiresAt', '>', new Date());

        debugAuth('[session] Found %d active session(s) (userId: %s)', sessions.length, userId);

        // Get user data
        const [user] = await db.select().from('users').where({ id: userId }).limit(1);

        return sessions.map((session: any) => ({
          ...session,
          user,
        })) as DotSession[];
      } catch (error) {
        debugAuth(
          '[session] Error getting active sessions: %s',
          error instanceof Error ? error.message : 'unknown error',
        );
        console.error('Error getting active sessions:', error);
        return [];
      }
    },

    async validateToken(token: string): Promise<DotSession | null> {
      debugAuth('[session] Validating token');

      if (!token || typeof token !== 'string') {
        debugAuth('[session] Invalid token provided');
        return null;
      }

      try {
        if (!db) {
          debugAuth('[session] Database required for token validation');
          console.warn('Database is required for token validation');
          return null;
        }

        // Find session by token
        const [session] = await db
          .select()
          .from('sessions')
          .where({ token })
          .where('expiresAt', '>', new Date())
          .limit(1);

        if (!session) {
          debugAuth('[session] Token not found or session expired');
          return null;
        }

        debugAuth('[session] Token validated successfully (sessionId: %s)', session.id);

        // Get user data
        const [user] = await db.select().from('users').where({ id: session.userId }).limit(1);

        return {
          ...session,
          user,
        } as DotSession;
      } catch (error) {
        debugAuth('[session] Error validating token: %s', error instanceof Error ? error.message : 'unknown error');
        console.error('Error validating token:', error);
        return null;
      }
    },

    async refreshSession(sessionId: string): Promise<DotSession> {
      debugAuth('[session] Refreshing session (sessionId: %s)', sessionId);

      try {
        if (!db) {
          debugAuth('[session] Database required but not available');
          throw new Error('Database is required for session refresh');
        }

        // Extend session expiration
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

        const [session] = await db
          .update('sessions')
          .set({
            expiresAt,
            updatedAt: new Date(),
          })
          .where({ id: sessionId })
          .returning();

        debugAuth('[session] Session refreshed (sessionId: %s, newExpiry: %s)', sessionId, expiresAt.toISOString());

        // Get user data
        const [user] = await db.select().from('users').where({ id: session.userId }).limit(1);

        return {
          ...session,
          user,
        } as DotSession;
      } catch (error) {
        debugAuth('[session] Error refreshing session: %s', error instanceof Error ? error.message : 'unknown error');
        console.error('Error refreshing session:', error);
        throw error;
      }
    },

    async updateSessionMetadata(sessionId: string, metadata: Record<string, any>): Promise<void> {
      debugAuth(
        '[session] Updating session metadata (sessionId: %s, keys: %s)',
        sessionId,
        Object.keys(metadata).join(', '),
      );

      try {
        if (!db) {
          debugAuth('[session] Database required but not available');
          throw new Error('Database is required for session update');
        }

        await db
          .update('sessions')
          .set({
            ...metadata,
            updatedAt: new Date(),
          })
          .where({ id: sessionId });

        debugAuth('[session] Session metadata updated successfully (sessionId: %s)', sessionId);
      } catch (error) {
        debugAuth(
          '[session] Error updating session metadata: %s',
          error instanceof Error ? error.message : 'unknown error',
        );
        console.error('Error updating session metadata:', error);
        throw error;
      }
    },
  };
}

/**
 * Session utility functions for common session operations
 *
 * @example
 * ```typescript
 * if (sessionUtils.isExpired(session)) {
 *   // Handle expired session
 * }
 * ```
 */
export const sessionUtils = {
  /**
   * Check if session is expired
   * @param session - The session to check
   * @returns True if session is expired, false otherwise
   */
  isExpired(session: DotSession | null | undefined): boolean {
    if (!session || !session.expiresAt) {
      debugAuth('[session-utils] Session has no expiration (sessionId: %s)', session?.id || 'null');
      return false;
    }

    try {
      const isExpired = new Date(session.expiresAt) < new Date();
      debugAuth('[session-utils] Session expiration check (sessionId: %s, expired: %s)', session.id, isExpired);
      return isExpired;
    } catch {
      debugAuth('[session-utils] Invalid expiration date in session (sessionId: %s)', session.id);
      console.warn('Invalid expiration date in session');
      return true; // Treat invalid dates as expired for safety
    }
  },

  /**
   * Get remaining session time in seconds
   */
  getRemainingTime(session: DotSession): number {
    if (!session.expiresAt) {
      debugAuth('[session-utils] Session has no expiration, returning 0 (sessionId: %s)', session.id);
      return 0;
    }
    const remaining = new Date(session.expiresAt).getTime() - Date.now();
    const seconds = Math.max(0, Math.floor(remaining / 1000));
    debugAuth('[session-utils] Remaining time calculated (sessionId: %s, seconds: %d)', session.id, seconds);
    return seconds;
  },

  /**
   * Check if session should be refreshed
   */
  shouldRefresh(session: DotSession, updateAge = 24 * 60 * 60): boolean {
    if (!session.updatedAt) {
      debugAuth('[session-utils] Session has no updatedAt, should refresh (sessionId: %s)', session.id);
      return true;
    }
    const age = Date.now() - new Date(session.updatedAt).getTime();
    const shouldRefresh = age > updateAge * 1000;
    debugAuth(
      '[session-utils] Refresh check (sessionId: %s, age: %ds, threshold: %ds, shouldRefresh: %s)',
      session.id,
      Math.floor(age / 1000),
      updateAge,
      shouldRefresh,
    );
    return shouldRefresh;
  },

  /**
   * Extract user from session
   */
  getUser(session: DotSession): DotUser | null {
    const user = session.user || null;
    debugAuth('[session-utils] Getting user from session (sessionId: %s, hasUser: %s)', session.id, !!user);
    return user;
  },

  /**
   * Check if user has a specific role
   */
  hasRole(session: DotSession, role: string): boolean {
    debugAuth('[session-utils] Checking role (sessionId: %s, role: %s)', session.id, role);

    const user = session.user;
    if (!user || !user.roles) {
      debugAuth('[session-utils] User has no roles (sessionId: %s)', session.id);
      return false;
    }

    const hasRole = user.roles.some(r => r.name === role);
    debugAuth('[session-utils] Role check result (sessionId: %s, role: %s, hasRole: %s)', session.id, role, hasRole);
    return hasRole;
  },

  /**
   * Check if user has a specific permission
   */
  hasPermission(session: DotSession, resource: string, action: string): boolean {
    debugAuth(
      '[session-utils] Checking permission (sessionId: %s, resource: %s, action: %s)',
      session.id,
      resource,
      action,
    );

    const user = session.user;
    if (!user) {
      debugAuth('[session-utils] No user in session (sessionId: %s)', session.id);
      return false;
    }

    // Check direct permissions
    if (user.permissions) {
      const hasDirectPermission = user.permissions.some(p => p.resource === resource && p.action === action);
      if (hasDirectPermission) {
        debugAuth(
          '[session-utils] User has direct permission (sessionId: %s, resource: %s, action: %s)',
          session.id,
          resource,
          action,
        );
        return true;
      }
    }

    // Check role permissions
    if (user.roles) {
      for (const role of user.roles) {
        if (role.permissions) {
          const hasRolePermission = role.permissions.some(p => p.resource === resource && p.action === action);
          if (hasRolePermission) {
            debugAuth(
              '[session-utils] User has permission via role (sessionId: %s, roleName: %s, resource: %s, action: %s)',
              session.id,
              role.name,
              resource,
              action,
            );
            return true;
          }
        }
      }
    }

    debugAuth(
      '[session-utils] User lacks permission (sessionId: %s, resource: %s, action: %s)',
      session.id,
      resource,
      action,
    );
    return false;
  },
};
