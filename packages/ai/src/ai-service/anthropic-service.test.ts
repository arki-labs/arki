/**
 * AnthropicService returns every way a call can fail. WHY it matters: a caller can only wait out a
 * 429, fix a key, or tell the user "refused" when each comes back as its own failure; a thrown
 * `GenerationError` string, a cut-off answer that looks complete, or a stream that ends quietly on
 * a provider error all hide what happened.
 */
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { z } from '@arki/contracts';
import { isFailure, orThrow } from '@arki/failure';

import type { ProviderFailure } from '../failures';
import { RateLimited } from '../failures';
import { rateLimiters } from '../utils/rate-limiter';

import { AnthropicService } from './anthropic-service';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('@ai-sdk/anthropic', () => ({
  // `@arki/ai/anthropic` builds its default provider with `createAnthropic`.
  createAnthropic: vi.fn(() => vi.fn(() => 'mocked-anthropic-model')),
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

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function apiError(statusCode: number, responseHeaders?: Record<string, string>): APICallError {
  return new APICallError({ message: `status ${statusCode}`, url: 'https://x', requestBodyValues: {}, statusCode, responseHeaders });
}

function answering(text: string, unified: 'stop' | 'length' | 'content-filter' = 'stop') {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({ content: [{ type: 'text', text }], finishReason: { unified, raw: unified }, usage, warnings: [] }),
  });
}

function throwing(error: Error) {
  return new MockLanguageModelV4({ doGenerate: () => Promise.reject(error), doStream: () => Promise.reject(error) });
}

function streamingText(texts: string[], unified: 'stop' | 'length' = 'stop') {
  return streaming([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    ...texts.map((delta): LanguageModelV4StreamPart => ({ type: 'text-delta', id: '1', delta })),
    { type: 'text-end', id: '1' },
    { type: 'finish', finishReason: { unified, raw: unified }, usage },
  ]);
}

function streaming(chunks: LanguageModelV4StreamPart[]) {
  return new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks }) }) });
}

/** Run the real AI SDK against `model` instead of the Anthropic one. */
function useModel(model: MockLanguageModelV4) {
  mockedGenerateText.mockImplementation(options => sdk.generateText({ ...options, model }));
  mockedStreamText.mockImplementation(options => sdk.streamText({ ...options, model }));
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('AnthropicService — conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiters.anthropic.resetAll();
  });

  afterEach(() => {
    rateLimiters.anthropic.resetAll();
  });

  describe('generateConversation', () => {
    it('returns the model reply as plain text', async () => {
      useModel(answering('A haiku, you say?'));

      const svc = new AnthropicService({ model: 'claude-3-5-haiku-latest' });
      const reply = await svc.generateConversation([{ role: 'user', content: 'write a haiku' }]);

      expect(reply).toBe('A haiku, you say?');
      expect(mockedGenerateText).toHaveBeenCalledWith(
        expect.not.objectContaining({ output: expect.anything() }),
      );
    });

    it('passes a string system prompt through buildSystemParam unchanged', async () => {
      useModel(answering('ok'));

      const svc = new AnthropicService();
      await orThrow(svc.generateConversation([{ role: 'user', content: 'hi' }], {
        systemPrompt: 'Deflect any identity questions.',
      }));

      expect(mockedGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({ instructions: 'Deflect any identity questions.' }),
      );
    });

    it('builds cache-control system parts when given SystemPart[]', async () => {
      useModel(answering('ok'));

      const svc = new AnthropicService();
      await orThrow(svc.generateConversation([{ role: 'user', content: 'hi' }], {
        systemPrompt: [{ text: 'big stable prompt', cacheControl: { type: 'ephemeral' } }],
      }));

      expect(mockedGenerateText.mock.calls[0]?.[0].instructions).toEqual([
        expect.objectContaining({
          role: 'system',
          content: 'big stable prompt',
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        }),
      ]);
    });

    it('applies rate limiting', async () => {
      useModel(answering('ok'));

      const executeSpy = vi.spyOn(rateLimiters.anthropic, 'execute');
      const svc = new AnthropicService();
      await orThrow(svc.generateConversation([{ role: 'user', content: 'hi' }]));

      expect(executeSpy).toHaveBeenCalledWith('generateConversation', expect.any(Function));
    });

    it('returns RateLimited when the limiter refuses, so the caller can wait instead of catching', async () => {
      const executeSpy = vi.spyOn(rateLimiters.anthropic, 'execute').mockResolvedValue(
        RateLimited({ retryAfterMs: 4000 }),
      );

      const svc = new AnthropicService();
      const result = await svc.generateConversation([{ role: 'user', content: 'hi' }]);

      expect(RateLimited.is(result) && result.data.retryAfterMs).toBe(4000);
      expect(mockedGenerateText).not.toHaveBeenCalled();

      executeSpy.mockRestore();
    });

    it('a filtered answer is ContentFiltered, not text that looks complete', async () => {
      useModel(answering('I can', 'content-filter'));

      const result = await new AnthropicService().generateConversation([{ role: 'user', content: 'hi' }]);

      expect(isFailure(result) && result.code).toBe('ai.content_filtered');
    });
  });

  describe('streamConversation', () => {
    it('consumes a rate-limit slot then yields each delta', async () => {
      useModel(streamingText(['Once', ' upon']));

      const executeSpy = vi.spyOn(rateLimiters.anthropic, 'execute');
      const svc = new AnthropicService();

      let completed: string | undefined;
      const out = await collect(await orThrow(svc.streamConversation([{ role: 'user', content: 'tell a story' }], {
        onComplete: (full) => { completed = full; },
      })));

      expect(out).toEqual(['Once', ' upon']);
      expect(completed).toBe('Once upon');
      expect(executeSpy).toHaveBeenCalledWith('streamConversation', expect.any(Function));
    });

    it('a provider error mid-stream is the last item and reaches onError; the stream never looks complete', async () => {
      useModel(streaming([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'hel' },
        { type: 'error', error: apiError(429, { 'retry-after': '2' }) },
      ]));

      let captured: ProviderFailure | undefined;
      let completed = false;
      const out = await collect(await orThrow(new AnthropicService().streamConversation([{ role: 'user', content: 'hi' }], {
        onError: (failure) => { captured = failure; },
        onComplete: () => { completed = true; },
      })));

      expect(out[0]).toBe('hel');
      const last = out.at(-1);
      expect(RateLimited.is(last) && last.data.retryAfterMs).toBe(2000);
      expect(captured?.code).toBe('ai.rate_limited');
      expect(completed).toBe(false);
    });

    it('a stream cut off by the token limit ends with IncompleteGeneration', async () => {
      useModel(streamingText(['par', 'tial'], 'length'));

      const out = await collect(await orThrow(new AnthropicService().streamConversation([{ role: 'user', content: 'hi' }])));

      const last = out.at(-1);
      expect(isFailure(last) && last.code).toBe('ai.incomplete');
    });

    it('returns RateLimited before the stream starts when no slot is free', async () => {
      const executeSpy = vi.spyOn(rateLimiters.anthropic, 'execute').mockResolvedValue(
        RateLimited({ retryAfterMs: 3000 }),
      );

      const svc = new AnthropicService();
      const stream = await svc.streamConversation([{ role: 'user', content: 'hi' }]);

      expect(RateLimited.is(stream)).toBe(true);
      expect(mockedStreamText).not.toHaveBeenCalled();

      executeSpy.mockRestore();
    });

    it('opens a telemetry span for the stream', async () => {
      useModel(streamingText(['x']));

      expect(await collect(await orThrow(new AnthropicService().streamConversation([{ role: 'user', content: 'hi' }])))).toEqual(['x']);

      expect(mockedStreamText).toHaveBeenCalledWith(
        expect.objectContaining({ telemetry: expect.objectContaining({ functionId: 'anthropic.streamConversation' }) }),
      );
    });
  });
});

describe('AnthropicService — failures are returned, not thrown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiters.anthropic.resetAll();
  });

  it('a 401 from generateText is ProviderUnauthorized', async () => {
    useModel(throwing(apiError(401)));

    const result = await new AnthropicService({ maxRetries: 0 }).generateText('hi');

    expect(isFailure(result) && result.code).toBe('ai.unauthorized');
  });

  it('a 5xx from structured generation is ProviderFailed', async () => {
    useModel(throwing(apiError(503)));

    const result = await new AnthropicService({ maxRetries: 0 }).generateStructuredData('hi', z.object({ ok: z.boolean() }));

    expect(isFailure(result) && result.code).toBe('ai.provider_failed');
  });

  it('an answer cut off by the token limit is IncompleteGeneration, not partial text', async () => {
    useModel(answering('partial', 'length'));

    const result = await new AnthropicService().generateText('hi');

    expect(isFailure(result) && result.code).toBe('ai.incomplete');
  });

  it('a cut-off structured answer is IncompleteGeneration', async () => {
    useModel(answering('{"ok":true}', 'length'));

    const result = await new AnthropicService().generateStructuredData('hi', z.object({ ok: z.boolean() }));

    expect(isFailure(result) && result.code).toBe('ai.incomplete');
  });

  it('every call opens a telemetry span named after the operation', async () => {
    useModel(answering('{"ok":true}'));
    const svc = new AnthropicService();

    await orThrow(svc.generateStructuredData('hi', z.object({ ok: z.boolean() })));
    await orThrow(svc.generateText('hi'));

    const functionIds = mockedGenerateText.mock.calls.map(([options]) => options.telemetry?.functionId);
    expect(functionIds).toEqual(['anthropic.generateStructuredData', 'anthropic.generateText']);
  });
});
