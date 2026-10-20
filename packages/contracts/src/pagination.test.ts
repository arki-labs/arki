import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow, revive, serialize, UnexpectedDefect, ValidatorDefect } from '@arki/failure';
import { parseAsync } from '@arki/failure/schema';

import type { CursorValue } from './pagination.js';
import { InvalidCursor, InvalidCursorValue } from './errors.js';
import { CURSOR_FAILURES, keyset, page, pageInput } from './pagination.js';

const storyOrder = keyset({ createdAt: 'desc', id: 'desc' });

describe('keyset', () => {
  it('roundtrips dates and keeps the existing cursor bytes for valid values', () => {
    const createdAt = new Date('2026-10-15T08:00:00.000Z');
    const cursor = orThrow(storyOrder.encode({ createdAt, id: 'sty_a' }));
    const values = orThrow(storyOrder.decode(cursor));
    expect(values).toEqual({ createdAt, id: 'sty_a' });
    expect(cursor).toBe(
      btoa(
        JSON.stringify([
          ['d', createdAt.toISOString()],
          ['s', 'sty_a'],
        ]),
      ).replace(/=+$/, ''),
    );
    expectTypeOf(values).toEqualTypeOf<{ readonly createdAt: CursorValue; readonly id: CursorValue }>();
  });

  it('keeps Unicode and reserved URL characters lossless on engines without TextDecoder', () => {
    const byName = keyset({ name: 'asc', id: 'asc' });
    for (const name of ['Ștefan 🎯 café', '\uD800']) {
      const cursor = orThrow(byName.encode({ name, id: 'u_/+?' }));
      expect(cursor).toMatch(/^[\w-]+$/);
      expect(orThrow(byName.decode(cursor))).toEqual({ name, id: 'u_/+?' });
    }
  });

  it('returns exact input failures for malformed base64, UTF8, JSON, tags and arity', () => {
    const other = orThrow(keyset({ id: 'asc' }).encode({ id: 'sty_a' }));
    for (const cursor of ['not-a-cursor', '_w', 'a', '%', btoa('not JSON'), btoa('[["x",1]]'), other]) {
      expect(InvalidCursor.is(storyOrder.decode(cursor))).toBe(true);
      expect(storyOrder.cursor.safeParse(cursor).success).toBe(false);
    }
  });

  it('keeps empty-order declaration misuse throwing', () => {
    expect(() => keyset({})).toThrowError(expect.objectContaining({ code: 'ARKI_CONTRACTS_E004' }));
  });
});

describe('cursor failure contract', () => {
  it.each([Number.NaN, Infinity, -Infinity, new Date(Number.NaN)])(
    'refuses unrepresentable row value %s before publishing a cursor',
    value => {
      expect(InvalidCursorValue.is(keyset({ value: 'asc' }).encode({ value }))).toBe(true);
    },
  );

  it('refuses NULL or missing keys rather than creating a misleading next-page cursor', () => {
    // @ts-expect-error Dynamic data can violate the non-null row contract.
    expect(InvalidCursorValue.is(storyOrder.encode({ createdAt: null, id: 'a' }))).toBe(true);
    // @ts-expect-error A missing cursor key is not representable.
    expect(InvalidCursorValue.is(storyOrder.encode({ id: 'a' }))).toBe(true);
  });

  it('refuses dates outside the wire schema instead of returning an unreadable cursor', () => {
    expect(InvalidCursorValue.is(storyOrder.encode({ createdAt: new Date(8.64e15), id: 'a' }))).toBe(true);
  });

  it('never publishes a cursor rejected by its size limit', () => {
    expect(InvalidCursorValue.is(keyset({ value: 'asc' }).encode({ value: 'a'.repeat(1024) }))).toBe(true);
  });

  it('roundtrips every supported value including finite numeric limits and prototype-shaped keys', () => {
    const byValue = keyset({ value: 'asc' });
    for (const value of [true, false, 0, Number.MAX_VALUE, -Number.MAX_VALUE, '', 'é', new Date(0)]) {
      const cursor = orThrow(byValue.encode({ value }));
      expect(byValue.cursor.safeParse(cursor).success).toBe(true);
      expect(orThrow(byValue.decode(cursor))).toEqual({ value });
    }
    const byPrototype = keyset({ ['__proto__']: 'asc' });
    const decoded = orThrow(byPrototype.decode(orThrow(byPrototype.encode({ ['__proto__']: 'value' }))));
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
    expect(decoded.__proto__).toBe('value');
  });

  it('keeps row getters and codec provider faults private and distinct from bad input', async () => {
    const cause = new Error('private provider failure');
    const row = {
      get value(): string {
        throw cause;
      },
    };
    const encoded = keyset({ value: 'asc' }).encode(row);
    expect(UnexpectedDefect.is(encoded)).toBe(true);
    if (isFailure(encoded)) expect(encoded.cause).toBe(cause);
    const atob = vi.spyOn(globalThis, 'atob').mockImplementation(() => {
      throw cause;
    });
    try {
      const decoded = storyOrder.decode('W10');
      expect(UnexpectedDefect.is(decoded)).toBe(true);
      if (isFailure(decoded)) expect(decoded.cause).toBe(cause);
      expect(JSON.stringify(decoded)).not.toContain('private provider failure');
      // Expected malformed input becomes a Zod issue; provider defects reach the schema owner.
      expect(ValidatorDefect.is(await parseAsync(storyOrder.cursor, 'W10'))).toBe(true);
    } finally {
      atob.mockRestore();
    }
  });

  it('preserves an unexpected validator failure instead of labelling it an invalid row', () => {
    const cause = new Error('broken date validator');
    const date = new Date(0);
    date.getTime = () => { throw cause; };
    const result = storyOrder.encode({ createdAt: date, id: 'sty_a' });
    expect(ValidatorDefect.is(result)).toBe(true);
    if (isFailure(result)) expect(result.cause).toBe(cause);
  });

  it('preserves exact failure definitions across a JSON boundary without private input', () => {
    for (const failure of [InvalidCursor({ cause: 'private cursor' }), InvalidCursorValue({ cause: 'private row' })]) {
      const envelope = orThrow(serialize(failure, CURSOR_FAILURES));
      expect(JSON.stringify(envelope)).not.toContain('private');
      const wire = JSON.stringify(envelope);
      const decodedWire: unknown = JSON.parse(wire);
      const revived = revive(decodedWire, CURSOR_FAILURES);
      expect(revived?.code).toBe(failure.code);
      if (isFailure(revived)) expect(revived.cause).toBeUndefined();
    }
  });
});

describe('page schemas', () => {
  it('defaults and caps the page limit while preserving string cursor input/output', () => {
    const input = pageInput(storyOrder, { maxLimit: 50 });
    expect(input.parse({})).toEqual({ limit: 20 });
    expect(input.safeParse({ limit: 51 }).success).toBe(false);
    expect(input.safeParse({ limit: 0 }).success).toBe(false);
    expect(input.safeParse({ cursor: 'garbage', limit: 5 }).success).toBe(false);
    const cursor = orThrow(storyOrder.encode({ createdAt: new Date(), id: 'sty_a' }));
    expect(input.parse({ cursor, limit: 5 })).toEqual({ cursor, limit: 5 });
  });

  it('says no more with nextCursor:null rather than inferring it from a short page', () => {
    const stories = page(z.object({ id: z.string() }));
    expect(stories.parse({ items: [{ id: 'sty_a' }], nextCursor: null })).toEqual({
      items: [{ id: 'sty_a' }],
      nextCursor: null,
    });
    expect(stories.safeParse({ items: [] }).success).toBe(false);
  });
});
