/**
 * Auth features module for Dot framework
 * Provides better-auth integration with the builder pattern
 */

import type { Auth } from 'better-auth';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { Dot } from './index';
import type { AuthConfig, EnvConfig, Repository, RouterRecord, SchemaInterface } from './types';
import { createDotAuth, createAuthConfigFromEnv, type DotAuth, type DotAuthConfig } from './auth/index';

/**
 * Auth features for Dot framework
 */
export const authFeatures = {
  /**
   * Adds authentication configuration to the Dot builder
   */
  withAuth<
    TAppName extends string,
    TRouters extends RouterRecord,
    TSchema extends SchemaInterface,
    TRepositories extends Repository,
    TEnv extends EnvConfig,
  >(
    this: Dot<TAppName, TRouters, TSchema, TRepositories, TEnv>,
    config?: Partial<DotAuthConfig> | ((env: TEnv) => Partial<DotAuthConfig>),
  ) {
    // Get the environment config from the builder
    const env = (this as any).env || {};

    // Build the auth configuration
    let authConfig: DotAuthConfig;

    if (typeof config === 'function') {
      // Allow config to be a function that receives env
      const partialConfig = config(env);
      authConfig = createAuthConfigFromEnv(partialConfig);
    } else if (config) {
      // Direct config object
      authConfig = createAuthConfigFromEnv(config);
    } else {
      // Auto-detect from environment
      authConfig = createAuthConfigFromEnv();
    }

    // Store the config in the builder
    const authConfigForBuilder: AuthConfig = {
      secret: authConfig.secret || env.AUTH_SECRET || env.BETTER_AUTH_SECRET || '',
      baseUrl: authConfig.baseUrl,
      debug: authConfig.features?.debugMode,
      providers: authConfig.providers,
      // Map to match the AuthConfig type in types.ts
      pages: authConfig.pages ? {
        signIn: authConfig.pages.signIn,
        signOut: authConfig.pages.signOut,
        error: authConfig.pages.error,
        verifyRequest: authConfig.pages.verifyRequest,
        newUser: authConfig.pages.newUser,
      } : undefined,
      callbacks: authConfig.hooks ? {
        session: authConfig.hooks.onSessionRefresh,
        signIn: authConfig.hooks.onSignIn,
        redirect: authConfig.hooks.onRedirect,
        jwt: authConfig.hooks.onJwtGeneration,
      } : undefined,
    };

    return this.createNew({
      authConfig: authConfigForBuilder,
    });
  },

  /**
   * Initialize auth with database connection
   */
  async initAuth(
    config: AuthConfig | DotAuthConfig,
    db?: NodePgDatabase<any>,
  ): Promise<DotAuth | undefined> {
    if (!config) {
      return undefined;
    }

    // Check if config is already a DotAuthConfig
    const isDotConfig = 'appName' in config || 'providers' in config;

    let dotConfig: DotAuthConfig;
    if (isDotConfig) {
      dotConfig = config as DotAuthConfig;
    } else {
      // Convert from basic AuthConfig to DotAuthConfig
      const authConfig = config as AuthConfig;
      dotConfig = {
        secret: authConfig.secret,
        baseUrl: authConfig.baseUrl,
        providers: authConfig.providers || [],
        features: {
          debugMode: authConfig.debug,
        },
        pages: authConfig.pages,
        hooks: authConfig.callbacks ? {
          onSessionRefresh: authConfig.callbacks.session,
          onSignIn: authConfig.callbacks.signIn,
          onRedirect: authConfig.callbacks.redirect,
          onJwtGeneration: authConfig.callbacks.jwt,
        } : undefined,
      };
    }

    // Create and return the DotAuth instance
    return createDotAuth(dotConfig, db);
  },

  /**
   * Get session from cookies (for server-side use)
   */
  async getSessionFromCookies() {
    // This would need to be implemented with cookie parsing
    // For now, return null as a placeholder
    // In a real implementation, this would parse cookies and validate the session
    console.warn('getSessionFromCookies not yet implemented - requires cookie parsing');
    return null;
  },

  /**
   * Create auth context for tRPC
   */
  createAuthContext(auth?: DotAuth) {
    if (!auth) {
      return {
        session: null,
        user: null,
      };
    }

    return {
      auth,
      sessionManager: auth.session,
      rbac: auth.rbac,
    };
  },
};

// Re-export types from auth module
export type {
  DotAuth,
  DotAuthConfig,
  DotUser,
  DotSession,
  Role,
  Permission,
} from './auth/index';