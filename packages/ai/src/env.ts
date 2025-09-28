/**
 * Environment variable configuration for @arki/ai package
 * Using T3 Env pattern for type-safe environment variables
 */

import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod/v4';

export const env = createEnv({
  server: {
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    EMBEDDING_PROVIDER: z.enum(['openai', 'mock', 'cohere', 'anthropic']).default('mock'),
    QDRANT_URL: z.string().url().optional(),
    QDRANT_API_KEY: z.string().optional(),
  },
  client: {},
  clientPrefix: '',
  runtimeEnv: {
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    OPENAI_EMBEDDING_MODEL: process.env['OPENAI_EMBEDDING_MODEL'],
    EMBEDDING_PROVIDER: process.env['EMBEDDING_PROVIDER'],
    QDRANT_URL: process.env['QDRANT_URL'],
    QDRANT_API_KEY: process.env['QDRANT_API_KEY'],
  },
  skipValidation: !!process.env['CI'] || process.env['NODE_ENV'] !== 'development',
});