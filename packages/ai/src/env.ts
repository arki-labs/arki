/**
 * Environment variable configuration for @arki/ai package
 * Using T3 Env pattern for type-safe environment variables
 */

import { z } from '@arki/contracts';
import { createEnv } from '@t3-oss/env-core';

export const env = createEnv({
  server: {
    // OpenAI
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

    // Anthropic
    ANTHROPIC_API_KEY: z.string().optional(),

    // Groq (OpenAI-compatible API with fast inference)
    GROQ_API_KEY: z.string().optional(),

    // Google AI (Gemini)
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),

    // Mistral AI
    MISTRAL_API_KEY: z.string().optional(),

    // OpenRouter (aggregator for multiple models)
    OPENROUTER_API_KEY: z.string().optional(),

    // Embedding and vector search
    EMBEDDING_PROVIDER: z.enum(['openai', 'mock', 'cohere', 'anthropic']).default('mock'),
    QDRANT_URL: z.url().optional(),
    QDRANT_API_KEY: z.string().optional(),
  },
  client: {},
  clientPrefix: '',
  runtimeEnv: {
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    OPENAI_EMBEDDING_MODEL: process.env['OPENAI_EMBEDDING_MODEL'],
    ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
    GROQ_API_KEY: process.env['GROQ_API_KEY'],
    GOOGLE_GENERATIVE_AI_API_KEY: process.env['GOOGLE_GENERATIVE_AI_API_KEY'],
    MISTRAL_API_KEY: process.env['MISTRAL_API_KEY'],
    OPENROUTER_API_KEY: process.env['OPENROUTER_API_KEY'],
    EMBEDDING_PROVIDER: process.env['EMBEDDING_PROVIDER'],
    QDRANT_URL: process.env['QDRANT_URL'],
    QDRANT_API_KEY: process.env['QDRANT_API_KEY'],
  },
  skipValidation: !!process.env['CI'] || process.env['NODE_ENV'] !== 'development',
});
