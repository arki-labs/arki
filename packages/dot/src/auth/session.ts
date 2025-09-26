/**
 * Session management wrapper for better-auth
 */

import type { Auth } from 'better-auth';

import type { DotSession, DotUser } from './types';

/**
 * Session manager interface
 */
export interface DotSessionManager {
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
}

/**
 * Create session manager wrapper around better-auth
 */
export function createSessionManager(auth: Auth, db?: any): DotSessionManager {
  return {
    async getSession(headers: Headers): Promise<DotSession | null> {
      try {
        const session = await auth.api.getSession({ headers });

        if (!session) {
          return null;
        }

        // Enhance with additional data if needed
        return session as DotSession;
      } catch (error) {
        console.error('Error getting session:', error);
        return null;
      }
    },

    async createSession(userId: string, metadata?: Record<string, any>): Promise<DotSession> {
      // Create session through better-auth
      // This would typically be done through the sign-in flow
      // For direct session creation, we'd need to interact with the database
      if (!db) {
        throw new Error('Database is required for direct session creation');
      }

      // Create session token
      const sessionToken = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      // Insert session into database
      const [session] = await db
        .insert('sessions')
        .values({
          id: `sess_${crypto.randomUUID()}`,
          userId,
          token: sessionToken,
          expiresAt,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...metadata,
        })
        .returning();

      // Get user data
      const [user] = await db
        .select()
        .from('users')
        .where({ id: userId })
        .limit(1);

      return {
        ...session,
        user,
      } as DotSession;
    },

    async invalidateSession(sessionId: string): Promise<void> {
      try {
        // Invalidate through better-auth API if available
        // Otherwise, delete from database
        if (db) {
          await db
            .delete('sessions')
            .where({ id: sessionId });
        }
      } catch (error) {
        console.error('Error invalidating session:', error);
        throw error;
      }
    },

    async invalidateAllUserSessions(userId: string): Promise<void> {
      try {
        if (!db) {
          throw new Error('Database is required for session invalidation');
        }

        // Delete all sessions for the user
        await db
          .delete('sessions')
          .where({ userId });
      } catch (error) {
        console.error('Error invalidating user sessions:', error);
        throw error;
      }
    },

    async getActiveSessions(userId: string): Promise<DotSession[]> {
      try {
        if (!db) {
          throw new Error('Database is required to get active sessions');
        }

        // Get all non-expired sessions for the user
        const sessions = await db
          .select()
          .from('sessions')
          .where({ userId })
          .where('expiresAt', '>', new Date());

        // Get user data
        const [user] = await db
          .select()
          .from('users')
          .where({ id: userId })
          .limit(1);

        return sessions.map((session: any) => ({
          ...session,
          user,
        })) as DotSession[];
      } catch (error) {
        console.error('Error getting active sessions:', error);
        return [];
      }
    },

    async validateToken(token: string): Promise<DotSession | null> {
      try {
        if (!db) {
          throw new Error('Database is required for token validation');
        }

        // Find session by token
        const [session] = await db
          .select()
          .from('sessions')
          .where({ token })
          .where('expiresAt', '>', new Date())
          .limit(1);

        if (!session) {
          return null;
        }

        // Get user data
        const [user] = await db
          .select()
          .from('users')
          .where({ id: session.userId })
          .limit(1);

        return {
          ...session,
          user,
        } as DotSession;
      } catch (error) {
        console.error('Error validating token:', error);
        return null;
      }
    },

    async refreshSession(sessionId: string): Promise<DotSession> {
      try {
        if (!db) {
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

        // Get user data
        const [user] = await db
          .select()
          .from('users')
          .where({ id: session.userId })
          .limit(1);

        return {
          ...session,
          user,
        } as DotSession;
      } catch (error) {
        console.error('Error refreshing session:', error);
        throw error;
      }
    },

    async updateSessionMetadata(sessionId: string, metadata: Record<string, any>): Promise<void> {
      try {
        if (!db) {
          throw new Error('Database is required for session update');
        }

        await db
          .update('sessions')
          .set({
            ...metadata,
            updatedAt: new Date(),
          })
          .where({ id: sessionId });
      } catch (error) {
        console.error('Error updating session metadata:', error);
        throw error;
      }
    },
  };
}

/**
 * Session utilities
 */
export const sessionUtils = {
  /**
   * Check if session is expired
   */
  isExpired(session: DotSession): boolean {
    if (!session.expiresAt) return false;
    return new Date(session.expiresAt) < new Date();
  },

  /**
   * Get remaining session time in seconds
   */
  getRemainingTime(session: DotSession): number {
    if (!session.expiresAt) return 0;
    const remaining = new Date(session.expiresAt).getTime() - Date.now();
    return Math.max(0, Math.floor(remaining / 1000));
  },

  /**
   * Check if session should be refreshed
   */
  shouldRefresh(session: DotSession, updateAge = 24 * 60 * 60): boolean {
    if (!session.updatedAt) return true;
    const age = Date.now() - new Date(session.updatedAt).getTime();
    return age > updateAge * 1000;
  },

  /**
   * Extract user from session
   */
  getUser(session: DotSession): DotUser | null {
    return session.user || null;
  },

  /**
   * Check if user has a specific role
   */
  hasRole(session: DotSession, role: string): boolean {
    const user = session.user;
    if (!user || !user.roles) return false;
    return user.roles.some(r => r.name === role);
  },

  /**
   * Check if user has a specific permission
   */
  hasPermission(session: DotSession, resource: string, action: string): boolean {
    const user = session.user;
    if (!user) return false;

    // Check direct permissions
    if (user.permissions) {
      const hasDirectPermission = user.permissions.some(
        p => p.resource === resource && p.action === action
      );
      if (hasDirectPermission) return true;
    }

    // Check role permissions
    if (user.roles) {
      for (const role of user.roles) {
        if (role.permissions) {
          const hasRolePermission = role.permissions.some(
            p => p.resource === resource && p.action === action
          );
          if (hasRolePermission) return true;
        }
      }
    }

    return false;
  },
};