import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Failure } from './failure.js';
import { FAILURE_ERROR_CODES } from './errors.js';
import { defineFailure, isFailure } from './failure.js';
import { revive } from './revive.js';

const PostNotFound = defineFailure('post.not_found', {
  status: 404,
  data: z.object({ id: z.string() }),
  message: 'no post {id}',
});
const Unauthorized = defineFailure('auth.unauthorized', { status: 401 });

/** A failure after a trip through a queue: JSON out, JSON in. */
const overTheWire = (value: unknown): unknown => {
  const json = JSON.stringify(value);
  return JSON.parse(json);
};

describe('revive', () => {
  it('turns a failure that went through JSON back into a live, typed failure', () => {
    const wire = overTheWire(PostNotFound({ id: 'p9' }));
    expect(isFailure(wire)).toBe(false); // the brand does not survive JSON
    const failure = revive(wire, [PostNotFound, Unauthorized]);
    expect(isFailure(failure)).toBe(true);
    expect(failure).toMatchObject({ code: 'post.not_found', message: 'no post p9', status: 404 });
    expectTypeOf(failure).toEqualTypeOf<
      Failure<'post.not_found', { id: string }> | Failure<'auth.unauthorized', undefined> | undefined
    >();
    expect(revive(overTheWire(Unauthorized()), [PostNotFound, Unauthorized])).toMatchObject({ status: 401 });
  });

  it('returns undefined for a success value or an unknown code, so the caller can treat it as success', () => {
    expect(revive({ id: 'p1', title: 'Hello' }, [PostNotFound])).toBeUndefined();
    expect(revive(overTheWire(Unauthorized()), [PostNotFound])).toBeUndefined();
    expect(revive('text', [PostNotFound])).toBeUndefined();
  });

  it('refuses data that does not match the schema: data from the wire is not trusted', () => {
    expect(() => revive({ code: 'post.not_found', data: { id: 42 } }, [PostNotFound])).toThrow(
      expect.objectContaining({ code: FAILURE_ERROR_CODES.invalidData }),
    );
  });
});
