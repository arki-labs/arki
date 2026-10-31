/**
 * `StructuredGenerator` and `analyzeContent` add no failure of their own: whatever the provider
 * returns reaches the caller unchanged. WHY it matters: a caller can only wait out a 429 or fix a key
 * when the exact provider failure survives these helpers instead of being rewrapped or thrown.
 * The provider is a stand-in for a paid model call; the failure is the real `RateLimited`.
 */
import { describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';

import type { StructuredLLMProvider } from './types';
import { analyzeContent } from '../capabilities/content-analysis';
import { RateLimited } from '../failures';
import { StructuredGenerator } from './structured-generation';

const limited = RateLimited({ retryAfterMs: 1500 });

const rateLimitedProvider: StructuredLLMProvider = {
  generateStructuredData: () => Promise.resolve(limited),
  generateStructuredDataFromMessages: () => Promise.resolve(limited),
  generateText: () => Promise.resolve(limited),
  // eslint-disable-next-line require-yield -- a stream that ends with its failure only
  async *streamConversation() {
    return;
  },
};

describe('StructuredGenerator', () => {
  const generator = new StructuredGenerator(rateLimitedProvider);

  it('returns the provider failure unchanged from every task', async () => {
    const results = await Promise.all([
      generator.generateSummary('text'),
      generator.answerQuestion('q', 'context'),
      generator.classifyText('text', ['a', 'b']),
      generator.extractEntities('text'),
      generator.analyzeSentiment('text'),
      generator.translateText('text', 'ro'),
      generator.generateCode('sort a list', 'typescript'),
      generator.generateQuestions('content'),
      generator.generateCustom('prompt', z.object({ ok: z.boolean() })),
    ]);
    for (const result of results) expect(result).toBe(limited);
    expect(limited.code).toBe('ai.rate_limited');
  });
});

describe('analyzeContent', () => {
  it('returns the provider failure unchanged', async () => {
    const result = await analyzeContent('article', 'title', 1, rateLimitedProvider);
    expect(result).toBe(limited);
  });
});
