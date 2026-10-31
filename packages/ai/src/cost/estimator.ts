/**
 * Cost Estimator
 *
 * Provides cost estimation utilities for LLM operations.
 * This is a general-purpose estimator that can be extended
 * for application-specific needs.
 *
 * @module cost/estimator
 */

import type { Price } from './pricing.js';
import type { CostEstimate, ModelPricing } from './types.js';
import {
  calculateLLMCost,
  estimateTokens,
  estimateTokensFromWords,
  getModelPricing,
  hasKnownPricing,
  priceOf,
} from './pricing.js';

// ============================================
// Cost Estimator Class
// ============================================

/**
 * General-purpose cost estimator for LLM operations.
 *
 * Provides methods to estimate costs before operations are performed,
 * helping with budget planning and cost control.
 *
 * @example
 * ```typescript
 * const estimator = new CostEstimator();
 *
 * // Estimate LLM cost
 * const cost = estimator.estimateLLMCost('gpt-4o-mini', 1000, 500);
 *
 * // Create detailed estimate
 * const estimate = estimator.createEstimate(
 *   'Generate summary',
 *   'gpt-4o-mini',
 *   1000,
 *   500
 * );
 * ```
 */
export class CostEstimator {
  constructor(_options?: { fallbackPricing?: ModelPricing }) {
    // Options reserved for future extensibility
  }

  // ============================================
  // LLM Cost Estimation
  // ============================================

  /**
   * Estimate cost for an LLM operation.
   *
   * @param model - Model identifier
   * @param inputTokens - Estimated input token count
   * @param outputTokens - Estimated output token count
   * @returns Cost in USD
   */
  estimateLLMCost(model: string, inputTokens: number, outputTokens: number): number {
    return calculateLLMCost(model, inputTokens, outputTokens);
  }

  /**
   * Estimate the price of an LLM operation and say how it was worked out, like `priceOf`:
   * `list-price` for a known model, `default-rate` for a guess on an unknown hosted model, `local`
   * for a provider that runs on your machine.
   *
   * @param model - Model identifier
   * @param inputTokens - Estimated input token count
   * @param outputTokens - Estimated output token count
   * @param options - `provider`: the provider that will serve the call (`ollama` costs 0)
   * @returns The price in USD and its basis
   */
  estimateLLMPrice(
    model: string,
    inputTokens: number,
    outputTokens: number,
    options: { readonly provider?: string } = {}
  ): Price {
    return priceOf({ ...options, model, inputTokens, outputTokens });
  }

  /**
   * Estimate tokens from text content.
   *
   * Uses a simple heuristic of ~4 characters per token.
   * For more accurate counts, use a proper tokenizer.
   *
   * @param text - Text to estimate
   * @returns Estimated token count
   */
  estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  /**
   * Estimate tokens from word count.
   *
   * Uses ~1.3 tokens per word for English text.
   *
   * @param wordCount - Number of words
   * @returns Estimated token count
   */
  estimateTokensFromWordCount(wordCount: number): number {
    return estimateTokensFromWords(wordCount);
  }

  /**
   * Get pricing info for a model.
   *
   * @param model - Model identifier
   * @returns Pricing info (uses fallback if unknown)
   */
  getModelPricing(model: string): ModelPricing {
    return getModelPricing(model);
  }

  /**
   * Check if a model has known pricing.
   *
   * @param model - Model identifier
   * @returns True if pricing is known
   */
  hasKnownPricing(model: string): boolean {
    return hasKnownPricing(model);
  }

  /**
   * Create a cost estimate object for an LLM operation.
   *
   * @param operation - Description of the operation
   * @param model - Model identifier
   * @param inputTokens - Estimated input tokens
   * @param outputTokens - Estimated output tokens
   * @returns Cost estimate object, with the price `basis` so a default-rate guess is never passed off as a list price
   */
  createEstimate(
    operation: string,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): CostEstimate {
    const price = this.estimateLLMPrice(model, inputTokens, outputTokens);
    return {
      operation,
      model,
      estimatedCostUsd: price.usd,
      basis: price.basis,
      tokenEstimate: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  }

  // ============================================
  // Embedding Cost Estimation
  // ============================================

  /**
   * Estimate cost for text embedding.
   *
   * @param text - Text to embed
   * @param model - Embedding model (defaults to text-embedding-3-small)
   * @returns Cost in USD
   */
  estimateEmbeddingCost(text: string, model = 'text-embedding-3-small'): number {
    const tokens = this.estimateTokens(text);
    return this.estimateLLMCost(model, tokens, 0);
  }

  /**
   * Estimate cost for embedding multiple texts.
   *
   * @param texts - Array of texts to embed
   * @param model - Embedding model
   * @returns Cost in USD
   */
  estimateBatchEmbeddingCost(
    texts: string[],
    model = 'text-embedding-3-small'
  ): number {
    const totalTokens = texts.reduce((sum, text) => sum + this.estimateTokens(text), 0);
    return this.estimateLLMCost(model, totalTokens, 0);
  }

  // ============================================
  // Batch Estimation
  // ============================================

  /**
   * Estimate total cost for multiple operations.
   *
   * @param estimates - Array of cost estimates
   * @returns Total cost in USD
   */
  sumEstimates(estimates: CostEstimate[]): number {
    return estimates.reduce((sum, est) => sum + est.estimatedCostUsd, 0);
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Create a new CostEstimator instance.
 *
 * @param options - Optional configuration
 * @returns Configured CostEstimator
 */
export function createCostEstimator(options?: {
  fallbackPricing?: ModelPricing;
}): CostEstimator {
  return new CostEstimator(options);
}

// ============================================
// Default Instance
// ============================================

/**
 * Default cost estimator instance for convenience.
 */
export const costEstimator = new CostEstimator();
