import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  deduplicate,
  ensureEnd,
  ensureStart,
  mask,
  padBoth,
  padEnd,
  padStart,
  replaceAll,
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
import type { InterpolateOptions } from './interpolate.js';
import { interpolate, MissingValue } from './interpolate.js';

describe('replace*', () => {
  it('replaces literally', () => {
    expect(replaceFirst('aaa', 'a', '$&')).toBe('$&aa');
    expect(replaceLast('aaa', 'a', 'b')).toBe('aab');
    expect(replaceFirst('abc', 'z', 'y')).toBe('abc');
    expect(replaceStart('foobar', 'foo', 'x')).toBe('xbar');
    expect(replaceStart('barfoo', 'foo', 'x')).toBe('barfoo');
    expect(replaceEnd('foobar', 'bar', 'x')).toBe('foox');
    expect(replaceEnd('barfoo', 'bar', 'x')).toBe('barfoo');
    expect(() => replaceFirst('abc', '', 'x')).toThrowError(/ARKI_STRING_E001/);
    expect(replaceFirst('é', 'e', 'x')).toBe('é');
  });
});

describe('swap / deduplicate', () => {
  it('swaps without cascading and prefers the longest key', () => {
    expect(swap('ab', { a: 'b', b: 'c' })).toBe('bc');
    expect(swap('abc', { ab: '1', a: '2', abc: '3' })).toBe('3');
    expect(swap('hello', {})).toBe('hello');
    expect(() => swap('x', { '': 'y' })).toThrowError(/ARKI_STRING_E001/);
  });
  it('deduplicates adjacent tokens', () => {
    expect(deduplicate('a   b  c')).toBe('a b c');
    expect(deduplicate('a..b...c', '.')).toBe('a.b.c');
    expect(deduplicate('a--b', '-')).toBe('a-b');
    expect(() => deduplicate('x', '')).toThrowError(/ARKI_STRING_E001/);
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
    expect(() => mask('abc', { start: 0.5 })).toThrowError(/ARKI_STRING_E001/);
  });
});

describe('padding', () => {
  it('pads in graphemes', () => {
    expect(padBoth('x', 4, '.')).toBe('.x..');
    expect(padStart('👩‍💻', 3, '-')).toBe('--👩‍💻');
    expect(padEnd('a', 4, '👍🏽x')).toBe('a👍🏽x👍🏽');
    expect(padStart('abc', 2)).toBe('abc');
    expect(() => padStart('a', 3, '')).toThrowError(/ARKI_STRING_E001/);
    expect(() => padStart('a', -1)).toThrowError(/ARKI_STRING_E001/);
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
    expect(interpolate('{{ nope }}', {})).toMatchObject({ code: 'string.missing_value' });
    expect(interpolate('{{ value }}', { value: undefined })).toMatchObject({ code: 'string.missing_value' });
    expect(interpolate('a {{ nope }} b', {}, { missing: 'keep' })).toBe('a {{ nope }} b');
    expect(interpolate('a {{ nope }} b', {}, { missing: 'empty' })).toBe('a  b');
    expect(interpolate('{{ toString }}', {})).toMatchObject({ code: 'string.missing_value' });
  });
  it('rejects the removed policy for JavaScript callers instead of silently dropping missing text', () => {
    expect(() => {
      // @ts-expect-error -- Exercise a JavaScript caller with the removed configuration value.
      return interpolate('{{ value }}', {}, { missing: 'throw' });
    }).toThrowError('Interpolation missing policy must be fail, keep or empty.');
  });
  it('stops before later values and never exposes partial text or the missing key', () => {
    let reads = 0;
    const values = {
      token: 'private-token',
      get later() {
        reads += 1;
        return 'unused';
      },
    };
    const result = interpolate('private-template {{ token }} {{ privateKey }} {{ later }}', values, {
      missing: 'fail',
    });

    expect(MissingValue.is(result)).toBe(true);
    expect(JSON.stringify(result)).toBe(JSON.stringify(MissingValue()));
    expect(reads).toBe(0);
  });
  it('accepts own prototype-named keys and Unicode values without treating falsy data as missing', () => {
    expect(interpolate('{{ toString }}', { toString: 'own value' })).toBe('own value');
    expect(interpolate('{{ nume }}', { nume: '👩‍💻 é' })).toBe('👩‍💻 é');
    expect(interpolate('{{ value }}', { value: null }, { missing: 'fail' })).toBe('');
    expect(MissingValue.is(interpolate('{{ constructor }}', {}))).toBe(true);
  });
  it('infers the canonical refusal and unwrapped success without the old throw policy', () => {
    expectTypeOf<Exclude<ReturnType<typeof interpolate>, string>>().toEqualTypeOf<ReturnType<typeof MissingValue>>();
    expectTypeOf<Extract<ReturnType<typeof interpolate>, string>>().toEqualTypeOf<string>();
    expectTypeOf<'throw'>().not.toMatchTypeOf<NonNullable<InterpolateOptions['missing']>>();
    const result = interpolate('{{ name }}', {});
    if (MissingValue.is(result)) {
      expectTypeOf(result.code).toEqualTypeOf<'string.missing_value'>();
    } else {
      expectTypeOf(result).toEqualTypeOf<string>();
    }
  });
  it('escapes and rejects malformed placeholders', () => {
    expect(interpolate(String.raw`\{{ raw }} and \\ slash`, {})).toBe(String.raw`{{ raw }} and \ slash`);
    expect(() => interpolate('{{ open', {})).toThrowError(/ARKI_STRING_E004/);
    expect(() => interpolate('{{ a.b }}', {})).toThrowError(/ARKI_STRING_E004/);
    expect(() => interpolate('{{ }}', {})).toThrowError(/ARKI_STRING_E004/);
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

describe('replacement strings are literal', () => {
  it('deduplicate keeps $& literal and replaceAll is grapheme-aligned', () => {
    expect(deduplicate('$&$&', '$&')).toBe('$&');
    expect(replaceAll('a-b-c', '-', '$&')).toBe('a$&b$&c');
    expect(replaceAll('é e', 'e', 'X')).toBe('é X');
    expect(replaceAll('aaa', 'aa', 'b')).toBe('ba');
    expect(replaceAll('abc', 'z', 'y')).toBe('abc');
    expect(() => replaceAll('abc', '', 'y')).toThrowError(/ARKI_STRING_E001/);
  });
});

describe('padding and mask keep their grapheme contract', () => {
  it('rejects fills that merge into neighbours', () => {
    expect(() => padEnd('a', 3, '́')).toThrowError(/ARKI_STRING_E001/);
    expect(() => padStart('a', 3, '\u{1F1F7}')).toThrowError(/ARKI_STRING_E001/);
    expect(padEnd('a', 3, '\u{1F1F7}\u{1F1F4}')).toBe('a\u{1F1F7}\u{1F1F4}\u{1F1F7}\u{1F1F4}');
    expect(() => mask('abc', { glyph: '́' })).toThrowError(/ARKI_STRING_E001/);
  });
});
