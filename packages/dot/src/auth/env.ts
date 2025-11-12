/**
 * Environment variable validation for auth module
 * Using @t3-oss/env-core for type-safe environment variables
 */

import { z } from '@arki/contracts';
import { createEnv } from '@t3-oss/env-core';

/**
 * Auth-specific environment variables with validation
 */
export const authEnv = createEnv({
  /**
   * Server-side environment variables
   */
  server: {
    // Core auth configuration
    AUTH_SECRET: z.string().min(1).optional(),

    // URLs
    BASE_URL: z.url().optional(),
    PRODUCTION_URL: z.url().optional(),

    // App configuration
    APP_NAME: z.string().optional(),
    APP_KEY: z.string().optional(),

    // Database
    DATABASE_URL: z.string().optional(),
    DB_URL: z.string().optional(),
    POSTGRES_URL: z.string().optional(),

    // OAuth - Google
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    AUTH_GOOGLE_ID: z.string().optional(),
    AUTH_GOOGLE_SECRET: z.string().optional(),

    // OAuth - GitHub
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    AUTH_GITHUB_ID: z.string().optional(),
    AUTH_GITHUB_SECRET: z.string().optional(),

    // OAuth - Discord
    DISCORD_CLIENT_ID: z.string().optional(),
    DISCORD_CLIENT_SECRET: z.string().optional(),
    AUTH_DISCORD_ID: z.string().optional(),
    AUTH_DISCORD_SECRET: z.string().optional(),

    // OAuth - Facebook
    FACEBOOK_CLIENT_ID: z.string().optional(),
    FACEBOOK_CLIENT_SECRET: z.string().optional(),
    AUTH_FACEBOOK_ID: z.string().optional(),
    AUTH_FACEBOOK_SECRET: z.string().optional(),

    // OAuth - Apple
    APPLE_CLIENT_ID: z.string().optional(),
    APPLE_CLIENT_SECRET: z.string().optional(),
    AUTH_APPLE_ID: z.string().optional(),
    AUTH_APPLE_SECRET: z.string().optional(),

    // OAuth - Twitter
    TWITTER_CLIENT_ID: z.string().optional(),
    TWITTER_CLIENT_SECRET: z.string().optional(),
    AUTH_TWITTER_ID: z.string().optional(),
    AUTH_TWITTER_SECRET: z.string().optional(),

    // Email configuration
    EMAIL_FROM: z.string().email().optional(),
    EMAIL_SERVER: z.string().optional(),
    EMAIL_SERVER_HOST: z.string().optional(),
    EMAIL_SERVER_PORT: z.string().transform(Number).pipe(z.number()).optional(),
    EMAIL_SERVER_USER: z.string().optional(),
    EMAIL_SERVER_PASSWORD: z.string().optional(),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.string().transform(Number).pipe(z.number()).optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().email().optional(),

    // Redis/KV configuration
    REDIS_URL: z.string().optional(),
    KV_URL: z.string().optional(),
    UPSTASH_REDIS_URL: z.string().optional(),
    UPSTASH_REDIS_REST_URL: z.string().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

    // WebAuthn configuration
    RPID: z.string().optional(),

    // Node environment
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  },

  /**
   * Client-side environment variables (if any needed for auth)
   */
  client: {
    // Add any client-side env vars here if needed
  },
  clientPrefix: 'NEXT_PUBLIC_',

  /**
   * Runtime environment variables
   * Maps the actual environment variables to the validated schema
   */
  runtimeEnv: {
    // Core auth
    AUTH_SECRET: process.env['AUTH_SECRET'],

    // URLs
    BASE_URL: process.env['BASE_URL'],
    NEXT_PUBLIC_BASE_URL: process.env['NEXT_PUBLIC_BASE_URL'],
    PRODUCTION_URL: process.env['PRODUCTION_URL'],
    NEXT_PUBLIC_PRODUCTION_URL: process.env['NEXT_PUBLIC_PRODUCTION_URL'],

    // App config
    APP_NAME: process.env['APP_NAME'],
    APP_KEY: process.env['APP_KEY'],

    // Database
    DATABASE_URL: process.env['DATABASE_URL'],
    DB_URL: process.env['DB_URL'],
    POSTGRES_URL: process.env['POSTGRES_URL'],

    // OAuth - Google
    GOOGLE_CLIENT_ID: process.env['GOOGLE_CLIENT_ID'],
    GOOGLE_CLIENT_SECRET: process.env['GOOGLE_CLIENT_SECRET'],
    AUTH_GOOGLE_ID: process.env['AUTH_GOOGLE_ID'],
    AUTH_GOOGLE_SECRET: process.env['AUTH_GOOGLE_SECRET'],

    // OAuth - GitHub
    GITHUB_CLIENT_ID: process.env['GITHUB_CLIENT_ID'],
    GITHUB_CLIENT_SECRET: process.env['GITHUB_CLIENT_SECRET'],
    AUTH_GITHUB_ID: process.env['AUTH_GITHUB_ID'],
    AUTH_GITHUB_SECRET: process.env['AUTH_GITHUB_SECRET'],

    // OAuth - Discord
    DISCORD_CLIENT_ID: process.env['DISCORD_CLIENT_ID'],
    DISCORD_CLIENT_SECRET: process.env['DISCORD_CLIENT_SECRET'],
    AUTH_DISCORD_ID: process.env['AUTH_DISCORD_ID'],
    AUTH_DISCORD_SECRET: process.env['AUTH_DISCORD_SECRET'],

    // OAuth - Facebook
    FACEBOOK_CLIENT_ID: process.env['FACEBOOK_CLIENT_ID'],
    FACEBOOK_CLIENT_SECRET: process.env['FACEBOOK_CLIENT_SECRET'],
    AUTH_FACEBOOK_ID: process.env['AUTH_FACEBOOK_ID'],
    AUTH_FACEBOOK_SECRET: process.env['AUTH_FACEBOOK_SECRET'],

    // OAuth - Apple
    APPLE_CLIENT_ID: process.env['APPLE_CLIENT_ID'],
    APPLE_CLIENT_SECRET: process.env['APPLE_CLIENT_SECRET'],
    AUTH_APPLE_ID: process.env['AUTH_APPLE_ID'],
    AUTH_APPLE_SECRET: process.env['AUTH_APPLE_SECRET'],

    // OAuth - Twitter
    TWITTER_CLIENT_ID: process.env['TWITTER_CLIENT_ID'],
    TWITTER_CLIENT_SECRET: process.env['TWITTER_CLIENT_SECRET'],
    AUTH_TWITTER_ID: process.env['AUTH_TWITTER_ID'],
    AUTH_TWITTER_SECRET: process.env['AUTH_TWITTER_SECRET'],

    // Email
    EMAIL_FROM: process.env['EMAIL_FROM'],
    EMAIL_SERVER: process.env['EMAIL_SERVER'],
    EMAIL_SERVER_HOST: process.env['EMAIL_SERVER_HOST'],
    EMAIL_SERVER_PORT: process.env['EMAIL_SERVER_PORT'],
    EMAIL_SERVER_USER: process.env['EMAIL_SERVER_USER'],
    EMAIL_SERVER_PASSWORD: process.env['EMAIL_SERVER_PASSWORD'],
    SMTP_HOST: process.env['SMTP_HOST'],
    SMTP_PORT: process.env['SMTP_PORT'],
    SMTP_USER: process.env['SMTP_USER'],
    SMTP_PASSWORD: process.env['SMTP_PASSWORD'],
    SMTP_FROM: process.env['SMTP_FROM'],

    // Redis/KV
    REDIS_URL: process.env['REDIS_URL'],
    KV_URL: process.env['KV_URL'],
    UPSTASH_REDIS_URL: process.env['UPSTASH_REDIS_URL'],
    UPSTASH_REDIS_REST_URL: process.env['UPSTASH_REDIS_REST_URL'],
    UPSTASH_REDIS_REST_TOKEN: process.env['UPSTASH_REDIS_REST_TOKEN'],

    // WebAuthn
    RPID: process.env['RPID'],

    // Node environment
    NODE_ENV: process.env['NODE_ENV'],
  },

  /**
   * Skip validation in certain environments
   */
  skipValidation: !!process.env['CI'] || process.env['NODE_ENV'] === 'test',

  /**
   * Tell the library when we're in a server context
   */
  isServer: typeof window === 'undefined',
});

/**
 * Helper function to get auth secret from validated environment
 */
export function getAuthSecret(): string | undefined {
  return authEnv.AUTH_SECRET || authEnv.AUTH_SECRET;
}

/**
 * Helper function to get base URL from validated environment
 */
export function getBaseUrl(): string | undefined {
  return authEnv.BASE_URL;
}

/**
 * Helper function to get production URL from validated environment
 */
export function getProductionUrl(): string | undefined {
  return authEnv.PRODUCTION_URL;
}

/**
 * Helper function to get database URL from validated environment
 */
export function getDatabaseUrl(): string | undefined {
  return authEnv.DATABASE_URL || authEnv.DB_URL || authEnv.POSTGRES_URL;
}

/**
 * Helper function to check if Google OAuth is configured
 */
export function isGoogleOAuthConfigured(): boolean {
  const clientId = authEnv.GOOGLE_CLIENT_ID || authEnv.AUTH_GOOGLE_ID;
  const clientSecret = authEnv.GOOGLE_CLIENT_SECRET || authEnv.AUTH_GOOGLE_SECRET;
  return !!(clientId && clientSecret);
}

/**
 * Helper function to check if GitHub OAuth is configured
 */
export function isGitHubOAuthConfigured(): boolean {
  const clientId = authEnv.GITHUB_CLIENT_ID || authEnv.AUTH_GITHUB_ID;
  const clientSecret = authEnv.GITHUB_CLIENT_SECRET || authEnv.AUTH_GITHUB_SECRET;
  return !!(clientId && clientSecret);
}

/**
 * Helper function to check if Discord OAuth is configured
 */
export function isDiscordOAuthConfigured(): boolean {
  const clientId = authEnv.DISCORD_CLIENT_ID || authEnv.AUTH_DISCORD_ID;
  const clientSecret = authEnv.DISCORD_CLIENT_SECRET || authEnv.AUTH_DISCORD_SECRET;
  return !!(clientId && clientSecret);
}

/**
 * Helper function to get email configuration
 */
export function getEmailConfig() {
  const from = authEnv.EMAIL_FROM || authEnv.SMTP_FROM;
  const host = authEnv.EMAIL_SERVER_HOST || authEnv.SMTP_HOST;
  const port = authEnv.EMAIL_SERVER_PORT || authEnv.SMTP_PORT;
  const user = authEnv.EMAIL_SERVER_USER || authEnv.SMTP_USER;
  const password = authEnv.EMAIL_SERVER_PASSWORD || authEnv.SMTP_PASSWORD;

  if (!from || !host || !port || !user || !password) {
    return;
  }

  return {
    from,
    server: {
      host,
      port,
      auth: {
        user,
        pass: password,
      },
    },
  };
}

/**
 * Helper function to get Redis/KV URL
 */
export function getKvUrl(): string | undefined {
  return authEnv.KV_URL || authEnv.REDIS_URL || authEnv.UPSTASH_REDIS_URL || authEnv.UPSTASH_REDIS_REST_URL;
}

/**
 * Validate required environment variables for production
 */
export function validateProductionEnv(): void {
  if (authEnv.NODE_ENV !== 'production') {
    return;
  }

  const errors: string[] = [];

  // Check auth secret
  const secret = getAuthSecret();
  if (!secret) {
    errors.push('AUTH_SECRET or AUTH_SECRET is required in production');
  } else if (secret.length < 32) {
    errors.push('Auth secret must be at least 32 characters in production');
  }

  // Check base URL
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    errors.push('BASE_URL or NEXT_PUBLIC_BASE_URL is required in production');
  } else if (baseUrl.includes('localhost')) {
    errors.push('Base URL cannot be localhost in production');
  }

  // Check database
  if (!getDatabaseUrl()) {
    console.warn('Database URL not configured - some features may be limited');
  }

  if (errors.length > 0) {
    throw new Error(`Production environment validation failed:\n${errors.join('\n')}`);
  }
}
