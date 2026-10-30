import { describe, expect, expectTypeOf, it } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import { InvalidBase64, InvalidUtf8 } from './base64.js';
import { str, StringValue } from './fluent.js';
import { MissingValue } from './interpolate.js';

describe('str()', () => {
  it('preserves canonical interpolation refusals instead of wrapping them as text', () => {
    const result = str('{{ name }}').interpolate({});
    expectTypeOf<Exclude<typeof result, StringValue>>().toEqualTypeOf<ReturnType<typeof MissingValue>>();
    expect(MissingValue.is(result)).toBe(true);
    if (isFailure(result)) {
      expect(result.code).toBe(MissingValue.code);
    } else {
      expectTypeOf(result).toEqualTypeOf<StringValue>();
      throw new Error('Missing data must not become a StringValue');
    }
    expect(orThrow(str('{{ name }}').interpolate({}, { missing: 'keep' })).value()).toBe('{{ name }}');
    expect(orThrow(str('{{ name }}').interpolate({}, { missing: 'empty' })).value()).toBe('');
  });
  it('chains and extracts', () => {
    expect(str('  XML_http_request  ').squish().titleCase().truncate(24).value()).toBe('Xml Http Request');
    expect(str(' Ada@Example.COM ').trim().lower().value()).toBe('ada@example.com');
    expect(str('/articles/hello.md').after('/articles/').trimSuffix('.md').value()).toBe('hello');
    expect(str('x').wrap('"').toString()).toBe('"x"');
    expect(String(str('a'))).toBe('a');
    expect(JSON.stringify({ v: str('a') })).toBe('{"v":"a"}');
    expect(str(str('a'))).toBeInstanceOf(StringValue);
  });

  it('is immutable', () => {
    const original = str('abc');
    const upper = original.upper();
    expect(original.value()).toBe('abc');
    expect(upper.value()).toBe('ABC');
  });

  it('iterates graphemes and reports grapheme length', () => {
    const value = str('a👩‍💻b');
    expect([...value]).toEqual(['a', '👩‍💻', 'b']);
    expect(value.length).toBe(3);
    expect(value.at(1)).toBe('👩‍💻');
    // eslint-disable-next-line unicorn/no-array-reverse -- StringValue#reverse, not Array#reverse
    expect(value.reverse().value()).toBe('b👩‍💻a');
  });

  it('predicates and combinators', () => {
    expect(str('').isEmpty()).toBe(true);
    expect(str(' ').isEmpty()).toBe(false);
    expect(str(' \n').isBlank()).toBe(true);
    expect(str('a').equals('a')).toBe(true);
    expect(str('a').equals(str('b'))).toBe(false);
    expect(
      str('x')
        .when(true, v => v.append('!'))
        .value(),
    ).toBe('x!');
    expect(
      str('x')
        .when(
          v => v.isEmpty(),
          v => v.append('!'),
          v => v.append('?'),
        )
        .value(),
    ).toBe('x?');
    expect(
      str('')
        .whenEmpty(v => v.append('fallback'))
        .value(),
    ).toBe('fallback');
    expect(
      str('ab')
        .whenEmpty(v => v.append('fallback'))
        .value(),
    ).toBe('ab');
    expect(
      str('ab')
        .map(text => text.repeat(2))
        .value(),
    ).toBe('abab');
    expect(str('ab').pipe(v => v.length)).toBe(2);
    let seen = '';
    expect(
      str('ab')
        .tap(v => {
          seen = v.value();
        })
        .value(),
    ).toBe('ab');
    expect(seen).toBe('ab');
  });

  it('regex helpers never mutate the caller expression', () => {
    const pattern = /a/g;
    pattern.lastIndex = 1;
    expect(str('a').test(pattern)).toBe(true);
    expect(pattern.lastIndex).toBe(1);
    expect([...str('a1b2').scan(/\d/)].map(match => match[0])).toEqual(['1', '2']);
  });

  it('delegates to the function surface', () => {
    expect(str('foo bar').camelCase().value()).toBe('fooBar');
    expect(str('ab').swap({ a: 'b', b: 'c' }).value()).toBe('bc');
    expect(str('x').padBoth(4, '.').value()).toBe('.x..');
    expect(str('<b>').escapeHtml().value()).toBe('&lt;b&gt;');
    expect(orThrow(str('Hi {{ n }}').interpolate({ n: 'Ada' })).value()).toBe('Hi Ada');
    expect(orThrow(orThrow(str('hi').toBase64()).fromBase64()).value()).toBe('hi');
    expect(str('Ada Lovelace').initials().value()).toBe('AL');
    expect(str('a b c').words()).toEqual(['a', 'b', 'c']);
    expect(str('taylor@example.com').mask({ start: 3, end: -4 }).value()).toBe('tay***********.com');
    expect(str('x').excerpt('y')).toBeUndefined();
    expect(str('a-b').containsAny(['-'])).toBe(true);
    expect(str('Mihai Eminescu').slugify().value()).toBe('mihai-eminescu');
    expect(str('Привет').transliterate().value()).toBe('Privet');
  });
});

describe('literal searches are grapheme-aligned', () => {
  it('includes, startsWith, endsWith and replaceAll never match inside a grapheme', () => {
    const decomposed = str('é');
    expect(decomposed.includes('e')).toBe(false);
    expect(decomposed.startsWith('e')).toBe(false);
    expect(str('aé').endsWith('́')).toBe(false);
    expect(str('x').includes('')).toBe(true);
    expect(str('a-b').replaceAll('-', '$&').value()).toBe('a$&b');
    expect(str('ée').replaceAll('e', 'X').value()).toBe('éX');
  });

  it('length is cached on the immutable value', () => {
    const value = str('\u{1F468}‍\u{1F469}abc');
    expect(value.length).toBe(4);
    expect(value.length).toBe(4);
  });
});

it('fluent codecs preserve canonical failures and require narrowing before chaining', () => {
  expectTypeOf<ReturnType<StringValue['toBase64']>>().toEqualTypeOf<StringValue | ReturnType<typeof InvalidUtf8>>();
  expectTypeOf<ReturnType<StringValue['fromBase64']>>().toEqualTypeOf<
    StringValue | ReturnType<typeof InvalidUtf8> | ReturnType<typeof InvalidBase64>
  >();
  expect(InvalidUtf8.is(str('\uD800').toBase64())).toBe(true);
  expect(InvalidBase64.is(str('bad!').fromBase64())).toBe(true);
  expect(InvalidUtf8.is(str('/w==').fromBase64())).toBe(true);
  const value = str('aGk=').fromBase64();
  if (isFailure(value)) throw new Error(value.code);
  expect(value.upper().value()).toBe('HI');
});

describe('StringValue casing with a malformed locale tag', () => {
  it('falls back to locale-independent casing instead of throwing', () => {
    expect(str('abc').upper('xx_yy').toString()).toBe('ABC');
    expect(str('ABC').lower('not a locale!').toString()).toBe('abc');
  });
});
