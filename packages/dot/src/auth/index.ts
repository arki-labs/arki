/**
 * Dot Auth Module - Better-Auth Integration
 */

import { betterAuth } from 'better-auth';
import type { Auth } from 'better-auth';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { DotAuthConfig } from './config';
import { createAuthMiddleware, createAuthProcedures } from './middleware';
import { createRBACManager, initializeRBAC, type DotRBACManager } from './rbac';
import { createSessionManager, sessionUtils, type DotSessionManager } from './session';
import { toBetterAuthConfig, validateConfig } from './transform';
import type { DotSession, DotUser } from './types';

// Re-export all types
export * from './types';
export * from './config';
export { sessionUtils };

/**
 * Dot Auth instance
 */
export interface DotAuth {
  /**
   * The underlying better-auth instance
   */
  instance: Auth;

  /**
   * Better-auth API methods
   */
  api: Auth['api'];

  /**
   * Session manager
   */
  session: DotSessionManager;

  /**
   * RBAC manager
   */
  rbac: DotRBACManager;

  /**
   * Create tRPC procedures with auth
   */
  createProcedures: <TRouter>(t: any) => ReturnType<typeof createAuthProcedures>;

  /**
   * Create auth middleware
   */
  createMiddleware: () => ReturnType<typeof createAuthMiddleware>;

  /**
   * Get session from headers
   */
  getSession: (headers: Headers) => Promise<DotSession | null>;

  /**
   * Sign out a session
   */
  signOut: (sessionId: string) => Promise<void>;

  /**
   * Configuration
   */
  config: DotAuthConfig;
}

/**
 * Create a Dot Auth instance
 */
export async function createDotAuth(
  config: DotAuthConfig,
  db?: NodePgDatabase<any>
): Promise<DotAuth> {
  // Validate configuration
  validateConfig(config);

  // Transform to better-auth config
  const betterAuthConfig = toBetterAuthConfig(config, db);

  // Create better-auth instance
  const auth = betterAuth(betterAuthConfig);

  // Create managers
  const sessionManager = createSessionManager(auth, db);
  const rbacManager = db ? createRBACManager(db) : createMockRBACManager();

  // Initialize default roles if RBAC is enabled
  if (config.rbac?.enabled && db) {
    await initializeRBAC(rbacManager);

    // Assign default role to new users if configured
    if (config.rbac.defaultRole) {
      // This would be done in a sign-up hook
      // We'll add this to the hooks configuration
    }
  }

  return {
    instance: auth,
    api: auth.api,
    session: sessionManager,
    rbac: rbacManager,

    createProcedures: <TRouter>(t: any) => {
      return createAuthProcedures<TRouter>(t, sessionManager, rbacManager);
    },

    createMiddleware: () => {
      return createAuthMiddleware(sessionManager, rbacManager);
    },

    getSession: async (headers: Headers) => {
      return sessionManager.getSession(headers);
    },

    signOut: async (sessionId: string) => {
      return sessionManager.invalidateSession(sessionId);
    },

    config,
  };
}

/**
 * Create mock RBAC manager for when database is not available
 */
function createMockRBACManager(): DotRBACManager {
  console.warn('Database not configured - using mock RBAC manager');

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
 * Helper to create auth configuration from environment variables
 */
export function createAuthConfigFromEnv(
  overrides?: Partial<DotAuthConfig>
): DotAuthConfig {
  const config: DotAuthConfig = {
    appName: process.env.APP_NAME,
    appKey: process.env.APP_KEY,
    baseUrl: process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL,
    productionUrl: process.env.PRODUCTION_URL || process.env.NEXT_PUBLIC_PRODUCTION_URL,
    secret: process.env.AUTH_SECRET || process.env.BETTER_AUTH_SECRET,

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

  // Auto-detect OAuth providers from environment
  const providerChecks = [
    { provider: 'google', envVars: ['GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_ID'] },
    { provider: 'github', envVars: ['GITHUB_CLIENT_ID', 'AUTH_GITHUB_ID'] },
    { provider: 'discord', envVars: ['DISCORD_CLIENT_ID', 'AUTH_DISCORD_ID'] },
    { provider: 'facebook', envVars: ['FACEBOOK_CLIENT_ID', 'AUTH_FACEBOOK_ID'] },
    { provider: 'apple', envVars: ['APPLE_CLIENT_ID', 'AUTH_APPLE_ID'] },
    { provider: 'twitter', envVars: ['TWITTER_CLIENT_ID', 'AUTH_TWITTER_ID'] },
  ];

  for (const check of providerChecks) {
    const hasProvider = check.envVars.some(envVar => process.env[envVar]);
    if (hasProvider && config.providers) {
      config.providers.push(check.provider as any);
    }
  }

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
      socialLogin: providers.some(p =>
        ['google', 'github', 'discord', 'facebook', 'apple', 'twitter'].includes(p)
      ),
    },
  }),

  /**
   * Merge configs with proper precedence
   */
  mergeConfigs: (...configs: Partial<DotAuthConfig>[]): DotAuthConfig => {
    const merged: DotAuthConfig = {};

    for (const config of configs) {
      Object.assign(merged, config);

      // Special handling for nested objects
      if (config.session) {
        merged.session = { ...merged.session, ...config.session };
      }
      if (config.email) {
        merged.email = { ...merged.email, ...config.email };
      }
      if (config.rbac) {
        merged.rbac = { ...merged.rbac, ...config.rbac };
      }
      if (config.mfa) {
        merged.mfa = { ...merged.mfa, ...config.mfa };
      }
      if (config.security) {
        merged.security = { ...merged.security, ...config.security };
      }
      if (config.features) {
        merged.features = { ...merged.features, ...config.features };
      }
      if (config.hooks) {
        merged.hooks = { ...merged.hooks, ...config.hooks };
      }
    }

    return merged;
  },
};