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

    // Mixedbread
    MXBAI_API_KEY: z.string().optional(),
    MXBAI_EMBEDDING_MODEL: z.string().default('mixedbread-ai/mxbai-embed-large-v1'),
    MXBAI_RERANK_MODEL: z.string().default('mixedbread-ai/mxbai-rerank-large-v1'),

    // Ollama (local-first; preferred per workspace operating rules)
    OLLAMA_BASE_URL: z.string().default('http://127.0.0.1:11434/api'),
    OLLAMA_EMBEDDING_MODEL: z.string().default('nomic-embed-text'),

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
      .enum(['openai', 'anthropic', 'groq', 'google', 'mistral'])
      .default('openai'),
    // Default model for the selected LLM provider
    LLM_MODEL: z.string().optional(),

    // Embedding and vector search
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
        'mixedbread',
        'transformers-js',
        'mock',
      ])
      .default('mock'),
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
    GOOGLE_API_KEYS: process.env['GOOGLE_API_KEYS'],
    GOOGLE_EMBEDDING_MODEL: process.env['GOOGLE_EMBEDDING_MODEL'],
    MISTRAL_API_KEY: process.env['MISTRAL_API_KEY'],
    MISTRAL_EMBEDDING_MODEL: process.env['MISTRAL_EMBEDDING_MODEL'],
    OPENROUTER_API_KEY: process.env['OPENROUTER_API_KEY'],
    COHERE_API_KEY: process.env['COHERE_API_KEY'],
    COHERE_EMBEDDING_MODEL: process.env['COHERE_EMBEDDING_MODEL'],
    COHERE_RERANK_MODEL: process.env['COHERE_RERANK_MODEL'],
    VOYAGE_API_KEY: process.env['VOYAGE_API_KEY'],
    VOYAGE_EMBEDDING_MODEL: process.env['VOYAGE_EMBEDDING_MODEL'],
    VOYAGE_RERANK_MODEL: process.env['VOYAGE_RERANK_MODEL'],
    JINA_API_KEY: process.env['JINA_API_KEY'],
    JINA_EMBEDDING_MODEL: process.env['JINA_EMBEDDING_MODEL'],
    JINA_RERANK_MODEL: process.env['JINA_RERANK_MODEL'],
    MXBAI_API_KEY: process.env['MXBAI_API_KEY'],
    MXBAI_EMBEDDING_MODEL: process.env['MXBAI_EMBEDDING_MODEL'],
    MXBAI_RERANK_MODEL: process.env['MXBAI_RERANK_MODEL'],
    OLLAMA_BASE_URL: process.env['OLLAMA_BASE_URL'],
    OLLAMA_EMBEDDING_MODEL: process.env['OLLAMA_EMBEDDING_MODEL'],
    OPENAI_COMPATIBLE_BASE_URL: process.env['OPENAI_COMPATIBLE_BASE_URL'],
    OPENAI_COMPATIBLE_API_KEY: process.env['OPENAI_COMPATIBLE_API_KEY'],
    OPENAI_COMPATIBLE_MODEL: process.env['OPENAI_COMPATIBLE_MODEL'],
    OPENAI_COMPATIBLE_DIMENSIONS: process.env['OPENAI_COMPATIBLE_DIMENSIONS'],
    AWS_REGION: process.env['AWS_REGION'],
    BEDROCK_EMBEDDING_MODEL: process.env['BEDROCK_EMBEDDING_MODEL'],
    BEDROCK_RERANK_MODEL: process.env['BEDROCK_RERANK_MODEL'],
    TRANSFORMERS_JS_MODEL: process.env['TRANSFORMERS_JS_MODEL'],
    LLM_PROVIDER: process.env['LLM_PROVIDER'],
    LLM_MODEL: process.env['LLM_MODEL'],
    EMBEDDING_PROVIDER: process.env['EMBEDDING_PROVIDER'],
    QDRANT_URL: process.env['QDRANT_URL'],
    QDRANT_API_KEY: process.env['QDRANT_API_KEY'],
  },
  skipValidation: !!process.env['CI'] || process.env['NODE_ENV'] !== 'development',
});
