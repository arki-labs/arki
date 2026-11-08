/**
 * Pricing: a local model is free, and a price says whether it is a list price or a guess, so a
 * cost dashboard neither bills local runs nor passes a default rate off as a real price.
 */
import { describe, expect, it } from 'vitest';

import { CostEstimator, createCostEstimator } from './estimator';
import { calculateLLMCost, DEFAULT_PRICING, getModelPricing, hasKnownPricing, priceOf } from './pricing';

describe('priceOf', () => {
  it('prices a local provider at 0 with basis local (lib-gaps 24)', () => {
    // WHY: 200 tokens of `gemma4:latest` used to cost $0.004 at the default rate; a laptop model
    // has no per-token cost. AI SDK ids such as `ollama.chat` name the same provider.
    const call = { model: 'gemma4:latest', inputTokens: 100, outputTokens: 100 };

    expect(priceOf({ ...call, provider: 'ollama' })).toEqual({ usd: 0, basis: 'local' });
    expect(priceOf({ ...call, provider: 'ollama.chat' })).toEqual({ usd: 0, basis: 'local' });
  });

  it('uses the list price for a known hosted model', () => {
    // WHY: a known model must be billed at its real price.
    const price = priceOf({ provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500 });

    expect(price.basis).toBe('list-price');
    expect(price.usd).toBeCloseTo(0.0075, 10);
  });

  it('keeps the default rate for an unknown hosted model, and says it is a default', () => {
    // WHY: an unknown hosted model must never be priced at 0 (undercharging), but a reader must
    // be able to tell the guess from a list price.
    const price = priceOf({ provider: 'openai', model: 'brand-new-model', inputTokens: 1000, outputTokens: 1000 });

    expect(price).toEqual({ usd: DEFAULT_PRICING.inputPer1k + DEFAULT_PRICING.outputPer1k, basis: 'default-rate' });
  });
});

describe('calculateLLMCost', () => {
  it('keeps its old answer without a provider, and returns 0 for a local one', () => {
    // WHY: existing callers pass three arguments and must get the same number as before.
    expect(calculateLLMCost('gemma4:latest', 100, 100)).toBeCloseTo(0.004, 10);
    expect(calculateLLMCost('gemma4:latest', 100, 100, { provider: 'ollama' })).toBe(0);
  });
});

describe('pricing lookups use own keys only (F8)', () => {
  it('treats Object.prototype names as unknown models, priced at the default rate', () => {
    // WHY: `constructor` resolved to Object's constructor: hasKnownPricing said true and the cost was NaN.
    for (const model of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(hasKnownPricing(model)).toBe(false);
      expect(getModelPricing(model)).toEqual(DEFAULT_PRICING);
      expect(priceOf({ model, inputTokens: 1000, outputTokens: 1000 })).toEqual({
        usd: DEFAULT_PRICING.inputPer1k + DEFAULT_PRICING.outputPer1k,
        basis: 'default-rate',
      });
    }
  });
});

describe('CostEstimator says how a price was worked out (F8)', () => {
  it('createEstimate carries the basis, so a default-rate guess is not passed off as a list price', () => {
    const estimator = new CostEstimator();

    expect(estimator.createEstimate('summary', 'gpt-4o', 1000, 500).basis).toBe('list-price');
    expect(estimator.createEstimate('summary', 'brand-new-model', 1000, 500).basis).toBe('default-rate');
    expect(estimator.estimateLLMPrice('gemma4:latest', 100, 100, { provider: 'ollama' })).toEqual({
      usd: 0,
      basis: 'local',
    });
  });
});

describe('CostEstimator fallbackPricing (audit-2 noticed)', () => {
  // Why: the option was accepted and then ignored, so a team that set its own rate for unknown models was
  // still billed against DEFAULT_PRICING in every estimate and budget check.
  it('prices an unknown hosted model at fallbackPricing, still marked default-rate', () => {
    const estimator = createCostEstimator({ fallbackPricing: { inputPer1k: 0.002, outputPer1k: 0.004 } });

    expect(estimator.estimateLLMPrice('brand-new-model', 1000, 500)).toEqual({ usd: 0.004, basis: 'default-rate' });
    expect(estimator.estimateLLMCost('brand-new-model', 1000, 500)).toBe(0.004);
    expect(estimator.createEstimate('summary', 'brand-new-model', 1000, 500)).toMatchObject({
      estimatedCostUsd: 0.004,
      basis: 'default-rate',
    });
    expect(estimator.getModelPricing('brand-new-model')).toEqual({ inputPer1k: 0.002, outputPer1k: 0.004 });
  });

  it('leaves list prices and local providers alone, and uses DEFAULT_PRICING when unset', () => {
    const estimator = new CostEstimator({ fallbackPricing: { inputPer1k: 0.002, outputPer1k: 0.004 } });

    expect(estimator.estimateLLMPrice('gpt-4o', 1000, 500)).toEqual(
      priceOf({ model: 'gpt-4o', inputTokens: 1000, outputTokens: 500 }),
    );
    expect(estimator.estimateLLMPrice('gemma4:latest', 100, 100, { provider: 'ollama' })).toEqual({
      usd: 0,
      basis: 'local',
    });
    expect(new CostEstimator().getModelPricing('brand-new-model')).toEqual(DEFAULT_PRICING);
  });
});
