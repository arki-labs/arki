import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { StandardSchemaV1 } from './types.js';
import { SCHEMA_ERROR_CODES, SchemaError, SchemaRunError } from './errors.js';
import { formatIssues } from './issues.js';
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

/** The value `fn` throws, so a test can check its class and fields. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('parse', () => {
  it('returns the schema output, not the input, because callers use the validated value', () => {
    const length = parse(lengthOf, 'abcd');
    expectTypeOf(length).toEqualTypeOf<number>();
    expect(length).toBe(4);
  });

  it('treats a result with a non-function `then` field as sync, because only a callable `then` makes a thenable', () => {
    expect(parse(withThen({ value: 123 }), 'x')).toBe(123);
    expect(thrownBy(() => parse(withThen({ issues: [{ message: 'bad' }] }), 'x'))).toBeInstanceOf(SchemaError);
  });

  it('throws SchemaError with the exact issues for bad data, so a boundary can answer with them', () => {
    const error = thrownBy(() => parse(lengthOf, 42));
    expect(error).toBeInstanceOf(SchemaError);
    expect(error).not.toBeInstanceOf(SchemaRunError);
    const issues = [{ message: 'expected a string', path: ['name'] }];
    expect(error).toMatchObject({ name: 'SchemaError', issues, message: formatIssues(issues) });
  });

  it('refuses an async schema with E001 naming the vendor, since a sync caller cannot wait', () => {
    const error = thrownBy(() => parse(asyncSchema('zod'), 1));
    expect(error).toBeInstanceOf(SchemaRunError);
    expect(error).toMatchObject({ code: SCHEMA_ERROR_CODES.asyncResult, name: 'SchemaRunError' });
    expect(String(error)).toContain('zod');
    expect(error).toHaveProperty('remediation', expect.stringContaining('parseAsync()'));
  });

  it('never leaks the async result as an unhandled rejection when it gives up on it', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const rejecting: StandardSchemaV1<unknown, string> = {
        '~standard': { version: 1, vendor: 'late', validate: () => Promise.reject(new Error('late failure')) },
      };
      expect(() => parse(rejecting, 1)).toThrow(SchemaRunError);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('reports a throwing validator as E002 with the cause, never as bad data', () => {
    // A validator bug must not read as "the input is invalid" to an http 400 or a revive.
    const error = thrownBy(() => parse(throwing, 'x'));
    expect(error).toBeInstanceOf(SchemaRunError);
    expect(error).not.toBeInstanceOf(SchemaError);
    expect(error).toMatchObject({ code: SCHEMA_ERROR_CODES.validatorThrew });
    expect(error).toHaveProperty('cause', bug);
  });
});

describe('parseAsync', () => {
  it('awaits an async schema and returns its output', async () => {
    const value = await parseAsync(asyncSchema('valibot'), 1);
    expectTypeOf(value).toEqualTypeOf<string>();
    expect(value).toBe('late');
  });

  it('works for a sync schema too', async () => {
    await expect(parseAsync(lengthOf, 'abc')).resolves.toBe(3);
  });

  it('rejects with SchemaError for bad data', async () => {
    await expect(parseAsync(lengthOf, 1)).rejects.toBeInstanceOf(SchemaError);
  });

  it('turns a sync throw into a rejection, so `await` callers need only one error path', async () => {
    let pending: Promise<string> | undefined;
    expect(() => {
      pending = parseAsync(throwing, 'x');
    }).not.toThrow();
    await expect(pending).rejects.toMatchObject({ code: SCHEMA_ERROR_CODES.validatorThrew, cause: bug });
  });

  it('reports a rejecting validator as E002, not bad data', async () => {
    const reason = new Error('db down');
    const rejecting: StandardSchemaV1<unknown, string> = {
      '~standard': { version: 1, vendor: 'remote', validate: () => Promise.reject(reason) },
    };
    const error: unknown = await parseAsync(rejecting, 1).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(SchemaRunError);
    expect(error).toMatchObject({ code: SCHEMA_ERROR_CODES.validatorThrew, cause: reason });
  });
});
