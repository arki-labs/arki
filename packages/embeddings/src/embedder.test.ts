import { describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';

import type { NativeRequest } from './types.js';
import { createEmbedder } from './embedder.js';
import { InvalidOutput, UnsupportedInput } from './failures.js';
import { calibrateInt8, calibrationId } from './quantize.js';
import { isSameSpace, spaceId } from './space.js';
import { QWEN3_INSTRUCTION } from './instructions.js';
import { echoTexts, stubModel } from './tests/stub-model.js';

/** An embedder over a model whose native call answers exactly `vectors`. */
function answering(vectors: readonly (readonly number[])[], facts: Parameters<typeof stubModel>[1] = {}) {
  const embedder = createEmbedder(stubModel(() => Promise.resolve({ vectors, tokens: { basis: 'unknown' as const } }), facts));
  if (isFailure(embedder)) throw new Error('stub embedder refused its own defaults');
  return embedder;
}

describe('createEmbedder validates every response', () => {
  it('wrong count is InvalidOutput', async () => {
    const result = await answering([[1, 0, 0, 0]]).embed(['a', 'b'], {});
    expect(isFailure(result) && result.code).toBe('embeddings.invalid_output');
  });

  // A model record with the wrong size must fail loudly, never be silently adopted into an index.
  it('wrong dims is InvalidOutput and names both numbers', async () => {
    const result = await answering([Array.from({ length: 768 }, () => 0.1)], { dimensions: 1024, matryoshka: [] }).embed(
      ['a'],
      {},
    );
    expect(isFailure(result) && result.code).toBe('embeddings.invalid_output');
    expect(InvalidOutput.is(result) && result.data.reason).toContain('expected 1024, got 768');
  });

  it('NaN is InvalidOutput', async () => {
    const result = await answering([[1, Number.NaN, 0, 0]]).embed(['a'], {});
    expect(InvalidOutput.is(result) && result.data.reason).toContain('non-finite');
  });

  // A zero vector would match everything at cosine 0 and poison a search index.
  it('zero-norm vector is InvalidOutput', async () => {
    const result = await answering([
      [1, 0, 0, 0],
      [0, 0, 0, 0],
    ]).embed(['a', 'b'], {});
    expect(InvalidOutput.is(result) && result.data.reason).toBe('zero-norm at index 1');
  });

  // The space is what an index stores; it must name the size and dtype the vectors really have.
  it('space reflects dimensions and quantization options', async () => {
    const embedder = createEmbedder(stubModel(echoTexts, { quantizations: ['int8'] }), {
      dimensions: 2,
      quantization: 'int8',
    });
    if (isFailure(embedder)) throw new Error('refused a listed truncation');
    expect(embedder.space).toMatchObject({ dimensions: 2, quantization: 'int8' });
    const batch = await embedder.embed(['t1'], {});
    if (isFailure(batch)) throw new Error(batch.message);
    expect(batch.vectors[0]).toBeInstanceOf(Int8Array);
    expect(batch.space).toEqual(embedder.space);
  });

  it('refuses dimensions outside matryoshka', () => {
    const refused = createEmbedder(stubModel(echoTexts, { matryoshka: [4, 2] }), { dimensions: 3 });
    expect(isFailure(refused) && refused.code).toBe('embeddings.unsupported_input');
    expect(UnsupportedInput.is(refused) && refused.data.part).toBe('dimensions');
    // Client-side int8 needs the corpus's shared range; without it there is no right scale.
    const uncalibrated = createEmbedder(stubModel(echoTexts), { quantization: 'int8' });
    expect(UnsupportedInput.is(uncalibrated) && uncalibrated.data.part).toBe('quantization');
    // Binary packs eight dimensions per byte; 4 dimensions do not fill one.
    const unpackable = createEmbedder(stubModel(echoTexts), { quantization: 'binary' });
    expect(UnsupportedInput.is(unpackable) && unpackable.data.part).toBe('dimensions');
  });

  // Qwen3 was trained with the prefix on queries and without it on documents.
  it('query instruction is prefixed only for purpose query', async () => {
    const seen: string[][] = [];
    const spy = vi.fn(async (request: NativeRequest) => {
      seen.push([...request.texts]);
      return echoTexts(request);
    });
    const embedder = createEmbedder(stubModel(spy, { instruction: QWEN3_INSTRUCTION }));
    if (isFailure(embedder)) throw new Error('refused defaults');
    await embedder.embed(['what is rain'], { purpose: 'query' });
    await embedder.embed(['rain is water'], { purpose: 'document' });
    await embedder.embed(['plain'], {});
    expect(seen).toEqual([[`${QWEN3_INSTRUCTION.query ?? ''}what is rain`], ['rain is water'], ['plain']]);
  });

  it('refuses a batch over maxBatch and an image the model cannot read', async () => {
    const embedder = createEmbedder(stubModel(echoTexts, { maxBatch: 2 }));
    if (isFailure(embedder)) throw new Error('refused defaults');
    const big = await embedder.embed(['a', 'b', 'c'], {});
    expect(isFailure(big) && big.data).toEqual({ index: 2, part: 'batch' });
    const image = await embedder.embed(['a', { image: new Uint8Array(1) }], {});
    expect(isFailure(image) && image.data).toEqual({ index: 1, part: 'image' });
  });
});

/** A native call answering one fixed 8-dim float vector per text. */
const eight = (request: NativeRequest) =>
  Promise.resolve({
    vectors: request.texts.map(() => [0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5]),
    tokens: { basis: 'unknown' as const },
  });

describe('createEmbedder makes the dtype the provider cannot', () => {

  // A provider without native binary still gets cheap first-pass vectors, and is asked for floats.
  it('binary is packed here from validated floats', async () => {
    const native = vi.fn(eight);
    const embedder = createEmbedder(stubModel(native, { dimensions: 8, matryoshka: [] }), { quantization: 'binary' });
    if (isFailure(embedder)) throw new Error(embedder.message);
    const batch = await embedder.embed(['a'], {});
    if (isFailure(batch)) throw new Error(batch.message);
    expect(native.mock.calls[0]?.[0].quantization).toBeUndefined();
    expect([...batch.vectors[0] ?? []]).toEqual([0b1010_1100]);
    expect(batch.space).toMatchObject({ dimensions: 8, quantization: 'binary' });
    expect(batch.space.calibration).toBeUndefined();
  });

  // Two int8 indexes are comparable only with the same calibration, so the space must name it.
  it('int8 with a calibration is made here and the space names the calibration', async () => {
    const calibration = calibrateInt8([new Float32Array(8).fill(-0.5), new Float32Array(8).fill(0.5)]);
    const embedder = createEmbedder(stubModel(eight, { dimensions: 8, matryoshka: [], quantizations: ['int8'] }), {
      quantization: 'int8',
      calibration,
    });
    if (isFailure(embedder)) throw new Error(embedder.message);
    const batch = await embedder.embed(['a'], {});
    if (isFailure(batch)) throw new Error(batch.message);
    expect([...batch.vectors[0] ?? []]).toEqual([127, -128, 127, -128, 127, 127, -128, -128]);
    expect(batch.space).toEqual(embedder.space);
    expect(spaceId(batch.space)).toContain(`/i8@${calibrationId(calibration)}/`);
    const other = calibrateInt8([new Float32Array(8).fill(-1), new Float32Array(8).fill(1)]);
    const otherEmbedder = createEmbedder(stubModel(eight, { dimensions: 8, matryoshka: [] }), {
      quantization: 'int8',
      calibration: other,
    });
    if (isFailure(otherEmbedder)) throw new Error(otherEmbedder.message);
    expect(isSameSpace(otherEmbedder.space, embedder.space)).toBe(false);
  });

  it('a calibration of another size is refused at creation and per call', async () => {
    const calibration = calibrateInt8([new Float32Array(4).fill(1)]);
    const refused = createEmbedder(stubModel(eight, { dimensions: 8, matryoshka: [4] }), {
      quantization: 'int8',
      calibration,
    });
    expect(UnsupportedInput.is(refused) && refused.data.part).toBe('dimensions');
    const embedder = createEmbedder(stubModel(eight, { dimensions: 8, matryoshka: [4] }), { calibration });
    if (isFailure(embedder)) throw new Error(embedder.message);
    const call = await embedder.embed(['a'], { quantization: 'int8' });
    expect(UnsupportedInput.is(call) && call.data.part).toBe('dimensions');
  });
});
