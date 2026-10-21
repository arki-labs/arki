import { describe, expect, it } from 'vitest';

import type { EmbeddingSpace } from './types.js';
import { isSameSpace, spaceId } from './space.js';

const qwen: EmbeddingSpace = {
  provider: 'ollama',
  model: 'qwen3-embedding:0.6b',
  revision: 'sha256:ab12',
  dimensions: 1024,
  normalized: true,
  quantization: 'float32',
  instructionVersion: 1,
};

describe('spaceId', () => {
  // The string is stored in app databases; a format change strands every index.
  it('spaceId is stable and readable', () => {
    expect(spaceId(qwen)).toBe('ollama/qwen3-embedding:0.6b@sha256:ab12/1024/l2/f32/i1');
    const { revision: _revision, ...unpinned } = qwen;
    expect(spaceId({ ...unpinned, normalized: false, quantization: 'binary', dimensions: 256 })).toBe(
      'ollama/qwen3-embedding:0.6b/256/raw/bin/i1',
    );
    expect(spaceId({ ...qwen, quantization: 'int8' })).toContain('/i8/');
    expect(spaceId({ ...qwen, quantization: 'int8', calibration: '0123456789abcdef' })).toBe(
      'ollama/qwen3-embedding:0.6b@sha256:ab12/1024/l2/i8@0123456789abcdef/i1',
    );
  });
});

describe('isSameSpace', () => {
  // An index created before Ollama's digest was known must still match; a re-pulled model must not.
  it('isSameSpace ignores a missing revision on one side but not a different one', () => {
    const { revision: _revision, ...unpinned } = qwen;
    expect(isSameSpace(qwen, unpinned)).toBe(true);
    expect(isSameSpace(unpinned, qwen)).toBe(true);
    expect(isSameSpace(qwen, { ...qwen, revision: 'sha256:cd34' })).toBe(false);
    expect(isSameSpace(qwen, { ...qwen, dimensions: 512 })).toBe(false);
    expect(isSameSpace(qwen, { ...qwen, instructionVersion: 2 })).toBe(false);
  });
});

describe('isSameSpace and calibrations', () => {
  // Int8 made with one range is not comparable with int8 made with another, nor with provider int8.
  it('two calibrations, or a calibration and none, are different spaces', () => {
    const int8 = { ...qwen, quantization: 'int8' as const };
    expect(isSameSpace({ ...int8, calibration: 'aaaaaaaaaaaaaaaa' }, { ...int8, calibration: 'aaaaaaaaaaaaaaaa' })).toBe(true);
    expect(isSameSpace({ ...int8, calibration: 'aaaaaaaaaaaaaaaa' }, { ...int8, calibration: 'bbbbbbbbbbbbbbbb' })).toBe(false);
    expect(isSameSpace({ ...int8, calibration: 'aaaaaaaaaaaaaaaa' }, int8)).toBe(false);
  });
});
