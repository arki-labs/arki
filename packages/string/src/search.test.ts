import { describe, expect, it } from 'vitest';

import { after, before, between, containsAny, indexOf } from './search.js';

describe('before / after / between', () => {
  it('extracts around delimiters', () => {
    expect(before('a:b:c', ':')).toBe('a');
    expect(before('a:b:c', ':', 'last')).toBe('a:b');
    expect(after('a:b:c', ':')).toBe('b:c');
    expect(after('a:b:c', ':', 'last')).toBe('c');
    expect(between('[x](y)', '[', ']')).toBe('x');
    expect(between('a{b{c}d}', '{', '}')).toBe('b{c');
  });
  it('returns the input when a delimiter is absent', () => {
    expect(before('abc', ':')).toBe('abc');
    expect(after('abc', ':')).toBe('abc');
    expect(between('abc', '[', ']')).toBe('abc');
    expect(between('[abc', '[', ']')).toBe('[abc');
  });
  it('rejects empty delimiters and respects grapheme boundaries', () => {
    expect(() => before('abc', '')).toThrowError(/ARKI_STRING_E001/);
    expect(after('éx', 'e')).toBe('éx');
    expect(after('🇷🇴🇷🇴', '🇴')).toBe('🇷🇴🇷🇴');
  });
});

describe('containsAny / indexOf', () => {
  it('containsAny', () => {
    expect(containsAny('hello world', ['moon', 'world'])).toBe(true);
    expect(containsAny('hello world', [])).toBe(false);
    expect(containsAny('hello', ['x'])).toBe(false);
    expect(() => containsAny('hello', [''])).toThrowError(/ARKI_STRING_E001/);
  });
  it('indexOf is grapheme-indexed', () => {
    expect(indexOf('a👩‍💻b', 'b')).toBe(2);
    expect(indexOf('abab', 'ab', 1)).toBe(2);
    expect(indexOf('abc', 'z')).toBe(-1);
    expect(indexOf('abc', 'a', 10)).toBe(-1);
    expect(() => indexOf('abc', 'a', -1)).toThrowError(/ARKI_STRING_E001/);
  });
});
