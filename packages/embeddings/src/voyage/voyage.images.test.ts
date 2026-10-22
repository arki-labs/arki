import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

import { createEmbedder } from '../embedder.js';
import { createVoyageModel } from './index.js';

const PNG = Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);
const PNG_URI = 'data:image/png;base64,iVBORw0KGgo=';
const SIZE = 1024;

type Call = { url: string; body: unknown };

/** The envelope of https://docs.voyageai.com/reference/multimodal-embeddings-api: `data[]` with `index`, and `usage.total_tokens`. Rows come back reversed to prove index order wins. */
function stub(answer?: () => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (answer) return Promise.resolve(answer());
    const inputs = is(body, recordSchema) && Array.isArray(body['inputs']) ? body['inputs'] : [];
    const data = inputs
      .map((_, index) => ({
        object: 'embedding',
        index,
        embedding: Array.from({ length: SIZE }, (__, at) => (at === 0 ? index + 1 : 0)),
      }))
      .toReversed();
    return Promise.resolve(
      Response.json({
        object: 'list',
        data,
        model: 'voyage-multimodal-3.5',
        usage: { text_tokens: 2, image_pixels: 100, total_tokens: 9 },
      }),
    );
  });
  return { fetch, calls };
}

function voyage(fetch: ReturnType<typeof stub>['fetch'], id = 'voyage-multimodal-3.5') {
  const model = createVoyageModel({ apiKey: 'key', fetch, id });
  if (isFailure(model)) throw new Error(model.message);
  const embedder = createEmbedder(model);
  if (isFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}

describe('./voyage images', () => {
  it('sends mixed inputs to the multimodal endpoint with a base64 data-URI image', async () => {
    const { fetch, calls } = stub();
    const batch = await voyage(fetch).embed(['a', { image: PNG }, { text: 'b', image: PNG }], { purpose: 'document' });
    if (isFailure(batch)) throw new Error(batch.message);
    expect(calls[0]?.url).toBe('https://api.voyageai.com/v1/multimodalembeddings');
    expect(calls[0]?.body).toEqual({
      model: 'voyage-multimodal-3.5',
      inputs: [
        { content: [{ type: 'text', text: 'a' }] },
        { content: [{ type: 'image_base64', image_base64: PNG_URI }] },
        {
          content: [
            { type: 'text', text: 'b' },
            { type: 'image_base64', image_base64: PNG_URI },
          ],
        },
      ],
      input_type: 'document',
      truncation: false,
    });
    expect(batch.vectors.map(vector => vector[0])).toEqual([1, 2, 3]);
    expect(batch.usage.tokens).toEqual({ basis: 'reported', count: 9 });
  });

  // `/v1/embeddings` does not serve the multimodal models, so their text calls use the same endpoint.
  it('a text-only call on the multimodal model still uses the text path, on the multimodal endpoint', async () => {
    const { fetch, calls } = stub();
    const batch = await voyage(fetch).embed(['a', 'b'], {});
    expect(isFailure(batch)).toBe(false);
    expect(calls[0]?.url).toBe('https://api.voyageai.com/v1/multimodalembeddings');
    expect(calls[0]?.body).toMatchObject({
      inputs: [{ content: [{ type: 'text', text: 'a' }] }, { content: [{ type: 'text', text: 'b' }] }],
    });
  });

  it('the text models stay text only', () => {
    const model = createVoyageModel({ apiKey: 'key' });
    if (isFailure(model)) throw new Error(model.message);
    expect(model.inputs).toEqual(['text']);
    expect(model.embedInputs).toBeUndefined();
  });

  // Sizes and dtypes are not documented for the multimodal endpoint, so they are refused before the request.
  it('a smaller size or int8 is refused before the request', () => {
    const model = createVoyageModel({ apiKey: 'key', id: 'voyage-multimodal-3.5' });
    if (isFailure(model)) throw new Error(model.message);
    expect(isFailure(createEmbedder(model, { dimensions: 512 }))).toBe(true);
    expect(isFailure(createEmbedder(model, { quantization: 'int8' }))).toBe(true);
  });

  it('401 on an image call is ConfigurationFailure', async () => {
    const { fetch } = stub(() => Response.json({ detail: 'bad key' }, { status: 401 }));
    const result = await voyage(fetch).embed([{ image: PNG }], {});
    expect(isFailure(result) && result.code).toBe('embeddings.configuration');
  });
});
