import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';

import { embedMany } from '../embed.js';
import { createEmbedder } from '../embedder.js';
import { InvalidOutput, ModelUnavailable } from '../failures.js';
import { EMBEDDINGGEMMA_2_INSTRUCTION } from '../instructions.js';
import { countTokens } from '../tokens.js';
import { createTransformersModel } from './index.js';

/** What the mocked Transformers.js answers; each test sets it. */
const mock = vi.hoisted(() => {
  const state: {
    dims: number;
    output: 'pooled' | 'hidden' | 'broken';
    loads: number;
    disposals: number;
    fail: Error | undefined;
  } = { dims: 6, output: 'pooled', loads: 0, disposals: 0, fail: undefined };
  return state;
});

vi.mock('@huggingface/transformers', () => {
  const tokenizer = Object.assign(
    (texts: string[]) => {
      const length = Math.max(...texts.map(text => text.split(' ').length));
      const mask = texts.flatMap(text =>
        Array.from({ length }, (_, token) => (token < text.split(' ').length ? 1n : 0n)),
      );
      return { attention_mask: { dims: [texts.length, length], data: BigInt64Array.from(mask) } };
    },
    { model_max_length: 2048, encode: (text: string) => text.split(' ') },
  );
  const model = Object.assign(
    (encoding: { attention_mask: { dims: [number, number] } }) => {
      const [rows, tokens] = encoding.attention_mask.dims;
      if (mock.output === 'broken') return Promise.resolve({ logits: [] });
      if (mock.output === 'hidden') {
        // Token t of every row is the vector [t + 1, 0, …]: the masked mean is easy to predict.
        const data = new Float32Array(rows * tokens * mock.dims);
        for (let index = 0; index < rows * tokens; index++) data[index * mock.dims] = (index % tokens) + 1;
        return Promise.resolve({ last_hidden_state: { dims: [rows, tokens, mock.dims], data } });
      }
      const data = Float32Array.from({ length: rows * mock.dims }, (_, index) => (index % mock.dims) + 1);
      return Promise.resolve({ sentence_embedding: { dims: [rows, mock.dims], data } });
    },
    {
      dispose: () => {
        mock.disposals++;
        return Promise.resolve([]);
      },
    },
  );
  return {
    // A stand-in constructor: the adapter only checks `instanceof` on a load error.
    ModelFileNotFoundError: RangeError,
    AutoTokenizer: { from_pretrained: () => Promise.resolve(tokenizer) },
    AutoModel: {
      from_pretrained: async () => {
        mock.loads++;
        await new Promise(resolve => setTimeout(resolve, 5));
        if (mock.fail) throw mock.fail;
        return model;
      },
    },
  };
});

let cacheDir = 0;
/** A fresh cache dir per test is a fresh share key: loads never leak between tests. */
const fresh = () => ({ cacheDir: `cache-${++cacheDir}` });

beforeEach(() => {
  Object.assign(mock, { dims: 6, output: 'pooled', loads: 0, disposals: 0, fail: undefined });
});

describe('createTransformersModel', () => {
  // The stored index must match what the weights really produce, not what a table claims.
  it('dims come from the first output', async () => {
    const model = await createTransformersModel(fresh());
    if (isFailure(model)) throw new Error(model.message);
    expect(model.dimensions).toBe(6);
    expect(model.matryoshka).toEqual([]);
    expect(model.assurance).toBe('immutable');
    expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  // A known id gets its own pinned commit and card facts, or its space would drift with `main`.
  it('EmbeddingGemma 2 is pinned, with its own limits and prefixes', async () => {
    mock.dims = 768;
    const model = await createTransformersModel({ ...fresh(), id: 'onnx-community/embeddinggemma-2-ONNX' });
    if (isFailure(model)) throw new Error(model.message);
    expect(model).toMatchObject({
      revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0',
      assurance: 'immutable',
      matryoshka: [768, 512, 256, 128],
      maxInputTokens: 8192,
      instruction: EMBEDDINGGEMMA_2_INSTRUCTION,
    });
  });

  // Two records over one session: the session is freed once, after the last record lets go.
  it('dispose is called once', async () => {
    const options = fresh();
    const [first, second] = await Promise.all([createTransformersModel(options), createTransformersModel(options)]);
    if (isFailure(first) || isFailure(second)) throw new Error('load failed');
    await first.dispose?.();
    await first.dispose?.();
    expect(mock.disposals).toBe(0);
    await second.dispose?.();
    expect(mock.disposals).toBe(1);
    await expect(first.embedTexts({ texts: ['a'] })).rejects.toThrow(/after dispose/);
  });

  // A 316 MB model must not be loaded twice because two callers asked at once.
  it('concurrent creates share one load', async () => {
    const options = fresh();
    const models = await Promise.all([1, 2, 3].map(() => createTransformersModel(options)));
    expect(models.every(model => !isFailure(model))).toBe(true);
    expect(mock.loads).toBe(1);
  });

  // Telemetry sums loadMs: two records over one load must not count that load twice.
  it('a shared load reports loadMs once across records', async () => {
    const options = fresh();
    const [first, second] = await Promise.all([createTransformersModel(options), createTransformersModel(options)]);
    if (isFailure(first) || isFailure(second)) throw new Error('mocked load failed');
    const rows = await Promise.all([first, second, first].map(model => model.embedTexts({ texts: ['a'] })));
    const reported = rows.filter(row => !isFailure(row) && row.loadMs !== undefined);
    expect(reported).toHaveLength(1);
  });

  it('a failed load is a value and the next create tries again', async () => {
    const options = fresh();
    mock.fail = new RangeError('no such file');
    const missing = await createTransformersModel(options);
    expect(ModelUnavailable.is(missing) && missing.data.reason).toBe('unknown-model');
    mock.fail = undefined;
    expect(isFailure(await createTransformersModel(options))).toBe(false);
    expect(mock.loads).toBe(2);
  });

  // Token limits are enforced before any inference, so the count must come from the real tokenizer.
  it('counts tokens with the loaded tokenizer and reports them', async () => {
    const model = await createTransformersModel(fresh());
    if (isFailure(model)) throw new Error(model.message);
    expect(countTokens(model, 'one two three')).toEqual({ basis: 'counted', count: 3 });
    const embedder = createEmbedder(model);
    if (isFailure(embedder)) throw new Error(embedder.message);
    const batch = await embedMany(embedder, ['a b', 'c d e']);
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.usage.tokens).toEqual({ basis: 'counted', count: 5 });
    expect(batch.usage.loadMs).toBeGreaterThan(0);
  });

  // Padding tokens must not pull a short text's vector toward zero.
  it('a token-level output is mean-pooled over unmasked tokens only', async () => {
    mock.output = 'hidden';
    mock.dims = 2;
    const model = await createTransformersModel({ ...fresh(), id: 'Xenova/some-model' });
    if (isFailure(model)) throw new Error(model.message);
    const rows = await model.embedTexts({ texts: ['a', 'a b c'] });
    if (isFailure(rows)) throw new Error(rows.message);
    // Both rows are [mean, 0] normalised to [1, 0]; padding would have made the first [2/3 …] before normalising.
    expect(rows.vectors[0]).toEqual(Float32Array.of(1, 0));
    expect(rows.tokens).toEqual({ basis: 'counted', count: 4 });
    expect(model.revision).toBe('main');
    expect(model.assurance).toBe('mutable');
  });

  it('an output without embeddings is InvalidOutput', async () => {
    const model = await createTransformersModel(fresh());
    if (isFailure(model)) throw new Error(model.message);
    mock.output = 'broken';
    expect(InvalidOutput.is(await model.embedTexts({ texts: ['a'] }))).toBe(true);
  });
});
