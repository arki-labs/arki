import { z } from '@arki/contracts';
import { createEnv } from '@t3-oss/env-core';

export const env = createEnv({
  /**
   * Environment variables schema for authentication services
   */
  server: {
    NEXT_PUBLIC_URL: z.url(),
    PRODUCTION_URL: z.url().optional(),

    // General Configuration
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // Auth Core Configuration
    AUTH_SECRET: z.string().min(1),
    AUTH_DEBUG: z
      .string()
      .default(String(process.env['NODE_ENV'] !== 'production'))
      .transform(val => val === 'true'),

    // Email Configuration
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.email().default('noreply@furculita.net'),

    // OAuth Providers - Google
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

    // OAuth Providers - Apple
    APPLE_CLIENT_ID: z.string().min(1).optional(),
    APPLE_CLIENT_SECRET: z.string().min(1).optional(),
    APPLE_APP_BUNDLE_IDENTIFIER: z.string().min(1).optional(),

    // OAuth Providers - Facebook
    FACEBOOK_CLIENT_ID: z.string().min(1).optional(),
    FACEBOOK_CLIENT_SECRET: z.string().min(1).optional(),

    // OAuth Providers - GitHub
    GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().min(1).optional(),

    // OAuth Providers - Discord
    DISCORD_CLIENT_ID: z.string().min(1).optional(),
    DISCORD_CLIENT_SECRET: z.string().min(1).optional(),

    // OAuth Providers - Twitter/X
    TWITTER_CLIENT_ID: z.string().min(1).optional(),
    TWITTER_CLIENT_SECRET: z.string().min(1).optional(),

    // OAuth Providers - LinkedIn
    LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
    LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
  },

  client: {},
  clientPrefix: '',

  /**
   * Destructure all variables from `process.env` to make sure they aren't tree-shaken away.
   */
  runtimeEnv: {
    NEXT_PUBLIC_URL: process.env['NEXT_PUBLIC_URL'],
    PRODUCTION_URL: process.env['PRODUCTION_URL'],
    NODE_ENV: process.env['NODE_ENV'],
    AUTH_SECRET: process.env['AUTH_SECRET'],
    AUTH_DEBUG: process.env['AUTH_DEBUG'],
    RESEND_API_KEY: process.env['RESEND_API_KEY'],
    EMAIL_FROM: process.env['EMAIL_FROM'],
    GOOGLE_CLIENT_ID: process.env['GOOGLE_CLIENT_ID'],
    GOOGLE_CLIENT_SECRET: process.env['GOOGLE_CLIENT_SECRET'],
    APPLE_CLIENT_ID: process.env['APPLE_CLIENT_ID'],
    APPLE_CLIENT_SECRET: process.env['APPLE_CLIENT_SECRET'],
    APPLE_APP_BUNDLE_IDENTIFIER: process.env['APPLE_APP_BUNDLE_IDENTIFIER'],
    FACEBOOK_CLIENT_ID: process.env['FACEBOOK_CLIENT_ID'],
    FACEBOOK_CLIENT_SECRET: process.env['FACEBOOK_CLIENT_SECRET'],
    GITHUB_CLIENT_ID: process.env['GITHUB_CLIENT_ID'],
    GITHUB_CLIENT_SECRET: process.env['GITHUB_CLIENT_SECRET'],
    DISCORD_CLIENT_ID: process.env['DISCORD_CLIENT_ID'],
    DISCORD_CLIENT_SECRET: process.env['DISCORD_CLIENT_SECRET'],
    TWITTER_CLIENT_ID: process.env['TWITTER_CLIENT_ID'],
    TWITTER_CLIENT_SECRET: process.env['TWITTER_CLIENT_SECRET'],
    LINKEDIN_CLIENT_ID: process.env['LINKEDIN_CLIENT_ID'],
    LINKEDIN_CLIENT_SECRET: process.env['LINKEDIN_CLIENT_SECRET'],
  },

  skipValidation: !!process.env['CI'] || process.env['NODE_ENV'] !== 'development',
});
