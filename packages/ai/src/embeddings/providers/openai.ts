/**
 * OpenAI Embedding Provider
 * Production-ready implementation with batching, caching, and error handling
 */

import type { EmbeddingProvider } from '../../types';
import { debugEmbeddings } from '../../debug.ts';
import { env } from '../../env';
import { EmbeddingError, getErrorMessage } from '../../errors';
import { openaiEmbeddingConfigSchema, validateInput } from '../../validation';

export type OpenAIEmbeddingConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
  batchSize?: number;
  cacheEnabled?: boolean;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  private apiKey: string | undefined;
  private baseUrl: string;
  private dimensions: number;
  private batchSize: number;
  private cache = new Map<string, number[]>();
  private cacheEnabled: boolean;
  private batchQueue: {
    text: string;
    resolve: (value: number[]) => void;
    reject: (error: Error) => void;
  }[] = [];
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(config: OpenAIEmbeddingConfig = {}) {
    const validConfig = validateInput(openaiEmbeddingConfigSchema, config);
    this.apiKey = validConfig.apiKey || env.OPENAI_API_KEY;
    this.model = validConfig.model || env.OPENAI_EMBEDDING_MODEL;
    this.baseUrl = validConfig.baseUrl || 'https://api.openai.com/v1';
    this.dimensions = validConfig.dimensions || (this.model === 'text-embedding-3-small' ? 1536 : 3072);
    this.batchSize = validConfig.batchSize || 100;
    this.cacheEnabled = validConfig.cacheEnabled !== false;

    if (!this.apiKey) {
      debugEmbeddings('[OpenAI] API key not provided');
      throw new EmbeddingError('OpenAI API key not provided. Set OPENAI_API_KEY environment variable or pass it in config.');
    }

    debugEmbeddings(
      '[OpenAI] Provider initialized (model: %s, dimensions: %d, batchSize: %d, cacheEnabled: %s)',
      this.model,
      this.dimensions,
      this.batchSize,
      this.cacheEnabled,
    );
  }

  async getEmbedding(text: string): Promise<number[]> {
    // Check cache first
    if (this.cacheEnabled) {
      const cached = this.cache.get(text);
      if (cached) {
        debugEmbeddings('[OpenAI] Cache hit for embedding (length: %d)', text.length);
        return cached;
      }
    }

    debugEmbeddings('[OpenAI] Cache miss, queuing for batch processing (text length: %d)', text.length);

    // Normalize text
    const normalizedText = this.normalizeText(text);

    // For single embeddings, use batch processing with delay for efficiency
    return new Promise((resolve, reject) => {
      this.batchQueue.push({ text: normalizedText, resolve, reject });
      debugEmbeddings('[OpenAI] Added to batch queue (queue size: %d)', this.batchQueue.length);
      this.scheduleBatchProcessing();
    });
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    debugEmbeddings('[OpenAI] Getting embeddings for %d texts', texts.length);

    // Process multiple texts in a single API call
    const normalizedTexts = texts.map((t) => this.normalizeText(t));

    // Check cache and identify missing embeddings
    const results: (number[] | null)[] = this.cacheEnabled
      ? normalizedTexts.map((text) => this.cache.get(text) || null)
      : Array.from({length: texts.length}).fill(null);

    const missingIndices: number[] = [];
    const missingTexts: string[] = [];

    for (const [i, result] of results.entries()) {
      if (!result) {
        missingIndices.push(i);
        missingTexts.push(normalizedTexts[i]!);
      }
    }

    const cacheHits = texts.length - missingTexts.length;
    debugEmbeddings('[OpenAI] Cache hits: %d/%d, fetching: %d', cacheHits, texts.length, missingTexts.length);

    if (missingTexts.length > 0) {
      const embeddings = await this.fetchEmbeddings(missingTexts);

      debugEmbeddings('[OpenAI] Fetched %d embeddings, updating cache', embeddings.length);

      // Update cache and results
      for (const [i, index] of missingIndices.entries()) {
        const embedding = embeddings[i]!;
        const text = missingTexts[i]!;

        if (this.cacheEnabled) {
          this.cache.set(text, embedding);
        }

        results[index] = embedding;
      }
    }

    debugEmbeddings('[OpenAI] Returning %d embeddings', results.length);
    return results as number[][];
  }

  getDimensions(): number {
    return this.dimensions;
  }

  clearCache(): void {
    const oldSize = this.cache.size;
    this.cache.clear();
    debugEmbeddings('[OpenAI] Cache cleared (was %d entries)', oldSize);
  }

  getCacheSize(): number {
    const size = this.cache.size;
    debugEmbeddings('[OpenAI] Cache size queried: %d entries', size);
    return size;
  }

  private scheduleBatchProcessing(): void {
    if (this.batchTimer) return;

    this.batchTimer = setTimeout(() => {
      this.processBatch();
    }, 50); // 50ms delay to batch requests
  }

  private async processBatch(): Promise<void> {
    if (this.batchQueue.length === 0) {
      this.batchTimer = null;
      debugEmbeddings('[OpenAI] Batch processing skipped - queue is empty');
      return;
    }

    // Take up to batchSize items from the queue
    const batch = this.batchQueue.splice(0, this.batchSize);
    this.batchTimer = null;

    debugEmbeddings('[OpenAI] Processing batch of %d items (remaining queue: %d)', batch.length, this.batchQueue.length);

    try {
      const texts = batch.map((item) => item.text);
      const embeddings = await this.fetchEmbeddings(texts);

      debugEmbeddings('[OpenAI] Batch processed successfully, resolving %d promises', batch.length);

      // Resolve promises and update cache
      for (const [i, item] of batch.entries()) {
        const embedding = embeddings[i]!;

        if (this.cacheEnabled) {
          this.cache.set(item.text, embedding);
        }

        item.resolve(embedding);
      }
    } catch (error) {
      debugEmbeddings('[OpenAI] Batch processing failed: %s', error instanceof Error ? error.message : 'Unknown error');
      // Reject all promises in the batch
      const err = error instanceof Error ? error : new Error('Failed to fetch embeddings');
      for (const item of batch) item.reject(err);
    }

    // Process remaining items if any
    if (this.batchQueue.length > 0) {
      debugEmbeddings('[OpenAI] Scheduling next batch (%d items remaining)', this.batchQueue.length);
      this.scheduleBatchProcessing();
    }
  }

  private async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      debugEmbeddings('[OpenAI] API key missing');
      throw new Error('OpenAI API key is required for embeddings');
    }

    const maxRetries = 3;
    const baseDelay = 1000;

    debugEmbeddings('[OpenAI] Fetching embeddings for %d texts (model: %s, dimensions: %d)', texts.length, this.model, this.dimensions);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        debugEmbeddings('[OpenAI] API call attempt %d/%d', attempt + 1, maxRetries);

        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: texts,
            encoding_format: 'float',
            dimensions: this.dimensions,
          }),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: { message: response.statusText } }));

          debugEmbeddings('[OpenAI] API error (status: %d): %s', response.status, (error as {error?: {message?: string}})['error']?.message || response.statusText);

          // Handle rate limiting
          if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            const delay = retryAfter ? Number.parseInt(retryAfter) * 1000 : baseDelay * Math.pow(2, attempt);

            debugEmbeddings('[OpenAI] Rate limited, waiting %dms before retry', delay);

            if (attempt < maxRetries - 1) {
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
          }

          throw new EmbeddingError(`OpenAI API error: ${(error as {error?: {message?: string}})['error']?.message || response.statusText}`);
        }

        const data = await response.json() as { data: { embedding: number[] }[] };
        debugEmbeddings('[OpenAI] Successfully fetched %d embeddings', data.data.length);
        return data.data.map((item) => item['embedding']);
      } catch (error) {
        if (attempt === maxRetries - 1) {
          debugEmbeddings('[OpenAI] All retry attempts exhausted: %s', getErrorMessage(error));
          throw new EmbeddingError(
            `Failed to fetch OpenAI embeddings after ${maxRetries} attempts: ${getErrorMessage(error)}`,
            error
          );
        }

        const delay = baseDelay * Math.pow(2, attempt);
        debugEmbeddings('[OpenAI] Network error, retrying after %dms: %s', delay, getErrorMessage(error));
        // Exponential backoff for network errors
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    debugEmbeddings('[OpenAI] Failed to fetch embeddings after max retries');
    throw new EmbeddingError('Failed to fetch embeddings after max retries');
  }

  private normalizeText(text: string): string {
    // Normalize text for better embedding quality
    return text
      .trim()
      .replaceAll(/\s+/g, ' ') // Normalize whitespace
      .slice(0, 8000); // OpenAI token limit (roughly)
  }

  /**
   * Estimate token count (rough approximation)
   */
  private estimateTokens(text: string): number {
    // Rough estimation: 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
  }

  /**
   * Split text into chunks if too large
   */
  async getEmbeddingForLongText(text: string, maxTokens = 8000): Promise<number[]> {
    const estimatedTokens = this.estimateTokens(text);

    debugEmbeddings('[OpenAI] Processing long text (length: %d, estimated tokens: %d)', text.length, estimatedTokens);

    if (estimatedTokens <= maxTokens) {
      debugEmbeddings('[OpenAI] Text within token limit, processing directly');
      return this.getEmbedding(text);
    }

    // Split text into chunks and average embeddings
    const chunkSize = Math.floor((maxTokens * 4) * 0.9); // 90% to be safe
    const chunks: string[] = [];

    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }

    debugEmbeddings('[OpenAI] Text exceeds token limit, split into %d chunks', chunks.length);

    const embeddings = await this.getEmbeddings(chunks);

    debugEmbeddings('[OpenAI] Averaging %d chunk embeddings', embeddings.length);

    // Average the embeddings
    const avgEmbedding = new Array(this.dimensions).fill(0);

    for (const embedding of embeddings) {
      for (let i = 0; i < this.dimensions; i++) {
        avgEmbedding[i] += embedding[i]! / embeddings.length;
      }
    }

    // Normalize the averaged embedding
    const magnitude = Math.sqrt(avgEmbedding.reduce((sum, val) => sum + val * val, 0));
    const normalized = avgEmbedding.map(val => val / (magnitude || 1));

    debugEmbeddings('[OpenAI] Long text embedding complete (magnitude: %f)', magnitude);

    return normalized;
  }
}