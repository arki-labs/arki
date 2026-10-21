import { describe, expect, it } from 'vitest';

import { assert, is } from './assert.js';
import { parse } from './parse.js';
import { plainObjectSchema, recordSchema } from './schemas.js';

class Point {
  x = 1;
}

describe('recordSchema', () => {
  it('accepts any non-null non-array object, because it only promises string-keyed reads', () => {
    for (const value of [{}, new Point(), new Date(), Object.create(null)]) expect(is(value, recordSchema)).toBe(true);
    for (const value of [[], null, 'x', () => 1]) expect(is(value, recordSchema)).toBe(false);
  });

  it('returns the very same object, because a check must not copy', () => {
    const input = new Point();
    expect(parse(recordSchema, input)).toBe(input);
  });
});

describe('plainObjectSchema', () => {
  it('also demands an Object.prototype or null prototype, so class instances and dates are out', () => {
    expect(is({}, plainObjectSchema)).toBe(true);
    expect(is(Object.create(null), plainObjectSchema)).toBe(true);
    for (const value of [new Point(), new Date(), [], null]) expect(is(value, plainObjectSchema)).toBe(false);
  });

  it('fails with one fixed message that never includes the value', () => {
    expect(() => {
      assert('sk-secret', plainObjectSchema);
    }).toThrow(/Expected a plain object\./);
    expect(() => {
      assert('sk-secret', plainObjectSchema);
    }).not.toThrow(/sk-secret/);
  });
});
