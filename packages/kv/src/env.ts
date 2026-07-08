import { defineEnv } from '@arki/env/core';

import { z } from '@arki/contracts';

export const env = defineEnv({
  name: '@arki/kv',
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

  options: {
    skipValidation: !!process.env['CI'] || process.env['NODE_ENV'] === 'test',
  },
});
