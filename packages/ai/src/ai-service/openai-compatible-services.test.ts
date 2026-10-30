/**
 * The Google, Groq, Mistral and OpenRouter services share one promise: when the local rate limiter
 * has no free slot, the call resolves to `RateLimited` (with the wait) instead of throwing, and no
 * paid request is sent. A caller can then wait `retryAfterMs` and try again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimited } from '../failures';
import { rateLimiters } from '../utils/rate-limiter';
import { GoogleService } from './google-service';
import { GroqService } from './groq-service';
import { MistralService } from './mistral-service';
import { OpenRouterService } from './openrouter-service';

vi.mock('../env.ts', () => ({
  env: {
    GOOGLE_GENERATIVE_AI_API_KEY: 'test-key',
    GROQ_API_KEY: 'test-key',
    MISTRAL_API_KEY: 'test-key',
    OPENROUTER_API_KEY: 'test-key',
  },
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

const { generateText } = await import('ai');
const messages = [{ role: 'user' as const, content: 'hi' }];

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
