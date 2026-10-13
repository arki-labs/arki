/**
 * Raw SQL inside relational queries
 *
 * The relational query builder gives the table an alias (`d0`). A raw `sql`
 * fragment that names the table through a schema column renders
 * `"pay"."customer_risk_profiles"."risk_score"`, and Postgres rejects it with
 * "invalid reference to FROM-clause entry". The repositories must read the
 * columns from the table the query hands to the `RAW` and `orderBy` callbacks.
 * These tests run the real queries on PGlite, so the failure shows up.
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant } from '@arki/date';

import type { CustomerSegmentId } from './primitives.js';
import type { CustomerRiskProfile } from './types.js';
import { core, customerId, schema, userId, users } from '../test-support.js';
import { createDunningRepository } from './repository.js';
import { createDunningTables } from './tables.js';

const dunning = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});

const tables = {
  dunningCampaigns: dunning.dunningCampaigns,
  customerSegments: dunning.customerSegments,
  customerRiskProfiles: dunning.customerRiskProfiles,
};

const relations = defineRelations(tables, () => ({}));

let client: PGlite;
let repositories: ReturnType<typeof createDunningRepository>;
let db: ReturnType<typeof drizzle<typeof relations>>;

const lastCalculated = instant('2026-03-04T05:06:07Z');

function profile(
  category: 'low' | 'high',
  overall: number,
  segmentIds: string[],
): Omit<CustomerRiskProfile, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    customerId,
    segmentIds,
    riskScore: {
      overall,
      factors: {},
      category,
      lastCalculated,
      trends: { direction: 'stable', changePercent: 0, timeframe: 30 },
    },
    paymentHistory: { totalPayments: 0, successfulPayments: 0, failedPayments: 0, averageAmount: 0, streakDays: 0 },
    subscriptionHistory: {
      totalSubscriptions: 0,
      activeSubscriptions: 0,
      canceledSubscriptions: 0,
      averageDuration: 0,
    },
    engagementMetrics: { score: 0, activityFrequency: 0, featureUsage: {} },
    communicationPreferences: { unsubscribed: false, unsubscribedChannels: [] },
    metadata: null,
  };
}

const settings = {
  enabled: true,
  priority: 1,
  cooldownPeriod: 1,
  maxExecutionsPerCustomer: 1,
  stopOnPaymentSuccess: true,
  respectUnsubscribe: true,
  businessHoursOnly: false,
};

beforeAll(async () => {
  client = new PGlite('memory://');
  await client.waitReady;
  db = drizzle({ client, relations });
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
      ...tables,
    },
    db,
  );
  await apply();
  await db.insert(users).values({ id: userId });
  await db
    .insert(core.customers)
    .values({ id: customerId, userId, providerCustomerId: 'cus_test', email: 'buyer@example.com' });
  repositories = createDunningRepository(db, { ...dunning, ...tables });
});

afterAll(async () => {
  await client.close();
});

describe('customer risk profile queries', () => {
  it('findByRiskCategory filters on the jsonb category and sorts by the jsonb score', async () => {
    await db.insert(dunning.customerRiskProfiles).values(profile('high', 80, ['seg_a']));

    const found = await repositories.customerRiskProfiles.findByRiskCategory('high');

    expect(found.map(row => row.riskScore.category)).toEqual(['high']);
    expect(await repositories.customerRiskProfiles.findByRiskCategory('low')).toEqual([]);
  });

  it('findBySegmentId matches the profiles whose segment list holds the id', async () => {
    const segmentId = 'seg_a' as CustomerSegmentId;
    const found = await repositories.customerRiskProfiles.findBySegmentId(segmentId);

    expect(found).toHaveLength(1);
    expect(await repositories.customerRiskProfiles.findBySegmentId('seg_none' as CustomerSegmentId)).toEqual([]);
  });
});

describe('campaign and segment queries', () => {
  it('findActiveForTrigger filters on the jsonb trigger type and target segments', async () => {
    await db.insert(dunning.dunningCampaigns).values({
      name: 'Retry',
      type: 'payment_failed',
      status: 'active',
      trigger: { type: 'payment_failure', conditions: {} },
      settings,
      targetSegments: ['seg_a'],
      createdBy: 'usr_admin',
    });

    expect(await repositories.campaigns.findActiveForTrigger('payment_failure')).toHaveLength(1);
    expect(await repositories.campaigns.findActiveForTrigger('payment_failure', ['seg_a'])).toHaveLength(1);
    expect(await repositories.campaigns.findActiveForTrigger('payment_failure', ['seg_b'])).toEqual([]);
    expect(await repositories.campaigns.findActiveForTrigger('manual')).toEqual([]);
  });

  it('findSegmentsForAutoUpdate compares the last calculation with the update frequency', async () => {
    await db.insert(dunning.customerSegments).values({
      name: 'Never calculated',
      type: 'behavior_based',
      criteria: {},
      createdBy: 'usr_admin',
    });

    const due = await repositories.customerSegments.findSegmentsForAutoUpdate();

    expect(due.map(segment => segment.name)).toEqual(['Never calculated']);
  });

  it('findMany sorts campaigns by a schema column', async () => {
    const found = await repositories.campaigns.findMany({
      limit: 10,
      offset: 0,
      sortBy: 'name',
      sortOrder: 'desc',
    });

    expect(found.map(campaign => campaign.name)).toEqual(['Retry']);
  });
});
