/**
 * Every capability returns its failures with an exact code instead of throwing. WHY it matters: a
 * caller branches on the code (retry a rate limit, show "no grounded answer"); a model answer that
 * breaks its schema or cites nothing real must never reach the user as if it were an answer.
 *
 * The model is a stand-in for a paid or local model call; the failures and checks are the real ones.
 * The Ollama-backed capabilities build their own `OllamaService`, so `ai-sdk-ollama`'s generation
 * functions run the real AI SDK against a mock model, as in `ollama-service.test.ts`.
 */
import type * as AiSdk from 'ai';
import type * as AiSdkOllama from 'ai-sdk-ollama';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';

import { createFakeLLMProvider } from '../testing';
import { answerEpisodeQuestion } from './ask';
import { nameCluster } from './cluster-naming';
import { classifyConnection } from './connection-classification';
import { classifyIntent } from './intent-classification';
import { suggestPipIntervals } from './pips';
import { selectPodHopMoments } from './podhop';
import { arrangeQueue } from './queue';

vi.mock('ai-sdk-ollama', async importOriginal => ({
  ...(await importOriginal<typeof AiSdkOllama>()),
  createOllama: vi.fn(() => vi.fn((model: string) => ({ __model: model }))),
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

const sdk = await vi.importActual<typeof AiSdk>('ai');
const { generateText } = await import('ai-sdk-ollama');
const mockedGenerateText = vi.mocked(generateText);

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that gives `answers` in order, one per call, as JSON text. */
function answering(...answers: unknown[]) {
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: () => {
      const text = JSON.stringify(answers[call]);
      call += 1;
      return Promise.resolve({
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' } as const,
        usage,
        warnings: [],
      });
    },
  });
  mockedGenerateText.mockImplementation(options => sdk.generateText({ ...options, model }));
}

function rateLimited() {
  mockedGenerateText.mockRejectedValue(
    new APICallError({ message: 'status 429', url: 'http://localhost:11434', requestBodyValues: {}, statusCode: 429 }),
  );
}

const transcript = {
  language: 'en',
  segments: [
    { start: 0, end: 4, text: 'Forests store carbon in their soil and roots.' },
    { start: 4, end: 8, text: 'Rivers carry that carbon down to the sea.' },
  ],
};

describe('capabilities with a caller provider return the provider failure', () => {
  // An answer that breaks the capability's schema is InvalidOutput, never a half-typed value.
  it('nameCluster: an answer missing fields is InvalidOutput', async () => {
    const result = await nameCluster(['Rust 2.0 ships'], createFakeLLMProvider({ answers: [{ name: 'Rust' }] }));
    expect(isFailure(result) && result.code).toBe('ai.invalid_output');
  });

  it('classifyConnection: a confidence above 1 is InvalidOutput', async () => {
    const provider = createFakeLLMProvider({
      answers: [{ connectionType: 'related', explanation: 'Same topic.', confidence: 2 }],
    });
    const result = await classifyConnection('Passage A', 'Passage B', provider);
    expect(isFailure(result) && result.code).toBe('ai.invalid_output');
  });

  it('classifyIntent: an intent outside the list is InvalidOutput', async () => {
    const provider = createFakeLLMProvider({ answers: [{ intent: 'dance', requiresRAG: true }] });
    const result = await classifyIntent('What did I read this week?', provider);
    expect(isFailure(result) && result.code).toBe('ai.invalid_output');
  });
});

describe('Ollama-backed capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('return the provider failure of the generation as it came (a 429 is RateLimited)', async () => {
    rateLimited();
    const results = await Promise.all([
      answerEpisodeQuestion({ question: 'What stores carbon?', at: 2, history: [] }, transcript, 'gemma4'),
      suggestPipIntervals(transcript, 4, 'gemma4'),
      selectPodHopMoments(transcript),
      arrangeQueue({ episodes: [{ id: 'a', mediaKey: 'a'.repeat(64), title: 'Sleep', summary: '' }] }, [], 'gemma4'),
    ]);
    expect(results.map(result => isFailure(result) && result.code)).toEqual([
      'ai.rate_limited',
      'ai.rate_limited',
      'ai.rate_limited',
      'ai.rate_limited',
    ]);
  });

  it('answerEpisodeQuestion: background that cites a passage is UngroundedOutput', async () => {
    // Background is general knowledge: a source id in it would pass model text off as episode evidence.
    answering({ episodeAnswer: null, background: 'As source_0 says, forests.', clarification: null, citations: [] });
    const result = await answerEpisodeQuestion(
      { question: 'What stores carbon?', at: 2, history: [] },
      transcript,
      'gemma4',
    );
    expect(isFailure(result) && result.code).toBe('ai.ungrounded_output');
  });

  it('suggestPipIntervals: no complete sentence near the anchor is UngroundedOutput, with no model call', async () => {
    const result = await suggestPipIntervals(transcript, 1000, 'gemma4');
    expect(isFailure(result) && result.code).toBe('ai.ungrounded_output');
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  it('selectPodHopMoments: no distinct passage is UngroundedOutput, with no model call', async () => {
    const result = await selectPodHopMoments({ language: 'en', segments: [{ start: 0, end: 1, text: 'Hi.' }] });
    expect(isFailure(result) && result.code).toBe('ai.ungrounded_output');
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  it('selectPodHopMoments: a route the self-review rejects is UngroundedOutput', async () => {
    answering(
      {
        language: 'en',
        mixedLanguage: false,
        moments: [
          {
            title: 'Carbon in forests',
            introduction: 'Notice how the speaker links forests and the soil beneath them.',
            evidence: 'Forests store carbon in their soil and roots.',
          },
        ],
      },
      { reason: 'The introduction adds a claim.', faithful: false, sameLanguage: true, preservesContext: true },
    );
    const result = await selectPodHopMoments(transcript);
    expect(isFailure(result) && result.code).toBe('ai.ungrounded_output');
  });

  it('arrangeQueue: an order that repeats an episode is UngroundedOutput', async () => {
    // A model that drops or repeats an episode must not silently change the listener's queue.
    answering({
      placements: [
        { id: 'a', reason: 'First.' },
        { id: 'a', reason: 'Again.' },
      ],
    });
    const episodes = ['a', 'b'].map(id => ({ id, mediaKey: id.repeat(64), title: `Episode ${id}`, summary: '' }));
    const result = await arrangeQueue({ episodes }, [], 'gemma4');
    expect(isFailure(result) && result.code).toBe('ai.ungrounded_output');
  });
});
