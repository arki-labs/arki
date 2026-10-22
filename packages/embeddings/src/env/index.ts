/**
 * `@arki/embeddings/env`: validates the embedding variables with `@arki/env`. The result is a plain
 * record with the same variable names, so it can be passed straight to `resolveEmbeddingModel`.
 */
import { z } from 'zod';

import { defineEnv } from '@arki/env/core';
import { formatIssues } from '@arki/schema';

import type { EmbeddingModelRef, EnvSource } from '../types.js';
import { ConfigurationFailure } from '../failures.js';
import { isModelRef } from '../ref.js';

/**
 * Reads and checks `EMBEDDING_MODEL`, `OLLAMA_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
 * `VOYAGE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `COHERE_API_KEY`, `MISTRAL_API_KEY`, `JINA_API_KEY` and
 * `OPENAI_COMPATIBLE_{BASE_URL,API_KEY,DIMENSIONS}` from `env`. A bad value is `ConfigurationFailure`.
 *
 * `OLLAMA_BASE_URL` has no default here: its presence is what picks Ollama in the provider order.
 * The default `http://127.0.0.1:11434` is applied by `createOllamaModel`.
 *
 * @example
 * const env = resolveEmbeddingConfig(process.env); // the record, or ConfigurationFailure
 */
export function resolveEmbeddingConfig(env: EnvSource) {
  let problem: string | undefined;
  const parsed = defineEnv({
    name: '@arki/embeddings',
    server: {
      EMBEDDING_MODEL: z.custom<EmbeddingModelRef>(isModelRef, 'expected provider:model, e.g. ollama:qwen3-embedding:0.6b').optional(),
      OLLAMA_BASE_URL: z.url().optional(),
      OPENAI_API_KEY: z.string().min(1).optional(),
      OPENAI_BASE_URL: z.url().optional(),
      VOYAGE_API_KEY: z.string().min(1).optional(),
      GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
      COHERE_API_KEY: z.string().min(1).optional(),
      MISTRAL_API_KEY: z.string().min(1).optional(),
      JINA_API_KEY: z.string().min(1).optional(),
      OPENAI_COMPATIBLE_BASE_URL: z.url().optional(),
      OPENAI_COMPATIBLE_API_KEY: z.string().min(1).optional(),
      // Kept as text: the record goes straight to `resolveEmbeddingModel`, which reads strings.
      OPENAI_COMPATIBLE_DIMENSIONS: z.string().regex(/^[1-9]\d*$/, 'expected a positive integer').optional(),
    },
    runtimeEnv: { ...env },
    options: {
      skipValidation: false,
      // `defineEnv` requires this handler to throw; the throw stops at the catch below and the
      // caller receives a failure value.
      onValidationError: issues => {
        problem = formatIssues(issues);
        throw new Error(problem);
      },
    },
  });
  try {
    return {
      EMBEDDING_MODEL: parsed.EMBEDDING_MODEL,
      OLLAMA_BASE_URL: parsed.OLLAMA_BASE_URL,
      OPENAI_API_KEY: parsed.OPENAI_API_KEY,
      OPENAI_BASE_URL: parsed.OPENAI_BASE_URL,
      VOYAGE_API_KEY: parsed.VOYAGE_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: parsed.GOOGLE_GENERATIVE_AI_API_KEY,
      COHERE_API_KEY: parsed.COHERE_API_KEY,
      MISTRAL_API_KEY: parsed.MISTRAL_API_KEY,
      JINA_API_KEY: parsed.JINA_API_KEY,
      OPENAI_COMPATIBLE_BASE_URL: parsed.OPENAI_COMPATIBLE_BASE_URL,
      OPENAI_COMPATIBLE_API_KEY: parsed.OPENAI_COMPATIBLE_API_KEY,
      OPENAI_COMPATIBLE_DIMENSIONS: parsed.OPENAI_COMPATIBLE_DIMENSIONS,
    };
  } catch (error) {
    return ConfigurationFailure({ message: problem ?? (error instanceof Error ? error.message : String(error)) });
  }
}
