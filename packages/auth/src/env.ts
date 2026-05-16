import { createEnv } from '@t3-oss/env-core';

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

export const env = createEnv({
  onValidationError(issues) {
    console.error(
      '❌ [@arki/auth] Invalid environment variables:\n' +
        issues.map(i => `  ${(i.path ?? []).join('.')}: ${i.message}`).join('\n'),
    );
    throw new Error(
      '❌ [@arki/auth] Invalid environment variables:\n' +
        issues.map(i => `  ${(i.path ?? []).join('.')}: ${i.message}`).join('\n'),
    );
  },
  /**
   * Environment variables schema for authentication services
   */
  server: {
    VITE_PUBLIC_URL: z.url().optional(),
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

  /**
   * Destructure all variables from `process.env` to make sure they aren't tree-shaken away.
   */
  runtimeEnv: {
    VITE_PUBLIC_URL: process.env.VITE_PUBLIC_URL,
    PRODUCTION_URL: process.env.PRODUCTION_URL,
    NODE_ENV: process.env.NODE_ENV,
    AUTH_SECRET: process.env.AUTH_SECRET,
    AUTH_DEBUG: process.env.AUTH_DEBUG,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    APPLE_CLIENT_ID: process.env.APPLE_CLIENT_ID,
    APPLE_CLIENT_SECRET: process.env.APPLE_CLIENT_SECRET,
    APPLE_APP_BUNDLE_IDENTIFIER: process.env.APPLE_APP_BUNDLE_IDENTIFIER,
    FACEBOOK_CLIENT_ID: process.env.FACEBOOK_CLIENT_ID,
    FACEBOOK_CLIENT_SECRET: process.env.FACEBOOK_CLIENT_SECRET,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
    TWITTER_CLIENT_ID: process.env.TWITTER_CLIENT_ID,
    TWITTER_CLIENT_SECRET: process.env.TWITTER_CLIENT_SECRET,
    LINKEDIN_CLIENT_ID: process.env.LINKEDIN_CLIENT_ID,
    LINKEDIN_CLIENT_SECRET: process.env.LINKEDIN_CLIENT_SECRET,
    MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
  },

  skipValidation: !!process.env.CI || process.env.NODE_ENV === 'test',
});
