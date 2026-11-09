// Fixture setup needs concrete IDs; abort setup if secure generation fails.
import { FAILURE_ERROR_CODES, orThrow } from '@arki/failure';
/**
 * generateDate bounds
 *
 * `between` takes the same moment kinds as the timestamp assertions: a `Date`,
 * an `Instant` or a `ZonedDateTime`.
 */
import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import { createUserId } from '../../ids.js';
import { instant, zoned } from '@arki/date';

import type { TestUser } from './types';
import { IntegrationTester } from './integration-tester';

const testUser: TestUser = { id: orThrow(createUserId()), email: 'test@example.com', name: 'Test' };

/** A tester that never connects: `generateDate` needs no database. */
function offlineTester() {
  return new IntegrationTester<
    Record<string, never>,
    NodePgDatabase<AnyRelations>,
    Record<string, never>,
    null,
    Record<string, never>,
    NodePgDatabase<AnyRelations> | NodePgTransaction<AnyRelations>
  >({
    schema: {},
    migrationsFolder: '',
    createDatabase: () => {
      throw new Error('offline tester: no database');
    },
    createContext: () => ({}),
    createCaller: () => null,
    createRepositories: () => ({}),
    defaultUsers: { user: testUser, moderator: testUser, admin: testUser },
  });
}

describe('generateDate between', () => {
  const from = Date.parse('2026-01-01T00:00:00Z');
  const to = Date.parse('2026-01-02T00:00:00Z');

  it.each([
    ['Date', new Date(from), new Date(to)],
    ['Instant', instant('2026-01-01T00:00:00Z'), instant('2026-01-02T00:00:00Z')],
    ['ZonedDateTime', zoned('2026-01-01T00:00:00Z', 'Asia/Tokyo'), zoned('2026-01-02T00:00:00Z', 'Europe/Bucharest')],
  ])('draws a Date inside %s bounds', (_kind, lower, upper) => {
    const tester = offlineTester();
    for (let i = 0; i < 20; i++) {
      const value = tester.generateDate({ between: { from: lower, to: upper } });

      expect(value).toBeInstanceOf(Date);
      expect(value.getTime()).toBeGreaterThanOrEqual(from);
      expect(value.getTime()).toBeLessThanOrEqual(to);
    }
  });
});

const invariantBroken = expect.objectContaining({ code: FAILURE_ERROR_CODES.invariant });

// Why (audit-3 #9): an Invalid Date bound threw a raw RangeError from BigInt(NaN), and reversed or fractional
// bounds returned values outside the range asked for. Each is a caller bug: the invariant failure, up front.
describe('generator preconditions', () => {
  it('generateDate refuses an Invalid Date bound and a reversed range', () => {
    const tester = offlineTester();
    const valid = new Date('2026-01-01T00:00:00Z');
    expect(() => tester.generateDate({ between: { from: new Date(Number.NaN), to: valid } })).toThrow(invariantBroken);
    expect(() => tester.generateDate({ between: { from: valid, to: new Date('nope') } })).toThrow(/Invalid Date/);
    expect(() => tester.generateDate({ between: { from: valid, to: new Date(0) } })).toThrow(/from must not be after/);
  });

  it.each([{ days: -1 }, { years: Number.NaN }, { months: Number.POSITIVE_INFINITY }, { years: 1e9 }])(
    'generateDate refuses the span %j on either side',
    span => {
      const tester = offlineTester();
      expect(() => tester.generateDate({ past: span })).toThrow(invariantBroken);
      expect(() => tester.generateDate({ future: span })).toThrow(invariantBroken);
    },
  );

  it('generateDate with a fractional span still returns a valid Date inside it', () => {
    const tester = offlineTester();
    const before = Date.now();
    const value = tester.generateDate({ past: { days: 0.000_000_1 } });
    expect(Number.isNaN(value.getTime())).toBe(false);
    expect(value.getTime()).toBeLessThanOrEqual(Date.now());
    // 1e-7 days is 8.64 ms, drawn as a whole number of milliseconds (9).
    expect(value.getTime()).toBeGreaterThanOrEqual(before - 9);
  });

  it.each([
    [5, 1],
    [0, 0.5],
    [Number.NaN, 1],
    [0, Number.POSITIVE_INFINITY],
  ])('generateBetween(%s, %s) throws the invariant failure', (min, max) => {
    expect(() => offlineTester().generateBetween(min, max)).toThrow(invariantBroken);
  });

  it('generateBetween stays inside whole-number bounds, including a single value', () => {
    const tester = offlineTester();
    expect(tester.generateBetween(7, 7)).toBe(7);
    for (let i = 0; i < 50; i++) {
      const value = tester.generateBetween(-3, 3);
      expect(Number.isInteger(value) && value >= -3 && value <= 3).toBe(true);
    }
  });

  it('generateString refuses a length it cannot honour instead of returning a shorter string', () => {
    const tester = offlineTester();
    for (const length of [-1, 1.5, Number.NaN, 65]) expect(() => tester.generateString(length)).toThrow(invariantBroken);
    expect(tester.generateString(64)).toHaveLength(64);
    expect(tester.generateString(0)).toBe('');
  });

  it('generateFromEnum refuses an empty list instead of returning undefined', () => {
    expect(() => offlineTester().generateFromEnum([])).toThrow(invariantBroken);
    expect(offlineTester().generateFromEnum(['only'])).toBe('only');
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, 2 ** 31])('waitForProjections(%s) throws the invariant failure', async ms => {
    await expect(offlineTester().waitForProjections(ms)).rejects.toThrow(invariantBroken);
  });
});

// Why (audit-3 #8, A-39): the shape checks come from schemas, so what the assertion narrows to is what it checked.
describe('shape assertions', () => {
  it('assertValidId refuses a non-string, a wrong prefix and an empty body', () => {
    const tester = offlineTester();
    expect(() => tester.assertValidId(5, 'usr_')).toThrow('Expected ID to be a string, got number');
    expect(() => tester.assertValidId('org_1', 'usr_')).toThrow(/start with 'usr_'/);
    expect(() => tester.assertValidId('usr_', 'usr_')).toThrow(/content after prefix/);
    expect(() => tester.assertValidId('usr_1', 'usr_')).not.toThrow();
  });

  it('assertPaginatedResponse checks the whole page shape with the @arki/testing schema', () => {
    // An assertion method narrows only through a name declared with an explicit type.
    const tester: ReturnType<typeof offlineTester> = offlineTester();
    expect(() => tester.assertPaginatedResponse(null)).toThrow('Expected paginated response to be an object');
    expect(() => tester.assertPaginatedResponse({ items: 'x' })).toThrow(/items array/);
    expect(() => tester.assertPaginatedResponse({ items: [], total: '2' })).toThrow(/total/);
    const page: unknown = { items: [1], total: 1, nextCursor: null, hasMore: false };
    tester.assertPaginatedResponse(page);
    expect(page.items).toEqual([1]);
  });
});
