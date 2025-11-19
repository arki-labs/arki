/**
 * Transform Dot auth configuration to better-auth configuration
 */

import type { BetterAuthOptions } from 'better-auth';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import { createPrefixedId } from '@arki/db/id';

import type { DotAuthConfig } from './config';
import { debugAuth } from '../debug.ts';
import { authEnv, getAuthSecret as getEnvAuthSecret, getBaseUrl as getEnvBaseUrl } from './env';
import { totpProviderFactory, transformProviders, webAuthnProviderFactory } from './providers';

/**
 * Parse duration string to seconds
 */
function parseDuration(duration: string | number): number {
  debugAuth('[transform] Parsing duration: %s', duration);

  if (typeof duration === 'number') {
    debugAuth('[transform] Duration already numeric: %d seconds', duration);
    return duration;
  }

  const match = /^(\d+)([dhms])$/.exec(duration);
  if (!match) {
    debugAuth('[transform] Invalid duration format: %s', duration);
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2];

  let seconds: number;
  switch (unit) {
    case 'd': {
      seconds = value * 86_400;
      break;
    } // days to seconds
    case 'h': {
      seconds = value * 3600;
      break;
    } // hours to seconds
    case 'm': {
      seconds = value * 60;
      break;
    } // minutes to seconds
    case 's': {
      seconds = value;
      break;
    } // already in seconds
    default: {
      debugAuth('[transform] Invalid duration unit: %s', unit);
      throw new Error(`Invalid duration unit: ${unit}`);
    }
  }

  debugAuth('[transform] Duration parsed: %s = %d seconds', duration, seconds);
  return seconds;
}

/**
 * Get auth secret from config or environment
 */
function getAuthSecret(config: DotAuthConfig): string {
  debugAuth('[transform] Getting auth secret (fromConfig: %s)', !!config.secret);

  const secret = config.secret || getEnvAuthSecret();

  if (!secret) {
    debugAuth('[transform] Auth secret not found in config or environment');
    throw new Error('Auth secret is required. Set it in the config or as AUTH_SECRET environment variable');
  }

  debugAuth('[transform] Auth secret retrieved (length: %d)', secret.length);
  return secret;
}

/**
 * Get base URL from config or environment
 */
function getBaseUrl(config: DotAuthConfig): string {
  debugAuth('[transform] Getting base URL (fromConfig: %s)', !!config.baseUrl);

  const baseUrl = config.baseUrl || getEnvBaseUrl();

  if (!baseUrl) {
    if (authEnv.NODE_ENV === 'development') {
      debugAuth('[transform] Using default development URL: http://localhost:3000');
      return 'http://localhost:3000';
    }
    debugAuth('[transform] Base URL not found in config or environment');
    throw new Error('Base URL is required. Set it in the config or as BASE_URL environment variable');
  }

  debugAuth('[transform] Base URL retrieved: %s', baseUrl);
  return baseUrl;
}

/**
 * Transform session configuration
 */
function transformSession(config: DotAuthConfig): BetterAuthOptions['session'] {
  debugAuth('[transform] Transforming session config (hasConfig: %s)', !!config.session);

  const sessionConfig = config.session;

  if (!sessionConfig) {
    debugAuth('[transform] Using default session config (expiresIn: 30d, updateAge: 1d)');
    return {
      expiresIn: 60 * 60 * 24 * 30, // 30 days default
      updateAge: 60 * 60 * 24, // 1 day default
    };
  }

  const expiresIn = sessionConfig.expiresIn ? parseDuration(sessionConfig.expiresIn) : 60 * 60 * 24 * 30;
  const updateAge = sessionConfig.updateAge ? parseDuration(sessionConfig.updateAge) : 60 * 60 * 24;
  const hasCookieOptions = !!sessionConfig.cookieOptions;

  debugAuth(
    '[transform] Session config transformed (expiresIn: %ds, updateAge: %ds, hasCookieOptions: %s)',
    expiresIn,
    updateAge,
    hasCookieOptions,
  );

  return {
    expiresIn,
    updateAge,
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
  debugAuth('[transform] Creating ID generator (appKey: %s)', _appKey || 'default');

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
    const id = createPrefixedId(prefix);
    debugAuth('[transform] Generated ID (model: %s, prefix: %s)', model, prefix);
    return id;
  };
}

/**
 * Transform email configuration
 */
function transformEmailConfig(config: DotAuthConfig): Partial<BetterAuthOptions> {
  debugAuth('[transform] Transforming email config (hasEmailConfig: %s)', !!config.email);

  const emailConfig = config.email;

  if (!emailConfig) {
    debugAuth('[transform] No email config provided, skipping');
    return {};
  }

  const result: Partial<BetterAuthOptions> = {};

  // Email verification
  if (emailConfig.verification === false) {
    debugAuth('[transform] Email verification disabled');
  } else {
    debugAuth(
      '[transform] Email verification enabled (autoSignIn: %s)',
      emailConfig.autoSignInAfterVerification ?? true,
    );
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
  const emailPasswordEnabled = config.features?.emailPassword !== false;
  debugAuth('[transform] Email/password enabled: %s', emailPasswordEnabled);
  result.emailAndPassword = {
    enabled: emailPasswordEnabled,
    sendResetPassword: async ({ user, url }) => {
      // This will be overridden by the email provider
      console.log(`Reset password for ${user.email}: ${url}`);
    },
  };

  // User email change
  const emailChangeEnabled = config.features?.emailChange !== false;
  debugAuth('[transform] Email change enabled: %s', emailChangeEnabled);
  result.user = {
    changeEmail: {
      enabled: emailChangeEnabled,
      sendChangeEmailVerification: async ({ user, newEmail, url }) => {
        // This will be overridden by the email provider
        console.log(`Change email for ${user.email} to ${newEmail}: ${url}`);
      },
    },
  };

  debugAuth('[transform] Email config transformed');
  return result;
}

/**
 * Transform account configuration
 */
function transformAccountConfig(config: DotAuthConfig): Partial<BetterAuthOptions> {
  const accountLinkingEnabled = config.features?.accountLinking !== false;
  const trustedProviders =
    config.providers
      ?.filter(p => typeof p === 'string' && p !== 'credentials' && p !== 'magicLink')
      .map(p => p as string) || [];

  debugAuth(
    '[transform] Transforming account config (accountLinking: %s, trustedProviders: %d)',
    accountLinkingEnabled,
    trustedProviders.length,
  );

  return {
    account: {
      accountLinking: {
        enabled: accountLinkingEnabled,
        trustedProviders,
      },
    },
  };
}

/**
 * Transform MFA configuration
 */
function transformMFA(config: DotAuthConfig): any[] {
  debugAuth('[transform] Transforming MFA config (hasMFA: %s)', !!config.mfa?.providers);

  const plugins: any[] = [];

  if (config.mfa?.providers) {
    debugAuth('[transform] Processing %d MFA provider(s)', config.mfa.providers.length);

    for (const provider of config.mfa.providers) {
      debugAuth('[transform] Adding MFA provider: %s', provider);
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

    debugAuth('[transform] MFA config transformed (%d plugin(s) added)', plugins.length);
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
  debugAuth('[transform] Transforming Dot auth config to better-auth config (hasDb: %s)', !!db);

  try {
    // Start with base configuration
    const appName = dotConfig.appName || authEnv.APP_NAME || 'Dot App';
    const baseURL = getBaseUrl(dotConfig);
    const secret = getAuthSecret(dotConfig);
    const trustedOriginsCount = dotConfig.trustedOrigins?.length || 0;

    debugAuth(
      '[transform] Base config (appName: %s, baseURL: %s, trustedOrigins: %d)',
      appName,
      baseURL,
      trustedOriginsCount,
    );

    const config: BetterAuthOptions = {
      appName,
      baseURL,
      secret,
      database: dotConfig.database || (db ? createDatabaseAdapter(db) : undefined),
      trustedOrigins: dotConfig.trustedOrigins || [],
    };

    // Continue with the rest of the configuration...

    // Advanced configuration
    const cookiePrefix = dotConfig.appKey ? `auth-${dotConfig.appKey}` : 'auth';
    const isProduction = authEnv.NODE_ENV === 'production';
    debugAuth(
      '[transform] Advanced config (cookiePrefix: %s, production: %s, appKey: %s)',
      cookiePrefix,
      isProduction,
      dotConfig.appKey || 'default',
    );

    config.advanced = {
      cookiePrefix,
      database: {
        generateId: createIdGenerator(dotConfig.appKey),
      },
      // Enable secure defaults in production
      ...(isProduction && {
        secureCookies: true,
        sameSiteCookie: 'strict',
        crossOriginOpenerPolicy: true,
      }),
    };

    // Transform session config
    config.session = transformSession(dotConfig);

    // Transform providers
    if (dotConfig.providers) {
      debugAuth('[transform] Transforming %d provider(s)', dotConfig.providers.length);
      const providerResult = transformProviders(dotConfig.providers);
      config.socialProviders = providerResult.socialProviders;
      config.plugins = providerResult.plugins || [];

      // Merge additional config
      if (providerResult.config) {
        debugAuth('[transform] Merging additional provider config');
        Object.assign(config, providerResult.config);
      }
    } else {
      debugAuth('[transform] No providers configured');
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
        debugAuth('[transform] Adding %d MFA plugin(s)', mfaPlugins.length);
        (config.plugins as any[]).push(...mfaPlugins);
      }
    }

    // Add production URL for OAuth proxy
    if (dotConfig.productionUrl) {
      debugAuth('[transform] Setting production URL: %s', dotConfig.productionUrl);
      // The oAuthProxy plugin will use this
      (config as any).productionURL = dotConfig.productionUrl;
    }

    debugAuth('[transform] Config transformation complete (plugins: %d)', (config.plugins as any[])?.length || 0);
    return config;
  } catch (error) {
    debugAuth(
      '[transform] Failed to transform auth config: %s',
      error instanceof Error ? error.message : 'unknown error',
    );
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
  debugAuth('[transform] Creating database adapter (provider: pg, usePlural: true)');

  try {
    const adapter = drizzleAdapter(db, {
      provider: 'pg',
      usePlural: true,
    });
    debugAuth('[transform] Database adapter created successfully');
    return adapter;
  } catch (error) {
    debugAuth(
      '[transform] Failed to create database adapter: %s',
      error instanceof Error ? error.message : 'unknown error',
    );
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
  debugAuth('[validate] Validating auth config (env: %s)', authEnv.NODE_ENV);

  if (!config) {
    debugAuth('[validate] Validation failed: no config provided');
    throw new Error('Auth configuration is required');
  }

  // Validate secret for production
  if (authEnv.NODE_ENV === 'production') {
    debugAuth('[validate] Validating auth secret for production');
    const secret = config.secret || getEnvAuthSecret();
    if (!secret) {
      debugAuth('[validate] Validation failed: auth secret missing in production');
      throw new Error('Auth secret is required in production. Set AUTH_SECRET or AUTH_SECRET environment variable.');
    }
    if (secret.length < 32) {
      debugAuth('[validate] Validation failed: auth secret too short (%d < 32 characters)', secret.length);
      throw new Error('Auth secret must be at least 32 characters in production for security.');
    }
    debugAuth('[validate] Auth secret validation passed');
  }

  // Validate base URL for production
  if (authEnv.NODE_ENV === 'production') {
    debugAuth('[validate] Validating base URL for production');
    const baseUrl = config.baseUrl || getEnvBaseUrl();
    if (!baseUrl || baseUrl.includes('localhost')) {
      debugAuth('[validate] Validation failed: invalid production base URL (%s)', baseUrl || 'undefined');
      throw new Error('Production base URL is required and cannot be localhost.');
    }
    debugAuth('[validate] Base URL validation passed: %s', baseUrl);
  }

  // Validate email configuration if email features are enabled
  const emailFeaturesEnabled =
    config.features?.emailPassword || config.features?.passwordReset || config.providers?.includes('magicLink');
  if (emailFeaturesEnabled) {
    debugAuth('[validate] Validating email configuration (features enabled)');
    if (!config.email?.from) {
      debugAuth('[validate] Validation failed: email from address missing');
      throw new Error('Email from address is required when using email-based authentication.');
    }
    if (authEnv.NODE_ENV === 'production' && !config.email?.provider) {
      debugAuth('[validate] Warning: email provider not configured in production');
      console.warn('Email provider not configured. Email features will not work properly in production.');
    }
    debugAuth('[validate] Email configuration validation passed');
  } else {
    debugAuth('[validate] Skipping email validation (no email features enabled)');
  }

  // Validate provider configuration
  if (config.providers) {
    debugAuth('[validate] Validating %d provider(s)', config.providers.length);
    for (const provider of config.providers) {
      if (typeof provider !== 'string' && !provider.id) {
        debugAuth('[validate] Validation failed: custom provider missing id');
        throw new Error('Custom provider must have an id');
      }
    }
    debugAuth('[validate] Provider configuration validation passed');
  }

  // Validate RBAC configuration
  if (config.rbac?.enabled) {
    debugAuth('[validate] Validating RBAC configuration');
    if (!config.rbac.roles || config.rbac.roles.length === 0) {
      debugAuth('[validate] Validation failed: RBAC enabled but no roles defined');
      throw new Error('At least one role must be defined when RBAC is enabled');
    }
    debugAuth('[validate] RBAC has %d role(s) defined', config.rbac.roles.length);

    if (config.rbac.defaultRole) {
      const defaultRoleName =
        typeof config.rbac.defaultRole === 'string' ? config.rbac.defaultRole : config.rbac.defaultRole.name;

      const roleNames = config.rbac.roles.map(r => (typeof r === 'string' ? r : r.name));
      if (!roleNames.includes(defaultRoleName)) {
        debugAuth('[validate] Validation failed: default role "%s" not in configured roles', defaultRoleName);
        throw new Error(`Default role '${defaultRoleName}' is not in the list of configured roles`);
      }
      debugAuth('[validate] RBAC default role "%s" validation passed', defaultRoleName);
    }
    debugAuth('[validate] RBAC configuration validation passed');
  } else {
    debugAuth('[validate] Skipping RBAC validation (not enabled)');
  }

  // Validate MFA configuration
  if (config.mfa?.required) {
    debugAuth('[validate] Validating MFA configuration (required: true)');
    if (!config.mfa.providers || config.mfa.providers.length === 0) {
      debugAuth('[validate] Validation failed: MFA required but no providers configured');
      throw new Error('At least one MFA provider must be configured when MFA is required');
    }
    debugAuth('[validate] MFA has %d provider(s) configured', config.mfa.providers.length);

    if (config.mfa.gracePeriod && config.mfa.gracePeriod < 0) {
      debugAuth('[validate] Validation failed: MFA grace period is negative (%d)', config.mfa.gracePeriod);
      throw new Error('MFA grace period cannot be negative');
    }
    if (config.mfa.gracePeriod !== undefined) {
      debugAuth('[validate] MFA grace period: %d', config.mfa.gracePeriod);
    }
    debugAuth('[validate] MFA configuration validation passed');
  } else {
    debugAuth('[validate] Skipping MFA validation (not required)');
  }

  // Validate security settings
  if (config.security?.passwordPolicy) {
    debugAuth('[validate] Validating password policy');
    const policy = config.security.passwordPolicy;
    if (policy.minLength && policy.minLength < 8) {
      debugAuth('[validate] Warning: password min length is %d (< 8 characters)', policy.minLength);
      console.warn('Password minimum length is less than 8 characters. Consider increasing for better security.');
    } else if (policy.minLength) {
      debugAuth('[validate] Password min length: %d characters', policy.minLength);
    }
    debugAuth('[validate] Password policy validation passed');
  }

  // Validate session configuration
  if (config.session?.strategy === 'jwt') {
    debugAuth('[validate] Validating JWT session strategy');
    if (!config.secret) {
      debugAuth('[validate] Validation failed: JWT strategy requires secret');
      throw new Error('JWT session strategy requires a secret for signing tokens');
    }
    debugAuth('[validate] JWT session strategy validation passed');
  }

  debugAuth('[validate] Auth config validation complete - all checks passed');
}
