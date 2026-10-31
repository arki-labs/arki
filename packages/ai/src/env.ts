/**
 * Environment variable configuration for @arki/ai package
 * Using T3 Env pattern for type-safe environment variables
 */

import { z } from '@arki/contracts';
import { defineEnv } from '@arki/env/core';

import { LLM_PROVIDERS } from './ai-service/provider-names.js';

/**
 * Defaults that must also hold when validation is skipped (`SKIP_ENV_VALIDATION=1`).
 * A skipped schema applies no zod defaults, so callers fall back to these
 * instead of silently picking a paid provider.
 */
export const DEFAULT_LLM_PROVIDER = 'ollama';
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export const env = defineEnv({
  name: '@arki/ai',
  server: {
    // Diarized prerecorded speech
    DEEPGRAM_API_KEY: z.string().optional(),

    // OpenAI
    OPENAI_API_KEY: z.string().optional(),

    // Anthropic
    ANTHROPIC_API_KEY: z.string().optional(),
    // Required with a user-scoped key (`sk-ant-usr…`): the workspace its requests bill to.
    ANTHROPIC_WORKSPACE_ID: z.string().optional(),

    // Groq (OpenAI-compatible API with fast inference)
    GROQ_API_KEY: z.string().optional(),

    // Google AI (Gemini)
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
    // Multiple Google AI keys (comma-separated) for load distribution
    GOOGLE_API_KEYS: z.string().optional(),

    // Mistral AI
    MISTRAL_API_KEY: z.string().optional(),

    // OpenRouter (aggregator for multiple models)
    OPENROUTER_API_KEY: z.string().optional(),

    // Ollama (local-first; preferred per workspace operating rules).
    OLLAMA_BASE_URL: z.string().default(DEFAULT_OLLAMA_BASE_URL),

    // LLM provider selection for createLLMProvider() factory
    LLM_PROVIDER: z.enum(LLM_PROVIDERS).default(DEFAULT_LLM_PROVIDER),
    // Default model for the selected LLM provider
    LLM_MODEL: z.string().optional(),
    // Tests only: when set, every createLLMProvider() call runs at temperature 0 with this seed,
    // so a real local model answers the same input the same way run after run.
    AI_DETERMINISTIC_SEED: z.coerce.number().int().optional(),

    // Vector search (Qdrant). The embedding settings live in `@arki/embeddings`.
    QDRANT_URL: z.url().optional(),
    QDRANT_API_KEY: z.string().optional(),
  },
  client: {},
  clientPrefix: '',
});
