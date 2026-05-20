import { describe, expect, it } from 'vitest';

import { countCharacters } from './countCharacters.js';

describe('countCharacters', () => {
  it('should work', () => {
    expect(countCharacters('23432')).toEqual(5);
  });
});
