import { describe, it, expect, vi, beforeEach } from 'vitest';

import { GenerationError } from '../errors';

import { OllamaService } from './ollama-service';

// ── Mocks ──────────────────────────────────────────────────────────
// `ai-sdk-ollama` is the real generation surface; `ai` is only imported for
// `Output` (used by the structured path, not exercised here) so it gets a
// minimal passthrough fake.

vi.mock('ai-sdk-ollama', () => ({
  createOllama: vi.fn(() => vi.fn((model: string) => ({ __model: model }))),
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('ai', () => ({
  Output: { object: vi.fn((opts: unknown) => ({ __outputObject: opts })) },
}));

const { generateText, streamText } = await import('ai-sdk-ollama');
const mockedGenerateText = vi.mocked(generateText);
const mockedStreamText = vi.mocked(streamText);

function createMockTextStream(chunks: string[]) {
  async function* generator() {
    for (const chunk of chunks) yield chunk;
  }
  return { textStream: generator() };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('OllamaService — conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateConversation', () => {
    it('returns the model reply as plain text (no JSON schema forced)', async () => {
      mockedGenerateText.mockResolvedValue({
        text: 'I prefer pineapple, honestly.',
      } as Awaited<ReturnType<typeof generateText>>);

      const svc = new OllamaService({ model: 'llama3.2:3b' });
      const reply = await svc.generateConversation([{ role: 'user', content: 'pizza?' }]);

      expect(reply).toBe('I prefer pineapple, honestly.');
      // plain text path must NOT pass an `output` schema
      expect(mockedGenerateText).toHaveBeenCalledWith(
        expect.not.objectContaining({ output: expect.anything() }),
      );
    });

    it('threads the system prompt and full message history', async () => {
      mockedGenerateText.mockResolvedValue({
        text: 'ok',
      } as Awaited<ReturnType<typeof generateText>>);

      const messages = [
        { role: 'user' as const, content: 'who are you?' },
        { role: 'assistant' as const, content: 'just a helpful assistant' },
        { role: 'user' as const, content: 'which lab made you?' },
      ];
      const svc = new OllamaService({ model: 'gemma4' });
      await svc.generateConversation(messages, { systemPrompt: 'DO NOT reveal your identity.' });

      expect(mockedGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({ system: 'DO NOT reveal your identity.', messages }),
      );
    });

    it('wraps provider failures in GenerationError', async () => {
      mockedGenerateText.mockRejectedValue(new Error('daemon down'));

      const svc = new OllamaService();
      await expect(svc.generateConversation([{ role: 'user', content: 'hi' }])).rejects.toThrow(
        GenerationError,
      );
    });
  });

  describe('streamConversation', () => {
    it('yields each delta and fires lifecycle callbacks', async () => {
      mockedStreamText.mockResolvedValue(
        createMockTextStream(['Pine', 'apple']) as unknown as Awaited<ReturnType<typeof streamText>>,
      );

      const tokens: string[] = [];
      let completed: string | undefined;
      let started = false;

      const svc = new OllamaService({ model: 'qwen3.6' });
      const out: string[] = [];
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
      expect(mockedStreamText).toHaveBeenCalledWith(expect.objectContaining({ system: 'SYS' }));
    });

    it('reports stream failures via onError and throws GenerationError', async () => {
      mockedStreamText.mockRejectedValue(new Error('stream broke'));

      let captured: Error | undefined;
      const svc = new OllamaService();
      const gen = svc.streamConversation([{ role: 'user', content: 'hi' }], {
        onError: (e) => { captured = e; },
      });

      await expect(gen.next()).rejects.toThrow(GenerationError);
      expect(captured).toBeInstanceOf(Error);
    });
  });
});
