/**
 * Dot Auth Module - Better-Auth Integration
 *
 * Provides a comprehensive authentication solution with:
 * - Zero-boilerplate configuration
 * - Built-in RBAC (Role-Based Access Control)
 * - Session management
 * - OAuth provider auto-detection
 * - Type-safe oRPC integration
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { betterAuth } from '@arki/auth';

import type { DotAuthConfig } from './config.js';
import type { DotRBACManager } from './rbac.js';
import type { DotSessionManager } from './session.js';
import type { DotSession } from './types.js';
import { debugAuth } from './../debug.js';
import {
  authEnv,
  getAuthSecret as getEnvAuthSecret,
  getBaseUrl as getEnvBaseUrl,
  getProductionUrl as getEnvProductionUrl,
} from './env.js';
import { createAuthMiddleware, createAuthProcedures } from './middleware.js';
import { createRBACManager, initializeRBAC } from './rbac.js';
import { createSessionManager } from './session.js';
import { toBetterAuthConfig, validateConfig } from './transform.js';

// Re-export all types
export * from './config.js';
export * from './types.js';

export type { DotRBACManager } from './rbac.js';
export type { DotSessionManager } from './session.js';

// Re-export security utilities
export {
  addSecurityDelay,
  compareTokens,
  createRateLimitKey,
  generateSecureToken,
  generateSessionToken,
  hashToken,
  isValidEmail,
  isValidSessionToken,
  rateLimitDefaults,
  sanitizeInput,
  secureCompare,
  securityHeaders,
  validatePassword,
  type RateLimitConfig,
} from './security.js';
export { sessionUtils } from './session.js';

/**
 * Dot Auth instance - The main authentication interface
 *
 * @example
 * ```typescript
 * const auth = await createDotAuth(config, db);
 * const session = await auth.getSession(headers);
 * ```
 */
export type DotAuth = {
  /**
   * The underlying better-auth instance for direct access when needed
   */
  instance: ReturnType<typeof betterAuth>;

  /**
   * Better-auth API methods for authentication operations
   */
  api: ReturnType<typeof betterAuth>['api'];

  /**
   * Session manager for handling user sessions
   */
  session: DotSessionManager;

  /**
   * RBAC manager for role and permission management
   */
  rbac: DotRBACManager;

  /**
   * Create oRPC procedures with built-in auth middleware
   * @param t - The oRPC instance
   * @returns Auth-aware procedures (public, protected, admin, etc.)
   */
  createProcedures: (t: any) => ReturnType<typeof createAuthProcedures>;

  /**
   * Create auth middleware for custom use
   * @returns Middleware functions for authentication and authorization
   */
  createMiddleware: () => ReturnType<typeof createAuthMiddleware>;

  /**
   * Get session from HTTP headers
   * @param headers - HTTP headers containing session information
   * @returns The user session or null if not authenticated
   */
  getSession: (headers: Headers) => Promise<DotSession | null>;

  /**
   * Sign out a user session
   * @param sessionId - The session ID to invalidate
   */
  signOut: (sessionId: string) => Promise<void>;

  /**
   * The current auth configuration
   */
  config: DotAuthConfig;
};

/**
 * Create a Dot Auth instance with better-auth integration
 *
 * @param config - The authentication configuration
 * @param db - Optional database connection for session storage and RBAC
 * @returns A configured DotAuth instance
 * @throws {Error} If configuration is invalid
 *
 * @example
 * ```typescript
 * const auth = await createDotAuth({
 *   providers: ['google', 'github'],
 *   rbac: { enabled: true }
 * }, db);
 * ```
 */
export async function createDotAuth(config: DotAuthConfig, db?: NodePgDatabase<any>): Promise<DotAuth> {
  debugAuth('[index] Creating DotAuth instance (hasDb: %s)', !!db);

  // Validate configuration
  try {
    debugAuth('[index] Validating auth configuration');
    validateConfig(config);
    debugAuth('[index] Configuration validation passed');
  } catch (error) {
    debugAuth('[index] Configuration validation failed: %s', error instanceof Error ? error.message : 'unknown error');
    throw new Error(`Invalid auth configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Transform to better-auth config
  debugAuth('[index] Transforming config to better-auth format');
  const betterAuthConfig = toBetterAuthConfig(config, db);
  debugAuth('[index] Config transformation complete');

  // Create better-auth instance
  debugAuth('[index] Creating better-auth instance');
  const auth = betterAuth(betterAuthConfig);
  debugAuth('[index] better-auth instance created');

  // Create managers with error handling
  let sessionManager: DotSessionManager;
  let rbacManager: DotRBACManager;

  try {
    debugAuth('[index] Creating session and RBAC managers');
    sessionManager = createSessionManager(auth, db);
    rbacManager = db ? createRBACManager(db) : createMockRBACManager();
    debugAuth('[index] Managers created successfully (rbac: %s)', db ? 'real' : 'mock');
  } catch (error) {
    debugAuth(
      '[index] Failed to initialize auth managers: %s',
      error instanceof Error ? error.message : 'unknown error',
    );
    console.error('Failed to initialize auth managers:', error);
    throw new Error(`Failed to initialize auth: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Initialize default roles if RBAC is enabled
  if (config.rbac?.enabled && db) {
    debugAuth('[index] RBAC enabled, initializing default roles');
    try {
      await initializeRBAC(rbacManager);

      // Log successful RBAC initialization
      debugAuth('[index] RBAC initialized with default roles');
      console.log('RBAC initialized with default roles');
    } catch (error) {
      debugAuth('[index] RBAC initialization failed: %s', error instanceof Error ? error.message : 'unknown error');
      // Log error but don't fail - RBAC is optional
      console.error('Failed to initialize RBAC roles:', error);

      // Only throw if RBAC is explicitly enabled
      if (config.rbac.enabled) {
        throw new Error(`RBAC initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  } else {
    debugAuth('[index] Skipping RBAC initialization (enabled: %s, hasDb: %s)', !!config.rbac?.enabled, !!db);
  }

  debugAuth('[index] DotAuth instance created successfully');
  return {
    instance: auth,
    api: auth.api,
    session: sessionManager,
    rbac: rbacManager,

    createProcedures: (t: any) => {
      debugAuth('[index] Creating auth procedures');
      return createAuthProcedures(t, sessionManager, rbacManager);
    },

    createMiddleware: () => {
      debugAuth('[index] Creating auth middleware');
      return createAuthMiddleware(sessionManager, rbacManager);
    },

    getSession: async (headers: Headers) => {
      debugAuth('[index] Getting session from headers');
      try {
        const session = await sessionManager.getSession(headers);
        debugAuth('[index] Session retrieved (found: %s)', !!session);
        return session;
      } catch (error) {
        debugAuth('[index] Error getting session: %s', error instanceof Error ? error.message : 'unknown error');
        console.error('Error getting session:', error);
        return null; // Return null on error rather than throwing
      }
    },

    signOut: async (sessionId: string) => {
      debugAuth('[index] Signing out session: %s', sessionId);
      if (!sessionId) {
        debugAuth('[index] Sign out failed: session ID required');
        throw new Error('Session ID is required for sign out');
      }

      try {
        await sessionManager.invalidateSession(sessionId);
        debugAuth('[index] Session signed out successfully: %s', sessionId);
      } catch (error) {
        debugAuth('[index] Error signing out session: %s', error instanceof Error ? error.message : 'unknown error');
        console.error('Error signing out session:', error);
        throw new Error(`Failed to sign out: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },

    config,
  };
}

/**
 * Create mock RBAC manager for when database is not available
 * This allows the auth module to work without a database connection
 * but with limited functionality
 *
 * @private
 */
function createMockRBACManager(): DotRBACManager {
  debugAuth('[index] Creating mock RBAC manager (env: %s)', authEnv.NODE_ENV);
  if (authEnv.NODE_ENV !== 'test') {
    debugAuth('[index] Warning: mock RBAC manager - features will be limited');
    console.warn('Database not configured - using mock RBAC manager. RBAC features will be limited.');
  }

  return {
    createRole: async () => {
      throw new Error('RBAC not available without database');
    },
    updateRole: async () => {
      throw new Error('RBAC not available without database');
    },
    deleteRole: async () => {
      throw new Error('RBAC not available without database');
    },
    getRole: async () => null,
    getRoleByName: async () => null,
    listRoles: async () => [],
    assignRole: async () => {},
    assignRoleByName: async () => {},
    removeRole: async () => {},
    removeRoleByName: async () => {},
    getUserRoles: async () => [],
    getUserRoleNames: async () => [],
    hasRole: async () => false,
    createPermission: async () => {
      throw new Error('RBAC not available without database');
    },
    deletePermission: async () => {},
    getPermission: async () => null,
    listPermissions: async () => [],
    assignPermissionToRole: async () => {},
    removePermissionFromRole: async () => {},
    getRolePermissions: async () => [],
    getUserPermissions: async () => [],
    hasPermission: async () => false,
    hasAnyPermission: async () => false,
    hasAllPermissions: async () => false,
    evaluatePolicy: async () => false,
    syncUserRoles: async () => {},
    getUserWithRolesAndPermissions: async () => null,
  };
}

/**
 * Create auth configuration from environment variables
 *
 * Automatically detects OAuth providers and other settings from environment
 *
 * @param overrides - Optional configuration overrides
 * @returns Complete auth configuration
 *
 * @example
 * ```typescript
 * // Auto-detect everything from environment
 * const config = createAuthConfigFromEnv();
 *
 * // Override specific settings
 * const config = createAuthConfigFromEnv({
 *   rbac: { enabled: true }
 * });
 * ```
 */
export function createAuthConfigFromEnv(overrides?: Partial<DotAuthConfig>): DotAuthConfig {
  debugAuth('[index] Creating auth config from environment (hasOverrides: %s)', !!overrides);

  const config: DotAuthConfig = {
    appName: authEnv.APP_NAME,
    appKey: authEnv.APP_KEY,
    baseUrl: getEnvBaseUrl(),
    productionUrl: getEnvProductionUrl(),
    secret: getEnvAuthSecret(),

    // Detect providers from environment
    providers: [],

    // Default session config
    session: {
      strategy: 'database',
      expiresIn: '30d',
      updateAge: '1d',
    },

    // Default features
    features: {
      emailPassword: true,
      accountLinking: true,
      profileUpdate: true,
      emailChange: true,
      passwordReset: true,
      registration: true,
      socialLogin: true,
    },

    ...overrides,
  };

  debugAuth('[index] Base config created (appName: %s, baseUrl: %s)', config.appName, config.baseUrl);

  // Auto-detect OAuth providers from environment using validated env
  const providerChecks = [
    { provider: 'google', check: () => !!(authEnv.GOOGLE_CLIENT_ID || authEnv.AUTH_GOOGLE_ID) },
    { provider: 'github', check: () => !!(authEnv.GITHUB_CLIENT_ID || authEnv.AUTH_GITHUB_ID) },
    { provider: 'discord', check: () => !!(authEnv.DISCORD_CLIENT_ID || authEnv.AUTH_DISCORD_ID) },
    { provider: 'facebook', check: () => !!(authEnv.FACEBOOK_CLIENT_ID || authEnv.AUTH_FACEBOOK_ID) },
    { provider: 'apple', check: () => !!(authEnv.APPLE_CLIENT_ID || authEnv.AUTH_APPLE_ID) },
    { provider: 'twitter', check: () => !!(authEnv.TWITTER_CLIENT_ID || authEnv.AUTH_TWITTER_ID) },
  ];

  debugAuth('[index] Auto-detecting OAuth providers from environment');
  let detectedCount = 0;
  for (const { provider, check } of providerChecks) {
    if (check() && config.providers) {
      debugAuth('[index] Detected provider: %s', provider);
      config.providers.push(provider as any);
      detectedCount++;
    }
  }

  debugAuth('[index] Config from environment complete (detected providers: %d)', detectedCount);
  return config;
}

/**
 * Quick setup function for common auth configurations
 */
export const authPresets = {
  /**
   * Basic auth with email/password
   */
  basic: (): DotAuthConfig => ({
    providers: ['credentials'],
    features: {
      emailPassword: true,
      passwordReset: true,
      registration: true,
    },
  }),

  /**
   * Social auth only (no email/password)
   */
  socialOnly: (): DotAuthConfig => ({
    providers: ['google', 'github', 'discord'],
    features: {
      emailPassword: false,
      socialLogin: true,
      accountLinking: true,
    },
  }),

  /**
   * Full featured auth
   */
  full: (): DotAuthConfig => ({
    providers: ['google', 'github', 'discord', 'credentials', 'magicLink'],
    rbac: {
      enabled: true,
      roles: ['admin', 'moderator', 'user'],
      defaultRole: 'user',
    },
    mfa: {
      providers: ['totp', 'webauthn'],
      required: false,
    },
    features: {
      emailPassword: true,
      socialLogin: true,
      accountLinking: true,
      profileUpdate: true,
      emailChange: true,
      passwordReset: true,
      registration: true,
    },
  }),

  /**
   * Enterprise auth with SSO and MFA
   */
  enterprise: (): DotAuthConfig => ({
    providers: ['credentials'],
    rbac: {
      enabled: true,
      roles: ['admin', 'manager', 'employee', 'contractor'],
      defaultRole: 'employee',
      abac: true,
    },
    mfa: {
      providers: ['totp', 'webauthn', 'sms'],
      required: true,
      gracePeriod: 7,
    },
    security: {
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireNumbers: true,
        requireSymbols: true,
        preventCommon: true,
        preventUserInfo: true,
      },
      accountLockout: {
        enabled: true,
        maxAttempts: 5,
        lockoutDurationMs: 30 * 60 * 1000, // 30 minutes
      },
      session: {
        invalidateOnPasswordChange: true,
        maxConcurrent: 3,
        deviceFingerprint: true,
        validateIp: true,
      },
    },
    features: {
      emailPassword: true,
      socialLogin: false,
      accountLinking: false,
      profileUpdate: true,
      emailChange: true,
      passwordReset: true,
      registration: false, // Admin-controlled
    },
  }),
};

/**
 * Export helper to integrate with Dot builder
 */
export const dotAuthIntegration = {
  /**
   * Transform simple provider list to full config
   */
  simpleConfig: (providers: string[]): DotAuthConfig => ({
    providers: providers as any[],
    features: {
      emailPassword: providers.includes('credentials'),
      socialLogin: providers.some(p => ['google', 'github', 'discord', 'facebook', 'apple', 'twitter'].includes(p)),
    },
  }),

  /**
   * Merge configs with proper precedence
   */
  mergeConfigs: (...configs: Partial<DotAuthConfig>[]): DotAuthConfig => {
    debugAuth('[index] Merging %d auth config(s)', configs.length);
    const merged: DotAuthConfig = {};

    for (let i = 0; i < configs.length; i++) {
      const config = configs[i];
      debugAuth('[index] Merging config %d of %d', i + 1, configs.length);
      Object.assign(merged, config);

      // Special handling for nested objects
      if (config?.session) {
        debugAuth('[index] Merging session config');
        merged.session = { ...merged.session, ...config.session };
      }
      if (config?.email) {
        debugAuth('[index] Merging email config');
        merged.email = { ...merged.email, ...config.email };
      }
      if (config?.rbac) {
        debugAuth('[index] Merging RBAC config');
        merged.rbac = { ...merged.rbac, ...config.rbac };
      }
      if (config?.mfa) {
        debugAuth('[index] Merging MFA config');
        merged.mfa = { ...merged.mfa, ...config.mfa };
      }
      if (config?.security) {
        debugAuth('[index] Merging security config');
        merged.security = { ...merged.security, ...config.security };
      }
      if (config?.features) {
        debugAuth('[index] Merging features config');
        merged.features = { ...merged.features, ...config.features };
      }
      if (config?.hooks) {
        debugAuth('[index] Merging hooks config');
        merged.hooks = { ...merged.hooks, ...config.hooks };
      }
    }

    debugAuth('[index] Config merge complete');
    return merged;
  },
};

/**
 * Auth features for use by Dot framework
 */
export const authFeatures = {
  createDotAuth,
  createAuthConfigFromEnv,
  authPresets,
  dotAuthIntegration,

  /**
   * Get session from cookies (for Next.js contexts)
   */
  getSessionFromCookies: async () => {
    // This would be implemented with Next.js specific logic
    // For now, return null as a placeholder
    console.warn('getSessionFromCookies needs to be implemented for your specific context');
    return null;
  },

  /**
   * Initialize auth with configuration
   */
  initAuth: async (config: DotAuthConfig, db?: NodePgDatabase<any>) => {
    return createDotAuth(config, db);
  },
};
