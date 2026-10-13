import { describe, expect, it } from 'vitest';

import { jsonValue } from './json.js';
import { serializeError } from './serialize.js';

describe('serializeError', () => {
  it('keeps name, message, stack, code and own enumerable fields', () => {
    const error = Object.assign(new RangeError('too big'), { code: 'E_BIG', limit: 10 });
    const out = serializeError(error);
    expect(out).toMatchObject({ name: 'RangeError', message: 'too big', code: 'E_BIG', limit: 10 });
    expect(typeof out.stack).toBe('string');
  });

  it('walks a cause chain', () => {
    const root = new Error('disk full');
    const middle = new Error('write failed', { cause: root });
    const top = new Error('save failed', { cause: middle });
    const out = serializeError(top);
    expect(out).toMatchObject({
      message: 'save failed',
      cause: { message: 'write failed', cause: { message: 'disk full' } },
    });
  });

  it('serialises AggregateError members', () => {
    const error = new AggregateError([new Error('a'), new TypeError('b')], 'both failed');
    expect(serializeError(error)).toMatchObject({
      name: 'AggregateError',
      message: 'both failed',
      errors: [
        { name: 'Error', message: 'a' },
        { name: 'TypeError', message: 'b' },
      ],
    });
  });

  it('stops at a cycle instead of looping', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b, enumerable: false });
    const out = serializeError(a);
    expect(out).toMatchObject({ message: 'a', cause: { message: 'b', cause: '[Circular]' } });
    expect(() => jsonValue(new Error('x', { cause: a }))).not.toThrow();
  });

  it('bounds depth on a long cause chain', () => {
    let error = new Error('0');
    for (let index = 1; index < 50; index++) error = new Error(String(index), { cause: error });
    const text = JSON.stringify(serializeError(error));
    expect(text).toContain('[MaxDepth]');
    expect(text).not.toContain('"message":"0"');
  });

  it('never calls an own getter', () => {
    let called = false;
    const error = new Error('lazy');
    Object.defineProperty(error, 'expensive', {
      enumerable: true,
      get() {
        called = true;
        return 'secret';
      },
    });
    const out = serializeError(error);
    expect(called).toBe(false);
    expect(out).not.toHaveProperty('expensive');
  });
});
