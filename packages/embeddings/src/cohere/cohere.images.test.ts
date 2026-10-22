import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import { createEmbedder } from '../embedder.js';
import { RateLimited } from '../failures.js';
import { createCohereModel } from './index.js';

const PNG = Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);
const PNG_URI = 'data:image/png;base64,iVBORw0KGgo=';
const SIZE = 256;

type Call = { url: string; body: unknown };

/** The v2 envelope (https://docs.cohere.com/reference/embed): `embeddings.float` rows in input order, tagged by row. */
function stub(answer?: () => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (answer) return Promise.resolve(answer());
    const inputs = is(body, recordSchema) && Array.isArray(body['inputs']) ? body['inputs'] : [];
    const float = inputs.map((_, row) => Array.from({ length: SIZE }, (__, at) => (at === 0 ? row + 1 : 0)));
    return Promise.resolve(Response.json({ embeddings: { float }, meta: { billed_units: { input_tokens: 7 } } }));
  });
  return { fetch, calls };
}

function cohere(fetch: ReturnType<typeof stub>['fetch'], id?: string) {
  const model = createCohereModel({ apiKey: 'key', fetch, ...(id === undefined ? {} : { id }) });
  if (isFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model, { dimensions: SIZE });
  if (isFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}

describe('./cohere images', () => {
  // The documented v2 shape: `inputs` items, each a `content` array; no `texts` field beside it.
  it('sends mixed inputs as content arrays with a data-URI image', async () => {
    const { fetch, calls } = stub();
    const batch = await cohere(fetch).embed(['a', { image: PNG }, { text: 'b', image: PNG }], { purpose: 'document' });
    if (isFailure(batch)) throw new Error(batch.message);
    expect(calls[0]?.url).toBe('https://api.cohere.com/v2/embed');
    expect(calls[0]?.body).toEqual({
      model: 'embed-v4.0',
      inputs: [
        { content: [{ type: 'text', text: 'a' }] },
        { content: [{ type: 'image_url', image_url: { url: PNG_URI } }] },
        {
          content: [
            { type: 'text', text: 'b' },
            { type: 'image_url', image_url: { url: PNG_URI } },
          ],
        },
      ],
      input_type: 'search_document',
      embedding_types: ['float'],
      truncate: 'NONE',
      output_dimension: SIZE,
    });
    expect(batch.vectors.map(vector => vector[0])).toEqual([1, 2, 3]);
    expect(batch.usage.tokens).toEqual({ basis: 'reported', count: 7 });
  });

  it('a text-only call on embed-v4.0 still sends `texts`', async () => {
    const { fetch, calls } = stub(() =>
      Response.json({ embeddings: { float: [Array.from({ length: SIZE }, () => 0)] } }),
    );
    await cohere(fetch).embed(['a'], {});
    expect(calls[0]?.body).toMatchObject({ texts: ['a'] });
    expect(calls[0]?.body).not.toHaveProperty('inputs');
  });

  it('the v3 models stay text only', () => {
    const { fetch } = stub();
    const model = createCohereModel({ apiKey: 'key', fetch, id: 'embed-english-v3.0' });
    if (isFailure(model)) throw new Error(model.message);
    expect(model.inputs).toEqual(['text']);
    expect(model.embedInputs).toBeUndefined();
  });

  it('429 on an image call is RateLimited', async () => {
    const { fetch } = stub(() =>
      Response.json({ message: 'slow down' }, { status: 429, headers: { 'retry-after': '3' } }),
    );
    const result = await cohere(fetch).embed([{ image: PNG }], {});
    expect(RateLimited.is(result) && result.data.retryAfterMs).toBe(3000);
  });
});
