import { defineEnv } from '@arki/env/core';

import { z } from '@arki/contracts';

/**
 * Treats an empty string the same as absent.
 *
 * Deployment platforms (Coolify, Vercel, etc.) often store unset optional
 * credentials as "" rather than omitting the variable entirely.  Zod's
 * `.optional()` only skips validation for `undefined`, so an empty string
 * still triggers `.min(1)`.  This preprocessor normalises "" → undefined
 * before the schema runs.
 */
const optionalCredential = z.preprocess(
  val => (val === '' ? undefined : val),
  z.string().min(1).optional(),
);

export const env = defineEnv({
  name: '@arki/auth',
  /**
   * Environment variables schema for authentication services
   */
  server: {
    VITE_URL: z.url().optional(),
    PRODUCTION_URL: z.url().optional(),

    // General Configuration
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // Auth Core Configuration
    AUTH_SECRET: z.string().min(1),
    AUTH_DEBUG: z
      .string()
      .default(String(process.env.NODE_ENV !== 'production'))
      .transform(val => val === 'true'),

    // Email Configuration
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.email().default('noreply@furculita.net'),

    // OAuth Providers - Google
    GOOGLE_CLIENT_ID: optionalCredential,
    GOOGLE_CLIENT_SECRET: optionalCredential,

    // OAuth Providers - Apple
    APPLE_CLIENT_ID: optionalCredential,
    APPLE_CLIENT_SECRET: optionalCredential,
    APPLE_APP_BUNDLE_IDENTIFIER: optionalCredential,

    // OAuth Providers - Facebook
    FACEBOOK_CLIENT_ID: optionalCredential,
    FACEBOOK_CLIENT_SECRET: optionalCredential,

    // OAuth Providers - GitHub
    GITHUB_CLIENT_ID: optionalCredential,
    GITHUB_CLIENT_SECRET: optionalCredential,

    // OAuth Providers - Discord
    DISCORD_CLIENT_ID: optionalCredential,
    DISCORD_CLIENT_SECRET: optionalCredential,

    // OAuth Providers - Twitter/X
    TWITTER_CLIENT_ID: optionalCredential,
    TWITTER_CLIENT_SECRET: optionalCredential,

    // OAuth Providers - LinkedIn
    LINKEDIN_CLIENT_ID: optionalCredential,
    LINKEDIN_CLIENT_SECRET: optionalCredential,

    // OAuth Providers - Microsoft
    MICROSOFT_CLIENT_ID: optionalCredential,
    MICROSOFT_CLIENT_SECRET: optionalCredential,
  },

  client: {},
  clientPrefix: '',

  options: {
    skipValidation: !!process.env.CI || process.env.NODE_ENV === 'test',
  },
});
