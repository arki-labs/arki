/**
 * BaseEmbeddingProvider — shared logic for all concrete providers.
 *
 * Subclasses only need to implement `fetchEmbeddings(texts)` and `getDimensions()`.
 * Shared logic: in-memory caching, request batching with a 50ms coalescing window,
 * text normalization, and a uniform `getEmbedding` / `getEmbeddings` interface.
 *
 * This factoring eliminates ~80 LOC per provider that would otherwise be duplicated.
 */

import type { EmbeddingProvider } from '../types';
import { debugEmbeddings } from '../debug.ts';

export type BaseEmbeddingConfig = {
  /** Per-batch upper bound when flushing the queue. Provider-specific defaults apply. */
  batchSize?: number;
  /** In-memory deterministic cache keyed by normalized text. Default: true. */
  cacheEnabled?: boolean;
  /** Hard cap on input text length before slicing. Default: 8000 chars. */
  maxInputChars?: number;
};

type QueueItem = {
  text: string;
  resolve: (value: number[]) => void;
  reject: (error: Error) => void;
};

export abstract class BaseEmbeddingProvider implements EmbeddingProvider {
  protected readonly batchSize: number;
  protected readonly cacheEnabled: boolean;
  protected readonly maxInputChars: number;
  private readonly cache = new Map<string, number[]>();
  private readonly batchQueue: QueueItem[] = [];
  private batchTimer: NodeJS.Timeout | null = null;

  /** Logger label injected by subclass for clearer debug output. */
  protected abstract readonly providerLabel: string;

  constructor(config: BaseEmbeddingConfig = {}) {
    this.batchSize = config.batchSize ?? 100;
    this.cacheEnabled = config.cacheEnabled !== false;
    this.maxInputChars = config.maxInputChars ?? 8000;
  }

  /** Provider-specific: fetch embeddings from the underlying API/runtime. */
  protected abstract fetchEmbeddings(texts: string[]): Promise<number[][]>;

  /** Provider-specific: report the dimensionality of returned embeddings. */
  abstract getDimensions(): number;

  async getEmbedding(text: string): Promise<number[]> {
    const normalized = this.normalizeText(text);

    if (this.cacheEnabled) {
      const cached = this.cache.get(normalized);
      if (cached) {
        debugEmbeddings.debug('[{providerLabel}] cache hit (text length: {length})', {
          providerLabel: this.providerLabel,
          length: text.length,
        });
        return cached;
      }
    }

    return new Promise<number[]>((resolve, reject) => {
      this.batchQueue.push({ text: normalized, resolve, reject });
      debugEmbeddings.debug('[{providerLabel}] queued (queue size: {size})', {
        providerLabel: this.providerLabel,
        size: this.batchQueue.length,
      });
      this.scheduleBatchFlush();
    });
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    const normalized = texts.map(t => this.normalizeText(t));
    const results: (number[] | null)[] = this.cacheEnabled
      ? normalized.map(t => this.cache.get(t) ?? null)
      : Array.from<number[] | null>({ length: texts.length }).fill(null);

    const missingIndices: number[] = [];
    const missingTexts: string[] = [];
    for (const [i, hit] of results.entries()) {
      if (!hit) {
        missingIndices.push(i);
        missingTexts.push(normalized[i]!);
      }
    }

    debugEmbeddings.debug('[{providerLabel}] batch: {batch} total, {value3} cached, {missingTextsLength} to fetch', {
      providerLabel: this.providerLabel,
      batch: texts.length,
      value3: texts.length - missingTexts.length,
      missingTextsLength: missingTexts.length,
    });

    if (missingTexts.length === 0) return results as number[][];

    // Honour provider batch size by chunking the outgoing request.
    for (let offset = 0; offset < missingTexts.length; offset += this.batchSize) {
      const chunk = missingTexts.slice(offset, offset + this.batchSize);
      const chunkIndices = missingIndices.slice(offset, offset + this.batchSize);
      const embeddings = await this.fetchEmbeddings(chunk);

      for (const [i, idx] of chunkIndices.entries()) {
        const emb = embeddings[i]!;
        if (this.cacheEnabled) this.cache.set(chunk[i]!, emb);
        results[idx] = emb;
      }
    }

    return results as number[][];
  }

  clearCache(): void {
    const oldSize = this.cache.size;
    this.cache.clear();
    debugEmbeddings.debug('[{providerLabel}] cache cleared (was {oldSize} entries)', {
      providerLabel: this.providerLabel,
      oldSize,
    });
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  protected normalizeText(text: string): string {
    return text.trim().replaceAll(/\s+/g, ' ').slice(0, this.maxInputChars);
  }

  private scheduleBatchFlush(): void {
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      void this.flushBatch();
    }, 50);
  }

  private async flushBatch(): Promise<void> {
    this.batchTimer = null;
    if (this.batchQueue.length === 0) return;

    const batch = this.batchQueue.splice(0, this.batchSize);
    debugEmbeddings.debug('[{providerLabel}] flushing batch (size: {size}, remaining queue: {queue})', {
      providerLabel: this.providerLabel,
      size: batch.length,
      queue: this.batchQueue.length,
    });

    try {
      const embeddings = await this.fetchEmbeddings(batch.map(item => item.text));
      for (const [i, item] of batch.entries()) {
        const emb = embeddings[i]!;
        if (this.cacheEnabled) this.cache.set(item.text, emb);
        item.resolve(emb);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      for (const item of batch) item.reject(err);
    }

    if (this.batchQueue.length > 0) this.scheduleBatchFlush();
  }
}
