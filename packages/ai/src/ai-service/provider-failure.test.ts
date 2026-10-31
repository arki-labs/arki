/**
 * The one boundary from AI SDK throws and stream parts to returned failures. WHY it matters: a
 * caller can only wait out a 429, fix a key, or tell the user "refused" when each of those comes
 * back as its own failure; when they all look like one `GenerationError` string, the caller retries
 * a bad key forever and shows a cut-off answer as complete.
 */
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { APICallError, NoObjectGeneratedError, RetryError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { OllamaError } from 'ai-sdk-ollama';
import { describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import {
  Cancelled,
  ContentFiltered,
  IncompleteGeneration,
  InvalidOutput,
  ProviderFailed,
  ProviderUnauthorized,
  RateLimited,
} from '../failures';
import { adaptLanguageModel } from './factory';
import { providerFailure, retryAfterMs } from './provider-failure';

const call = { provider: 'test', model: 'mock' };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const objectResponse = { id: 'r', timestamp: new Date(0), modelId: 'mock' };
const objectUsage = {
  inputTokens: 1,
  inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 1,
  outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
  totalTokens: 2,
};

function apiError(statusCode: number | undefined, responseHeaders?: Record<string, string>): APICallError {
  return new APICallError({ message: `status ${statusCode}`, url: 'https://x', requestBodyValues: {}, statusCode, responseHeaders });
}

function adapted(model: MockLanguageModelV4) {
  return adaptLanguageModel(model, { provider: 'test', model: 'mock', temperature: 0, maxRetries: 0, deterministicSeed: undefined });
}

function answering(text: string, unified: 'stop' | 'length' | 'content-filter') {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({ content: [{ type: 'text', text }], finishReason: { unified, raw: unified }, usage, warnings: [] }),
  });
}

function streaming(chunks: LanguageModelV4StreamPart[]) {
  return new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks }) }) });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

describe('providerFailure: SDK errors become typed failures', () => {
  it('a 429 is RateLimited with the Retry-After wait', () => {
    const failure = providerFailure(apiError(429, { 'Retry-After': '3' }), call);
    expect(RateLimited.is(failure) && failure.data).toEqual({ retryAfterMs: 3000 });
  });

  it('a 429 inside the RetryError the SDK throws after its own retries is still RateLimited', () => {
    const error = new RetryError({ message: 'gave up', reason: 'maxRetriesExceeded', errors: [apiError(429, { 'retry-after-ms': '250' })] });
    const failure = providerFailure(error, call);
    expect(RateLimited.is(failure) && failure.data.retryAfterMs).toBe(250);
  });

  it('401 and 403 are ProviderUnauthorized, not a retryable outage', () => {
    expect(providerFailure(apiError(401), call).code).toBe('ai.unauthorized');
    const forbidden = providerFailure(apiError(403), call);
    expect(ProviderUnauthorized.is(forbidden) && forbidden.data).toEqual({ ...call, status: 403 });
  });

  it('a server error or a network failure is ProviderFailed', () => {
    const failure = providerFailure(apiError(503), call);
    expect(ProviderFailed.is(failure) && failure.data.status).toBe(503);
    expect(providerFailure(apiError(undefined), call).code).toBe('ai.provider_failed');
  });

  it('a schema the answer does not match is InvalidOutput; a cut-off object is IncompleteGeneration', () => {
    const bad = new NoObjectGeneratedError({ message: 'no object', text: '{', response: objectResponse, usage: objectUsage, finishReason: 'stop' });
    expect(providerFailure(bad, call).code).toBe('ai.invalid_output');
    const cut = new NoObjectGeneratedError({ message: 'no object', text: '{', response: objectResponse, usage: objectUsage, finishReason: 'length' });
    expect(providerFailure(cut, call).code).toBe('ai.incomplete');
  });

  it('an aborted caller signal is Cancelled, whatever was thrown', () => {
    const controller = new AbortController();
    controller.abort();
    expect(providerFailure(apiError(500), { ...call, signal: controller.signal }).code).toBe('ai.cancelled');
    expect(providerFailure(new DOMException('aborted', 'AbortError'), call).code).toBe('ai.cancelled');
  });

  it('an Ollama HTTP error keeps its status; an Ollama that cannot be reached is ProviderFailed', () => {
    // WHY: the local default provider wraps every client throw in OllamaError; without this a
    // stopped Ollama or a 429 from it came back as a defect instead of an outage or a rate limit.
    const http = (status_code: number) =>
      new OllamaError({ message: `status ${status_code}`, cause: Object.assign(new Error('x'), { status_code }) });
    expect(providerFailure(http(429), call).code).toBe('ai.rate_limited');
    expect(providerFailure(http(500), call)).toMatchObject({ code: 'ai.provider_failed', data: { status: 500 } });
    const down = new OllamaError({ message: 'fetch failed', cause: new TypeError('fetch failed') });
    expect(providerFailure(down, call).code).toBe('ai.provider_failed');
  });

  it('an unknown throw is a supervised UnexpectedDefect, never an expected refusal', () => {
    expect(UnexpectedDefect.is(providerFailure(new TypeError('bug'), call))).toBe(true);
  });

  it('retryAfterMs reads seconds, milliseconds and HTTP dates, and ignores junk', () => {
    expect(retryAfterMs({ 'retry-after': '2' })).toBe(2000);
    expect(retryAfterMs({ 'retry-after-ms': '40' })).toBe(40);
    expect(retryAfterMs({ 'retry-after': 'Wed, 21 Oct 2015 07:28:05 GMT' }, Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(5000);
    expect(retryAfterMs({ 'retry-after': 'soon' })).toBeUndefined();
    expect(retryAfterMs(undefined)).toBeUndefined();
  });
});

describe('the adapter returns failures instead of looking successful (F1, F3, F4)', () => {
  it('generateText: a `length` finish is IncompleteGeneration, not the partial text', async () => {
    const result = await adapted(answering('partial', 'length')).generateText('go');
    expect(IncompleteGeneration.is(result) && result.data.finishReason).toBe('length');
  });

  it('generateTextResult: a `content-filter` finish is ContentFiltered', async () => {
    const result = await adapted(answering('', 'content-filter')).generateTextResult('go');
    expect(ContentFiltered.is(result)).toBe(true);
  });

  it('generateText: a complete answer is the text itself', async () => {
    expect(await adapted(answering('done', 'stop')).generateText('go')).toBe('done');
  });

  it('generateStructuredData: a provider 429 is RateLimited, not a thrown GenerationError', async () => {
    const model = new MockLanguageModelV4({ doGenerate: () => Promise.reject(apiError(429, { 'retry-after': '1' })) });
    const result = await adapted(model).generateStructuredData('go', z.object({ a: z.string() }));
    expect(RateLimited.is(result) && result.data.retryAfterMs).toBe(1000);
  });

  it('generateStructuredData: JSON the schema rejects is InvalidOutput', async () => {
    const result = await adapted(answering('{"a":1}', 'stop')).generateStructuredData('go', z.object({ a: z.string() }));
    expect(InvalidOutput.is(result)).toBe(true);
  });

  it('streamConversation: an error part after text ends the stream with the failure, and onError gets it', async () => {
    // WHY: the AI SDK ends `textStream` quietly after an error part; reading it made `hel` look like a whole answer.
    const model = streaming([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', delta: 'hel' },
      { type: 'error', error: apiError(429, { 'retry-after': '2' }) },
    ]);
    const seen: string[] = [];
    const items = await collect(
      adapted(model).streamConversation([{ role: 'user', content: 'hi' }], { onError: failure => seen.push(failure.code) }),
    );
    expect(items.slice(0, -1)).toEqual(['hel']);
    const last = items.at(-1);
    expect(RateLimited.is(last) && last.data.retryAfterMs).toBe(2000);
    expect(seen).toEqual(['ai.rate_limited']);
  });

  it('streamConversation: a `length` finish ends with IncompleteGeneration; a `stop` finish ends on text', async () => {
    const parts = (unified: 'stop' | 'length'): LanguageModelV4StreamPart[] => [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', delta: 'ab' },
      { type: 'text-end', id: '1' },
      { type: 'finish', finishReason: { unified, raw: unified }, usage },
    ];
    const cut = await collect(adapted(streaming(parts('length'))).streamConversation([{ role: 'user', content: 'hi' }]));
    expect(cut.at(-1)).toSatisfy(item => IncompleteGeneration.is(item));
    const whole = await collect(adapted(streaming(parts('stop'))).streamConversation([{ role: 'user', content: 'hi' }]));
    expect(whole).toEqual(['ab']);
    expect(whole.some(item => isFailure(item))).toBe(false);
  });

  it('streamConversation: an aborted signal ends with Cancelled', async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      },
    });
    const items = await collect(adapted(model).streamConversation([{ role: 'user', content: 'hi' }], { signal: controller.signal }));
    expect(Cancelled.is(items.at(-1))).toBe(true);
  });
});
