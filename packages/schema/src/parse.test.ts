import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { AsyncSchema, InvalidInput, isFailure, ValidatorDefect } from '@arki/failure';

import type { StandardSchemaV1 } from './types.js';
import { parse, parseAsync } from './parse.js';

/** Accepts a string, returns its length: the output type differs from the input type. */
const lengthOf: StandardSchemaV1<string, number> = {
  '~standard': {
    version: 1,
    vendor: 'hand',
    validate: value =>
      typeof value === 'string'
        ? { value: value.length }
        : { issues: [{ message: 'expected a string', path: ['name'] }] },
  },
};

/** A schema whose check is asynchronous, the way a zod `refine(async …)` is. */
const asyncSchema = (vendor: string): StandardSchemaV1<unknown, string> => ({
  '~standard': { version: 1, vendor, validate: () => Promise.resolve({ value: 'late' }) },
});

/** A schema with a bug: `validate` throws instead of returning issues. */
const bug = new TypeError('boom');
const throwing: StandardSchemaV1<unknown, string> = {
  '~standard': {
    version: 1,
    vendor: 'buggy',
    validate: () => {
      throw bug;
    },
  },
};

/** A sync schema whose result also carries `then: undefined`, which is legal and still sync. */
function withThen(result: StandardSchemaV1.Result<number>): StandardSchemaV1<unknown, number> {
  // eslint-disable-next-line unicorn/no-thenable -- the point: a sync result with a non-function `then` field
  const sync = { ...result, then: undefined };
  return { '~standard': { version: 1, vendor: 'hand', validate: () => sync } };
}

describe('parse', () => {
  it('returns transformed output after narrowing canonical failures', () => {
    const length = parse(lengthOf, 'abcd');
    if (isFailure(length)) expect.unreachable(length.message);
    expectTypeOf(length).toEqualTypeOf<number>();
    expect(length).toBe(4);
  });

  it('treats a non-callable then as synchronous', () => {
    expect(parse(withThen({ value: 123 }), 'x')).toBe(123);
    expect(InvalidInput.is(parse(withThen({ issues: [{ message: 'bad' }] }), 'x'))).toBe(true);
  });

  it('returns issues as bad input without throwing', () => {
    const result = parse(lengthOf, 42);
    expect(InvalidInput.is(result)).toBe(true);
    if (!InvalidInput.is(result)) expect.unreachable('expected invalid input');
    expect(result.data.issues).toEqual([{ message: 'expected a string', path: ['name'] }]);
  });

  it('returns AsyncSchema when a synchronous caller cannot await validation', () => {
    expect(AsyncSchema.is(parse(asyncSchema('zod'), 1))).toBe(true);
  });

  it('observes discarded promise rejection so sync parsing never leaks it', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const rejecting: StandardSchemaV1<unknown, string> = {
        '~standard': { version: 1, vendor: 'late', validate: () => Promise.reject(new Error('late failure')) },
      };
      expect(AsyncSchema.is(parse(rejecting, 1))).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('keeps validator defects distinct from invalid input with the original cause', () => {
    const result = parse(throwing, 'x');
    expect(ValidatorDefect.is(result)).toBe(true);
    expect(InvalidInput.is(result)).toBe(false);
    expect(result).toHaveProperty('cause', bug);
  });

  it('preserves the schema receiver when validating', () => {
    const schema: StandardSchemaV1<unknown, string> = {
      '~standard': {
        version: 1,
        vendor: 'receiver',
        validate() {
          return { value: this.vendor };
        },
      },
    };
    expect(parse(schema, 1)).toBe('receiver');
  });

  it('normalizes malicious schema accessor defects', () => {
    const schema: StandardSchemaV1<unknown, string> = {
      get '~standard'(): StandardSchemaV1.Props<unknown, string> {
        throw bug;
      },
    };
    expect(ValidatorDefect.is(parse(schema, 1))).toBe(true);
  });
});

describe('parseAsync', () => {
  it('awaits a schema and preserves its transformed output type', async () => {
    const value = await parseAsync(asyncSchema('valibot'), 1);
    if (isFailure(value)) expect.unreachable(value.message);
    expectTypeOf(value).toEqualTypeOf<string>();
    expect(value).toBe('late');
  });

  it('accepts synchronous schemas too', async () => {
    await expect(parseAsync(lengthOf, 'abc')).resolves.toBe(3);
  });

  it('resolves invalid input as a canonical failure', async () => {
    expect(InvalidInput.is(await parseAsync(lengthOf, 1))).toBe(true);
  });

  it('resolves sync throws and async rejections as validator defects', async () => {
    expect(ValidatorDefect.is(await parseAsync(throwing, 1))).toBe(true);
    const rejecting: StandardSchemaV1<unknown, string> = {
      '~standard': { version: 1, vendor: 'remote', validate: () => Promise.reject(bug) },
    };
    expect(await parseAsync(rejecting, 1)).toMatchObject({ code: 'schema.validator_defect', cause: bug });
  });
});
