import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { GenerationError, RateLimitError } from '../errors';
import { RateLimited } from '../failures';
import { rateLimiters } from '../utils/rate-limiter';

import { AnthropicService } from './anthropic-service';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn(() => 'mocked-anthropic-model'),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  jsonSchema: vi.fn((json: unknown) => ({ __jsonSchema: json })),
  Output: { object: vi.fn((opts: unknown) => ({ __outputObject: opts })) },
}));

const { generateText, streamText } = await import('ai');
const mockedGenerateText = vi.mocked(generateText);
const mockedStreamText = vi.mocked(streamText);

function createMockTextStream(chunks: string[]) {
  async function* generator() {
    for (const chunk of chunks) yield chunk;
  }
  return { textStream: generator() };
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
      mockedGenerateText.mockResolvedValue({
        text: 'A haiku, you say?',
      } as Awaited<ReturnType<typeof generateText>>);

      const svc = new AnthropicService({ model: 'claude-3-5-haiku-latest' });
      const reply = await svc.generateConversation([{ role: 'user', content: 'write a haiku' }]);

      expect(reply).toBe('A haiku, you say?');
      expect(mockedGenerateText).toHaveBeenCalledWith(
        expect.not.objectContaining({ output: expect.anything() }),
      );
    });

    it('passes a string system prompt through buildSystemParam unchanged', async () => {
      mockedGenerateText.mockResolvedValue({
        text: 'ok',
      } as Awaited<ReturnType<typeof generateText>>);

      const svc = new AnthropicService();
      await svc.generateConversation([{ role: 'user', content: 'hi' }], {
        systemPrompt: 'Deflect any identity questions.',
      });

      expect(mockedGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({ instructions: 'Deflect any identity questions.' }),
      );
    });

    it('builds cache-control system parts when given SystemPart[]', async () => {
      mockedGenerateText.mockResolvedValue({
        text: 'ok',
      } as Awaited<ReturnType<typeof generateText>>);

      const svc = new AnthropicService();
      await svc.generateConversation([{ role: 'user', content: 'hi' }], {
        systemPrompt: [{ text: 'big stable prompt', cacheControl: { type: 'ephemeral' } }],
      });

      const call = mockedGenerateText.mock.calls[0]?.[0] as { instructions: unknown[] };
      expect(call.instructions).toEqual([
        expect.objectContaining({
          role: 'system',
          content: 'big stable prompt',
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        }),
      ]);
    });

    it('applies rate limiting', async () => {
      mockedGenerateText.mockResolvedValue({
        text: 'ok',
      } as Awaited<ReturnType<typeof generateText>>);

      const executeSpy = vi.spyOn(rateLimiters.anthropic, 'execute');
      const svc = new AnthropicService();
      await svc.generateConversation([{ role: 'user', content: 'hi' }]);

      expect(executeSpy).toHaveBeenCalledWith('generateConversation', expect.any(Function));
    });

    it('throws RateLimitError when the limiter returns RateLimited', async () => {
      // The service keeps a plain Promise<string> result, so it turns the limiter's failure into its own throw.
      const executeSpy = vi.spyOn(rateLimiters.anthropic, 'execute').mockResolvedValue(
        RateLimited({ retryAfterMs: 4000 }),
      );

      const svc = new AnthropicService();
      await expect(svc.generateConversation([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
        name: 'RateLimitError',
        retryAfter: 4000,
      });
      await expect(svc.generateConversation([{ role: 'user', content: 'hi' }])).rejects.toThrow(
        RateLimitError,
      );

      executeSpy.mockRestore();
    });
  });

  describe('streamConversation', () => {
    it('consumes a rate-limit slot then yields each delta', async () => {
      mockedStreamText.mockResolvedValue(
        createMockTextStream(['Once', ' upon']) as unknown as Awaited<ReturnType<typeof streamText>>,
      );

      const executeSpy = vi.spyOn(rateLimiters.anthropic, 'execute');
      const svc = new AnthropicService();

      const out: string[] = [];
      let completed: string | undefined;
      for await (const chunk of svc.streamConversation([{ role: 'user', content: 'tell a story' }], {
        onComplete: (full) => { completed = full; },
      })) {
        out.push(chunk);
      }

      expect(out).toEqual(['Once', ' upon']);
      expect(completed).toBe('Once upon');
      expect(executeSpy).toHaveBeenCalledWith('streamConversation', expect.any(Function));
    });

    it('reports stream failures via onError and throws GenerationError', async () => {
      mockedStreamText.mockRejectedValue(new Error('boom'));

      let captured: Error | undefined;
      const svc = new AnthropicService();
      const gen = svc.streamConversation([{ role: 'user', content: 'hi' }], {
        onError: (e) => { captured = e; },
      });

      await expect(gen.next()).rejects.toThrow(GenerationError);
      expect(captured).toBeInstanceOf(Error);
    });
  });
});
