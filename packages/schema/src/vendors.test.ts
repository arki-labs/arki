/**
 * The same contracts against four kinds of schema: hand-written, Zod, Valibot
 * and ArkType. Each case accepts a string and returns its length, so input
 * and output types differ and a mix-up shows in the types.
 */
import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { AsyncSchema, InvalidInput, orThrow } from '@arki/failure';

import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from './types.js';
import { hasJsonSchema, isStandardSchema, withJsonSchema } from './guards.js';
import { pathOf } from './issues.js';
import { parse, parseAsync } from './parse.js';

const hand: StandardSchemaV1<string, number> = {
  '~standard': {
    version: 1,
    vendor: 'hand',
    validate: value =>
      typeof value === 'string' ? { value: value.length } : { issues: [{ message: 'not a string' }] },
  },
};
const zod = z.string().transform(s => s.length);
const valibot = v.pipe(
  v.string(),
  v.transform(s => s.length),
);
const arktype = type('string').pipe(s => s.length);

/** `{ user: { age: number } }`, to compare the paths each validator reports. */
const handUser: StandardSchemaV1<{ user: { age: number } }> = {
  '~standard': {
    version: 1,
    vendor: 'hand',
    validate: value =>
      typeof value === 'object' &&
      value !== null &&
      'user' in value &&
      typeof value.user === 'object' &&
      value.user !== null &&
      'age' in value.user &&
      typeof value.user.age === 'number'
        ? { value: { user: { age: value.user.age } } }
        : { issues: [{ message: 'age must be a number', path: [{ key: 'user' }, 'age'] }] },
  },
};
const zodUser = z.object({ user: z.object({ age: z.number() }) });
const valibotUser = v.object({ user: v.object({ age: v.number() }) });
const arktypeUser = type({ user: { age: 'number' } });

/** A hand-written schema whose check is asynchronous; ArkType has no async checks. */
const handAsync: StandardSchemaV1<unknown, string> = {
  '~standard': { version: 1, vendor: 'arktype-like', validate: () => Promise.resolve({ value: 'ok' }) },
};
const asyncSchemas = {
  zod: z.string().refine(s => Promise.resolve(s.length > 0)),
  valibot: v.pipeAsync(
    v.string(),
    v.checkAsync(s => Promise.resolve(s.length > 0)),
  ),
  arktype: handAsync,
};

const kinds = [
  { vendor: 'hand', length: hand, user: handUser },
  { vendor: 'zod', length: zod, user: zodUser },
  { vendor: 'valibot', length: valibot, user: valibotUser },
  { vendor: 'arktype', length: arktype, user: arktypeUser },
];

describe('types are inferred the same for every vendor', () => {
  it('reads input and output from the schema, and parse returns the output', () => {
    expectTypeOf<SchemaInput<typeof hand>>().toEqualTypeOf<string>();
    expectTypeOf<SchemaOutput<typeof hand>>().toEqualTypeOf<number>();
    expectTypeOf<SchemaInput<typeof zod>>().toEqualTypeOf<string>();
    expectTypeOf<SchemaOutput<typeof zod>>().toEqualTypeOf<number>();
    expectTypeOf<SchemaInput<typeof valibot>>().toEqualTypeOf<string>();
    expectTypeOf<SchemaOutput<typeof valibot>>().toEqualTypeOf<number>();
    expectTypeOf<SchemaInput<typeof arktype>>().toEqualTypeOf<string>();
    expectTypeOf<SchemaOutput<typeof arktype>>().toEqualTypeOf<number>();

    expectTypeOf(orThrow(parse(hand, 'abc'))).toEqualTypeOf<number>();
    expectTypeOf(orThrow(parse(zod, 'abc'))).toEqualTypeOf<number>();
    expectTypeOf(orThrow(parse(valibot, 'abc'))).toEqualTypeOf<number>();
    expectTypeOf(orThrow(parse(arktype, 'abc'))).toEqualTypeOf<number>();
  });
});

describe.each(kinds)('$vendor', ({ length: schema, user }) => {
  it('parses to the output value', () => {
    expect(parse(schema, 'abc')).toBe(3);
  });

  it('returns canonical invalid input for bad data', () => {
    expect(InvalidInput.is(parse(schema, 42))).toBe(true);
  });

  it('is recognised as a Standard Schema', () => {
    // ArkType types are functions, so this is the case that matters.
    expect(isStandardSchema(schema)).toBe(true);
  });

  it('reports a nested bad field at ["user", "age"]', () => {
    const result = parse(user, { user: { age: 'old' } });
    if (!InvalidInput.is(result)) expect.unreachable('expected invalid input');
    expect(result.data.issues.map(issue => pathOf(issue))).toEqual([['user', 'age']]);
  });
});

describe.each(Object.entries(asyncSchemas))('%s async', (vendor, schema) => {
  it('returns AsyncSchema for sync parse while async parse resolves', async () => {
    expect(AsyncSchema.is(parse(schema, 'abc'))).toBe(true);
    if (vendor !== 'arktype') expect(schema['~standard'].vendor).toBe(vendor);
    await expect(parseAsync(schema, 'abc')).resolves.toBeDefined();
  });
});

describe('JSON Schema support today', () => {
  it('records which vendors describe themselves as JSON Schema', () => {
    // A fact about the installed versions, asserted so an upgrade that changes it is noticed.
    expect(hasJsonSchema(zod)).toBe(true);
    expect(hasJsonSchema(arktype)).toBe(true);
    expect(hasJsonSchema(valibot)).toBe(false);
  });

  it('lets withJsonSchema give a Valibot schema a JSON Schema the http layer can read', () => {
    const name = withJsonSchema(v.string(), { type: 'string' });
    expect(hasJsonSchema(name)).toBe(true);
    expect(name['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toEqual({ type: 'string' });
    expect(parse(name, 'ada')).toBe('ada');
  });
});
