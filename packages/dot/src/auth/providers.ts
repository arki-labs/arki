/**
 * Provider factory functions for common auth providers
 * Uses validated environment variables from @t3-oss/env-core
 */

import { magicLink, oAuthProxy, twoFactor } from 'better-auth/plugins';

import { authEnv } from './env';
import type { BuiltInProvider, CustomProvider, EmailTemplate, PasswordHasher, PasswordPolicy } from './types';

/**
 * Provider factory result
 */
export interface ProviderFactoryResult {
  socialProviders?: Record<string, any>;
  plugins?: any[];
  config?: Record<string, any>;
}


/**
 * Factory for Google OAuth provider
 */
export function googleProviderFactory(): ProviderFactoryResult | null {
  const clientId = authEnv.GOOGLE_CLIENT_ID || authEnv.AUTH_GOOGLE_ID;
  const clientSecret = authEnv.GOOGLE_CLIENT_SECRET || authEnv.AUTH_GOOGLE_SECRET;

  if (!clientId || !clientSecret) {
    console.warn('Google provider configured but credentials not found in environment');
    return null;
  }

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
  const clientId = authEnv.GITHUB_CLIENT_ID || authEnv.AUTH_GITHUB_ID;
  const clientSecret = authEnv.GITHUB_CLIENT_SECRET || authEnv.AUTH_GITHUB_SECRET;

  if (!clientId || !clientSecret) {
    console.warn('GitHub provider configured but credentials not found in environment');
    return null;
  }

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
  const clientId = authEnv.DISCORD_CLIENT_ID || authEnv.AUTH_DISCORD_ID;
  const clientSecret = authEnv.DISCORD_CLIENT_SECRET || authEnv.AUTH_DISCORD_SECRET;

  if (!clientId || !clientSecret) {
    console.warn('Discord provider configured but credentials not found in environment');
    return null;
  }

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
  const clientId = authEnv.FACEBOOK_CLIENT_ID || authEnv.AUTH_FACEBOOK_ID;
  const clientSecret = authEnv.FACEBOOK_CLIENT_SECRET || authEnv.AUTH_FACEBOOK_SECRET;

  if (!clientId || !clientSecret) {
    console.warn('Facebook provider configured but credentials not found in environment');
    return null;
  }

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
  const clientId = authEnv.APPLE_CLIENT_ID || authEnv.AUTH_APPLE_ID;
  const clientSecret = authEnv.APPLE_CLIENT_SECRET || authEnv.AUTH_APPLE_SECRET;
  // TODO: Add APPLE_BUNDLE_ID to env.ts if needed

  if (!clientId || !clientSecret) {
    console.warn('Apple provider configured but credentials not found in environment');
    return null;
  }

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
  const clientId = authEnv.TWITTER_CLIENT_ID || authEnv.AUTH_TWITTER_ID;
  const clientSecret = authEnv.TWITTER_CLIENT_SECRET || authEnv.AUTH_TWITTER_SECRET;

  if (!clientId || !clientSecret) {
    console.warn('Twitter provider configured but credentials not found in environment');
    return null;
  }

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
  // LinkedIn not in env.ts yet - add if needed
  const clientId = undefined;
  const clientSecret = undefined;

  if (!clientId || !clientSecret) {
    console.warn('LinkedIn provider configured but credentials not found in environment');
    return null;
  }

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
  const defaultSendEmail = async ({ email, url }: { email: string; url: string }) => {
    console.log(`Magic link for ${email}: ${url}`);
    if (authEnv.NODE_ENV === 'development') {
      console.warn('Magic link email not sent - configure email provider');
    }
  };

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
  // Default password policy
  // TODO: Use this when implementing password validation
  // const defaultPolicy: PasswordPolicy = {
  //   minLength: 8,
  //   requireUppercase: true,
  //   requireLowercase: true,
  //   requireNumbers: true,
  // };

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
  const isDevelopment = authEnv.NODE_ENV !== 'production';

  if (!isDevelopment) {
    return { plugins: [] };
  }

  const baseUrl = config?.baseUrl || authEnv.BASE_URL || 'http://localhost:3000';
  const productionUrl = config?.productionUrl || authEnv.PRODUCTION_URL || 'https://example.com';

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
  return {
    plugins: [
      twoFactor({
        issuer: authEnv.APP_NAME || 'Dot App',
      }),
    ],
  };
}

/**
 * Factory for WebAuthn/Passkeys provider
 */
export function webAuthnProviderFactory(): ProviderFactoryResult {
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
  providers: Array<BuiltInProvider | CustomProvider>,
  _emailConfig?: { sendEmail?: (params: any) => Promise<void> }
): ProviderFactoryResult {
  const result: ProviderFactoryResult = {
    socialProviders: {},
    plugins: [],
    config: {},
  };

  // Add OAuth proxy for development
  if (authEnv.NODE_ENV === 'development') {
    const proxyResult = oAuthProxyFactory();
    if (proxyResult.plugins) {
      result.plugins!.push(...proxyResult.plugins);
    }
  }

  for (const provider of providers) {
    if (typeof provider === 'string') {
      // Built-in provider
      const factory = providerFactories[provider];
      if (factory) {
        const providerResult = factory();
        if (providerResult) {
          if (providerResult.socialProviders) {
            Object.assign(result.socialProviders!, providerResult.socialProviders);
          }
          if (providerResult.plugins) {
            result.plugins!.push(...providerResult.plugins);
          }
          if (providerResult.config) {
            Object.assign(result.config!, providerResult.config);
          }
        }
      }
    } else {
      // Custom provider
      if (provider.type === 'oauth' || provider.type === 'oidc') {
        result.socialProviders![provider.id] = provider.config;
      } else {
        // Handle other custom provider types
        console.warn(`Custom provider type '${provider.type}' not yet supported`);
      }
    }
  }

  return result;
}