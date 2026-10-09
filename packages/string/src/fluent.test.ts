import { describe, expect, it } from 'vitest';

import { str, StringValue } from './fluent.js';

describe('str()', () => {
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
    expect(str('Hi {{ n }}').interpolate({ n: 'Ada' }).value()).toBe('Hi Ada');
    expect(str('hi').toBase64().fromBase64().value()).toBe('hi');
    expect(str('Ada Lovelace').initials().value()).toBe('AL');
    expect(str('a b c').words()).toEqual(['a', 'b', 'c']);
    expect(str('taylor@example.com').mask({ start: 3, end: -4 }).value()).toBe('tay***********.com');
    expect(str('x').excerpt('y')).toBeUndefined();
    expect(str('a-b').containsAny(['-'])).toBe(true);
    expect(str('Mihai Eminescu').slugify().value()).toBe('mihai-eminescu');
    expect(str('Привет').transliterate().value()).toBe('Privet');
  });
});
