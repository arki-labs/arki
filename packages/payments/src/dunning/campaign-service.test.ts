/**
 * DunningCampaignService.createCampaign: one transaction
 *
 * A campaign without its templates never runs a step, and a retry would then
 * make a second campaign. The campaign and every template are written in one
 * transaction on PGlite, so a template that Postgres rejects leaves no campaign.
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { count, defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CreateDunningCampaignInput } from './contracts.js';
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
