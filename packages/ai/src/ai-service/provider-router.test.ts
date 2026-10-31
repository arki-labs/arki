/**
 * The provider router. WHY it matters: fallback exists to ride out a provider OUTAGE. It must not
 * shop a refused prompt to the next provider, keep going after the caller cancelled, hide a bug as
 * "provider down", or restart a stream so the user reads the same text twice. When everything
 * fails, the caller needs each provider's reason, and a router with no usable provider must fail
 * at boot, not on the first request.
 */
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

import { isFailure, UnexpectedDefect } from '@arki/failure';

import type { ProviderFailure } from '../failures';
import type { LLMProvider } from './types';
import {
  AllProvidersFailed,
  Cancelled,
  ContentFiltered,
  InvalidOutput,
  NoProviderConfigured,
  ProviderFailed,
  ProviderUnauthorized,
  RateLimited,
} from '../failures';
import { createProviderRouter, ProviderRouter } from './provider-router';

/**
 * The model the mocked `@ai-sdk/openai` factory hands out, so the router's own provider runs on a
 * mock and never reaches the network. Tests that only pick a model get the bare model id.
 */
const openaiModel = vi.hoisted(() => ({ current: undefined as LanguageModel | undefined }));
vi.mock('@ai-sdk/openai', () => {
  const resolve = (modelId: string): LanguageModel => openaiModel.current ?? modelId;
  return { createOpenAI: () => resolve, openai: resolve };
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function twoProviders(maxConsecutiveFailures = 3): ProviderRouter {
  const router = createProviderRouter({
    maxConsecutiveFailures,
    providers: [
      { name: 'openai', model: 'gpt-4o-mini', apiKey: 'openai-test-key', weight: 1 },
      { name: 'anthropic', model: 'claude-3-haiku-20240307', apiKey: 'anthropic-test-key', weight: 1 },
    ],
  });
  if (isFailure(router)) throw new Error(`router setup failed: ${router.code}`);
  return router;
}

function outage(provider: string): ProviderFailure {
  return ProviderFailed({ provider, model: 'm', status: 503 });
}

async function* chunks(...items: (string | ProviderFailure)[]): AsyncGenerator<string | ProviderFailure, void, unknown> {
  for (const item of items) yield item;
}

/** The failure code of a result, or undefined when it is not a failure. */
function codeOf(value: unknown): string | undefined {
  return isFailure(value) ? value.code : undefined;
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

describe('ProviderRouter', () => {
  it('registers openai and anthropic providers when api keys are provided in config', () => {
    expect(twoProviders().getAvailableProviders()).toEqual(expect.arrayContaining(['openai', 'anthropic']));
  });

  it('supports api key overrides for providers that usually read from env', () => {
    const router = createProviderRouter({
      providers: [{ name: 'google', model: 'gemini-2.0-flash', apiKey: 'google-test-key', weight: 1 }],
    });

    expect(!isFailure(router) && router.getAvailableProviders()).toEqual(['google']);
  });

  it('applies weighted rotation in toLanguageModel', () => {
    const router = createProviderRouter({
      providers: [
        { name: 'openai', model: 'gpt-4o-mini', apiKey: 'openai-test-key', weight: 3 },
        { name: 'anthropic', model: 'claude-3-haiku-20240307', apiKey: 'anthropic-test-key', weight: 1 },
      ],
    });
    if (isFailure(router)) throw new Error(router.code);
    const counts: Record<string, number> = { anthropic: 0, openai: 0 };

    for (let index = 0; index < 12; index += 1) {
      const resolved = router.toLanguageModel();
      if (isFailure(resolved)) throw new Error(resolved.code);
      counts[resolved.providerName] = (counts[resolved.providerName] ?? 0) + 1;
    }

    expect(counts['openai']).toBe(9);
    expect(counts['anthropic']).toBe(3);
  });

  it('routes away from a provider whose reported outage tripped it', () => {
    const router = twoProviders(1);

    router.reportFailure('openai', outage('openai'));

    expect(router.toLanguageModel()).toMatchObject({ providerName: 'anthropic' });
  });

  it('maps a raw SDK error passed to reportFailure, so a 503 from streamText trips health', () => {
    const router = twoProviders(1);
    const error = new APICallError({ message: 'down', url: 'https://x', requestBodyValues: {}, statusCode: 503 });

    router.reportFailure('openai', error);

    expect(router.getHealthStatus().get('openai')).toMatchObject({ isHealthy: false, consecutiveFailures: 1 });
  });

  it('does not count a cancel or a bug against provider health', () => {
    const router = twoProviders(1);

    router.reportFailure('openai', Cancelled());
    router.reportFailure('openai', new Error('a bug in the caller'));

    expect(router.getHealthStatus().get('openai')).toMatchObject({ isHealthy: true, consecutiveFailures: 0 });
  });

  it('returns AllProvidersFailed from toLanguageModel when every provider is tripped, with each last code', () => {
    const router = twoProviders(1);
    router.reportFailure('openai', outage('openai'));
    router.reportFailure('anthropic', ProviderUnauthorized({ provider: 'anthropic', model: 'm' }));

    const resolved = router.toLanguageModel();

    expect(AllProvidersFailed.is(resolved) && resolved.data.failures).toEqual(
      expect.arrayContaining([
        { provider: 'openai', code: 'ai.provider_failed' },
        { provider: 'anthropic', code: 'ai.unauthorized' },
      ]),
    );
  });
});

describe('createProviderRouter: a router with no usable provider fails at boot', () => {
  it('returns NoProviderConfigured when every provider is disabled', () => {
    const router = createProviderRouter({
      providers: [{ name: 'openai', model: 'gpt-4o-mini', apiKey: 'k', enabled: false }],
    });

    expect(NoProviderConfigured.is(router)).toBe(true);
  });

  it('returns NoProviderConfigured when no provider is listed', () => {
    expect(codeOf(createProviderRouter({ providers: [] }))).toBe('ai.no_provider_configured');
  });

  it('builds a router instance, not a failure, when one provider has a key', () => {
    expect(twoProviders()).toBeInstanceOf(ProviderRouter);
  });
});

describe('executeWithFallback: only outages fall back', () => {
  it('falls over to the next provider when one is rate limited, so a busy provider does not fail the call', async () => {
    const result = await twoProviders().executeWithFallback(provider =>
      Promise.resolve(provider.name === 'openai' ? RateLimited({ retryAfterMs: 1000 }) : 'answer'),
    );

    expect(result).toMatchObject({ data: 'answer', provider: 'anthropic' });
  });

  it('falls over on a provider outage and on a bad key, and counts both against health', async () => {
    const router = twoProviders();
    const result = await router.executeWithFallback(provider =>
      Promise.resolve(provider.name === 'openai' ? ProviderUnauthorized({ provider: 'openai', model: 'm' }) : 'answer'),
    );

    expect(result).toMatchObject({ data: 'answer', provider: 'anthropic' });
    expect(router.getHealthStatus().get('openai')?.consecutiveFailures).toBe(1);
  });

  it('stops at once on Cancelled: the second provider is never called and health is untouched', async () => {
    const router = twoProviders();
    const called: string[] = [];

    const result = await router.executeWithFallback(provider => {
      called.push(provider.name);
      return Promise.resolve(Cancelled());
    });

    expect(codeOf(result)).toBe('ai.cancelled');
    expect(called).toHaveLength(1);
    expect([...router.getHealthStatus().values()].every(health => health.consecutiveFailures === 0)).toBe(true);
  });

  it('returns an unknown throw as UnexpectedDefect at once, without tripping provider health', async () => {
    const router = twoProviders(1);
    const called: string[] = [];

    const result = await router.executeWithFallback(provider => {
      called.push(provider.name);
      return Promise.reject(new TypeError('bug in the operation'));
    });

    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(called).toHaveLength(1);
    expect(router.getHealthyProviderNames()).toHaveLength(2);
  });

  it.each([
    ['ContentFiltered', ContentFiltered({ provider: 'p', model: 'm' })],
    ['InvalidOutput', InvalidOutput({ provider: 'p', model: 'm', reason: 'bad json' })],
  ])('returns %s at once: a refused or unusable answer is not shopped to the next provider', async (_name, failure) => {
    const called: string[] = [];

    const result = await twoProviders().executeWithFallback(provider => {
      called.push(provider.name);
      return Promise.resolve(failure);
    });

    expect(result).toBe(failure);
    expect(called).toHaveLength(1);
  });

  it('returns AllProvidersFailed with each provider code and the shortest Retry-After when every provider fails', async () => {
    const result = await twoProviders().executeWithFallback(provider =>
      Promise.resolve(
        provider.name === 'openai' ? RateLimited({ retryAfterMs: 5000 }) : RateLimited({ retryAfterMs: 2000 }),
      ),
    );

    expect(AllProvidersFailed.is(result) && result.data).toEqual({
      failures: expect.arrayContaining([
        { provider: 'openai', code: 'ai.rate_limited' },
        { provider: 'anthropic', code: 'ai.rate_limited' },
      ]),
      retryAfterMs: 2000,
    });
  });

  it('lists a tripped provider it did not call in AllProvidersFailed, with the code that tripped it', async () => {
    const router = twoProviders(1);
    router.reportFailure('openai', outage('openai'));
    const called: string[] = [];

    const result = await router.executeWithFallback(provider => {
      called.push(provider.name);
      return Promise.resolve(outage(provider.name));
    });

    expect(called).toEqual(['anthropic']);
    expect(AllProvidersFailed.is(result) && result.data.failures).toEqual(
      expect.arrayContaining([
        { provider: 'openai', code: 'ai.provider_failed' },
        { provider: 'anthropic', code: 'ai.provider_failed' },
      ]),
    );
  });

  it('ends when a provider failed but is not yet tripped while the other is tripped (no endless loop)', async () => {
    const router = twoProviders(3);
    router.reportFailure('anthropic', outage('anthropic'));
    router.reportFailure('anthropic', outage('anthropic'));
    router.reportFailure('anthropic', outage('anthropic'));

    const result = await router.executeWithFallback(provider => Promise.resolve(outage(provider.name)));

    expect(codeOf(result)).toBe('ai.all_providers_failed');
  });
});

describe('streamWithFallback: text is never repeated', () => {
  it('falls back before the first chunk: the caller sees only the second provider text', async () => {
    const router = twoProviders();
    const items = await collect(
      router.streamWithFallback(provider =>
        provider.name === 'openai' ? chunks(outage('openai')) : chunks('hello', ' world'),
      ),
    );

    expect(items).toEqual(['hello', ' world']);
  });

  it('a failure after the first chunk is final: the stream ends with it and no provider restarts the text', async () => {
    const router = twoProviders();
    const called: string[] = [];
    const items = await collect(
      router.streamWithFallback(provider => {
        called.push(provider.name);
        return chunks('hel', outage(provider.name));
      }),
    );

    expect(called).toHaveLength(1);
    expect(items.slice(0, 1)).toEqual(['hel']);
    expect(items).toHaveLength(2);
    expect(ProviderFailed.is(items[1])).toBe(true);
  });

  it('stops at once on Cancelled before any text', async () => {
    const called: string[] = [];
    const items = await collect(
      twoProviders().streamWithFallback(provider => {
        called.push(provider.name);
        return chunks(Cancelled());
      }),
    );

    expect(called).toHaveLength(1);
    expect(items.map(item => (typeof item === 'string' ? item : codeOf(item)))).toEqual(['ai.cancelled']);
  });

  it('a stream that throws is mapped, not rethrown: an unknown throw ends the stream as UnexpectedDefect', async () => {
    async function* broken(): AsyncGenerator<string | ProviderFailure, void, unknown> {
      yield* [];
      throw new TypeError('bug');
    }
    const items = await collect(twoProviders().streamWithFallback(() => broken()));

    expect(items).toHaveLength(1);
    expect(UnexpectedDefect.is(items[0])).toBe(true);
  });

  it('ends with AllProvidersFailed when every provider fails before its first chunk', async () => {
    const items = await collect(twoProviders().streamWithFallback(provider => chunks(outage(provider.name))));

    expect(items).toHaveLength(1);
    expect(AllProvidersFailed.is(items[0]) && items[0].data.failures).toHaveLength(2);
  });

  it('calls onError once, with the final failure only, not with a failure the router recovered from', async () => {
    const router = createProviderRouter({ providers: [{ name: 'openai', model: 'gpt-4o-mini', apiKey: 'k' }] });
    if (isFailure(router)) throw new Error(router.code);
    openaiModel.current = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [{ type: 'error', error: new APICallError({ message: 'busy', url: 'https://x', requestBodyValues: {}, statusCode: 429 }) }],
        }),
      }),
    });
    const onError = vi.fn();

    const items = await collect(router.streamText('hi', { onError }));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(items.at(-1));
    expect(AllProvidersFailed.is(items.at(-1))).toBe(true);
  });
});

describe("the router's own provider returns typed failures, never throws", () => {
  function onlyOpenAI(): { router: ProviderRouter; provider: LLMProvider } {
    const router = createProviderRouter({ providers: [{ name: 'openai', model: 'gpt-4o-mini', apiKey: 'k' }] });
    if (isFailure(router)) throw new Error(router.code);
    const provider = router.getNextProvider();
    if (!provider) throw new Error('no provider');
    return { router, provider };
  }

  it('a 429 from the provider is RateLimited with its Retry-After', async () => {
    openaiModel.current = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          new APICallError({
            message: 'busy',
            url: 'https://x',
            requestBodyValues: {},
            statusCode: 429,
            responseHeaders: { 'retry-after': '2' },
            isRetryable: false,
          }),
        ),
    });

    const result = await onlyOpenAI().provider.generateText('hi');

    expect(RateLimited.is(result) && result.data.retryAfterMs).toBe(2000);
  });

  it('a truncated answer (finish reason length) is IncompleteGeneration, not text', async () => {
    openaiModel.current = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: 'text', text: 'partial' }],
          finishReason: { unified: 'length', raw: 'length' },
          usage,
          warnings: [],
        }),
    });

    expect(codeOf(await onlyOpenAI().provider.generateConversation([{ role: 'user', content: 'hi' }]))).toBe(
      'ai.incomplete',
    );
  });

  it('a stream error part after text ends the stream with the failure, not as a success', async () => {
    openaiModel.current = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'hel' },
            {
              type: 'error',
              error: new APICallError({ message: 'down', url: 'https://x', requestBodyValues: {}, statusCode: 503 }),
            },
          ],
        }),
      }),
    });
    const onComplete = vi.fn();

    const items = await collect(onlyOpenAI().provider.streamText('hi', { onComplete }));

    expect(items[0]).toBe('hel');
    expect(ProviderFailed.is(items[1])).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('a call through the router with an aborted signal is Cancelled and does not trip health', async () => {
    openaiModel.current = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) => {
        abortSignal?.throwIfAborted();
        return Promise.reject(new Error('unreachable'));
      },
    });
    const { router } = onlyOpenAI();
    const controller = new AbortController();
    controller.abort();

    const result = await router.generateText('hi', { signal: controller.signal });

    expect(codeOf(result)).toBe('ai.cancelled');
    expect(router.getHealthStatus().get('openai')?.consecutiveFailures).toBe(0);
  });
});
