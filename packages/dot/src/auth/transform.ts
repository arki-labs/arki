/**
 * Transform Dot auth configuration to better-auth configuration
 */

import type { BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { createPrefixedId } from '@arki/db/id';

import type { DotAuthConfig } from './config';
import { authEnv, getAuthSecret as getEnvAuthSecret, getBaseUrl as getEnvBaseUrl } from './env';
import { totpProviderFactory, transformProviders, webAuthnProviderFactory } from './providers';

/**
 * Parse duration string to seconds
 */
function parseDuration(duration: string | number): number {
  if (typeof duration === 'number') return duration;

  const match = /^(\d+)([dhms])$/.exec(duration);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2];

  switch (unit) {
    case 'd': {
      return value * 86_400;
    } // days to seconds
    case 'h': {
      return value * 3600;
    } // hours to seconds
    case 'm': {
      return value * 60;
    } // minutes to seconds
    case 's': {
      return value;
    } // already in seconds
    default: {
      throw new Error(`Invalid duration unit: ${unit}`);
    }
  }
}

/**
 * Get auth secret from config or environment
 */
function getAuthSecret(config: DotAuthConfig): string {
  const secret = config.secret || getEnvAuthSecret();

  if (!secret) {
    throw new Error('Auth secret is required. Set it in the config or as AUTH_SECRET environment variable');
  }

  return secret;
}

/**
 * Get base URL from config or environment
 */
function getBaseUrl(config: DotAuthConfig): string {
  const baseUrl = config.baseUrl || getEnvBaseUrl();

  if (!baseUrl) {
    if (authEnv.NODE_ENV === 'development') {
      return 'http://localhost:3000';
    }
    throw new Error('Base URL is required. Set it in the config or as BASE_URL environment variable');
  }

  return baseUrl;
}

/**
 * Transform session configuration
 */
function transformSession(config: DotAuthConfig): BetterAuthOptions['session'] {
  const sessionConfig = config.session;

  if (!sessionConfig) {
    return {
      expiresIn: 60 * 60 * 24 * 30, // 30 days default
      updateAge: 60 * 60 * 24, // 1 day default
    };
  }

  return {
    expiresIn: sessionConfig.expiresIn ? parseDuration(sessionConfig.expiresIn) : 60 * 60 * 24 * 30,
    updateAge: sessionConfig.updateAge ? parseDuration(sessionConfig.updateAge) : 60 * 60 * 24,
    ...(sessionConfig.cookieOptions && {
      cookieCache: {
        enabled: true,
        maxAge: parseDuration(sessionConfig.expiresIn || '30d'),
      },
    }),
  };
}

/**
 * Create ID generator for better-auth
 */
function createIdGenerator(_appKey?: string) {
  return ({ model }: { model: string }) => {
    // Map model names to prefixes
    const prefixMap: Record<string, string> = {
      user: 'usr',
      users: 'usr',
      session: 'sess',
      sessions: 'sess',
      account: 'acc',
      accounts: 'acc',
      verification: 'verif',
      verifications: 'verif',
    };

    const prefix = prefixMap[model.toLowerCase()] || model.slice(0, 3).toLowerCase();
    return createPrefixedId(prefix);
  };
}

/**
 * Transform email configuration
 */
function transformEmailConfig(config: DotAuthConfig): Partial<BetterAuthOptions> {
  const emailConfig = config.email;

  if (!emailConfig) {
    return {};
  }

  const result: Partial<BetterAuthOptions> = {};

  // Email verification
  if (emailConfig.verification !== false) {
    result.emailVerification = {
      sendOnSignUp: true,
      autoSignInAfterVerification: emailConfig.autoSignInAfterVerification ?? true,
      sendVerificationEmail: async ({ user, url }) => {
        // This will be overridden by the email provider
        console.log(`Verification email for ${user.email}: ${url}`);
      },
    };
  }

  // Email and password
  result.emailAndPassword = {
    enabled: config.features?.emailPassword !== false,
    sendResetPassword: async ({ user, url }) => {
      // This will be overridden by the email provider
      console.log(`Reset password for ${user.email}: ${url}`);
    },
  };

  // User email change
  result.user = {
    changeEmail: {
      enabled: config.features?.emailChange !== false,
      sendChangeEmailVerification: async ({ user, newEmail, url }) => {
        // This will be overridden by the email provider
        console.log(`Change email for ${user.email} to ${newEmail}: ${url}`);
      },
    },
  };

  return result;
}

/**
 * Transform account configuration
 */
function transformAccountConfig(config: DotAuthConfig): Partial<BetterAuthOptions> {
  return {
    account: {
      accountLinking: {
        enabled: config.features?.accountLinking !== false,
        trustedProviders:
          config.providers
            ?.filter(p => typeof p === 'string' && p !== 'credentials' && p !== 'magicLink')
            .map(p => p as string) || [],
      },
    },
  };
}

/**
 * Transform MFA configuration
 */
function transformMFA(config: DotAuthConfig): any[] {
  const plugins: any[] = [];

  if (config.mfa?.providers) {
    for (const provider of config.mfa.providers) {
      switch (provider) {
        case 'totp': {
          plugins.push(...(totpProviderFactory().plugins || []));
          break;
        }
        case 'webauthn': {
          plugins.push(...(webAuthnProviderFactory().plugins || []));
          break;
        }
        // SMS and email MFA would need custom implementation
      }
    }
  }

  return plugins;
}

/**
 * Transform Dot auth config to better-auth config
 *
 * @param dotConfig - The Dot framework auth configuration
 * @param db - Optional database connection for session storage
 * @returns Configuration object for better-auth
 */
export function toBetterAuthConfig(dotConfig: DotAuthConfig, db?: NodePgDatabase<any>): BetterAuthOptions {
  try {
    // Start with base configuration
    const config: BetterAuthOptions = {
      appName: dotConfig.appName || authEnv.APP_NAME || 'Dot App',
      baseURL: getBaseUrl(dotConfig),
      secret: getAuthSecret(dotConfig),
      database: dotConfig.database || (db ? createDatabaseAdapter(db) : undefined),
      trustedOrigins: dotConfig.trustedOrigins || [],
    };

    // Continue with the rest of the configuration...

    // Advanced configuration
    config.advanced = {
      cookiePrefix: dotConfig.appKey ? `auth-${dotConfig.appKey}` : 'auth',
      database: {
        generateId: createIdGenerator(dotConfig.appKey),
      },
      // Enable secure defaults in production
      ...(authEnv.NODE_ENV === 'production' && {
        secureCookies: true,
        sameSiteCookie: 'strict',
        crossOriginOpenerPolicy: true,
      }),
    };

    // Transform session config
    config.session = transformSession(dotConfig);

    // Transform providers
    if (dotConfig.providers) {
      const providerResult = transformProviders(dotConfig.providers);
      config.socialProviders = providerResult.socialProviders;
      config.plugins = providerResult.plugins || [];

      // Merge additional config
      if (providerResult.config) {
        Object.assign(config, providerResult.config);
      }
    } else {
      config.plugins = [];
    }

    // Transform email config
    Object.assign(config, transformEmailConfig(dotConfig));

    // Transform account config
    Object.assign(config, transformAccountConfig(dotConfig));

    // Add MFA plugins
    if (dotConfig.mfa) {
      const mfaPlugins = transformMFA(dotConfig);
      if (mfaPlugins.length > 0) {
        (config.plugins as any[]).push(...mfaPlugins);
      }
    }

    // Add production URL for OAuth proxy
    if (dotConfig.productionUrl) {
      // The oAuthProxy plugin will use this
      (config as any).productionURL = dotConfig.productionUrl;
    }

    return config;
  } catch (error) {
    console.error('Failed to transform auth config:', error);
    throw new Error(`Invalid auth configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Create database adapter with error handling
 *
 * @private
 */
function createDatabaseAdapter(db: NodePgDatabase<any>) {
  try {
    return drizzleAdapter(db, {
      provider: 'pg',
      usePlural: true,
    });
  } catch (error) {
    console.error('Failed to create database adapter:', error);
    // Return undefined to allow auth to work without database
    return;
  }
}

/**
 * Validate Dot auth configuration for production readiness
 *
 * @param config - The auth configuration to validate
 * @throws {Error} If configuration is invalid or missing required fields
 */
export function validateConfig(config: DotAuthConfig): void {
    if (!config) {
      throw new Error('Auth configuration is required');
    }

    // Validate secret for production
    if (authEnv.NODE_ENV === 'production') {
      const secret = config.secret || getEnvAuthSecret();
      if (!secret) {
        throw new Error(
          'Auth secret is required in production. Set AUTH_SECRET or BETTER_AUTH_SECRET environment variable.',
        );
      }
      if (secret.length < 32) {
        throw new Error('Auth secret must be at least 32 characters in production for security.');
      }
    }

    // Validate base URL for production
    if (authEnv.NODE_ENV === 'production') {
      const baseUrl = config.baseUrl || getEnvBaseUrl();
      if (!baseUrl || baseUrl.includes('localhost')) {
        throw new Error('Production base URL is required and cannot be localhost.');
      }
    }

    // Validate email configuration if email features are enabled
    if (config.features?.emailPassword || config.features?.passwordReset || config.providers?.includes('magicLink')) {
      if (!config.email?.from) {
        throw new Error('Email from address is required when using email-based authentication.');
      }
      if (authEnv.NODE_ENV === 'production' && !config.email?.provider) {
        console.warn('Email provider not configured. Email features will not work properly in production.');
      }
    }

    // Validate provider configuration
    if (config.providers) {
      for (const provider of config.providers) {
        if (typeof provider !== 'string' && !provider.id) {
          throw new Error('Custom provider must have an id');
        }
      }
    }

    // Validate RBAC configuration
    if (config.rbac?.enabled) {
      if (!config.rbac.roles || config.rbac.roles.length === 0) {
        throw new Error('At least one role must be defined when RBAC is enabled');
      }
      if (config.rbac.defaultRole) {
        const defaultRoleName = typeof config.rbac.defaultRole === 'string'
          ? config.rbac.defaultRole
          : config.rbac.defaultRole.name;

        const roleNames = config.rbac.roles.map(r => typeof r === 'string' ? r : r.name);
        if (!roleNames.includes(defaultRoleName)) {
          throw new Error(`Default role '${defaultRoleName}' is not in the list of configured roles`);
        }
      }
    }

    // Validate MFA configuration
    if (config.mfa?.required) {
      if (!config.mfa.providers || config.mfa.providers.length === 0) {
        throw new Error('At least one MFA provider must be configured when MFA is required');
      }
      if (config.mfa.gracePeriod && config.mfa.gracePeriod < 0) {
        throw new Error('MFA grace period cannot be negative');
      }
    }

    // Validate security settings
    if (config.security?.passwordPolicy) {
      const policy = config.security.passwordPolicy;
      if (policy.minLength && policy.minLength < 8) {
        console.warn('Password minimum length is less than 8 characters. Consider increasing for better security.');
      }
    }

    // Validate session configuration
    if (config.session?.strategy === 'jwt' && !config.secret) {
      throw new Error('JWT session strategy requires a secret for signing tokens');
    }
  }
