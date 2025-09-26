/**
 * Provider factory functions for common auth providers
 */

import { magicLink, oAuthProxy, passkey, twoFactor } from 'better-auth/plugins';

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
 * Get environment variable with fallback
 */
function getEnvVar(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Factory for Google OAuth provider
 */
export function googleProviderFactory(): ProviderFactoryResult | null {
  const clientId = getEnvVar(['GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_ID']);
  const clientSecret = getEnvVar(['GOOGLE_CLIENT_SECRET', 'AUTH_GOOGLE_SECRET']);

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
  const clientId = getEnvVar(['GITHUB_CLIENT_ID', 'AUTH_GITHUB_ID']);
  const clientSecret = getEnvVar(['GITHUB_CLIENT_SECRET', 'AUTH_GITHUB_SECRET']);

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
  const clientId = getEnvVar(['DISCORD_CLIENT_ID', 'AUTH_DISCORD_ID']);
  const clientSecret = getEnvVar(['DISCORD_CLIENT_SECRET', 'AUTH_DISCORD_SECRET']);

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
  const clientId = getEnvVar(['FACEBOOK_CLIENT_ID', 'AUTH_FACEBOOK_ID', 'FB_CLIENT_ID']);
  const clientSecret = getEnvVar(['FACEBOOK_CLIENT_SECRET', 'AUTH_FACEBOOK_SECRET', 'FB_CLIENT_SECRET']);

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
  const clientId = getEnvVar(['APPLE_CLIENT_ID', 'AUTH_APPLE_ID']);
  const clientSecret = getEnvVar(['APPLE_CLIENT_SECRET', 'AUTH_APPLE_SECRET']);
  const bundleId = getEnvVar(['APPLE_BUNDLE_ID', 'APPLE_APP_BUNDLE_IDENTIFIER']);

  if (!clientId || !clientSecret) {
    console.warn('Apple provider configured but credentials not found in environment');
    return null;
  }

  return {
    socialProviders: {
      apple: {
        clientId,
        clientSecret,
        ...(bundleId && { appBundleIdentifier: bundleId }),
      },
    },
  };
}

/**
 * Factory for Twitter/X OAuth provider
 */
export function twitterProviderFactory(): ProviderFactoryResult | null {
  const clientId = getEnvVar(['TWITTER_CLIENT_ID', 'X_CLIENT_ID', 'AUTH_TWITTER_ID']);
  const clientSecret = getEnvVar(['TWITTER_CLIENT_SECRET', 'X_CLIENT_SECRET', 'AUTH_TWITTER_SECRET']);

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
  const clientId = getEnvVar(['LINKEDIN_CLIENT_ID', 'AUTH_LINKEDIN_ID']);
  const clientSecret = getEnvVar(['LINKEDIN_CLIENT_SECRET', 'AUTH_LINKEDIN_SECRET']);

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
    if (process.env.NODE_ENV === 'development') {
      console.warn('Magic link email not sent - configure email provider');
    }
  };

  return {
    plugins: [
      magicLink({
        sendMagicLink: config?.sendEmail || defaultSendEmail,
        expirationTime: config?.expiresIn || 60 * 15, // 15 minutes default
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
  const defaultPolicy: PasswordPolicy = {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
  };

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
  const isDevelopment = process.env.NODE_ENV !== 'production';

  if (!isDevelopment) {
    return { plugins: [] };
  }

  const baseUrl = config?.baseUrl || process.env.BASE_URL || 'http://localhost:3000';
  const productionUrl = config?.productionUrl || process.env.PRODUCTION_URL || 'https://example.com';

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
        issuer: process.env.APP_NAME || 'Dot App',
      }),
    ],
  };
}

/**
 * Factory for WebAuthn/Passkeys provider
 */
export function webAuthnProviderFactory(): ProviderFactoryResult {
  return {
    plugins: [
      passkey({
        rpName: process.env.APP_NAME || 'Dot App',
        rpID: process.env.RPID || 'localhost',
        origin: process.env.BASE_URL || 'http://localhost:3000',
      }),
    ],
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
  emailConfig?: { sendEmail?: (params: any) => Promise<void> }
): ProviderFactoryResult {
  const result: ProviderFactoryResult = {
    socialProviders: {},
    plugins: [],
    config: {},
  };

  // Add OAuth proxy for development
  if (process.env.NODE_ENV === 'development') {
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