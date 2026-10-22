import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import { createEmbedder } from '../embedder.js';
import { RateLimited } from '../failures.js';
import { createGoogleModel } from './index.js';

const PNG = Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);
const PNG_BASE64 = 'iVBORw0KGgo=';
const SIZE = 768;

type Call = { url: string; headers: unknown; body: unknown };

/** What a request asks for, as a number the answer carries in its first value: 1 image, 2 text and image, 3 text. */
function tagOf(request: unknown): number {
  const content = is(request, recordSchema) ? request['content'] : undefined;
  const parts = is(content, recordSchema) && Array.isArray(content['parts']) ? content['parts'] : [];
  const hasImage = parts.some(part => is(part, recordSchema) && 'inlineData' in part);
  const hasText = parts.some(part => is(part, recordSchema) && 'text' in part);
  if (hasImage) return hasText ? 2 : 1;
  return 3;
}

/** Answers like https://ai.google.dev/gemini-api/docs/embeddings (`{ embeddings: [{ values }] }`), one row per request, tagged by what the request held. */
function stubFetch(answer?: () => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, headers: init.headers, body });
    if (answer) return Promise.resolve(answer());
    const requests = is(body, recordSchema) && Array.isArray(body['requests']) ? body['requests'] : [];
    const embeddings = requests.map(request => ({
      values: Array.from({ length: SIZE }, (_, at) => (at === 0 ? tagOf(request) : 0)),
    }));
    return Promise.resolve(Response.json({ embeddings }));
  });
  return { fetch, calls };
}

function google(fetch: ReturnType<typeof stubFetch>['fetch'], id = 'gemini-embedding-2') {
  const model = createGoogleModel({ apiKey: 'test-key', id, fetch });
  if (isFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model, { dimensions: SIZE });
  if (isFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}

describe('./google images', () => {
  // The plan's name: every input gets its own request, so a mix of text, image and both must not reorder.
  it('google aligned arrays keep input order', async () => {
    const stub = stubFetch();
    const batch = await google(stub.fetch).embed(['a', { image: PNG }, { text: 'b', image: PNG }, { image: PNG }], {});
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.vectors.map(vector => vector[0])).toEqual([3, 1, 2, 1]);
  });

  // The documented REST shape: one request per input, text part then inline image part, both in one content.
  it('sends one request per input with text and inline image parts', async () => {
    const stub = stubFetch();
    await google(stub.fetch).embed(['a', { text: 'b', image: PNG }], { purpose: 'query' });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents',
    );
    expect(stub.calls[0]?.headers).toMatchObject({ 'x-goog-api-key': 'test-key' });
    expect(stub.calls[0]?.body).toEqual({
      requests: [
        {
          model: 'models/gemini-embedding-2',
          content: { parts: [{ text: 'task: search result | query: a' }] },
          outputDimensionality: SIZE,
        },
        {
          model: 'models/gemini-embedding-2',
          content: {
            parts: [
              { text: 'task: search result | query: b' },
              { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
            ],
          },
          outputDimensionality: SIZE,
        },
      ],
    });
  });

  // Text-only calls keep the SDK path: the stub sees `:batchEmbedContents` from the SDK, not our `parts` of `inlineData`.
  it('a text-only call on embedding-2 still uses the text path', async () => {
    const stub = stubFetch();
    const batch = await google(stub.fetch).embed(['a', 'b'], {});
    expect(isFailure(batch)).toBe(false);
    expect(JSON.stringify(stub.calls[0]?.body)).not.toContain('inlineData');
  });

  it('gemini-embedding-001 stays text only and refuses an image before the request', async () => {
    const stub = stubFetch();
    const result = await google(stub.fetch, 'gemini-embedding-001').embed([{ image: PNG }], {});
    expect(isFailure(result) && result.code).toBe('embeddings.unsupported_input');
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('429 on an image call is RateLimited', async () => {
    const stub = stubFetch(() =>
      Response.json({ error: { code: 429, message: 'quota' } }, { status: 429, headers: { 'retry-after': '2' } }),
    );
    const result = await google(stub.fetch).embed([{ image: PNG }], {});
    expect(RateLimited.is(result) && result.data.retryAfterMs).toBe(2000);
  });

  // A short answer would attach vectors to the wrong inputs.
  it('a wrong row count is InvalidOutput', async () => {
    const stub = stubFetch(() => Response.json({ embeddings: [{ values: Array.from({ length: SIZE }, () => 0) }] }));
    const result = await google(stub.fetch).embed([{ image: PNG }, { image: PNG }], {});
    expect(isFailure(result) && result.code).toBe('embeddings.invalid_output');
  });
});
