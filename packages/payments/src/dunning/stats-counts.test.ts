/**
 * Dunning stats counts are numbers
 *
 * Postgres sends COUNT and SUM as bigint, and node-postgres hands bigint over
 * as text, so a stat read through a bare `sql<number>` is the string '3'. The
 * repositories map every raw aggregate with `Number`. PGlite parses bigint
 * differently from node-postgres, so one test reads the aggregates through the
 * node-postgres text parser as well.
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { now, sub } from '@arki/date';

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
  dunningCampaignAnalytics: dunning.dunningCampaignAnalytics,
  dunningTemplates: dunning.dunningTemplates,
  dunningExecutions: dunning.dunningExecutions,
  dunningCommunications: dunning.dunningCommunications,
  customerSegments: dunning.customerSegments,
  customerRiskProfiles: dunning.customerRiskProfiles,
};
const relations = defineRelations(tables, () => ({}));

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof relations>>;

beforeAll(async () => {
  // Bigint (OID 20) as text, the way node-postgres delivers it
  client = new PGlite('memory://', { parsers: { 20: (value: string) => value } });
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
    .values({ id: customerId, userId, providerCustomerId: 'cus_stats', email: 'stats@example.com' });
});

afterAll(async () => {
  await client.close();
});

describe('stats read through raw aggregates', () => {
  it('campaign analytics and communication metrics are numbers, not bigint text', async () => {
    const repositories = createDunningRepository(db, tables);
    const campaign = await repositories.campaigns.create({
      name: 'Stats',
      type: 'payment_failed',
      trigger: { type: 'manual', conditions: {} },
      settings: {
        enabled: true,
        priority: 1,
        cooldownPeriod: 1,
        maxExecutionsPerCustomer: 1,
        stopOnPaymentSuccess: true,
        respectUnsubscribe: true,
        businessHoursOnly: false,
      },
      targetSegments: [],
      templates: [
        {
          name: 'Step 1',
          stepNumber: 1,
          delayHours: 0,
          communication: { channel: 'email', subject: 'Hi', content: 'Hello', variables: [] },
        },
      ],
      createdBy: 'usr_admin',
    });
    await db.insert(tables.dunningCampaignAnalytics).values({
      id: 'stats-row',
      campaignId: campaign.id,
      date: sub(now(), { hours: 1 }),
      currency: 'USD',
      executions: 4,
      customersReached: 3,
      communicationsSent: 2,
      paymentsRecovered: 1,
      revenueRecoveredMinor: 1999,
    });
    const execution = await repositories.executions.create({
      campaignId: campaign.id,
      customerId,
      triggerType: 'manual',
      triggerData: {},
      status: 'scheduled',
      scheduledAt: now(),
      retryCount: 0,
    });

    const summary = await repositories.campaigns.getAnalyticsSince(sub(now(), { hours: 2 }), campaign.id);
    const top = await repositories.campaigns.findTopPerformer(sub(now(), { hours: 2 }));
    const metrics = await repositories.communications.getMetricsForExecution(execution.id);

    expect(summary.executions).toBe(4);
    expect(summary.customersReached).toBe(3);
    expect(summary.communicationsSent).toBe(2);
    expect(summary.paymentsRecovered).toBe(1);
    expect(top?.paymentsRecovered).toBe(1);
    expect(metrics).toEqual({ total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, failed: 0 });
  });
});
