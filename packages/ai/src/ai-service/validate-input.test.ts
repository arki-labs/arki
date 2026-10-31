import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { UnexpectedFailure } from '@arki/failure';

import { ValidationError } from '../errors';
import { validateInput } from './validate-input';

// Input is a string, output is a number: proves the result type follows the OUTPUT type.
const handWritten: StandardSchemaV1<string, number> = {
  '~standard': {
    version: 1,
    vendor: 'hand',
    validate: value =>
      typeof value === 'string'
        ? { value: value.length }
        : { issues: [{ message: 'not a string', path: [{ key: 'name' }] }] },
  },
};
const zodSchema = z.object({ n: z.string().transform(s => s.length) });
const valibotSchema = v.object({
  n: v.pipe(
    v.string(),
    v.transform(s => s.length),
  ),
});
const arkSchema = type({ n: 'string' });

describe('validateInput accepts every Standard Schema and maps output types', () => {
  it('returns the transformed output for each kind', () => {
    const a: number = validateInput(handWritten, 'abc');
    const b: { n: number } = validateInput(zodSchema, { n: 'abcd' });
    const c: { n: number } = validateInput(valibotSchema, { n: 'ab' });
    const d: { n: string } = validateInput(arkSchema, { n: 'x' });
    expect([a, b.n, c.n, d.n]).toEqual([3, 4, 2, 'x']);
    const typed: SchemaOutput<typeof zodSchema> = b;
    expect(typed.n).toBe(4);
  });
});

describe('invalid input becomes ValidationError with plain field paths', () => {
  it('unwraps { key } path segments (valibot, hand-written)', () => {
    expect.assertions(4);
    try {
      validateInput(handWritten, 1);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error instanceof ValidationError && error.validationErrors).toEqual([
        { field: 'name', message: 'not a string' },
      ]);
    }
    try {
      validateInput(valibotSchema, { n: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error instanceof ValidationError && error.validationErrors?.[0]?.field).toBe('n');
    }
  });

  it('uses the custom message and never reports a throwing validator as bad input', () => {
    expect(() => validateInput(zodSchema, {}, 'custom')).toThrow('custom');
    const broken: StandardSchemaV1<unknown, unknown> = {
      '~standard': {
        version: 1,
        vendor: 'broken',
        validate: () => {
          throw new Error('boom');
        },
      },
    };
    expect(() => validateInput(broken, 1)).toThrow(UnexpectedFailure);
    expect(() => validateInput(broken, 1)).not.toThrow(ValidationError);
  });
});
