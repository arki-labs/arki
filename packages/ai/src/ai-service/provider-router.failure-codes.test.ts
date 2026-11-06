/**
 * The router operations that `provider-router.test.ts` does not call by name: `generateConversation`,
 * `streamConversation` and `createDefaultProviderRouter`. WHY it matters: a chat goes through the
 * conversation methods, so they must fall back on an outage, stop on a refusal, never repeat text,
 * and tell the caller every provider's code. A default router with no key must fail at boot.
 *
 * The provider is the router's own AI SDK provider on a mock model (a stand-in for a paid model
 * call); the failures are the real ones the shared boundary returns.
 */
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';

import type { ProviderRouter } from './provider-router';
import { AllProvidersFailed, ContentFiltered, ProviderFailed } from '../failures';
import { createProviderRouter } from './provider-router';

/** The model the mocked `@ai-sdk/openai` factory hands out, so no call reaches the network. */
const openaiModel = vi.hoisted(() => ({ current: undefined as LanguageModel | undefined }));
vi.mock('@ai-sdk/openai', () => {
  const resolve = (modelId: string): LanguageModel => openaiModel.current ?? modelId;
  return { createOpenAI: () => resolve, openai: resolve };
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const messages = [{ role: 'user' as const, content: 'hi' }];

function onlyOpenAI(): ProviderRouter {
  const router = createProviderRouter({ providers: [{ name: 'openai', model: 'gpt-4o-mini', apiKey: 'k' }] });
  if (isFailure(router)) throw new Error(`router setup failed: ${router.code}`);
  return router;
}

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: 'provider error',
    url: 'https://x',
    requestBodyValues: {},
    statusCode,
    isRetryable: false,
  });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

describe('ProviderRouter.generateConversation', () => {
  it('returns AllProvidersFailed with the provider code when its only provider has an outage', async () => {
    openaiModel.current = new MockLanguageModelV4({ doGenerate: () => Promise.reject(apiError(503)) });
    const router = onlyOpenAI();

    const result = await router.generateConversation(messages);

    expect(AllProvidersFailed.is(result) && result.code).toBe('ai.all_providers_failed');
    expect(AllProvidersFailed.is(result) && result.data.failures).toEqual([
      { provider: 'openai', code: 'ai.provider_failed' },
    ]);
    expect(router.getHealthStatus().get('openai')?.consecutiveFailures).toBe(1);
  });

  it('returns a refusal as ContentFiltered at once, without counting it against provider health', async () => {
    openaiModel.current = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: 'text', text: '' }],
          finishReason: { unified: 'content-filter', raw: 'content_filter' },
          usage,
          warnings: [],
        }),
    });
    const router = onlyOpenAI();

    const result = await router.generateConversation(messages);

    expect(ContentFiltered.is(result) && result.code).toBe('ai.content_filtered');
    expect(router.getHealthStatus().get('openai')?.consecutiveFailures).toBe(0);
  });
});

describe('ProviderRouter.streamConversation', () => {
  it('ends with AllProvidersFailed, passed once to onError, when the provider is rate limited before any text', async () => {
    openaiModel.current = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [{ type: 'error', error: apiError(429) }],
        }),
      }),
    });
    const onError = vi.fn();

    const items = await collect(onlyOpenAI().streamConversation(messages, { onError }));

    expect(items).toHaveLength(1);
    expect(AllProvidersFailed.is(items[0]) && items[0].data.failures).toEqual([
      { provider: 'openai', code: 'ai.rate_limited' },
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(items[0]);
  });

  it('ends with the provider failure after text, so the text is never restarted', async () => {
    openaiModel.current = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'hel' },
            { type: 'error', error: apiError(503) },
          ],
        }),
      }),
    });
    const onError = vi.fn();

    const items = await collect(onlyOpenAI().streamConversation(messages, { onError }));

    expect(items[0]).toBe('hel');
    expect(items).toHaveLength(2);
    expect(ProviderFailed.is(items[1]) && items[1].code).toBe('ai.provider_failed');
    expect(onError).toHaveBeenCalledWith(items[1]);
  });
});

/** A fresh module graph, so the lazily read env sees the stubbed variables. */
async function freshRouterModule() {
  vi.resetModules();
  return import('./provider-router');
}

describe('createDefaultProviderRouter', () => {
  const keys = ['GROQ_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY'] as const;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns NoProviderConfigured at boot when none of the default providers has a key', async () => {
    for (const key of keys) vi.stubEnv(key, '');
    const { createDefaultProviderRouter } = await freshRouterModule();

    const router = createDefaultProviderRouter();

    expect(isFailure(router) && router.code).toBe('ai.no_provider_configured');
  });

  it('builds a router with only the providers that have a key', async () => {
    for (const key of keys) vi.stubEnv(key, '');
    vi.stubEnv('GROQ_API_KEY', 'gsk-test');
    const { createDefaultProviderRouter } = await freshRouterModule();

    const router = createDefaultProviderRouter();

    expect(isFailure(router) ? router.code : router.getAvailableProviders()).toEqual(['groq']);
  });
});
