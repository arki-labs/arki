import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { StandardSchemaV1 } from '@arki/schema';
import { SchemaError, SchemaRunError } from '@arki/schema';

import type { Failure } from './failure.js';
import { FAILURE_ERROR_CODES, FailureError } from './errors.js';
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

  it('keeps the SchemaError as the cause of E006, so the caller can read the issues', () => {
    const error = thrownBy(() => revive({ code: 'post.not_found', data: { id: 42 } }, [PostNotFound]));
    expect(error).toBeInstanceOf(FailureError);
    expect(error).toHaveProperty('cause', expect.any(SchemaError));
  });

  it('revives a transforming schema after a real JSON round trip: data is the live value again', () => {
    const Expired = defineFailure('token.expired', {
      status: 401,
      data: z.object({ at: z.union([z.string(), z.date()]).transform(value => new Date(value)) }),
    });
    const at = new Date('2026-10-16T08:00:00Z');
    // JSON, not structuredClone: a clone would keep the Date and prove nothing.
    const wire = overTheWire(Expired({ at }));
    const failure = revive(wire, [Expired]);
    expect(failure?.data.at).toBeInstanceOf(Date);
    expect(failure?.data.at.getTime()).toBe(at.getTime());
  });

  it('refuses an async schema with E007, whose cause is the schema package error', () => {
    const Slow = defineFailure('slow.check', {
      status: 400,
      data: z.object({ id: z.string() }).refine(() => Promise.resolve(true)),
    });
    const error = thrownBy(() => revive({ code: 'slow.check', data: { id: 'a' } }, [Slow]));
    expect(error).toMatchObject({ code: FAILURE_ERROR_CODES.asyncSchema });
    expect(error).toHaveProperty('cause.code', 'ARKI_SCHEMA_E001');
  });

  it('lets a throwing validator through as SchemaRunError E002: a schema bug is not bad data', () => {
    const bug = new TypeError('validator bug');
    const broken: StandardSchemaV1<{ id: string }> = {
      '~standard': {
        version: 1,
        vendor: 'broken',
        validate: () => {
          throw bug;
        },
      },
    };
    const Broken = defineFailure('broken.schema', { status: 400, data: broken });
    const error = thrownBy(() => revive({ code: 'broken.schema', data: { id: 'a' } }, [Broken]));
    expect(error).toBeInstanceOf(SchemaRunError);
    expect(error).not.toBeInstanceOf(FailureError);
    expect(error).toMatchObject({ code: 'ARKI_SCHEMA_E002', cause: bug });
  });
});

/** The value `fn` throws. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}
