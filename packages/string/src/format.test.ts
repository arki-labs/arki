import { describe, expect, it } from 'vitest';

import { collapseWhitespace, excerpt, initials, squish, truncate, wrapText } from './format.js';

describe('whitespace', () => {
  it('collapseWhitespace keeps one leading/trailing space', () => {
    expect(collapseWhitespace(' \tA\r\n B\u00A0 ')).toBe(' A B ');
  });
  it('squish', () => {
    expect(squish(' \tA\r\n B\u00A0 ')).toBe('A B');
    expect(squish(squish('  a   b  '))).toBe(squish('  a   b  '));
  });
  it('does not strip zero-width characters', () => {
    expect(squish('a\u200Bb')).toBe('a\u200Bb');
  });
});

describe('initials', () => {
  it('picks first and last by default', () => {
    expect(initials(' Ada   Lovelace ')).toBe('AL');
    expect(initials('Ada King Lovelace')).toBe('AL');
    expect(initials('Ada King Lovelace', { pick: 'first' })).toBe('AK');
    expect(initials('Ada King Lovelace', { max: 3 })).toBe('AKL');
    expect(initials('ada')).toBe('A');
    expect(initials('')).toBe('');
    expect(initials('émile zola')).toBe('ÉZ');
    expect(initials('👩‍💻 dev')).toBe('👩‍💻D');
    expect(() => initials('x', { max: 0 })).toThrow(RangeError);
  });
});

describe('truncate', () => {
  it('enforces a total grapheme budget', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abcdef', 1)).toBe('…');
    expect(truncate('abcdef', 0)).toBe('');
    expect(truncate('abcd', 4)).toBe('abcd');
    expect(truncate('abcdef', 5, { ellipsis: '...' })).toBe('ab...');
    expect(truncate('abcdef', 2, { ellipsis: '...' })).toBe('..');
    expect(truncate('👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦', 2)).toBe('👨‍👩‍👧‍👦…');
    expect(() => truncate('x', -1)).toThrow(RangeError);
  });
  it('backs up to a word boundary', () => {
    expect(truncate('alpha beta', 8, { boundary: 'word-before' })).toBe('alpha…');
    expect(truncate('alpha beta gamma', 11, { boundary: 'word-before' })).toBe('alpha beta…');
    expect(truncate('alphabetagamma', 6, { boundary: 'word-before' })).toBe('alpha…');
  });
});

describe('excerpt', () => {
  const text = 'The quick brown fox jumps over the lazy dog';
  it('returns context around the match', () => {
    expect(excerpt(text, 'fox', { radius: 6 })).toBe('…brown fox jumps…');
    expect(excerpt(text, 'The', { radius: 5 })).toBe('The quic…');
    expect(excerpt(text, 'dog', { radius: 5 })).toBe('…lazy dog');
    expect(excerpt(text, 'cat')).toBeUndefined();
    expect(excerpt(text, 'fox')).toBe(text);
    expect(excerpt('é', 'e')).toBeUndefined();
    expect(() => excerpt(text, '')).toThrow(TypeError);
  });
});

describe('wrapText', () => {
  it('wraps greedily and keeps existing breaks', () => {
    expect(wrapText('the quick brown fox', 10)).toBe('the quick\nbrown fox');
    expect(wrapText('a\n\nb', 10)).toBe('a\n\nb');
    expect(wrapText('supercalifragilistic', 5)).toBe('supercalifragilistic');
    expect(wrapText('supercalifragilistic', 5, { breakWords: true })).toBe('super\ncalif\nragil\nistic');
    expect(wrapText('a b', 1, { newline: '<br>' })).toBe('a<br>b');
    expect(() => wrapText('x', 0)).toThrow(RangeError);
  });
});
