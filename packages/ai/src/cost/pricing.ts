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

import type { LLMProviderName } from '../ai-service/provider-names';
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
  'claude-sonnet-5-5': {
    inputPer1k: 0.002,
    outputPer1k: 0.01,
  },
  'claude-haiku-5-5': {
    inputPer1k: 0.0001,
    outputPer1k: 0.0005,
  },
  'claude-opus-5-5': {
    inputPer1k: 0.004,
    outputPer1k: 0.02,
  },
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
 * Providers whose models run on your own machine: a call costs nothing per token.
 */
export const LOCAL_PROVIDERS = ['ollama'] as const satisfies readonly LLMProviderName[];

/**
 * How a price was worked out: `local` (the model runs on your machine, so 0), `list-price` (the
 * model is in `LLM_PRICING`) or `default-rate` (an unknown hosted model, priced at
 * `DEFAULT_PRICING` so it is never undercharged).
 */
export const PRICE_BASES = ['local', 'list-price', 'default-rate'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];

/** The cost of one call in USD, and how it was worked out. */
export type Price = { readonly usd: number; readonly basis: PriceBasis };

/** The tokens of one call, and the provider and model that served it. */
export type PricedCall = {
  /**
   * The provider: `ollama`, `openai`, ... An AI SDK provider id such as `ollama.chat` counts as
   * its first segment. Omit it and a model is priced as hosted.
   */
  readonly provider?: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

/** Does `provider` run its models locally? `ollama` and AI SDK ids such as `ollama.chat` do. */
export function isLocalProvider(provider: string): boolean {
  return localProviderNames.has(provider.split('.', 1)[0] ?? provider);
}

const localProviderNames: ReadonlySet<string> = new Set(LOCAL_PROVIDERS);

/**
 * Price one call and say how the price was worked out. A local provider costs 0 (`local`). A
 * hosted model uses its list price (`list-price`), or `DEFAULT_PRICING` when it is unknown
 * (`default-rate`), so a dashboard can tell a real price from a guess.
 *
 * @example
 * ```ts
 * priceOf({ provider: 'ollama', model: 'gemma4:latest', inputTokens: 100, outputTokens: 100 });
 * // { usd: 0, basis: 'local' }
 * priceOf({ model: 'gpt-4o', inputTokens: 1000, outputTokens: 500 });
 * // { usd: 0.0075, basis: 'list-price' }
 * ```
 */
export function priceOf(call: PricedCall): Price {
  if (call.provider !== undefined && isLocalProvider(call.provider)) return { usd: 0, basis: 'local' };
  const pricing = getModelPricing(call.model);
  const usd = (call.inputTokens / 1000) * pricing.inputPer1k + (call.outputTokens / 1000) * pricing.outputPer1k;
  return { usd, basis: hasKnownPricing(call.model) ? 'list-price' : 'default-rate' };
}

/**
 * Calculate LLM cost from token counts. Pass the provider to price a local model at 0;
 * `priceOf` also says how the price was worked out.
 *
 * @param model - Model identifier
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param options - `provider`: the provider that served the call (`ollama` costs 0)
 * @returns Cost in USD
 *
 * @example
 * ```ts
 * calculateLLMCost('gpt-4o', 1000, 500); // 0.0075
 * calculateLLMCost('gemma4:latest', 100, 100, { provider: 'ollama' }); // 0
 * ```
 */
export function calculateLLMCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  options: { readonly provider?: string } = {},
): number {
  return priceOf({ ...options, model, inputTokens, outputTokens }).usd;
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
