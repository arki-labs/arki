/**
 * Pricing: a local model is free, and a price says whether it is a list price or a guess, so a
 * cost dashboard neither bills local runs nor passes a default rate off as a real price.
 */
import { describe, expect, it } from 'vitest';

import { calculateLLMCost, DEFAULT_PRICING, priceOf } from './pricing';

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
