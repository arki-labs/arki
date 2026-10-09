import { describe, expect, it } from 'vitest';

import {
  deduplicate,
  ensureEnd,
  ensureStart,
  mask,
  padBoth,
  padEnd,
  padStart,
  replaceEnd,
  replaceFirst,
  replaceLast,
  replaceStart,
  swap,
  trimPrefix,
  trimSuffix,
  unwrap,
  wrap,
} from './edit.js';
import { escapeHtml, escapeRegExp } from './escape.js';
import { interpolate } from './interpolate.js';

describe('replace*', () => {
  it('replaces literally', () => {
    expect(replaceFirst('aaa', 'a', '$&')).toBe('$&aa');
    expect(replaceLast('aaa', 'a', 'b')).toBe('aab');
    expect(replaceFirst('abc', 'z', 'y')).toBe('abc');
    expect(replaceStart('foobar', 'foo', 'x')).toBe('xbar');
    expect(replaceStart('barfoo', 'foo', 'x')).toBe('barfoo');
    expect(replaceEnd('foobar', 'bar', 'x')).toBe('foox');
    expect(replaceEnd('barfoo', 'bar', 'x')).toBe('barfoo');
    expect(() => replaceFirst('abc', '', 'x')).toThrow(TypeError);
    expect(replaceFirst('é', 'e', 'x')).toBe('é');
  });
});

describe('swap / deduplicate', () => {
  it('swaps without cascading and prefers the longest key', () => {
    expect(swap('ab', { a: 'b', b: 'c' })).toBe('bc');
    expect(swap('abc', { ab: '1', a: '2', abc: '3' })).toBe('3');
    expect(swap('hello', {})).toBe('hello');
    expect(() => swap('x', { '': 'y' })).toThrow(TypeError);
  });
  it('deduplicates adjacent tokens', () => {
    expect(deduplicate('a   b  c')).toBe('a b c');
    expect(deduplicate('a..b...c', '.')).toBe('a.b.c');
    expect(deduplicate('a--b', '-')).toBe('a-b');
    expect(() => deduplicate('x', '')).toThrow(TypeError);
  });
});

describe('wrap / unwrap / mask', () => {
  it('wrap and unwrap complete pairs only', () => {
    expect(wrap('x', '"')).toBe('"x"');
    expect(wrap('x', '[', ']')).toBe('[x]');
    expect(unwrap('"x"', '"')).toBe('x');
    expect(unwrap('[x]', '[', ']')).toBe('x');
    expect(unwrap('[x', '[', ']')).toBe('[x');
    expect(unwrap('"', '"')).toBe('"');
  });
  it('masks grapheme ranges', () => {
    expect(mask('secret')).toBe('******');
    expect(mask('taylor@example.com', { start: 3, end: -4 })).toBe('tay***********.com');
    expect(mask('ab👩‍💻cd', { start: 1, end: 3, glyph: '#' })).toBe('a##cd');
    expect(mask('abc', { start: 2, end: 1 })).toBe('abc');
    expect(() => mask('abc', { start: 0.5 })).toThrow(RangeError);
  });
});

describe('padding', () => {
  it('pads in graphemes', () => {
    expect(padBoth('x', 4, '.')).toBe('.x..');
    expect(padStart('👩‍💻', 3, '-')).toBe('--👩‍💻');
    expect(padEnd('a', 4, '👍🏽x')).toBe('a👍🏽x👍🏽');
    expect(padStart('abc', 2)).toBe('abc');
    expect(() => padStart('a', 3, '')).toThrow(TypeError);
    expect(() => padStart('a', -1)).toThrow(RangeError);
  });
});

describe('escape', () => {
  it('escapeHtml', () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;',
    );
  });
  it('escapeRegExp follows RegExp.escape semantics', () => {
    expect(escapeRegExp('a.b*c')).toBe(String.raw`\x61\.b\*c`);
    expect(escapeRegExp('.*+?^${}()|[]\\/')).toBe(String.raw`\.\*\+\?\^\$\{\}\(\)\|\[\]\\\/`);
    expect(escapeRegExp('1 2\t3')).toBe(String.raw`\x31\x202\t3`);
    expect(escapeRegExp('a-b,c')).toBe(String.raw`\x61\x2db\x2cc`);
    expect(escapeRegExp('é👍')).toBe('é👍');
    expect(escapeRegExp('\u2028')).toBe(String.raw`\u2028`);
    expect(escapeRegExp('\uD83D')).toBe(String.raw`\ud83d`);
    expect(escapeRegExp('')).toBe('');
    for (const sample of ['hello.world', '(1+1)*[2]', 'x|y', 'a\nb', '3.14']) {
      expect(new RegExp(`^${escapeRegExp(sample)}$`, 'u').test(sample)).toBe(true);
    }
  });
});

describe('interpolate', () => {
  it('renders flat values', () => {
    expect(interpolate('Hi {{ name }}, {{count}} new', { name: 'Ada', count: 3 })).toBe('Hi Ada, 3 new');
    expect(interpolate('{{ value }}', { value: false })).toBe('false');
    expect(interpolate('{{ value }}', { value: 0 })).toBe('0');
    expect(interpolate('[{{ value }}]', { value: null })).toBe('[]');
  });
  it('handles missing keys per policy', () => {
    expect(() => interpolate('{{ nope }}', {})).toThrow(ReferenceError);
    expect(() => interpolate('{{ value }}', { value: undefined })).toThrow(ReferenceError);
    expect(interpolate('a {{ nope }} b', {}, { missing: 'keep' })).toBe('a {{ nope }} b');
    expect(interpolate('a {{ nope }} b', {}, { missing: 'empty' })).toBe('a  b');
    expect(() => interpolate('{{ toString }}', {})).toThrow(ReferenceError);
  });
  it('escapes and rejects malformed placeholders', () => {
    expect(interpolate(String.raw`\{{ raw }} and \\ slash`, {})).toBe(String.raw`{{ raw }} and \ slash`);
    expect(() => interpolate('{{ open', {})).toThrow(SyntaxError);
    expect(() => interpolate('{{ a.b }}', {})).toThrow(SyntaxError);
    expect(() => interpolate('{{ }}', {})).toThrow(SyntaxError);
  });
});

describe('affixes', () => {
  it('ensureStart / ensureEnd are idempotent', () => {
    expect(ensureStart('path', '/')).toBe('/path');
    expect(ensureStart('/path', '/')).toBe('/path');
    expect(ensureEnd('path', '/')).toBe('path/');
    expect(ensureEnd('path/', '/')).toBe('path/');
    expect(ensureStart('x', '')).toBe('x');
    expect(ensureStart('é', 'e')).toBe('eé');
  });
  it('trimPrefix / trimSuffix remove one occurrence', () => {
    expect(trimPrefix('//a', '/')).toBe('/a');
    expect(trimSuffix('a.md', '.md')).toBe('a');
    expect(trimSuffix('a.md', '.txt')).toBe('a.md');
    expect(trimPrefix('x', '')).toBe('x');
  });
});
