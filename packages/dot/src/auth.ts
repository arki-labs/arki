import type { Session } from '@arki/auth';

import type { Dot } from './index';
import type { AuthConfig, AuthPackage, SchemaInterface } from './types';

/**
 * Authentication functionality for the Dot framework.
 * Contains methods for setting up and interacting with the auth system.
 */
export const authFeatures = {
  /**
   * Configures authentication for the application.
   *
   * This method sets up authentication using the @arki/auth package.
   * It configures session handling, JWT validation, and other auth-related features.
   *
   * @param this The Dot class instance
   * @param config Authentication configuration options
   * @returns A new Dot instance with the updated configuration
   */
  withAuth<
    TAppName extends string,
    TRouters extends Record<string, any>,
    TSchema extends SchemaInterface,
    TRepositories extends Record<string, any>,
    TEnv extends Record<string, any>,
  >(
    this: Dot<TAppName, TRouters, TSchema, TRepositories, TEnv>,
    config: AuthConfig,
  ): Dot<TAppName, TRouters, TSchema, TRepositories, TEnv> {
    return this.createNew({
      authConfig: config,
    });
  },

  /**
   * Gets a session from an auth token or cookies.
   *
   * This method tries to get a session using the auth token from the Authorization header,
   * falling back to cookies if the token is not available.
   *
   * @param authToken The authentication token from the Authorization header
   * @param authConfig The authentication configuration
   * @returns The resolved session or null if not authenticated
   */
  async getSessionFromToken(authToken: string | null, authConfig: AuthConfig | null): Promise<Session | null> {
    if (!authToken || !authConfig?.validateSession) return null;

    try {
      return await authConfig.validateSession(authToken);
    } catch (error) {
      console.error('Error validating session token:', error);
      return null;
    }
  },

  /**
   * Gets a session from cookies.
   *
   * This method tries to get a session using the Next.js auth function,
   * which reads session data from cookies.
   *
   * @returns The resolved session or null if not authenticated
   */
  async getSessionFromCookies(): Promise<Session | null> {
    try {
      // Import is used to avoid circular dependencies
      // In real usage, your backend will have access to the auth package's functions
      const authPackage = (await import('@arki/auth')) as unknown as AuthPackage;
      if (typeof authPackage.auth === 'function') {
        return await authPackage.auth();
      }
    } catch {
      // Silently ignore - this is expected when not in a Next.js context
    }
    return null;
  },
};
