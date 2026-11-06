/**
 * `generateStructuredDataFromMessages` is the body every Anthropic structured call runs, so its
 * failures are checked on it directly, not only through the `generateStructuredData` wrapper.
 * `generateText` is checked for what it really does with the shared limiter: it takes no slot, so
 * a full limiter never refuses it (only a provider 429 does).
 */
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { z } from '@arki/contracts';
import { isFailure } from '@arki/failure';

import { RateLimited } from '../failures';
import { rateLimiters } from '../utils/rate-limiter';
import { AnthropicService } from './anthropic-service';

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => 'mocked-anthropic-model')),
}));

// The real AI SDK runs every call; `useModel` swaps the provider's model for a mock one.
vi.mock('ai', async importOriginal => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(actual.generateText) };
});

const sdk = await vi.importActual<typeof import('ai')>('ai');
const { generateText } = await import('ai');
const mockedGenerateText = vi.mocked(generateText);

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function answering(text: string, unified: 'stop' | 'length' = 'stop') {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text', text }],
        finishReason: { unified, raw: unified },
        usage,
        warnings: [],
      }),
  });
}

function useModel(model: MockLanguageModelV4) {
  mockedGenerateText.mockImplementation(options => sdk.generateText({ ...options, model }));
}

const messages = [{ role: 'user' as const, content: 'extract' }];
const schema = z.object({ ok: z.boolean() });

describe('AnthropicService.generateStructuredDataFromMessages returns each failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiters.anthropic.resetAll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rateLimiters.anthropic.resetAll();
  });

  it('a 5xx is ProviderFailed', async () => {
    const error = new APICallError({ message: 'down', url: 'https://x', requestBodyValues: {}, statusCode: 503 });
    useModel(new MockLanguageModelV4({ doGenerate: () => Promise.reject(error) }));

    const result = await new AnthropicService({ maxRetries: 0 }).generateStructuredDataFromMessages(messages, schema);

    expect(isFailure(result) && result.code).toBe('ai.provider_failed');
  });

  it('an answer the schema rejects is InvalidOutput, not an unchecked object', async () => {
    // WHY: a caller that trusts the typed result would read a field the model never sent.
    useModel(answering('{"ok":"yes"}'));

    const result = await new AnthropicService().generateStructuredDataFromMessages(messages, schema);

    expect(isFailure(result) && result.code).toBe('ai.invalid_output');
  });

  it('a full limiter is RateLimited with its wait, and no request is sent', async () => {
    vi.spyOn(rateLimiters.anthropic, 'execute').mockResolvedValue(RateLimited({ retryAfterMs: 1200 }));

    const result = await new AnthropicService().generateStructuredDataFromMessages(messages, schema);

    expect(RateLimited.is(result) && result.data.retryAfterMs).toBe(1200);
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe('AnthropicService.generateText and the limiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes no limiter slot, so a full limiter does not refuse it', async () => {
    // WHY: the ledger says which calls the shared anthropic window can refuse; this one it cannot.
    const execute = vi.spyOn(rateLimiters.anthropic, 'execute').mockResolvedValue(RateLimited({ retryAfterMs: 1200 }));
    useModel(answering('hello'));

    const result = await new AnthropicService().generateText('hi');

    expect(result).toBe('hello');
    expect(execute).not.toHaveBeenCalled();
  });
});
