import { describe, expect, it } from 'vitest';

import { formatIssues, pathOf } from './issues.js';

const id = Symbol('id');

describe('pathOf', () => {
  it('unwraps { key } segments, so every validator reports the same path', () => {
    // Valibot writes path segments as objects; zod writes plain keys. Callers compare paths.
    expect(pathOf({ message: 'x', path: [{ key: 'user' }, 'tags', { key: 0 }] })).toEqual(['user', 'tags', 0]);
  });

  it('keeps number and symbol keys as they are', () => {
    expect(pathOf({ message: 'x', path: [1, id, { key: id }] })).toEqual([1, id, id]);
  });

  it('returns a plain array when the validator uses an Array subclass, so paths compare equal', () => {
    // ArkType's path is an Array subclass with extra fields; `.map` would keep the subclass.
    class Path extends Array<PropertyKey> {
      readonly cache = {};
    }
    const path = Path.from(['user', 'age']);
    expect(Object.getPrototypeOf(pathOf({ message: 'x', path }))).toBe(Array.prototype);
  });

  it('is empty for an issue about the whole value', () => {
    expect(pathOf({ message: 'x' })).toEqual([]);
    expect(pathOf({ message: 'x', path: [] })).toEqual([]);
  });
});

describe('formatIssues', () => {
  it('writes "path: message" pairs joined by "; "', () => {
    expect(
      formatIssues([
        { message: 'must be a number', path: ['a', 0, { key: 'b' }] },
        { message: 'is required', path: ['c'] },
      ]),
    ).toBe('a.0.b: must be a number; c: is required');
  });

  it('omits the path of a root issue instead of printing an empty prefix', () => {
    expect(formatIssues([{ message: 'expected an object' }])).toBe('expected an object');
  });

  it('prints symbol keys without throwing', () => {
    expect(formatIssues([{ message: 'bad', path: [id] }])).toBe('Symbol(id): bad');
  });
});
