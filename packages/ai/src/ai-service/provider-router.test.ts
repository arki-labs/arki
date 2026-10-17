import { describe, expect, it } from 'vitest';

import { RateLimited } from '../failures';
import { createProviderRouter } from './provider-router';

describe('ProviderRouter', () => {
  it('registers openai and anthropic providers when api keys are provided in config', () => {
    const router = createProviderRouter({
      providers: [
        { name: 'openai', model: 'gpt-4o-mini', apiKey: 'openai-test-key', weight: 2 },
        { name: 'anthropic', model: 'claude-3-haiku-20240307', apiKey: 'anthropic-test-key', weight: 1 },
      ],
    });

    expect(router.getAvailableProviders()).toEqual(expect.arrayContaining(['openai', 'anthropic']));
  });

  it('supports api key overrides for providers that usually read from env', () => {
    const router = createProviderRouter({
      providers: [
        { name: 'google', model: 'gemini-2.0-flash', apiKey: 'google-test-key', weight: 1 },
      ],
    });

    expect(router.getAvailableProviders()).toEqual(['google']);
  });

  it('applies weighted rotation in toLanguageModel', () => {
    const router = createProviderRouter({
      providers: [
        { name: 'openai', model: 'gpt-4o-mini', apiKey: 'openai-test-key', weight: 3 },
        { name: 'anthropic', model: 'claude-3-haiku-20240307', apiKey: 'anthropic-test-key', weight: 1 },
      ],
    });

    const counts: Record<string, number> = {
      anthropic: 0,
      openai: 0,
    };

    for (let index = 0; index < 12; index += 1) {
      const { providerName } = router.toLanguageModel();
      counts[providerName] = (counts[providerName] ?? 0) + 1;
    }

    expect(counts['openai']).toBe(9);
    expect(counts['anthropic']).toBe(3);
  });

  it('routes away from unhealthy providers', () => {
    const router = createProviderRouter({
      maxConsecutiveFailures: 1,
      providers: [
        { name: 'openai', model: 'gpt-4o-mini', apiKey: 'openai-test-key', weight: 1 },
        { name: 'anthropic', model: 'claude-3-haiku-20240307', apiKey: 'anthropic-test-key', weight: 1 },
      ],
    });

    router.reportFailure('openai', new Error('simulated failure'));

    const { providerName } = router.toLanguageModel();

    expect(providerName).toBe('anthropic');
  });

  it('falls over to the next provider when one is rate limited, so a busy provider does not fail the call', async () => {
    const router = createProviderRouter({
      providers: [
        { name: 'openai', model: 'gpt-4o-mini', apiKey: 'openai-test-key', weight: 1 },
        { name: 'anthropic', model: 'claude-3-haiku-20240307', apiKey: 'anthropic-test-key', weight: 1 },
      ],
    });

    const result = await router.executeWithFallback(provider =>
      Promise.resolve(provider.name === 'openai' ? RateLimited({ retryAfterMs: 1000 }) : 'answer'),
    );

    expect(result).toMatchObject({ data: 'answer', provider: 'anthropic' });
  });

  it('returns the RateLimited with the shortest wait when every provider is rate limited', async () => {
    const router = createProviderRouter({
      providers: [
        { name: 'openai', model: 'gpt-4o-mini', apiKey: 'openai-test-key', weight: 1 },
        { name: 'anthropic', model: 'claude-3-haiku-20240307', apiKey: 'anthropic-test-key', weight: 1 },
      ],
    });

    const result = await router.executeWithFallback(provider =>
      Promise.resolve(RateLimited({ retryAfterMs: provider.name === 'openai' ? 5000 : 2000 })),
    );

    expect(RateLimited.is(result) && result.data.retryAfterMs).toBe(2000);
  });
});
