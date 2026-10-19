import { describe, expect, it } from 'vitest';

import { InvalidInput } from '@arki/failure';

import type { StandardSchemaV1 } from './types.js';
import { SCHEMA_ERROR_CODES, SchemaRunError } from './errors.js';
import { hasJsonSchema, isStandardSchema, withJsonSchema } from './guards.js';
import { parse } from './parse.js';

/** A schema whose `validate` reads `this`, the way class-based validators do. */
const props = {
  version: 1 as const,
  vendor: 'this-bound',
  min: 2,
  validate(value: unknown) {
    return typeof value === 'string' && value.length >= this.min
      ? { value }
      : { issues: [{ message: `at least ${String(this.min)} characters` }] };
  },
};
const minLength: StandardSchemaV1<string> = { '~standard': props };

describe('isStandardSchema', () => {
  it('accepts a callable schema, because ArkType types are functions', () => {
    const callable = Object.assign((value: unknown) => value, {
      '~standard': { version: 1, vendor: 'callable', validate: (value: unknown) => ({ value }) },
    });
    expect(isStandardSchema(callable)).toBe(true);
    expect(isStandardSchema(minLength)).toBe(true);
  });

  it('rejects values that only look like schemas', () => {
    expect(isStandardSchema(null)).toBe(false);
    expect(isStandardSchema({})).toBe(false);
    expect(isStandardSchema({ '~standard': { version: 2 } })).toBe(false);
    expect(isStandardSchema({ '~standard': { version: 1, vendor: 'x' } })).toBe(false);
    expect(isStandardSchema({ '~standard': { version: 1, vendor: 7, validate: () => ({ value: 1 }) } })).toBe(false);
  });
});

describe('withJsonSchema', () => {
  const json = { type: 'string', minLength: 2 };
  const wrapped = withJsonSchema(minLength, json);

  it('keeps validation working on the original object, so `this` and getters still resolve', () => {
    expect(parse(wrapped, 'abc')).toBe('abc');
    expect(parse(wrapped, 'a')).toMatchObject({
      code: InvalidInput.code,
      data: { issues: [{ message: 'at least 2 characters' }] },
    });
  });

  it('copies vendor and version, and answers draft-2020-12 with the given JSON Schema', () => {
    expect(wrapped['~standard']).toMatchObject({ version: 1, vendor: 'this-bound' });
    expect(wrapped['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toBe(json);
    expect(wrapped['~standard'].jsonSchema.output({ target: 'draft-2020-12' })).toBe(json);
  });

  it('uses a separate output JSON Schema when given one', () => {
    const output = { type: 'number' };
    const split = withJsonSchema(minLength, json, output);
    expect(split['~standard'].jsonSchema.output({ target: 'draft-2020-12' })).toBe(output);
  });

  it('throws E003 for any other target, since a draft-2020-12 document is wrong for them', () => {
    // The spec says a converter should throw for a target it does not support.
    expect(() => wrapped['~standard'].jsonSchema.input({ target: 'draft-07' })).toThrow(SchemaRunError);
    expect(() => wrapped['~standard'].jsonSchema.output({ target: 'openapi-3.0' })).toThrow(
      expect.objectContaining({ code: SCHEMA_ERROR_CODES.unsupportedTarget }),
    );
  });

  it('makes hasJsonSchema true, and leaves the original alone', () => {
    expect(hasJsonSchema(minLength)).toBe(false);
    expect(hasJsonSchema(wrapped)).toBe(true);
    expect('jsonSchema' in minLength['~standard']).toBe(false);
  });
});
