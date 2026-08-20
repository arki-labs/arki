/**
 * AI Model Pricing
 *
 * Current pricing for LLM and embedding models.
 * Prices are in USD per 1,000 tokens.
 *
 * @module cost/pricing
 *
 * Last updated: 2025-01
 *
 * @example
 * ```typescript
 * import { LLM_PRICING, getModelPricing, calculateLLMCost } from '@arki/ai/cost';
 *
 * // Get pricing for a model
 * const pricing = getModelPricing('claude-sonnet-4-20250514');
 *
 * // Calculate cost
 * const cost = calculateLLMCost('gpt-4o', 1000, 500);
 * ```
 */

import type { ModelPricing } from './types';

// ============================================
// LLM Model Pricing
// ============================================

/**
 * Current pricing for LLM models.
 * Prices are in USD per 1,000 tokens.
 */
export const LLM_PRICING: Record<string, ModelPricing> = {
  // ----------------------------------------
  // Anthropic Models
  // ----------------------------------------
  'claude-sonnet-4-20250514': {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
  },
  'claude-3-5-sonnet-latest': {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
  },
  'claude-3-5-sonnet-20241022': {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
  },
  'claude-3-opus-20240229': {
    inputPer1k: 0.015,
    outputPer1k: 0.075,
  },
  'claude-3-haiku-20240307': {
    inputPer1k: 0.000_25,
    outputPer1k: 0.001_25,
  },
  'claude-3-5-haiku-latest': {
    inputPer1k: 0.0008,
    outputPer1k: 0.004,
  },

  // ----------------------------------------
  // OpenAI Models
  // ----------------------------------------
  'gpt-4o': {
    inputPer1k: 0.0025,
    outputPer1k: 0.01,
  },
  'gpt-4o-2024-11-20': {
    inputPer1k: 0.0025,
    outputPer1k: 0.01,
  },
  'gpt-4o-mini': {
    inputPer1k: 0.000_15,
    outputPer1k: 0.0006,
  },
  'gpt-4o-mini-2024-07-18': {
    inputPer1k: 0.000_15,
    outputPer1k: 0.0006,
  },
  'gpt-4-turbo': {
    inputPer1k: 0.01,
    outputPer1k: 0.03,
  },
  'gpt-4-turbo-preview': {
    inputPer1k: 0.01,
    outputPer1k: 0.03,
  },
  'gpt-4': {
    inputPer1k: 0.03,
    outputPer1k: 0.06,
  },
  'gpt-3.5-turbo': {
    inputPer1k: 0.0005,
    outputPer1k: 0.0015,
  },
  o1: {
    inputPer1k: 0.015,
    outputPer1k: 0.06,
  },
  'o1-mini': {
    inputPer1k: 0.003,
    outputPer1k: 0.012,
  },
  'o1-preview': {
    inputPer1k: 0.015,
    outputPer1k: 0.06,
  },

  // ----------------------------------------
  // Google Models
  // ----------------------------------------
  'gemini-1.5-pro': {
    inputPer1k: 0.001_25,
    outputPer1k: 0.005,
  },
  'gemini-1.5-flash': {
    inputPer1k: 0.000_075,
    outputPer1k: 0.0003,
  },
  'gemini-2.0-flash': {
    inputPer1k: 0.0001,
    outputPer1k: 0.0004,
  },
  'gemini-pro': {
    inputPer1k: 0.0005,
    outputPer1k: 0.0015,
  },

  // ----------------------------------------
  // Mistral Models
  // ----------------------------------------
  'mistral-large-latest': {
    inputPer1k: 0.002,
    outputPer1k: 0.006,
  },
  'mistral-medium-latest': {
    inputPer1k: 0.002_75,
    outputPer1k: 0.0081,
  },
  'mistral-small-latest': {
    inputPer1k: 0.0002,
    outputPer1k: 0.0006,
  },
  'codestral-latest': {
    inputPer1k: 0.0003,
    outputPer1k: 0.0009,
  },

  // ----------------------------------------
  // Groq Models (hosted)
  // ----------------------------------------
  'llama-3.3-70b-versatile': {
    inputPer1k: 0.000_59,
    outputPer1k: 0.000_79,
  },
  'llama-3.1-8b-instant': {
    inputPer1k: 0.000_05,
    outputPer1k: 0.000_08,
  },
  'openai/gpt-oss-20b': {
    inputPer1k: 0.000_075,
    outputPer1k: 0.000_3,
  },
  'mixtral-8x7b-32768': {
    inputPer1k: 0.000_24,
    outputPer1k: 0.000_24,
  },

  // ----------------------------------------
  // Embedding Models
  // ----------------------------------------
  'text-embedding-3-small': {
    inputPer1k: 0.000_02,
    outputPer1k: 0,
  },
  'text-embedding-3-large': {
    inputPer1k: 0.000_13,
    outputPer1k: 0,
  },
  'text-embedding-ada-002': {
    inputPer1k: 0.0001,
    outputPer1k: 0,
  },
} as const;

// ============================================
// Pricing Utilities
// ============================================

/**
 * Default pricing for unknown models.
 * Uses conservative estimates to prevent undercharging.
 */
export const DEFAULT_PRICING: ModelPricing = {
  inputPer1k: 0.01,
  outputPer1k: 0.03,
};

/**
 * Get pricing for a model.
 *
 * @param model - Model identifier
 * @returns Model pricing or default if unknown
 */
export function getModelPricing(model: string): ModelPricing {
  return LLM_PRICING[model] ?? DEFAULT_PRICING;
}

/**
 * Check if a model has known pricing.
 *
 * @param model - Model identifier
 * @returns True if pricing is known
 */
export function hasKnownPricing(model: string): boolean {
  return model in LLM_PRICING;
}

/**
 * Calculate LLM cost from token counts.
 *
 * @param model - Model identifier
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @returns Cost in USD
 */
export function calculateLLMCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = getModelPricing(model);
  const inputCost = (inputTokens / 1000) * pricing.inputPer1k;
  const outputCost = (outputTokens / 1000) * pricing.outputPer1k;
  return inputCost + outputCost;
}

/**
 * Estimate tokens from text.
 *
 * Uses a simple heuristic of ~4 characters per token for English text.
 * For more accurate counts, use a proper tokenizer.
 *
 * @param text - Text to estimate
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens from word count.
 *
 * Uses ~1.3 tokens per word for English text.
 *
 * @param wordCount - Number of words
 * @returns Estimated token count
 */
export function estimateTokensFromWords(wordCount: number): number {
  return Math.ceil(wordCount * 1.3);
}

/**
 * Get all supported models.
 *
 * @returns Array of model identifiers
 */
export function getSupportedModels(): string[] {
  return Object.keys(LLM_PRICING);
}

/**
 * Get models by provider.
 *
 * @param provider - Provider name prefix
 * @returns Array of model identifiers
 */
export function getModelsByProvider(
  provider: 'claude' | 'gpt' | 'gemini' | 'mistral' | 'llama' | 'text-embedding',
): string[] {
  return Object.keys(LLM_PRICING).filter(model => model.startsWith(provider));
}
