/**
 * OpenAI Embedding Provider
 * Production-ready implementation with batching, caching, and error handling
 */

import type { EmbeddingProvider } from '../../types';
import { env } from '../../env';
import { EmbeddingError, getErrorMessage } from '../../errors';
import { openaiEmbeddingConfigSchema, validateInput } from '../../validation';

export interface OpenAIEmbeddingConfig {
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
  private cache: Map<string, number[]> = new Map();
  private cacheEnabled: boolean;
  private batchQueue: Array<{
    text: string;
    resolve: (value: number[]) => void;
    reject: (error: Error) => void;
  }> = [];
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
      throw new EmbeddingError('OpenAI API key not provided. Set OPENAI_API_KEY environment variable or pass it in config.');
    }
  }

  async getEmbedding(text: string): Promise<number[]> {
    // Check cache first
    if (this.cacheEnabled) {
      const cached = this.cache.get(text);
      if (cached) return cached;
    }

    // Normalize text
    const normalizedText = this.normalizeText(text);

    // For single embeddings, use batch processing with delay for efficiency
    return new Promise((resolve, reject) => {
      this.batchQueue.push({ text: normalizedText, resolve, reject });
      this.scheduleBatchProcessing();
    });
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    // Process multiple texts in a single API call
    const normalizedTexts = texts.map((t) => this.normalizeText(t));

    // Check cache and identify missing embeddings
    const results: (number[] | null)[] = this.cacheEnabled
      ? normalizedTexts.map((text) => this.cache.get(text) || null)
      : new Array(texts.length).fill(null);

    const missingIndices: number[] = [];
    const missingTexts: string[] = [];

    results.forEach((result, i) => {
      if (!result) {
        missingIndices.push(i);
        missingTexts.push(normalizedTexts[i]!);
      }
    });

    if (missingTexts.length > 0) {
      const embeddings = await this.fetchEmbeddings(missingTexts);

      // Update cache and results
      missingIndices.forEach((index, i) => {
        const embedding = embeddings[i]!;
        const text = missingTexts[i]!;

        if (this.cacheEnabled) {
          this.cache.set(text, embedding);
        }

        results[index] = embedding;
      });
    }

    return results as number[][];
  }

  getDimensions(): number {
    return this.dimensions;
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
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
      return;
    }

    // Take up to batchSize items from the queue
    const batch = this.batchQueue.splice(0, this.batchSize);
    this.batchTimer = null;

    try {
      const texts = batch.map((item) => item.text);
      const embeddings = await this.fetchEmbeddings(texts);

      // Resolve promises and update cache
      batch.forEach((item, i) => {
        const embedding = embeddings[i]!;

        if (this.cacheEnabled) {
          this.cache.set(item.text, embedding);
        }

        item.resolve(embedding);
      });
    } catch (error) {
      // Reject all promises in the batch
      const err = error instanceof Error ? error : new Error('Failed to fetch embeddings');
      batch.forEach((item) => item.reject(err));
    }

    // Process remaining items if any
    if (this.batchQueue.length > 0) {
      this.scheduleBatchProcessing();
    }
  }

  private async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key is required for embeddings');
    }

    const maxRetries = 3;
    const baseDelay = 1000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
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

          // Handle rate limiting
          if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            const delay = retryAfter ? parseInt(retryAfter) * 1000 : baseDelay * Math.pow(2, attempt);

            if (attempt < maxRetries - 1) {
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
          }

          throw new EmbeddingError(`OpenAI API error: ${(error as {error?: {message?: string}})['error']?.message || response.statusText}`);
        }

        const data = await response.json() as { data: Array<{ embedding: number[] }> };
        return data.data.map((item) => item['embedding']);
      } catch (error) {
        if (attempt === maxRetries - 1) {
          throw new EmbeddingError(
            `Failed to fetch OpenAI embeddings after ${maxRetries} attempts: ${getErrorMessage(error)}`,
            error
          );
        }

        // Exponential backoff for network errors
        await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
      }
    }

    throw new EmbeddingError('Failed to fetch embeddings after max retries');
  }

  private normalizeText(text: string): string {
    // Normalize text for better embedding quality
    return text
      .trim()
      .replace(/\s+/g, ' ') // Normalize whitespace
      .substring(0, 8000); // OpenAI token limit (roughly)
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
  async getEmbeddingForLongText(text: string, maxTokens: number = 8000): Promise<number[]> {
    const estimatedTokens = this.estimateTokens(text);

    if (estimatedTokens <= maxTokens) {
      return this.getEmbedding(text);
    }

    // Split text into chunks and average embeddings
    const chunkSize = Math.floor((maxTokens * 4) * 0.9); // 90% to be safe
    const chunks: string[] = [];

    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }

    const embeddings = await this.getEmbeddings(chunks);

    // Average the embeddings
    const avgEmbedding = new Array(this.dimensions).fill(0);

    for (const embedding of embeddings) {
      for (let i = 0; i < this.dimensions; i++) {
        avgEmbedding[i] += embedding[i]! / embeddings.length;
      }
    }

    // Normalize the averaged embedding
    const magnitude = Math.sqrt(avgEmbedding.reduce((sum, val) => sum + val * val, 0));
    return avgEmbedding.map(val => val / (magnitude || 1));
  }
}