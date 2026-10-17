import { describe, expect, it } from 'vitest';

import { tweaksColumn, EMPTY_TWEAKS } from './tweaks-column.js';

describe('tweaksColumn', () => {
  it('returns a Drizzle jsonb column with default empty TweakStore', () => {
    const col = tweaksColumn();
    expect(col).toBeDefined();
    expect(typeof col).toBe('object');
  });
});

describe('EMPTY_TWEAKS', () => {
  it('has version 1 and empty global/pageScoped', () => {
    expect(EMPTY_TWEAKS).toEqual({
      version: 1,
      global: {},
      pageScoped: {},
    });
  });
});
