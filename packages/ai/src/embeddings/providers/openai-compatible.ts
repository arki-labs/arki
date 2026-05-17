/**
 * OpenAI-compatible embedding provider.
 *
 * Single class for every runtime that exposes the OpenAI `/v1/embeddings`
 * shape: Hugging Face TEI, vLLM ≥0.19, SGLang ≥0.5.10, Groq, Anyscale,
 * Together (when running OSS models), and any custom OpenAI-compat shim.
 *
 * Backed by `@ai-sdk/openai`'s `createOpenAI({ baseURL })` — no separate
 * adapter needed.
 *
 * For frontier OSS self-host (Qwen3-Embedding-8B, Stella-1.5B, BGE-M3),
 * spin TEI or vLLM with the model, then point this provider at
 * `http://your-host:8080/v1` and choose the right `model` and `dimensions`.
 */

import { createOpenAI } from '@ai-sdk/openai';

import { AiSdkEmbeddingProvider } from './ai-sdk';
import type { BaseEmbeddingConfig } from '../base';

export type OpenAICompatibleEmbeddingConfig = BaseEmbeddingConfig & {
  /** Required: e.g. `http://tei.internal:8080/v1`. */
  baseURL: string;
  /** Model id as the runtime expects it (`Qwen/Qwen3-Embedding-8B`, etc.). */
  model: string;
  /** Reported embedding dimension. Must match the model. */
  dimensions: number;
  /** API key — many self-host runtimes accept any string; supply `'unused'` if none. */
  apiKey?: string;
  /** Optional name override for the underlying provider ('tei', 'vllm', etc.) */
  label?: string;
};

export class OpenAICompatibleEmbeddingProvider extends AiSdkEmbeddingProvider {
  constructor(config: OpenAICompatibleEmbeddingConfig) {
    const openai = createOpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey ?? 'unused',
    });
    super({
      ...config,
      label: config.label ?? 'openai-compatible',
      model: openai.textEmbeddingModel(config.model),
      dimensions: config.dimensions,
    });
  }
}
