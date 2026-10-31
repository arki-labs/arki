/**
 * The Google, Groq, Mistral and OpenRouter services share one promise: when the local rate limiter
 * has no free slot, the call resolves to `RateLimited` (with the wait) instead of throwing, and no
 * paid request is sent. A caller can then wait `retryAfterMs` and try again. Streams keep the same
 * promise, and every other way a call fails (no key, provider error, cut-off answer) is returned
 * too, so a stream never ends quietly on an error and partial text never looks complete.
 */
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';

import type { ProviderFailure } from '../failures';
import { RateLimited } from '../failures';
import { rateLimiters } from '../utils/rate-limiter';
import { GoogleService } from './google-service';
import { GroqService } from './groq-service';
import { MistralService } from './mistral-service';
import { OpenRouterService } from './openrouter-service';

/** The API key every service sees; a test clears it to check the missing-key path. */
const apiKey = vi.hoisted((): { value: string | undefined } => ({ value: 'test-key' }));

vi.mock('../env.ts', () => ({
  env: {
    get GOOGLE_GENERATIVE_AI_API_KEY() {
      return apiKey.value;
    },
    get GROQ_API_KEY() {
      return apiKey.value;
    },
    get MISTRAL_API_KEY() {
      return apiKey.value;
    },
    get OPENROUTER_API_KEY() {
      return apiKey.value;
    },
  },
}));

// The real AI SDK runs every call; `useModel` swaps the provider's model for a mock one.
vi.mock('ai', async importOriginal => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(actual.generateText), streamText: vi.fn(actual.streamText) };
});

const sdk = await vi.importActual<typeof import('ai')>('ai');
const { generateText, streamText } = await import('ai');
const mockedGenerateText = vi.mocked(generateText);
const mockedStreamText = vi.mocked(streamText);
const messages = [{ role: 'user' as const, content: 'hi' }];

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function apiError(statusCode: number, responseHeaders?: Record<string, string>): APICallError {
  return new APICallError({ message: `status ${statusCode}`, url: 'https://x', requestBodyValues: {}, statusCode, responseHeaders });
}

function answering(text: string, unified: 'stop' | 'length' = 'stop') {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({ content: [{ type: 'text', text }], finishReason: { unified, raw: unified }, usage, warnings: [] }),
  });
}

function streaming(chunks: LanguageModelV4StreamPart[]) {
  return new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks }) }) });
}

/** Run the real AI SDK against `model` instead of the provider's. */
function useModel(model: MockLanguageModelV4) {
  mockedGenerateText.mockImplementation(options => sdk.generateText({ ...options, model }));
  mockedStreamText.mockImplementation(options => sdk.streamText({ ...options, model }));
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

const services = [
  { name: 'google', limiter: rateLimiters.google, service: () => new GoogleService() },
  { name: 'groq', limiter: rateLimiters.groq, service: () => new GroqService() },
  { name: 'mistral', limiter: rateLimiters.mistral, service: () => new MistralService() },
  { name: 'openrouter', limiter: rateLimiters.openrouter, service: () => new OpenRouterService() },
] as const;

describe.each(services)('$name service: a full rate limiter is a returned failure', ({ limiter, service }) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generateText returns RateLimited with the wait, and sends no request', async () => {
    // WHY: a caller that cannot branch on this would catch a thrown error and retry at once, which is the burst the limiter exists to stop.
    vi.spyOn(limiter, 'execute').mockResolvedValue(RateLimited({ retryAfterMs: 1500 }));

    const result = await service().generateText('hello');

    expect(RateLimited.is(result) && result.code).toBe('ai.rate_limited');
    expect(RateLimited.is(result) && result.data.retryAfterMs).toBe(1500);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('generateConversation returns RateLimited with the wait, and sends no request', async () => {
    vi.spyOn(limiter, 'execute').mockResolvedValue(RateLimited({ retryAfterMs: 2500 }));

    const result = await service().generateConversation(messages);

    expect(RateLimited.is(result) && result.code).toBe('ai.rate_limited');
    expect(RateLimited.is(result) && result.data.retryAfterMs).toBe(2500);
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe.each(services)('$name service: every failure is returned, never thrown', ({ name, limiter, service }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiKey.value = 'test-key';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('streamText takes a slot from the same rate limiter, and a full limiter is the stream\'s only item', async () => {
    // WHY: an unthrottled stream lets a chat loop burst past the provider's free-tier limit.
    vi.spyOn(limiter, 'execute').mockResolvedValue(RateLimited({ retryAfterMs: 1500 }));
    let captured: ProviderFailure | undefined;

    const out = await collect(service().streamText('hello', { onError: failure => { captured = failure; } }));

    expect(out).toHaveLength(1);
    expect(RateLimited.is(out[0]) && out[0].data.retryAfterMs).toBe(1500);
    expect(captured?.code).toBe('ai.rate_limited');
    expect(streamText).not.toHaveBeenCalled();
  });

  it('streamConversation is rate limited the same way', async () => {
    vi.spyOn(limiter, 'execute').mockResolvedValue(RateLimited({ retryAfterMs: 900 }));

    const out = await collect(service().streamConversation(messages));

    expect(out.map(item => isFailure(item) && item.code)).toEqual(['ai.rate_limited']);
    expect(streamText).not.toHaveBeenCalled();
  });

  it('a missing API key is ProviderUnauthorized for calls and streams, and sends no request', async () => {
    apiKey.value = undefined;

    const text = await service().generateText('hello');
    const stream = await collect(service().streamText('hello'));

    expect(isFailure(text) && text.code).toBe('ai.unauthorized');
    expect(stream.map(item => isFailure(item) && item.code)).toEqual(['ai.unauthorized']);
    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  it('a provider 429 is RateLimited with its Retry-After wait', async () => {
    useModel(new MockLanguageModelV4({ doGenerate: () => Promise.reject(apiError(429, { 'retry-after': '2' })) }));

    const result = await service().generateText('hello', { maxRetries: 0 });

    expect(RateLimited.is(result) && result.data.retryAfterMs).toBe(2000);
  });

  it('an answer cut off by the token limit is IncompleteGeneration, not partial text', async () => {
    useModel(answering('partial', 'length'));

    const result = await service().generateConversation(messages);

    expect(isFailure(result) && result.code).toBe('ai.incomplete');
  });

  it('a provider error mid-stream is the last item; the stream never looks complete', async () => {
    useModel(streaming([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', delta: 'hel' },
      { type: 'error', error: apiError(503) },
    ]));
    let completed = false;

    const out = await collect(service().streamConversation(messages, { onComplete: () => { completed = true; } }));

    expect(out[0]).toBe('hel');
    const last = out.at(-1);
    expect(isFailure(last) && last.code).toBe('ai.provider_failed');
    expect(completed).toBe(false);
  });

  it('every call opens a telemetry span named after the provider and operation', async () => {
    useModel(answering('ok'));

    expect(await service().generateText('hello')).toBe('ok');

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ telemetry: expect.objectContaining({ functionId: `${name}.generateText` }) }),
    );
  });
});
