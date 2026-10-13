import { describe, expect, expectTypeOf, it } from 'vitest';

import type { FieldsArg, PlaceholderNames } from './template.js';
import { cachedTemplateCount, parseTemplate, placeholderNames, renderTemplate } from './template.js';

describe('renderTemplate', () => {
  it('fills placeholders from fields', () => {
    expect(renderTemplate('user {userId} signed in', { userId: 'usr_1' })).toBe('user usr_1 signed in');
  });

  it('turns {{ and }} into literal braces, and leaves the name inside untouched', () => {
    expect(renderTemplate('{{literal}} and {value}', { literal: 'NO', value: 'yes' })).toBe('{literal} and yes');
  });

  it('keeps a placeholder with no value as {name}, so a missing field is visible in the output', () => {
    expect(renderTemplate('hello {name}', {})).toBe('hello {name}');
    expect(renderTemplate('hello {name}', { name: undefined })).toBe('hello {name}');
  });

  it('fills a repeated placeholder every time', () => {
    expect(renderTemplate('{a}-{a}-{a}', { a: 1 })).toBe('1-1-1');
  });

  it('treats {} and an unclosed brace as text', () => {
    expect(renderTemplate('empty {} and open { brace', {})).toBe('empty {} and open { brace');
  });

  it('formats non-string values readably', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    expect(
      renderTemplate('{n} {b} {nil} {big} {at} {list} {obj} {err}', {
        n: 1.5,
        b: false,
        nil: null,
        big: 10n,
        at,
        list: [1, 'x'],
        obj: { k: 'v' },
        err: new TypeError('bad'),
      }),
    ).toBe('1.5 false null 10 2026-01-02T03:04:05.000Z [1,"x"] {"k":"v"} TypeError: bad');
  });

  it('does not read inherited properties as values', () => {
    expect(renderTemplate('{toString}', {})).toBe('{toString}');
  });
});

describe('parseTemplate', () => {
  it('splits literal text and placeholder names', () => {
    expect(parseTemplate('a {x} b {y}')).toEqual(['a ', 'x', ' b ', 'y', '']);
  });

  it('returns the cached parse for the same template', () => {
    const template = `cache-check-${Math.random()}`;
    expect(parseTemplate(template)).toBe(parseTemplate(template));
  });

  it('keeps the cache bounded', () => {
    for (let index = 0; index < 1500; index++) parseTemplate(`bounded {x} ${index}`);
    expect(cachedTemplateCount()).toBeLessThanOrEqual(1000);
  });

  it('lists placeholder names once each, in order', () => {
    expect(placeholderNames('{b} {a} {b} {{c}}')).toEqual(['b', 'a']);
  });
});

// Typed no-op loggers: the type tests below call them at runtime harmlessly.
const info = <T extends string>(_template: T, ..._args: FieldsArg<T, never>): void => undefined;
const bound = <T extends string>(_template: T, ..._args: FieldsArg<T, 'orderId'>): void => undefined;

describe('placeholder types', () => {
  it('extracts placeholder names the way the parser does', () => {
    expectTypeOf<PlaceholderNames<'user {userId} in {org}'>>().toEqualTypeOf<'userId' | 'org'>();
    expectTypeOf<PlaceholderNames<'{{escaped}} {real}'>>().toEqualTypeOf<'real'>();
    expectTypeOf<PlaceholderNames<'{a{b}'>>().toEqualTypeOf<'b'>();
    expectTypeOf<PlaceholderNames<'no placeholders'>>().toEqualTypeOf<never>();
    expect(placeholderNames('{a{b}')).toEqual(['b']);
  });

  it('makes a missing placeholder field a compile error', () => {
    info('user {userId} signed in', { userId: 'usr_1' });
    info('user {userId} signed in', { userId: 'usr_1', extra: true });
    // @ts-expect-error -- `user` does not satisfy `{userId}`
    info('user {userId} signed in', { user: 'usr_1' });
    // @ts-expect-error -- fields are required when the template has a placeholder
    info('user {userId} signed in');
    info('user {userId} signed in', () => ({ userId: 'usr_1' }));
    expect(true).toBe(true);
  });

  it('lets a bound field satisfy a placeholder', () => {
    bound('charged {orderId}', { amount: 42 });
    bound('charged {orderId}');
    // @ts-expect-error -- `amount` is neither bound nor passed
    bound('charged {orderId} {amount}', { other: 1 });
    expect(true).toBe(true);
  });

  it('accepts any fields when the template is a plain string', () => {
    const template = `dynamic ${String(Date.now())} {x}`;
    info(template, { anything: 1 });
    info(template);
    expect(true).toBe(true);
  });
});
