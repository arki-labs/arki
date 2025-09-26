/**
 * Transform Dot auth configuration to better-auth configuration
 */

import type { BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { createPrefixedId } from '@arki/db/id';

import type { DotAuthConfig } from './config';
import { totpProviderFactory, transformProviders, webAuthnProviderFactory } from './providers';

/**
 * Parse duration string to seconds
 */
function parseDuration(duration: string | number): number {
  if (typeof duration === 'number') return duration;

  const match = duration.match(/^(\d+)([dhms])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'd':
      return value * 86400; // days to seconds
    case 'h':
      return value * 3600; // hours to seconds
    case 'm':
      return value * 60; // minutes to seconds
    case 's':
      return value; // already in seconds
    default:
      throw new Error(`Invalid duration unit: ${unit}`);
  }
}

/**
 * Get auth secret from config or environment
 */
function getAuthSecret(config: DotAuthConfig): string {
  const secret = config.secret || process.env.AUTH_SECRET || process.env.BETTER_AUTH_SECRET;

  if (!secret) {
    throw new Error(
      'Auth secret is required. Set it in the config or as AUTH_SECRET environment variable'
    );
  }

  return secret;
}

/**
 * Get base URL from config or environment
 */
function getBaseUrl(config: DotAuthConfig): string {
  const baseUrl = config.baseUrl || process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;

  if (!baseUrl) {
    if (process.env.NODE_ENV === 'development') {
      return 'http://localhost:3000';
    }
    throw new Error(
      'Base URL is required. Set it in the config or as BASE_URL environment variable'
    );
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
    expiresIn: sessionConfig.expiresIn
      ? parseDuration(sessionConfig.expiresIn)
      : 60 * 60 * 24 * 30,
    updateAge: sessionConfig.updateAge
      ? parseDuration(sessionConfig.updateAge)
      : 60 * 60 * 24,
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
function createIdGenerator(appKey?: string) {
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
      sendChangeEmailVerification: async ({ user, newEmail, url, token }) => {
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
        trustedProviders: config.providers
          ?.filter((p) => typeof p === 'string' && p !== 'credentials' && p !== 'magicLink')
          .map((p) => p as string) || [],
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
        case 'totp':
          plugins.push(...(totpProviderFactory().plugins || []));
          break;
        case 'webauthn':
          plugins.push(...(webAuthnProviderFactory().plugins || []));
          break;
        // SMS and email MFA would need custom implementation
      }
    }
  }

  return plugins;
}

/**
 * Transform Dot auth config to better-auth config
 */
export function toBetterAuthConfig(
  dotConfig: DotAuthConfig,
  db?: NodePgDatabase<any>
): BetterAuthOptions {
  // Start with base configuration
  const config: BetterAuthOptions = {
    appName: dotConfig.appName || process.env.APP_NAME || 'Dot App',
    baseURL: getBaseUrl(dotConfig),
    secret: getAuthSecret(dotConfig),
    database: dotConfig.database || (db && drizzleAdapter(db, {
      provider: 'pg',
      usePlural: true,
    })),
    trustedOrigins: dotConfig.trustedOrigins || [],
  };

  // Advanced configuration
  config.advanced = {
    cookiePrefix: dotConfig.appKey ? `auth-${dotConfig.appKey}` : 'auth',
    database: {
      generateId: createIdGenerator(dotConfig.appKey),
    },
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
    config.plugins!.push(...transformMFA(dotConfig));
  }

  // Add production URL for OAuth proxy
  if (dotConfig.productionUrl) {
    // The oAuthProxy plugin will use this
    (config as any).productionURL = dotConfig.productionUrl;
  }

  return config;
}

/**
 * Validate Dot auth configuration
 */
export function validateConfig(config: DotAuthConfig): void {
  // Validate required fields based on features
  if (config.email && !config.email.from) {
    throw new Error('Email from address is required when email is configured');
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
  if (config.rbac?.enabled && !config.rbac.roles) {
    throw new Error('Roles must be defined when RBAC is enabled');
  }

  // Validate MFA configuration
  if (config.mfa?.required && !config.mfa.providers) {
    throw new Error('MFA providers must be configured when MFA is required');
  }
}