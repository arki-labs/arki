import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Failure } from './failure.js';
import { attempt } from './attempt.js';
import { defineFailure } from './failure.js';

const InvalidJson = defineFailure('request.invalid_json', { data: z.object({ reason: z.string() }) });
const toInvalidJson = (cause: unknown) => InvalidJson({ reason: cause instanceof Error ? cause.name : 'unknown' });

describe('attempt', () => {
  it('preserves an original returned failure, including its private cause', async () => {
    const original = InvalidJson({ reason: 'known' }, { cause: new Error('private') });
    expect(attempt(() => original, toInvalidJson)).toBe(original);
    expect(await attempt(() => Promise.resolve(original), toInvalidJson)).toBe(original);
  });

  it('maps a throwing then accessor at the same boundary as invocation failures', () => {
    // eslint-disable-next-line unicorn/no-thenable -- exercise an untrusted then accessor at the boundary
    const value = Object.defineProperty({}, 'then', {
      get() {
        throw new TypeError('private');
      },
    });
    expect(attempt(() => value, toInvalidJson)).toEqual(toInvalidJson(new TypeError('private')));
  });

  it('returns the value when nothing throws', () => {
    expect(attempt(() => JSON.parse('{"a":1}') as unknown, toInvalidJson)).toEqual({ a: 1 });
  });

  it('turns a throw into the failure the mapper chooses, typed', () => {
    const parsed = attempt(() => JSON.parse('{') as { a: number }, toInvalidJson);
    expect(parsed).toMatchObject({ code: 'request.invalid_json', data: { reason: 'SyntaxError' } });
    expectTypeOf(parsed).toEqualTypeOf<{ a: number } | Failure<'request.invalid_json', { reason: string }>>();
  });

  it('turns a rejected promise into the failure, and keeps an async result a promise', async () => {
    const rejected = attempt(() => Promise.reject(new TypeError('offline')), toInvalidJson);
    expectTypeOf(rejected).toEqualTypeOf<Promise<Failure<'request.invalid_json', { reason: string }>>>();
    await expect(rejected).resolves.toMatchObject({ data: { reason: 'TypeError' } });
    await expect(attempt(() => Promise.resolve(7), toInvalidJson)).resolves.toBe(7);
  });

  it('can fall back to a plain value, like Laravel rescue()', () => {
    expect(
      attempt(
        () => JSON.parse('{') as unknown,
        () => null,
      ),
    ).toBeNull();
  });

  it('lets the mapper rethrow what it does not know: unknown throws stay bugs', () => {
    const bug = new RangeError('not a parse error');
    const mapKnown = (cause: unknown) => {
      if (cause instanceof SyntaxError) return toInvalidJson(cause);
      throw cause;
    };
    expect(() =>
      attempt(() => {
        throw bug;
      }, mapKnown),
    ).toThrow(bug);
  });
});
