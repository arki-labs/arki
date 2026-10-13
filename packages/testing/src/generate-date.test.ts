/**
 * generateDate bounds
 *
 * `between` takes the same moment kinds as the timestamp assertions: a `Date`,
 * an `Instant` or a `ZonedDateTime`.
 */
import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import { createUserId } from '@arki/auth';
import { instant, zoned } from '@arki/date';

import type { TestUser } from './types';
import { IntegrationTester } from './integration-tester';

const testUser: TestUser = { id: createUserId(), email: 'test@example.com', name: 'Test' };

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
