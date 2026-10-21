import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { assert, ensure, is } from './assert.js';
import { plainObjectSchema, recordSchema } from './schemas.js';

const Port = z.object({ port: z.string().transform(Number) });

describe('types of the throwing channel', () => {
  it('assert narrows the variable to the schema input, not the output', () => {
    const value: unknown = {};
    assert(value, Port);
    expectTypeOf(value).toEqualTypeOf<{ port: string }>();
  });

  it('is narrows to the input type inside the true branch', () => {
    const value: unknown = {};
    if (is(value, Port)) expectTypeOf(value).toEqualTypeOf<{ port: string }>();
  });

  it('ensure returns the output type of a transforming schema', () => {
    expectTypeOf(ensure('8080', z.coerce.number())).toEqualTypeOf<number>();
    expectTypeOf(ensure({ port: '1' }, Port)).toEqualTypeOf<{ port: number }>();
  });

  it('rejects a non-schema', () => {
    // @ts-expect-error -- a plain object is not a Standard Schema
    ensure(1, { parse: () => 1 });
  });
});

describe('types of the object schemas', () => {
  it('assert narrows an unknown to a string-keyed record for both', () => {
    const a: unknown = {};
    assert(a, recordSchema);
    expectTypeOf(a).toEqualTypeOf<Record<string, unknown>>();
    const b: unknown = {};
    assert(b, plainObjectSchema);
    expectTypeOf(b).toEqualTypeOf<Record<string, unknown>>();
  });

  it('is narrows in the true branch', () => {
    const c: unknown = {};
    if (is(c, recordSchema)) expectTypeOf(c).toEqualTypeOf<Record<string, unknown>>();
    if (is(c, plainObjectSchema)) expectTypeOf(c).toEqualTypeOf<Record<string, unknown>>();
  });
});
