/**
 * DunningCampaignService.createCampaign: one transaction
 *
 * A campaign without its templates never runs a step, and a retry would then
 * make a second campaign. The campaign and every template are written in one
 * transaction on PGlite, so a template that Postgres rejects leaves no campaign.
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { count, defineRelations, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { add, now, sub } from '@arki/date';

import type { CreateDunningCampaignInput } from './contracts.js';
import type { DunningCampaignId } from './primitives.js';
import { core, customerId, schema, userId, users } from '../test-support.js';
import { DunningCampaignService } from './services/campaign-service.js';
import { createDunningTables } from './tables.js';

const dunning = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});

const tables = {
  dunningCampaigns: dunning.dunningCampaigns,
  dunningCampaignAnalytics: dunning.dunningCampaignAnalytics,
  dunningTemplates: dunning.dunningTemplates,
  dunningExecutions: dunning.dunningExecutions,
};

const relations = defineRelations(tables, () => ({}));

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof relations>>;
let service: DunningCampaignService;

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
  service = new DunningCampaignService(db, tables, () => {
    throw new Error('no communications in this test');
  });
});

afterAll(async () => {
  await client.close();
});

function campaignInput(delayHours: number[]): CreateDunningCampaignInput {
  return {
    name: 'Recover failed payments',
    type: 'payment_failed',
    trigger: { type: 'payment_failure', conditions: { paymentFailureCount: 1 } },
    settings: {
      enabled: true,
      priority: 1,
      cooldownPeriod: 24,
      maxExecutionsPerCustomer: 3,
      stopOnPaymentSuccess: true,
      respectUnsubscribe: true,
      businessHoursOnly: false,
    },
    targetSegments: [],
    templates: delayHours.map((delay, index) => ({
      name: `Step ${index + 1}`,
      stepNumber: index + 1,
      delayHours: delay,
      communication: { channel: 'email', subject: 'Payment failed', content: 'Please update your card', variables: [] },
    })),
  };
}

async function countOf(table: typeof tables.dunningCampaigns | typeof tables.dunningTemplates) {
  const [row] = await db.select({ total: count() }).from(table);

  return row?.total ?? 0;
}

describe('createCampaign', () => {
  it('writes the campaign and all its templates', async () => {
    const campaigns = await countOf(tables.dunningCampaigns);

    const created = await service.createCampaign(campaignInput([0, 24]), 'usr_admin');

    expect(created.templates.map(template => template.stepNumber)).toEqual([1, 2]);
    expect(await countOf(tables.dunningCampaigns)).toBe(campaigns + 1);
  });

  it('leaves no campaign behind when a template is rejected', async () => {
    const campaigns = await countOf(tables.dunningCampaigns);
    const templates = await countOf(tables.dunningTemplates);

    // 2^31 hours does not fit the integer column: Postgres rejects the second template
    await expect(service.createCampaign(campaignInput([0, 2_147_483_648]), 'usr_admin')).rejects.toThrow();

    expect(await countOf(tables.dunningCampaigns)).toBe(campaigns);
    expect(await countOf(tables.dunningTemplates)).toBe(templates);
  });
});

async function createdCampaign(name: string, status: 'active' | 'draft' = 'active'): Promise<DunningCampaignId> {
  const created = await service.createCampaign({ ...campaignInput([0]), name }, 'usr_admin');
  await service.updateCampaign(created.id, { status }, 'usr_admin');

  return created.id;
}

async function execution(campaignId: DunningCampaignId, status: 'scheduled' | 'completed', scheduledAt = now()) {
  const [row] = await db
    .insert(tables.dunningExecutions)
    .values({ campaignId, customerId, triggerType: 'manual', triggerData: {}, status, scheduledAt })
    .returning();
  if (!row) throw new Error('execution not inserted');

  return row;
}

describe('listExecutions', () => {
  it('returns the executions of one campaign, filtered by status, newest scheduled first, one page at a time', async () => {
    const mine = await createdCampaign('List executions: mine');
    const other = await createdCampaign('List executions: other');
    const first = await execution(mine, 'scheduled', sub(now(), { hours: 3 }));
    const second = await execution(mine, 'completed', sub(now(), { hours: 2 }));
    const third = await execution(mine, 'scheduled', sub(now(), { hours: 1 }));
    await execution(other, 'scheduled');
    const query = { limit: 20, offset: 0, sortBy: 'scheduledAt', sortOrder: 'desc' } as const;

    const all = await service.listExecutions({ ...query, campaignId: mine });
    const scheduled = await service.listExecutions({ ...query, campaignId: mine, status: 'scheduled' });
    const secondPage = await service.listExecutions({ ...query, campaignId: mine, limit: 2, offset: 2 });

    expect(all.map(row => row.id)).toEqual([third.id, second.id, first.id]);
    expect(scheduled.map(row => row.id)).toEqual([third.id, first.id]);
    expect(secondPage.map(row => row.id)).toEqual([first.id]);
  });
});

async function analytics(
  campaignId: DunningCampaignId,
  at: ReturnType<typeof now>,
  row: {
    currency: string;
    revenueMinor: number;
    executions: number;
    conversionRate: number;
    paymentsRecovered: number;
  },
) {
  await db.insert(tables.dunningCampaignAnalytics).values({
    id: `${campaignId}-${at.toString()}-${row.currency}`,
    campaignId,
    date: at,
    currency: row.currency,
    revenueRecoveredMinor: row.revenueMinor,
    executions: row.executions,
    customersReached: row.executions,
    paymentsRecovered: row.paymentsRecovered,
    conversionRate: row.conversionRate,
  });
}

describe('getDashboardStats', () => {
  it('reads campaign counts, today, the month, the top campaign and the latest executions from the tables', async () => {
    // Each assertion below is about this campaign's rows; other tests' campaigns only add to the counts
    const before = await service.getDashboardStats();
    const winner = await createdCampaign('Dashboard: winner');
    await createdCampaign('Dashboard: idle', 'draft');
    await analytics(winner, now(), {
      currency: 'USD',
      revenueMinor: 1999,
      executions: 4,
      conversionRate: 0.5,
      paymentsRecovered: 400,
    });
    await analytics(winner, add(now(), { seconds: 1 }), {
      currency: 'EUR',
      revenueMinor: 500,
      executions: 1,
      conversionRate: 0.5,
      paymentsRecovered: 100,
    });
    await analytics(winner, sub(now(), { hours: 24 * 45 }), {
      currency: 'USD',
      revenueMinor: 99_999,
      executions: 70,
      conversionRate: 0.9,
      paymentsRecovered: 9000,
    });
    const latest = await execution(winner, 'scheduled');

    const stats = await service.getDashboardStats();

    expect(stats.totalCampaigns).toBe(before.totalCampaigns + 2);
    expect(stats.activeCampaigns).toBe(before.activeCampaigns + 1);
    expect(stats.executionsToday - before.executionsToday).toBe(5);
    expect(stats.customersReachedToday - before.customersReachedToday).toBe(5);
    expect(stats.revenueRecoveredToday.toJSON()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: 'USD' }),
        expect.objectContaining({ currency: 'EUR' }),
      ]),
    );
    // 45 days ago is outside today, the month and the top-campaign window
    expect(stats.revenueRecoveredThisMonth.toString()).not.toContain('999.99');
    expect(stats.topPerformingCampaign).toMatchObject({
      id: winner,
      name: 'Dashboard: winner',
      paymentsRecovered: 500,
    });
    expect(stats.topPerformingCampaign?.revenueRecovered.toJSON()).toHaveLength(2);
    expect(stats.recentExecutions[0]?.id).toBe(latest.id);
    expect(stats.recentExecutions.length).toBeLessThanOrEqual(10);
  });
});

describe('campaign analytics', () => {
  it('adds each metric to the day row of the campaign, in a schema that is not public', async () => {
    const campaignId = await createdCampaign('Analytics: counters');

    // The method is private: the execution paths that call it also need a mail provider
    await service['updateCampaignAnalytics'](campaignId, { customersReached: 1, communicationsSent: 1 });
    await service['updateCampaignAnalytics'](campaignId, { customersReached: 2, executions: 3 });

    const rows = await db
      .select()
      .from(tables.dunningCampaignAnalytics)
      .where(eq(tables.dunningCampaignAnalytics.campaignId, campaignId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customersReached: 3, communicationsSent: 1, executions: 3, paymentsRecovered: 0 });
  });
});
