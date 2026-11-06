/**
 * `generateStructuredDataFromMessages` is the body every Ollama structured call runs, so its
 * failures are checked on it directly, not only through the `generateStructuredData` wrapper.
 */
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { isFailure } from '@arki/failure';

import { OllamaService } from './ollama-service';

// Keep the real `OllamaError`: the failure boundary checks it before it reads a schema mismatch.
vi.mock('ai-sdk-ollama', async importOriginal => ({
  ...(await importOriginal<typeof import('ai-sdk-ollama')>()),
  createOllama: vi.fn(() => vi.fn((model: string) => ({ __model: model }))),
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

const sdk = await vi.importActual<typeof import('ai')>('ai');
const { generateText } = await import('ai-sdk-ollama');
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
const schema = z.object({ title: z.string() });

describe('OllamaService.generateStructuredDataFromMessages returns each failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a daemon outage is ProviderFailed, not a throw', async () => {
    const error = new APICallError({
      message: 'down',
      url: 'http://localhost:11434',
      requestBodyValues: {},
      statusCode: 503,
    });
    useModel(new MockLanguageModelV4({ doGenerate: () => Promise.reject(error) }));

    const result = await new OllamaService({ maxRetries: 0 }).generateStructuredDataFromMessages(messages, schema);

    expect(isFailure(result) && result.code).toBe('ai.provider_failed');
  });

  it('a cut-off answer is IncompleteGeneration', async () => {
    useModel(answering('{"title":"x"}', 'length'));

    const result = await new OllamaService().generateStructuredDataFromMessages(messages, schema);

    expect(isFailure(result) && result.code).toBe('ai.incomplete');
  });

  it('an answer the schema rejects is InvalidOutput, not an unchecked object', async () => {
    // WHY: local models often answer with the wrong shape; the caller must see that, not a typed lie.
    useModel(answering('{"title":42}'));

    const result = await new OllamaService().generateStructuredDataFromMessages(messages, schema);

    expect(isFailure(result) && result.code).toBe('ai.invalid_output');
  });
});
