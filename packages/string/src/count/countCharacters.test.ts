import { describe, expect, it } from 'vitest';

import { countCharacters } from './countCharacters.js';

describe('countCharacters (deprecated)', () => {
  it('keeps the UTF-16 code-unit contract', () => {
    expect(countCharacters('23432')).toBe(5);
    expect(countCharacters()).toBe(0);
    expect(countCharacters('👍')).toBe(2);
  });
});
