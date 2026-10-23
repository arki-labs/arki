import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { rerank } from '../rerank/index.js';
import { createTransformersReranker } from './index.js';

// Opt-in: downloads bge-reranker-v2-m3 q8 (570 MB) and Qwen3-Reranker-0.6B q8 (1.2 GB) on the first
// run. Run with TRANSFORMERS_LIVE=1; TRANSFORMERS_CACHE_DIR keeps the weights outside the repository.
const cacheDir = process.env['TRANSFORMERS_CACHE_DIR'];
const documents = [
  'Berlin is the capital of Germany.',
  'Paris is the capital and largest city of France.',
  'France is a country in Western Europe.',
];

describe.skipIf(process.env['TRANSFORMERS_LIVE'] !== '1')('createTransformersReranker live', () => {
  for (const id of ['onnx-community/bge-reranker-v2-m3-ONNX', 'onnx-community/Qwen3-Reranker-0.6B-ONNX']) {
    it(`${id}: the model card's ranking, scores in (0, 1), the load reported once`, { timeout: 900_000 }, async () => {
      const reranker = await createTransformersReranker({ id, ...(cacheDir === undefined ? {} : { cacheDir }) });
      if (isFailure(reranker)) throw new Error(reranker.message);
      try {
        const first = await rerank(reranker, 'What is the capital of France?', documents, { text: item => item });
        if (isFailure(first)) throw new Error(first.message);
        expect(first.hits[0]?.item).toBe(documents[1]);
        for (const hit of first.hits) expect(hit.score > 0 && hit.score < 1).toBe(true);
        expect(first.usage.loadMs).toBeGreaterThan(0);
        expect(first.usage.tokens.basis).toBe('counted');

        // Romanian: several products are Romanian, and the default must rank it too.
        const romanian = await rerank(
          reranker,
          'Care este capitala Franței?',
          ['Berlin este capitala Germaniei.', 'Paris este capitala Franței.'],
          {
            text: item => item,
          },
        );
        if (isFailure(romanian)) throw new Error(romanian.message);
        expect(romanian.hits[0]?.item).toBe('Paris este capitala Franței.');
        expect(romanian.usage.loadMs).toBeUndefined();

        // The exact tokenizer sizes the windows: every one must fit, or the reranker refuses it.
        const long = `${'Filler sentence about nothing in particular. '.repeat(120)}Paris is the capital of France. ${'More filler text. '.repeat(120)}`;
        const split = await rerank(reranker, 'What is the capital of France?', [long, documents[0] ?? ''], {
          text: item => item,
          onTooLong: 'split',
        });
        if (isFailure(split)) throw new Error(split.message);
        expect(split.hits[0]?.item).toBe(long);
        const refused = await rerank(reranker, 'What is the capital of France?', [long], { text: item => item });
        expect(isFailure(refused) && refused.code).toBe('embeddings.input_too_long');
      } finally {
        await reranker.dispose?.();
      }
    });
  }
});
