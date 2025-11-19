/**
 * Provider factory functions for common auth providers
 * Uses validated environment variables from @t3-oss/env-core
 */

import { magicLink, oAuthProxy, twoFactor } from 'better-auth/plugins';

import type { BuiltInProvider, CustomProvider, EmailTemplate, PasswordHasher, PasswordPolicy } from './types';
import { debugAuth } from '../debug.ts';
import { authEnv } from './env';

/**
 * Provider factory result
 */
export type ProviderFactoryResult = {
  socialProviders?: Record<string, any>;
  plugins?: any[];
  config?: Record<string, any>;
};

/**
 * Factory for Google OAuth provider
 */
export function googleProviderFactory(): ProviderFactoryResult | null {
  debugAuth('[providers] Creating Google OAuth provider');
  const clientId = authEnv.GOOGLE_CLIENT_ID || authEnv.AUTH_GOOGLE_ID;
  const clientSecret = authEnv.GOOGLE_CLIENT_SECRET || authEnv.AUTH_GOOGLE_SECRET;

  if (!clientId || !clientSecret) {
    debugAuth('[providers] Google OAuth credentials not found');
    console.warn('Google provider configured but credentials not found in environment');
    return null;
  }

  debugAuth('[providers] Google OAuth provider created successfully');
  return {
    socialProviders: {
      google: {
        clientId,
        clientSecret,
        scopes: ['email', 'profile'],
      },
    },
  };
}

/**
 * Factory for GitHub OAuth provider
 */
export function githubProviderFactory(): ProviderFactoryResult | null {
  debugAuth('[providers] Creating GitHub OAuth provider');
  const clientId = authEnv.GITHUB_CLIENT_ID || authEnv.AUTH_GITHUB_ID;
  const clientSecret = authEnv.GITHUB_CLIENT_SECRET || authEnv.AUTH_GITHUB_SECRET;

  if (!clientId || !clientSecret) {
    debugAuth('[providers] GitHub OAuth credentials not found');
    console.warn('GitHub provider configured but credentials not found in environment');
    return null;
  }

  debugAuth('[providers] GitHub OAuth provider created successfully');
  return {
    socialProviders: {
      github: {
        clientId,
        clientSecret,
        scopes: ['user:email'],
      },
    },
  };
}

/**
 * Factory for Discord OAuth provider
 */
export function discordProviderFactory(): ProviderFactoryResult | null {
  debugAuth('[providers] Creating Discord OAuth provider');
  const clientId = authEnv.DISCORD_CLIENT_ID || authEnv.AUTH_DISCORD_ID;
  const clientSecret = authEnv.DISCORD_CLIENT_SECRET || authEnv.AUTH_DISCORD_SECRET;

  if (!clientId || !clientSecret) {
    debugAuth('[providers] Discord OAuth credentials not found');
    console.warn('Discord provider configured but credentials not found in environment');
    return null;
  }

  debugAuth('[providers] Discord OAuth provider created successfully');
  return {
    socialProviders: {
      discord: {
        clientId,
        clientSecret,
        scopes: ['identify', 'email'],
      },
    },
  };
}

/**
 * Factory for Facebook OAuth provider
 */
export function facebookProviderFactory(): ProviderFactoryResult | null {
  debugAuth('[providers] Creating Facebook OAuth provider');
  const clientId = authEnv.FACEBOOK_CLIENT_ID || authEnv.AUTH_FACEBOOK_ID;
  const clientSecret = authEnv.FACEBOOK_CLIENT_SECRET || authEnv.AUTH_FACEBOOK_SECRET;

  if (!clientId || !clientSecret) {
    debugAuth('[providers] Facebook OAuth credentials not found');
    console.warn('Facebook provider configured but credentials not found in environment');
    return null;
  }

  debugAuth('[providers] Facebook OAuth provider created successfully');
  return {
    socialProviders: {
      facebook: {
        clientId,
        clientSecret,
        scopes: ['email', 'public_profile'],
      },
    },
  };
}

/**
 * Factory for Apple OAuth provider
 */
export function appleProviderFactory(): ProviderFactoryResult | null {
  debugAuth('[providers] Creating Apple OAuth provider');
  const clientId = authEnv.APPLE_CLIENT_ID || authEnv.AUTH_APPLE_ID;
  const clientSecret = authEnv.APPLE_CLIENT_SECRET || authEnv.AUTH_APPLE_SECRET;
  // TODO: Add APPLE_BUNDLE_ID to env.ts if needed

  if (!clientId || !clientSecret) {
    debugAuth('[providers] Apple OAuth credentials not found');
    console.warn('Apple provider configured but credentials not found in environment');
    return null;
  }

  debugAuth('[providers] Apple OAuth provider created successfully');
  return {
    socialProviders: {
      apple: {
        clientId,
        clientSecret,
        // appBundleIdentifier can be added when available in env
      },
    },
  };
}

/**
 * Factory for Twitter/X OAuth provider
 */
export function twitterProviderFactory(): ProviderFactoryResult | null {
  debugAuth('[providers] Creating Twitter/X OAuth provider');
  const clientId = authEnv.TWITTER_CLIENT_ID || authEnv.AUTH_TWITTER_ID;
  const clientSecret = authEnv.TWITTER_CLIENT_SECRET || authEnv.AUTH_TWITTER_SECRET;

  if (!clientId || !clientSecret) {
    debugAuth('[providers] Twitter/X OAuth credentials not found');
    console.warn('Twitter provider configured but credentials not found in environment');
    return null;
  }

  debugAuth('[providers] Twitter/X OAuth provider created successfully');
  return {
    socialProviders: {
      twitter: {
        clientId,
        clientSecret,
      },
    },
  };
}

/**
 * Factory for LinkedIn OAuth provider
 */
export function linkedinProviderFactory(): ProviderFactoryResult | null {
  debugAuth('[providers] Creating LinkedIn OAuth provider');
  // LinkedIn not in env.ts yet - add if needed
  const clientId = undefined;
  const clientSecret = undefined;

  if (!clientId || !clientSecret) {
    debugAuth('[providers] LinkedIn OAuth credentials not configured in environment');
    console.warn('LinkedIn provider configured but credentials not found in environment');
    return null;
  }

  debugAuth('[providers] LinkedIn OAuth provider created successfully');
  return {
    socialProviders: {
      linkedin: {
        clientId,
        clientSecret,
        scopes: ['openid', 'profile', 'email'],
      },
    },
  };
}

/**
 * Factory for Magic Link provider
 */
export function magicLinkProviderFactory(config?: {
  sendEmail?: (params: { email: string; url: string; token: string }) => Promise<void>;
  expiresIn?: number;
  throttle?: number;
  template?: EmailTemplate;
}): ProviderFactoryResult {
  debugAuth('[providers] Creating Magic Link provider (custom email: %s)', !!config?.sendEmail);
  const defaultSendEmail = async ({ email, url }: { email: string; url: string }) => {
    console.log(`Magic link for ${email}: ${url}`);
    if (authEnv.NODE_ENV === 'development') {
      debugAuth('[providers] Magic Link email logged to console (development mode)');
      console.warn('Magic link email not sent - configure email provider');
    }
  };

  debugAuth('[providers] Magic Link provider created successfully');
  return {
    plugins: [
      magicLink({
        sendMagicLink: config?.sendEmail || defaultSendEmail,
        // TODO: Check better-auth docs for correct expiration property name
        // expirationTime: config?.expiresIn || 60 * 15, // 15 minutes default
        ...(config?.throttle && { throttle: config.throttle }),
      }),
    ],
  };
}

/**
 * Factory for Credentials provider
 */
export function credentialsProviderFactory(config?: {
  passwordHasher?: PasswordHasher;
  passwordPolicy?: PasswordPolicy;
  allowSignUp?: boolean;
}): ProviderFactoryResult {
  debugAuth('[providers] Creating Credentials provider (allowSignUp: %s)', config?.allowSignUp ?? 'default');
  // Default password policy
  // TODO: Use this when implementing password validation
  // const defaultPolicy: PasswordPolicy = {
  //   minLength: 8,
  //   requireUppercase: true,
  //   requireLowercase: true,
  //   requireNumbers: true,
  // };

  debugAuth('[providers] Credentials provider created successfully');
  return {
    config: {
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: false,
        ...(config?.allowSignUp !== undefined && { allowSignUp: config.allowSignUp }),
      },
    },
  };
}

/**
 * Factory for development OAuth proxy
 */
export function oAuthProxyFactory(config?: { baseUrl?: string; productionUrl?: string }): ProviderFactoryResult {
  debugAuth('[providers] Checking OAuth proxy factory (NODE_ENV: %s)', authEnv.NODE_ENV);
  const isDevelopment = authEnv.NODE_ENV !== 'production';

  if (!isDevelopment) {
    debugAuth('[providers] OAuth proxy disabled (production mode)');
    return { plugins: [] };
  }

  const baseUrl = config?.baseUrl || authEnv.BASE_URL || 'http://localhost:3000';
  const productionUrl = config?.productionUrl || authEnv.PRODUCTION_URL || 'https://example.com';

  debugAuth('[providers] OAuth proxy enabled (development mode: %s -> %s)', baseUrl, productionUrl);
  return {
    plugins: [
      oAuthProxy({
        currentURL: baseUrl,
        productionURL: productionUrl,
      }),
    ],
  };
}

/**
 * Factory for TOTP/2FA provider
 */
export function totpProviderFactory(): ProviderFactoryResult {
  const issuer = authEnv.APP_NAME || 'Dot App';
  debugAuth('[providers] Creating TOTP/2FA provider (issuer: %s)', issuer);
  return {
    plugins: [
      twoFactor({
        issuer,
      }),
    ],
  };
}

/**
 * Factory for WebAuthn/Passkeys provider
 */
export function webAuthnProviderFactory(): ProviderFactoryResult {
  debugAuth('[providers] WebAuthn/Passkeys provider requested but not yet implemented');
  // TODO: Implement when passkey plugin is available in better-auth
  console.warn('WebAuthn/Passkeys provider not yet implemented - waiting for better-auth support');
  return {
    plugins: [],
  };
}

/**
 * Provider factory map
 */
export const providerFactories: Record<BuiltInProvider, () => ProviderFactoryResult | null> = {
  google: googleProviderFactory,
  github: githubProviderFactory,
  discord: discordProviderFactory,
  facebook: facebookProviderFactory,
  apple: appleProviderFactory,
  twitter: twitterProviderFactory,
  linkedin: linkedinProviderFactory,
  magicLink: magicLinkProviderFactory,
  credentials: credentialsProviderFactory,
};

/**
 * Transform provider configuration to better-auth format
 */
export function transformProviders(
  providers: (BuiltInProvider | CustomProvider)[],
  _emailConfig?: { sendEmail?: (params: any) => Promise<void> },
): ProviderFactoryResult {
  debugAuth('[providers] Transforming %d provider(s) to better-auth format', providers.length);
  const result: ProviderFactoryResult = {
    socialProviders: {},
    plugins: [],
    config: {},
  };

  // Add OAuth proxy for development
  if (authEnv.NODE_ENV === 'development') {
    debugAuth('[providers] Adding OAuth proxy for development mode');
    const proxyResult = oAuthProxyFactory();
    if (proxyResult.plugins) {
      result.plugins!.push(...proxyResult.plugins);
    }
  }

  for (const provider of providers) {
    if (typeof provider === 'string') {
      // Built-in provider
      debugAuth('[providers] Processing built-in provider: %s', provider);
      const factory = providerFactories[provider];
      if (factory) {
        const providerResult = factory();
        if (providerResult) {
          if (providerResult.socialProviders) {
            debugAuth('[providers] Adding social provider configuration for: %s', provider);
            Object.assign(result.socialProviders!, providerResult.socialProviders);
          }
          if (providerResult.plugins) {
            debugAuth('[providers] Adding %d plugin(s) for: %s', providerResult.plugins.length, provider);
            result.plugins!.push(...providerResult.plugins);
          }
          if (providerResult.config) {
            debugAuth('[providers] Adding configuration for: %s', provider);
            Object.assign(result.config!, providerResult.config);
          }
        } else {
          debugAuth('[providers] Provider %s returned null (likely missing credentials)', provider);
        }
      } else {
        debugAuth('[providers] No factory found for provider: %s', provider);
      }
    } else {
      // Custom provider
      debugAuth('[providers] Processing custom provider: %s (type: %s)', provider.id, provider.type);
      if (provider.type === 'oauth' || provider.type === 'oidc') {
        result.socialProviders![provider.id] = provider.config;
        debugAuth('[providers] Added custom OAuth/OIDC provider: %s', provider.id);
      } else {
        // Handle other custom provider types
        debugAuth('[providers] Custom provider type "%s" not yet supported', provider.type);
        console.warn(`Custom provider type '${provider.type}' not yet supported`);
      }
    }
  }

  debugAuth(
    '[providers] Provider transformation complete (socialProviders: %d, plugins: %d)',
    Object.keys(result.socialProviders!).length,
    result.plugins!.length,
  );
  return result;
}
