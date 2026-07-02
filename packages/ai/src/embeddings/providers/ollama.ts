/**
 * Ollama embedding provider (local-first).
 *
 * Backed by `ai-sdk-ollama`. Per workspace operating rule, Ollama is the
 * preferred default in the resilient provider chain (`ollama → openai → anthropic`).
 *
 * Default model: `qwen3-embedding:0.6b` — the smallest Qwen3-Embedding
 * variant (Apache 2.0, 1024-d, 32K ctx). Fits in ~1.2 GB VRAM fp16 /
 * ~600 MB int8, marginal on CPU. MTEB-Eng ~65 / MMTEB ~64.
 *
 * Trade up to a bigger Qwen3 variant when hardware allows:
 *   - `qwen3-embedding:4b`  — 4B, 2560-d MRL, ~$8 GB VRAM fp16, MTEB ~68 / MMTEB ~69
 *   - `qwen3-embedding:8b`  — 8B, 4096-d MRL, ~16 GB VRAM fp16, MMTEB 70.58 / MTEB-Code 80.68 (leader)
 *
 * Alternative Ollama tags that make sense as drop-ins:
 *   - `nomic-embed-text`           — 137M, 768-d (very small, ~62 MTEB-Eng)
 *   - `snowflake-arctic-embed2`    — 305M / 568M, multilingual, Apache 2.0
 *   - `mxbai-embed-large`          — 335M, English, Apache 2.0
 *   - `bge-m3`                     — 568M, 100+ langs, MIT
 */

import { createOllama } from 'ai-sdk-ollama';

import { AiSdkEmbeddingProvider } from './ai-sdk';
import type { BaseEmbeddingConfig } from '../base';
import { EmbeddingError } from '../../errors';

export type OllamaEmbeddingConfig = BaseEmbeddingConfig & {
  /** Ollama server URL. Defaults to `http://127.0.0.1:11434`. */
  baseURL?: string;
  /** Ollama model tag. */
  model?: string;
  /** Reported dimensions. Must match the chosen model. */
  dimensions?: number;
};

const DEFAULT_MODEL = 'qwen3-embedding:0.6b';
const DEFAULT_DIMS = 1024;

export class OllamaEmbeddingProvider extends AiSdkEmbeddingProvider {
  private readonly ollamaBaseURL: string;
  private readonly ollamaModel: string;

  constructor(config: OllamaEmbeddingConfig = {}) {
    // `ai-sdk-ollama` appends the `/api/<route>` segment itself (e.g. `${baseURL}/api/embed`), so
    // the base must be the bare host — NOT `.../api` (that yields `/api/api/embed` → 404). Matches
    // every other Ollama call site in the workspace and this type's own documented default.
    const baseURL = config.baseURL ?? 'http://127.0.0.1:11434';
    const model = config.model ?? DEFAULT_MODEL;
    const ollama = createOllama({ baseURL });
    super({
      ...config,
      label: 'ollama',
      model: ollama.embedding(model),
      dimensions: config.dimensions ?? DEFAULT_DIMS,
    });
    this.ollamaBaseURL = baseURL;
    this.ollamaModel = model;
  }

  /**
   * Override the AI SDK path with Ollama's NATIVE batch endpoint.
   *
   * `ai-sdk-ollama`'s `embedMany` advertises `maxEmbeddingsPerCall = 1`, so a 100-text chunk fans
   * out into 100 sequential single-embed requests, each re-entering the model scheduler. Ollama's
   * `/api/embed` accepts `input: string[]` and embeds the whole array in one forward pass. Measured
   * on `qwen3-embedding:4b`: 100 texts in ~3s native vs >120s via the fan-out (~40×). Batch indexing
   * (the reindex cron / bulk seed) is unusable without this. Single-embed calls keep the SDK path
   * (the base coalesces them through this same method, but 1-item chunks are cheap either way).
   */
  protected override async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    let res: Response;
    try {
      res = await fetch(`${this.ollamaBaseURL}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.ollamaModel, input: texts }),
      });
    } catch (error) {
      throw new EmbeddingError(`[ollama] /api/embed request failed`, error);
    }
    if (!res.ok) {
      throw new EmbeddingError(`[ollama] /api/embed returned ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new EmbeddingError(
        `[ollama] /api/embed returned ${data.embeddings?.length ?? 0} embeddings for ${texts.length} inputs`,
      );
    }
    return data.embeddings;
  }
}
