import { describe, expect, it, vi } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import type { EmbedFailure } from './failures.js';
import type { NativeEmbeddings, NativeInputsRequest } from './types.js';
import { createEmbedder } from './embedder.js';
import { InputTooLong, UnsupportedInput } from './failures.js';
import { echoTexts, stubModel, tracer } from './tests/stub-model.js';

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const instruction = { query: 'Q: ', version: 1 };

const answerInputs = ({ inputs }: NativeInputsRequest): Promise<NativeEmbeddings> =>
  Promise.resolve({ vectors: inputs.map((_, index) => tracer(index, 4)), tokens: { basis: 'unknown' } });

function build(facts: Parameters<typeof stubModel>[1], embedTexts: Parameters<typeof stubModel>[0] = echoTexts) {
  const embedder = createEmbedder(stubModel(embedTexts, { instruction, ...facts }));
  if (isFailure(embedder)) throw new Error(embedder.message);
  return embedder;
}

describe('image inputs', () => {
  // Otherwise a text-only provider embeds the rest of the input and the image is lost without a word.
  it('a text-only model refuses an image before dispatch', async () => {
    const embedTexts = vi.fn(echoTexts);
    const result = await build({}, embedTexts).embed(['a', { text: 'b', image: PNG }], {});
    expect(result).toEqual(UnsupportedInput({ index: 1, part: 'image' }));
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('a model listing images but missing embedInputs refuses too', async () => {
    const result = await build({ inputs: ['text', 'image'] }).embed([{ image: PNG }], {});
    expect(result).toEqual(UnsupportedInput({ index: 0, part: 'image' }));
  });

  // Prefixes are written for text; the provider needs each image's media type.
  it('a call with an image goes to embedInputs: prefixes on text only, the type read from the bytes', async () => {
    const embedInputs = vi.fn(answerInputs);
    const result = await build({ inputs: ['text', 'image'], embedInputs }).embed(
      ['cat', { image: PNG }, { text: 'dog', image: PNG, mimeType: 'image/jpeg' }],
      { purpose: 'query' },
    );
    expect(isFailure(result)).toBe(false);
    expect(embedInputs.mock.calls[0]?.[0].inputs).toEqual([
      { text: 'Q: cat' },
      { image: PNG, mimeType: 'image/png' },
      { text: 'Q: dog', image: PNG, mimeType: 'image/jpeg' },
    ]);
  });

  it('a text-only call on an image model still goes to embedTexts', async () => {
    const embedTexts = vi.fn(echoTexts);
    const embedInputs = vi.fn<(request: NativeInputsRequest) => Promise<NativeEmbeddings | EmbedFailure>>(answerInputs);
    orThrow(await build({ inputs: ['text', 'image'], embedInputs }, embedTexts).embed(['a', 'b'], {}));
    expect(embedTexts).toHaveBeenCalledOnce();
    expect(embedInputs).not.toHaveBeenCalled();
  });

  it('a stated media type no provider takes is refused before dispatch', async () => {
    const embedInputs = vi.fn(answerInputs);
    const result = await build({ inputs: ['text', 'image'], embedInputs }).embed(
      [{ image: PNG, mimeType: 'image/bmp' }],
      {},
    );
    expect(result).toEqual(UnsupportedInput({ index: 0, part: 'image' }));
    expect(embedInputs).not.toHaveBeenCalled();
  });

  it('an image in a format no provider takes is refused', async () => {
    const result = await build({ inputs: ['text', 'image'], embedInputs: answerInputs }).embed(
      [{ image: Uint8Array.of(1, 2, 3) }],
      {},
    );
    expect(result).toEqual(UnsupportedInput({ index: 0, part: 'image' }));
  });

  // The index must point at the caller's input, not at its place among the text parts.
  it('InputTooLong names the input even after an image-only one', async () => {
    const result = await build({ inputs: ['text', 'image'], embedInputs: answerInputs, maxInputTokens: 10 }).embed(
      [{ image: PNG }, 'word '.repeat(200)],
      {},
    );
    expect(InputTooLong.is(result) && result.data.index).toBe(1);
  });
});
