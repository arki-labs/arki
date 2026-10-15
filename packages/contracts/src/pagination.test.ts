import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod/v4';

import type { CursorValue } from './pagination.js';
import { keyset, page, pageInput } from './pagination.js';

const storyOrder = keyset({ createdAt: 'desc', id: 'desc' });

describe('keyset', () => {
  it('a cursor round-trips, and a Date comes back a Date (the db compares it as a timestamp)', () => {
    const createdAt = new Date('2026-10-15T08:00:00.123Z');
    const cursor = storyOrder.encode({ createdAt, id: 'sty_b' });
    const values = storyOrder.decode(cursor);
    expect(values.createdAt).toBeInstanceOf(Date);
    expect(values.createdAt).toEqual(createdAt);
    expect(values.id).toBe('sty_b');
    expectTypeOf(values).toEqualTypeOf<{ readonly createdAt: CursorValue; readonly id: CursorValue }>();
  });

  it('cursors are URL-safe, so a client can put one in a query string as is', () => {
    const cursor = storyOrder.encode({ createdAt: new Date(), id: 'sty_ü/+?' });
    expect(cursor).toMatch(/^[\w-]+$/);
    expect(storyOrder.decode(cursor).id).toBe('sty_ü/+?');
  });

  it('refuses a cursor it did not make instead of paging from a random place', () => {
    const other = keyset({ id: 'asc' }).encode({ id: 'sty_a' });
    expect(() => storyOrder.decode(other)).toThrow(TypeError);
    expect(() => storyOrder.decode('not-a-cursor')).toThrow(TypeError);
    expect(storyOrder.cursor.safeParse('not-a-cursor').success).toBe(false);
  });

  it('refuses a NULL key: `x < NULL` is never true, so the next page would silently be empty', () => {
    // @ts-expect-error null is not a cursor value
    expect(() => storyOrder.encode({ createdAt: null, id: 'sty_a' })).toThrow(/NOT NULL/);
  });

  it('needs at least one key', () => {
    expect(() => keyset({})).toThrow(TypeError);
  });
});

describe('page schemas', () => {
  it('pageInput defaults the limit and caps it, so a client cannot ask for the whole table', () => {
    const input = pageInput(storyOrder, { maxLimit: 50 });
    expect(input.parse({})).toEqual({ limit: 20 });
    expect(input.safeParse({ limit: 51 }).success).toBe(false);
    expect(input.safeParse({ limit: 0 }).success).toBe(false);
    expect(input.safeParse({ cursor: 'garbage', limit: 5 }).success).toBe(false);
    const cursor = storyOrder.encode({ createdAt: new Date(), id: 'sty_a' });
    expect(input.parse({ cursor, limit: 5 })).toEqual({ cursor, limit: 5 });
  });

  it('page() says "no more" with nextCursor: null, never by a short page', () => {
    const stories = page(z.object({ id: z.string() }));
    expect(stories.parse({ items: [{ id: 'sty_a' }], nextCursor: null })).toEqual({
      items: [{ id: 'sty_a' }],
      nextCursor: null,
    });
    expect(stories.safeParse({ items: [] }).success).toBe(false);
  });
});
