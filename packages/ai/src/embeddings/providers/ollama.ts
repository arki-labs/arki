/**
 * Ollama embedding provider (local-first).
 *
 * Backed by `ai-sdk-ollama`. Per workspace operating rule, Ollama is the
 * preferred default in the resilient provider chain (`ollama → openai → anthropic`).
 *
 * Default model: `nomic-embed-text` (137M, 768-d, Apache 2.0). For higher
 * quality local embeddings consider:
 *   - `snowflake-arctic-embed2`   — 305M / 568M, multilingual, Apache 2.0
 *   - `mxbai-embed-large`         — 335M, English, Apache 2.0
 *   - `bge-m3`                    — 568M, 100+ langs, MIT
 *   - `qwen3-embedding:4b` / `:8b` — Apache 2.0, MMTEB 70.58 leader
 */

import { createOllama } from 'ai-sdk-ollama';

import { AiSdkEmbeddingProvider } from './ai-sdk';
import type { BaseEmbeddingConfig } from '../base';

export type OllamaEmbeddingConfig = BaseEmbeddingConfig & {
  /** Ollama server URL. Defaults to `http://127.0.0.1:11434`. */
  baseURL?: string;
  /** Ollama model tag. */
  model?: string;
  /** Reported dimensions. Must match the chosen model. */
  dimensions?: number;
};

const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_DIMS = 768;

export class OllamaEmbeddingProvider extends AiSdkEmbeddingProvider {
  constructor(config: OllamaEmbeddingConfig = {}) {
    const ollama = createOllama({
      baseURL: config.baseURL ?? 'http://127.0.0.1:11434/api',
    });
    super({
      ...config,
      label: 'ollama',
      model: ollama.embedding(config.model ?? DEFAULT_MODEL),
      dimensions: config.dimensions ?? DEFAULT_DIMS,
    });
  }
}
