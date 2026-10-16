/**
 * assertMatchesSchema and itemSchema take any Standard Schema.
 *
 * A test helper must not force one validator on the app under test, so each
 * kind is pinned here: a hand-written `~standard` object, zod, valibot and
 * arktype. Issue paths must reach the failure message, and an async schema
 * must fail loudly instead of passing silently.
 */
import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { StandardSchemaV1 } from '@arki/schema';
import { SchemaRunError } from '@arki/schema';

import { assertMatchesSchema, assertPaginationValid } from './assertions';

const handWritten: StandardSchemaV1<{ id: number }, { id: string }> = {
  '~standard': {
    version: 1,
    vendor: 'hand',
    validate: (value) =>
      typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'number'
        ? { value: { id: String(value.id) } }
        : { issues: [{ message: 'id must be a number', path: [{ key: 'id' }] }] },
  },
};

const asyncSchema: StandardSchemaV1<unknown> = {
  '~standard': { version: 1, vendor: 'hand', validate: async (value) => ({ value }) },
};

const kinds = [
  ['hand-written', handWritten],
  ['zod', z.object({ id: z.number() })],
  ['valibot', v.object({ id: v.number() })],
  ['arktype', type({ id: 'number' })],
] as const;

describe('assertMatchesSchema', () => {
  it.each(kinds)('accepts a matching value with a %s schema', (_kind, schema) => {
    expect(() => assertMatchesSchema({ id: 1 }, schema)).not.toThrow();
  });

  it.each(kinds)('fails with the label and the issue path for a %s schema', (_kind, schema) => {
    expect(() => assertMatchesSchema({ id: 'x' }, schema, 'game')).toThrow(/game failed schema validation:.*id/s);
  });

  it('narrows to the schema INPUT type, since the value is checked before any transform', () => {
    const value: unknown = { id: 1 };
    assertMatchesSchema(value, handWritten);
    expectTypeOf(value).toEqualTypeOf<{ id: number }>();
  });

  it('fails clearly on an async schema instead of passing', () => {
    expect(() => assertMatchesSchema({}, asyncSchema)).toThrow(SchemaRunError);
  });
});

describe('assertPaginationValid itemSchema', () => {
  const page = (items: unknown[]) => ({ items, total: items.length, nextCursor: null, hasMore: false });

  it.each(kinds)('checks every item with a %s schema', (_kind, schema) => {
    expect(() => assertPaginationValid(page([{ id: 1 }]), { itemSchema: schema })).not.toThrow();
    expect(() => assertPaginationValid(page([{ id: 1 }, { id: 'x' }]), { itemSchema: schema })).toThrow(
      /Item at index 1 failed validation/,
    );
  });
});
