import { describe, expect, it } from 'vitest';

import { hashCode } from './hash.js';

describe('hashCode', () => {
  it('matches Java String.hashCode magnitudes for ASCII', () => {
    // "hello".hashCode() in Java is 99162322; "" is 0.
    expect(hashCode('hello')).toBe(99_162_322);
    expect(hashCode('')).toBe(0);
  });

  it('is non-negative and fits in 32 bits even when the signed hash overflows', () => {
    // "polygenelubricants" is the canonical Java example whose hashCode is Integer.MIN_VALUE.
    expect(hashCode('polygenelubricants')).toBe(2_147_483_648);
    for (const text of ['a', 'Hyphenation', 'what-is-hyphenation', '👩‍💻', 'ü'.repeat(100)]) {
      const value = hashCode(text);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(2_147_483_648);
    }
  });

  it('is deterministic and sensitive to order', () => {
    expect(hashCode('abc')).toBe(hashCode('abc'));
    expect(hashCode('abc')).not.toBe(hashCode('cba'));
  });
});
