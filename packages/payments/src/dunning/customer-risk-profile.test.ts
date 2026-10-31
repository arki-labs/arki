/**
 * Customer risk profile dates on the way back from Postgres
 *
 * `risk_score`, `payment_history` and `engagement_metrics` are jsonb. Postgres
 * returns their dates as ISO text, but the column types say `Instant`. Code
 * that calls `isBefore` on them would break at runtime, so every read of the
 * table (`CustomerRiskProfileRepository`) turns the text back into an Instant.
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Instant } from '@arki/date';
import { instant, isInstant } from '@arki/date';
import { AssertError } from '@arki/schema';

import type { CustomerRiskProfile } from './types.js';
import { core, customerId, schema, userId, users } from '../test-support.js';
import { readCustomerRiskProfile } from './stored-risk-profile.js';
import { createDunningTables } from './tables.js';

const dunning = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});

let client: PGlite;
let db: PgliteDatabase;

const calculatedAt = instant('2026-03-04T05:06:07.123Z');
const paidAt = instant('2026-02-01T10:00:00Z');
const activeAt = instant('2026-03-01T08:30:00Z');

function profile(): Omit<CustomerRiskProfile, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    customerId,
    segmentIds: [],
    riskScore: {
      overall: 40,
      factors: { recency: 0.4 },
      category: 'medium',
      lastCalculated: calculatedAt,
      trends: { direction: 'stable', changePercent: 0, timeframe: 30 },
    },
    paymentHistory: {
      totalPayments: 3,
      successfulPayments: 2,
      failedPayments: 1,
      averageAmount: 1000,
      lastPaymentDate: paidAt,
      streakDays: 5,
    },
    subscriptionHistory: {
      totalSubscriptions: 1,
      activeSubscriptions: 1,
      canceledSubscriptions: 0,
      averageDuration: 90,
    },
    engagementMetrics: { score: 70, lastActivity: activeAt, activityFrequency: 3, featureUsage: {} },
    communicationPreferences: { unsubscribed: false, unsubscribedChannels: [] },
    metadata: null,
  };
}

function expectInstantAt(value: Instant | undefined, expected: Instant) {
  expect(isInstant(value)).toBe(true);
  expect(value?.epochNanoseconds).toBe(expected.epochNanoseconds);
}

beforeAll(async () => {
  client = new PGlite('memory://');
  await client.waitReady;
  db = drizzle({ client });
  const { apply } = await pushSchema(
    {
      schema,
      users,
      ...core.enums,
      plans: core.plans,
      customers: core.customers,
      subscriptions: core.subscriptions,
      payments: core.payments,
      ...dunning.enums,
      customerRiskProfiles: dunning.customerRiskProfiles,
    },
    db,
  );
  await apply();
  await db.insert(users).values({ id: userId });
  await db
    .insert(core.customers)
    .values({ id: customerId, userId, providerCustomerId: 'cus_test', email: 'buyer@example.com' });
});

afterAll(async () => {
  await client.close();
});

describe('customer risk profile dates in jsonb', () => {
  it('come back from Postgres as ISO text, so a row must be read through readCustomerRiskProfile', async () => {
    const [created] = await db.insert(dunning.customerRiskProfiles).values(profile()).returning();

    // The column type says Instant; the database returns text. This is the bug the read fixes.
    expect(typeof Reflect.get(created?.riskScore ?? {}, 'lastCalculated')).toBe('string');

    const stored = await db.select().from(dunning.customerRiskProfiles);
    const [row] = stored.map(entry => readCustomerRiskProfile(entry));

    expectInstantAt(row?.riskScore.lastCalculated, calculatedAt);
    expectInstantAt(row?.paymentHistory.lastPaymentDate, paidAt);
    expectInstantAt(row?.engagementMetrics.lastActivity, activeAt);
  });

  it('keeps an absent optional date absent and the other fields as stored', async () => {
    const base = profile();
    const [stored] = await db
      .update(dunning.customerRiskProfiles)
      .set({
        paymentHistory: { ...base.paymentHistory, lastPaymentDate: undefined },
        engagementMetrics: { score: 0, activityFrequency: 0, featureUsage: {} },
      })
      .where(eq(dunning.customerRiskProfiles.customerId, customerId))
      .returning();
    const row = stored && readCustomerRiskProfile(stored);

    expect(row?.paymentHistory.lastPaymentDate).toBeUndefined();
    expect(row?.engagementMetrics.lastActivity).toBeUndefined();
    expect(row?.paymentHistory.streakDays).toBe(5);
    expect(row?.riskScore.overall).toBe(40);
  });

  it('throws the schema assert error, not a raw ZodError, for a stored date that is not an instant', async () => {
    // Corrupt the stored jsonb the way a bad migration or a hand edit would; the row comes back as Postgres holds it
    const { riskScore } = dunning.customerRiskProfiles;
    const [corrupt] = await db
      .update(dunning.customerRiskProfiles)
      .set({ riskScore: sql`jsonb_set(${riskScore}, '{lastCalculated}', '"not a date"')` })
      .where(eq(dunning.customerRiskProfiles.customerId, customerId))
      .returning();
    if (!corrupt) throw new Error('the risk profile row was not stored');

    expect(() => readCustomerRiskProfile(corrupt)).toThrow(AssertError);
  });
});
