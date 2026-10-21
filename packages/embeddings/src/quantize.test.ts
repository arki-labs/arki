import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { calibrateInt8, calibrationId, hamming, quantize, unpackBits } from './quantize.js';

describe('quantize binary', () => {
  // The bit order is a storage format: Qdrant, pgvector `bit` and FAISS all read the first dimension
  // from the most significant bit. Another order would silently scramble every stored vector.
  it('binary packs MSB first and round-trips through unpack', () => {
    const vector = Float32Array.of(0.3, -0.1, 0, 0.2, -0.5, -0.4, 0.9, 0.1, -0.2, 0.7, -0.1, -0.1, -0.1, -0.1, -0.1, 0.4);
    const bits = quantize(vector, 'binary');
    if (isFailure(bits)) throw new Error(bits.message);
    expect([...bits]).toEqual([0b1001_0011, 0b0100_0001]);
    expect([...unpackBits(bits, 16)]).toEqual(Array.from(vector, value => (value > 0 ? 1 : -1)));
  });

  it('a size that is not a multiple of 8 is refused', () => {
    const refused = quantize(new Float32Array(12).fill(1), 'binary');
    expect(isFailure(refused) && refused.data.part).toBe('dimensions');
  });

  it('hamming counts differing bits', () => {
    expect(hamming(Uint8Array.of(0b1010_0000, 0xFF), Uint8Array.of(0b0010_0000, 0x0F))).toBe(5);
    expect(hamming(Uint8Array.of(7), Uint8Array.of(7))).toBe(0);
  });
});

describe('quantize int8', () => {
  // Per-vector scaling maps every vector's own max to 127, so the same int8 value means different
  // floats in different vectors and dot products across vectors stop ranking correctly.
  it('int8 uses the shared calibration', () => {
    const calibration = calibrateInt8([Float32Array.of(-1, 0), Float32Array.of(1, 0.5)]);
    expect([...calibration.min]).toEqual([-1, 0]);
    expect([...calibration.max]).toEqual([1, 0.5]);
    const small = quantize(Float32Array.of(0, 0.25), 'int8', calibration);
    const large = quantize(Float32Array.of(1, 0.5), 'int8', calibration);
    if (isFailure(small) || isFailure(large)) throw new Error('refused');
    // The same float maps to the same int8 in every vector: 0 on [-1, 1] is the middle of -128…127.
    expect([...small]).toEqual([0, 0]);
    expect([...large]).toEqual([127, 127]);
    const outside = quantize(Float32Array.of(-3, 9), 'int8', calibration);
    if (isFailure(outside)) throw new Error(outside.message);
    expect([...outside]).toEqual([-128, 127]);
  });

  it('a calibration of another size is refused', () => {
    const calibration = calibrateInt8([Float32Array.of(-1, 1)]);
    const refused = quantize(Float32Array.of(0, 0, 0), 'int8', calibration);
    expect(isFailure(refused) && refused.data.part).toBe('dimensions');
  });

  // The id goes into the space id; equal ranges must name the same space on every runtime.
  it('calibrationId is stable and changes with the range', () => {
    const a = calibrateInt8([Float32Array.of(-1, 0), Float32Array.of(1, 0.5)]);
    const b = calibrateInt8([Float32Array.of(-1, 0), Float32Array.of(1, 0.5)]);
    expect(calibrationId(a)).toBe(calibrationId(b));
    expect(calibrationId(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(calibrationId(calibrateInt8([Float32Array.of(-1, 0), Float32Array.of(1, 0.6)]))).not.toBe(calibrationId(a));
  });
});
