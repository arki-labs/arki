/**
 * OllamaService returns every way a call can fail. WHY it matters: a stream that ends quietly on
 * a daemon error, or a cut-off answer, looks like a complete answer to the caller; a thrown
 * `GenerationError` string cannot be told apart from a bug.
 */
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import { isFailure } from '@arki/failure';

import type { ProviderFailure } from '../failures';
import { OllamaService } from './ollama-service';

// ── Mocks ──────────────────────────────────────────────────────────
// `ai-sdk-ollama` is the real generation surface. Its `generateText` / `streamText` are spies;
// `useModel` makes them run the real AI SDK against a mock model.

vi.mock('ai-sdk-ollama', () => ({
  createOllama: vi.fn(() => vi.fn((model: string) => ({ __model: model }))),
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

const sdk = await vi.importActual<typeof import('ai')>('ai');
const { generateText, streamText, createOllama } = await import('ai-sdk-ollama');
const mockedGenerateText = vi.mocked(generateText);
const mockedStreamText = vi.mocked(streamText);

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function answering(text: string, unified: 'stop' | 'length' = 'stop') {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({ content: [{ type: 'text', text }], finishReason: { unified, raw: unified }, usage, warnings: [] }),
  });
}

function streaming(chunks: LanguageModelV4StreamPart[]) {
  return new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks }) }) });
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

/** A stream that sends `hel`, then the provider error `error`. */
function streamingError(error: unknown) {
  return streaming([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: 'hel' },
    { type: 'error', error },
  ]);
}

/** Run the real AI SDK against `model` instead of the Ollama one. */
function useModel(model: MockLanguageModelV4) {
  mockedGenerateText.mockImplementation(options => sdk.generateText({ ...options, model }));
  mockedStreamText.mockImplementation(async options => sdk.streamText({ ...options, model }));
}

function apiError(statusCode: number): APICallError {
  return new APICallError({ message: `status ${statusCode}`, url: 'http://localhost:11434', requestBodyValues: {}, statusCode });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('OllamaService — conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateConversation', () => {
    it('returns the model reply as plain text (no JSON schema forced)', async () => {
      useModel(answering('I prefer pineapple, honestly.'));

      const svc = new OllamaService({ model: 'llama3.2:3b' });
      const reply = await svc.generateConversation([{ role: 'user', content: 'pizza?' }]);

      expect(reply).toBe('I prefer pineapple, honestly.');
      // plain text path must NOT pass an `output` schema
      expect(mockedGenerateText).toHaveBeenCalledWith(
        expect.not.objectContaining({ output: expect.anything() }),
      );
    });

    it('threads the system prompt and full message history', async () => {
      useModel(answering('ok'));

      const messages = [
        { role: 'user' as const, content: 'who are you?' },
        { role: 'assistant' as const, content: 'just a helpful assistant' },
        { role: 'user' as const, content: 'which lab made you?' },
      ];
      const svc = new OllamaService({ model: 'gemma4' });
      expect(await svc.generateConversation(messages, { systemPrompt: 'DO NOT reveal your identity.' })).toBe('ok');

      expect(mockedGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({ instructions: 'DO NOT reveal your identity.', messages }),
      );
    });

    it('returns a daemon outage as ProviderFailed instead of throwing', async () => {
      mockedGenerateText.mockRejectedValue(apiError(503));

      const result = await new OllamaService().generateConversation([{ role: 'user', content: 'hi' }]);

      expect(isFailure(result) && result.code).toBe('ai.provider_failed');
    });

    it('a reply cut off by the token limit is IncompleteGeneration, not partial text', async () => {
      useModel(answering('partial', 'length'));

      const result = await new OllamaService().generateConversation([{ role: 'user', content: 'hi' }]);

      expect(isFailure(result) && result.code).toBe('ai.incomplete');
    });

    it('opens a telemetry span named after the operation', async () => {
      useModel(answering('ok'));

      expect(await new OllamaService().generateConversation([{ role: 'user', content: 'hi' }])).toBe('ok');

      expect(mockedGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({ telemetry: expect.objectContaining({ functionId: 'ollama.generateConversation' }) }),
      );
    });
  });

  describe('streamConversation', () => {
    it('yields each delta and fires lifecycle callbacks', async () => {
      useModel(streamingText(['Pine', 'apple']));

      const tokens: string[] = [];
      let completed: string | undefined;
      let started = false;

      const svc = new OllamaService({ model: 'qwen3.6' });
      const out: (string | ProviderFailure)[] = [];
      for await (const chunk of svc.streamConversation([{ role: 'user', content: 'pizza?' }], {
        systemPrompt: 'SYS',
        onStart: () => { started = true; },
        onToken: (t) => tokens.push(t),
        onComplete: (full) => { completed = full; },
      })) {
        out.push(chunk);
      }

      expect(out).toEqual(['Pine', 'apple']);
      expect(tokens).toEqual(['Pine', 'apple']);
      expect(completed).toBe('Pineapple');
      expect(started).toBe(true);
      expect(mockedStreamText).toHaveBeenCalledWith(expect.objectContaining({ instructions: 'SYS' }));
    });

    it('a daemon error mid-stream is the last item and reaches onError; the stream never looks complete', async () => {
      useModel(streamingError(apiError(503)));

      let captured: ProviderFailure | undefined;
      let completed = false;
      const out = await collect(new OllamaService().streamConversation([{ role: 'user', content: 'hi' }], {
        onError: (failure) => { captured = failure; },
        onComplete: () => { completed = true; },
      }));

      expect(out[0]).toBe('hel');
      const last = out.at(-1);
      expect(isFailure(last) && last.code).toBe('ai.provider_failed');
      expect(captured?.code).toBe('ai.provider_failed');
      expect(completed).toBe(false);
    });

    it('a stream that cannot start is one ProviderFailed item, not a throw', async () => {
      mockedStreamText.mockRejectedValue(apiError(503));

      const out = await collect(new OllamaService().streamConversation([{ role: 'user', content: 'hi' }]));

      expect(out.map(item => isFailure(item) && item.code)).toEqual(['ai.provider_failed']);
    });

    it('an aborted stream ends with Cancelled', async () => {
      useModel(streamingText(['Pine', 'apple']));
      const controller = new AbortController();
      controller.abort();

      const out = await collect(new OllamaService().streamConversation([{ role: 'user', content: 'hi' }], { signal: controller.signal }));

      const last = out.at(-1);
      expect(isFailure(last) && last.code).toBe('ai.cancelled');
    });
  });
});

describe('Ollama structured generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the onToken path returns a mid-stream provider error as a failure, not a parsed object', async () => {
    useModel(streamingError(apiError(503)));

    const result = await new OllamaService().generateStructuredData('extract', z.object({ title: z.string() }), {
      onToken: vi.fn(),
    });

    expect(isFailure(result) && result.code).toBe('ai.provider_failed');
  });

  it('the onToken path returns a cut-off answer as IncompleteGeneration', async () => {
    useModel(streamingText(['{"title":', '"x"}'], 'length'));

    const result = await new OllamaService().generateStructuredData('extract', z.object({ title: z.string() }), {
      onToken: vi.fn(),
    });

    expect(isFailure(result) && result.code).toBe('ai.incomplete');
  });

  it('the onToken path returns the parsed object when the stream finishes', async () => {
    useModel(streamingText(['{"title":', '"x"}']));

    const result = await new OllamaService().generateStructuredData('extract', z.object({ title: z.string() }), {
      onToken: vi.fn(),
    });

    expect(result).toEqual({ title: 'x' });
  });

  it('a cut-off non-streaming answer is IncompleteGeneration', async () => {
    useModel(answering('{"title":"x"}', 'length'));

    const result = await new OllamaService().generateStructuredData('extract', z.object({ title: z.string() }));

    expect(isFailure(result) && result.code).toBe('ai.incomplete');
  });

  it('passes latency and residency settings to non-streaming generation', async () => {
    mockedGenerateText.mockRejectedValueOnce(apiError(500));
    const service = new OllamaService({ model: 'qwen3.6', think: false, keepAlive: '2m' });
    expect(isFailure(await service.generateStructuredData('extract', z.object({ title: z.string() })))).toBe(true);
    const factory = vi.mocked(createOllama).mock.results.at(-1)?.value;
    expect(factory).toHaveBeenCalledWith('qwen3.6', { think: false, keep_alive: '2m' });
  });
});
