/**
 * Environment variable configuration for @arki/ai package
 * Using T3 Env pattern for type-safe environment variables
 */

import { z } from '@arki/contracts';
import { defineEnv } from '@arki/env/core';

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
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

    // Anthropic
    ANTHROPIC_API_KEY: z.string().optional(),

    // Groq (OpenAI-compatible API with fast inference)
    GROQ_API_KEY: z.string().optional(),

    // Google AI (Gemini)
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
    // Multiple Google AI keys (comma-separated) for load distribution
    GOOGLE_API_KEYS: z.string().optional(),
    GOOGLE_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),

    // Mistral AI
    MISTRAL_API_KEY: z.string().optional(),
    MISTRAL_EMBEDDING_MODEL: z.string().default('mistral-embed'),

    // OpenRouter (aggregator for multiple models)
    OPENROUTER_API_KEY: z.string().optional(),

    // Cohere (embeddings + rerank)
    COHERE_API_KEY: z.string().optional(),
    COHERE_EMBEDDING_MODEL: z.string().default('embed-v4.0'),
    COHERE_RERANK_MODEL: z.string().default('rerank-v3.5'),

    // Voyage AI (embeddings + rerank, MongoDB-owned)
    VOYAGE_API_KEY: z.string().optional(),
    VOYAGE_EMBEDDING_MODEL: z.string().default('voyage-3.5'),
    VOYAGE_RERANK_MODEL: z.string().default('rerank-2.5'),

    // Jina AI (Elastic-owned post-2025-Q4)
    JINA_API_KEY: z.string().optional(),
    JINA_EMBEDDING_MODEL: z.string().default('jina-embeddings-v3'),
    JINA_RERANK_MODEL: z.string().default('jina-reranker-v2-base-multilingual'),

    // Nebius AI (Token Factory — OpenAI-compatible; serves Qwen3-Embedding-8B, 4096-d MMTEB leader)
    NEBIUS_API_KEY: z.string().optional(),
    NEBIUS_EMBEDDING_MODEL: z.string().default('Qwen/Qwen3-Embedding-8B'),
    NEBIUS_EMBEDDING_DIMENSIONS: z.coerce.number().default(4096),
    NEBIUS_BASE_URL: z.string().default('https://api.tokenfactory.nebius.com/v1'),

    // Mixedbread
    MXBAI_API_KEY: z.string().optional(),
    MXBAI_EMBEDDING_MODEL: z.string().default('mixedbread-ai/mxbai-embed-large-v1'),
    MXBAI_RERANK_MODEL: z.string().default('mixedbread-ai/mxbai-rerank-large-v1'),

    // Ollama (local-first; preferred per workspace operating rules).
    // Default model: qwen3-embedding:0.6b — Apache 2.0, 1024-d, MTEB-Eng ~65 /
    // MMTEB ~64. Bump to qwen3-embedding:4b (~8 GB VRAM, MMTEB ~69) or
    // qwen3-embedding:8b (~16 GB VRAM, MMTEB 70.58 leader) when hardware allows.
    OLLAMA_BASE_URL: z.string().default(DEFAULT_OLLAMA_BASE_URL),
    OLLAMA_EMBEDDING_MODEL: z.string().default('qwen3-embedding:0.6b'),

    // OpenAI-compatible (TEI, vLLM, SGLang, Groq, Anyscale, self-host)
    OPENAI_COMPATIBLE_BASE_URL: z.string().optional(),
    OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
    OPENAI_COMPATIBLE_MODEL: z.string().optional(),
    OPENAI_COMPATIBLE_DIMENSIONS: z.coerce.number().optional(),

    // AWS Bedrock (Titan Text Embeddings v2 etc.)
    AWS_REGION: z.string().optional(),
    BEDROCK_EMBEDDING_MODEL: z.string().default('amazon.titan-embed-text-v2:0'),
    BEDROCK_RERANK_MODEL: z.string().default('cohere.rerank-v3-5:0'),

    // transformers.js on-device (Persona 5 wildcard)
    TRANSFORMERS_JS_MODEL: z.string().default('nomic-ai/nomic-embed-text-v1.5'),

    // LLM provider selection for createLLMProvider() factory
    LLM_PROVIDER: z
      .enum(['ollama', 'openai', 'anthropic', 'groq', 'google', 'mistral'])
      .default(DEFAULT_LLM_PROVIDER),
    // Default model for the selected LLM provider
    LLM_MODEL: z.string().optional(),

    // Embedding and vector search. No default: `createEmbeddingRuntime(env)` in
    // `embeddings/runtime.ts` resolves local-first (Ollama → OpenAI → null) and
    // picks `mock` only when named here.
    EMBEDDING_PROVIDER: z
      .enum([
        'openai',
        'openai-compatible',
        'cohere',
        'mistral',
        'google',
        'ollama',
        'voyage',
        'jina',
        'nebius',
        'mixedbread',
        'transformers-js',
        'mock',
      ])
      .optional(),
    QDRANT_URL: z.url().optional(),
    QDRANT_API_KEY: z.string().optional(),
  },
  client: {},
  clientPrefix: '',
});
