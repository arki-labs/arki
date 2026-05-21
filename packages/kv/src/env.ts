import { createEnv } from '@t3-oss/env-core';

import { z } from '@arki/contracts';

export const env = createEnv({
  /**
   * Environment variables schema for key-value storage services (Redis/KV)
   */
  server: {
    // General Configuration
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // KV/Redis Configuration
    KV_URL: z.url().optional(),
    KV_NAMESPACE: z.string().optional(),

    // Redis-specific configurations (for advanced Redis features)
    REDIS_HOST: z.string().optional(),
    REDIS_PORT: z.coerce.number().default(6379),
    REDIS_USERNAME: z.string().optional(),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_DB: z.coerce.number().default(0),
    REDIS_TLS: z
      .string()
      .optional()
      .transform(val => val === 'true'),

    // Upstash Redis (for serverless Redis)
    UPSTASH_REDIS_REST_URL: z.url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

    // Rate limiting configuration
    RATE_LIMIT_REDIS_URL: z.url().optional(),
    RATE_LIMIT_PREFIX: z.string().default('rl'),

    // Cache configuration
    CACHE_TTL_DEFAULT: z.coerce.number().default(3600), // 1 hour default
    CACHE_TTL_LONG: z.coerce.number().default(86_400), // 24 hours
    CACHE_TTL_SHORT: z.coerce.number().default(300), // 5 minutes
  },

  client: {},
  clientPrefix: '',

  /**
   * Destructure all variables from `process.env` to make sure they aren't tree-shaken away.
   */
  runtimeEnv: {
    NODE_ENV: process.env['NODE_ENV'],
    KV_URL: process.env['KV_URL'],
    KV_NAMESPACE: process.env['KV_NAMESPACE'],
    REDIS_HOST: process.env['REDIS_HOST'],
    REDIS_PORT: process.env['REDIS_PORT'],
    REDIS_USERNAME: process.env['REDIS_USERNAME'],
    REDIS_PASSWORD: process.env['REDIS_PASSWORD'],
    REDIS_DB: process.env['REDIS_DB'],
    REDIS_TLS: process.env['REDIS_TLS'],
    UPSTASH_REDIS_REST_URL: process.env['UPSTASH_REDIS_REST_URL'],
    UPSTASH_REDIS_REST_TOKEN: process.env['UPSTASH_REDIS_REST_TOKEN'],
    RATE_LIMIT_REDIS_URL: process.env['RATE_LIMIT_REDIS_URL'],
    RATE_LIMIT_PREFIX: process.env['RATE_LIMIT_PREFIX'],
    CACHE_TTL_DEFAULT: process.env['CACHE_TTL_DEFAULT'],
    CACHE_TTL_LONG: process.env['CACHE_TTL_LONG'],
    CACHE_TTL_SHORT: process.env['CACHE_TTL_SHORT'],
  },

  skipValidation: !!process.env['CI'] || process.env['NODE_ENV'] === 'test',
});
