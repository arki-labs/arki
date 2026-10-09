import { describe, expect, it } from 'vitest';

import { isRoundingMode, ROUNDING_MODES } from './rounding.js';

describe('rounding', () => {
  it('lists the eight modes', () => {
    expect(ROUNDING_MODES).toHaveLength(8);
    expect(new Set(ROUNDING_MODES).size).toBe(8);
  });

  it.each(ROUNDING_MODES)('recognizes %s', mode => {
    expect(isRoundingMode(mode)).toBe(true);
  });

  it.each(['HALF_EVEN', 'half_even', '', 'round', 1, null, undefined, {}])('rejects %s', value => {
    expect(isRoundingMode(value)).toBe(false);
  });
});
