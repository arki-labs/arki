// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
import { orThrow } from '@arki/failure';

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

import type { CustomerId } from '../core/types.js';
import type { CreateDunningCampaignInput } from './contracts.js';
import { updateDunningCampaignInputSchema } from './contracts.js';
import type { DunningCampaignId } from './primitives.js';
import { DunningCampaignNotFound, DunningCampaignWithoutSteps, DunningTemplateInUse } from './failures.js';
import { createDunningCampaignId } from './primitives.js';
import { createCustomerId, createPaymentId, createSubscriptionId } from '../core/primitives.js';
import { userIdFactory } from '../core/user-id.js';
import { core, customerId, planId, schema, userId, users } from '../test-support.js';
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
  dunningCommunications: dunning.dunningCommunications,
};

const relations = defineRelations(tables, () => ({}));

const serviceTables = {
  ...tables,
  customerRiskProfiles: dunning.customerRiskProfiles,
  customers: core.customers,
  payments: core.payments,
  subscriptions: core.subscriptions,
};

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
      customerRiskProfiles: dunning.customerRiskProfiles,
    },
    db,
  );
  await apply();
  await db.insert(users).values({ id: userId });
  await db
    .insert(core.customers)
    .values({ id: customerId, userId, providerCustomerId: 'cus_test', email: 'buyer@example.com' });
  service = new DunningCampaignService(db, serviceTables, () => {
    throw new Error('no communications in this test');
  });
});

afterAll(async () => {
  await client.close();
});

function campaignInput(
  delayHours: number[],
  trigger?: CreateDunningCampaignInput['trigger'],
): CreateDunningCampaignInput {
  return {
    name: 'Recover failed payments',
    type: 'payment_failed',
    trigger: trigger ?? { type: 'payment_failure', conditions: { paymentFailureCount: 1 } },
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

describe('updateCampaign templates', () => {
  it('replaces the steps: updates a matching step in place, adds a new one, deletes the one that is gone', async () => {
    const created = await service.createCampaign(campaignInput([0, 24]), 'usr_admin');
    const [first, second] = created.templates;

    const updated = orThrow(
      await service.updateCampaign(
      created.id,
      {
        templates: [
          { name: 'SMS nudge', stepNumber: 1, delayHours: 2, communication: { channel: 'sms', content: 'Pay now', variables: [] } },
          { name: 'Final notice', stepNumber: 3, delayHours: 72, communication: { channel: 'email', subject: 'Last call', content: 'Final', variables: [] } },
        ],
      },
      'usr_admin',
    ));

    expect(updated?.templates.map(template => [template.stepNumber, template.communication.channel])).toEqual([
      [1, 'sms'],
      [3, 'email'],
    ]);
    // Step 1 keeps its id, so executions that point at it keep their history
    expect(updated?.templates[0]?.id).toBe(first?.id);
    expect(updated?.templates.some(template => template.id === second?.id)).toBe(false);
  });

  it('leaves the steps alone when templates is omitted', async () => {
    const created = await service.createCampaign(campaignInput([0, 24]), 'usr_admin');

    const updated = orThrow(await service.updateCampaign(created.id, { name: 'Renamed' }, 'usr_admin'));

    expect(updated?.name).toBe('Renamed');
    expect(updated?.templates.map(template => template.id)).toEqual(created.templates.map(template => template.id));
  });

  it('refuses to drop a step that already sent a communication, and changes nothing', async () => {
    const created = await service.createCampaign({ ...campaignInput([0, 24]), name: 'Before' }, 'usr_admin');
    const [first, second] = created.templates;
    if (!first || !second) throw new Error('campaign needs two steps');
    const sent = await execution(created.id, 'completed');
    await db.insert(tables.dunningCommunications).values({
      executionId: sent.id,
      customerId,
      templateId: second.id,
      channel: 'email',
      recipient: 'buyer@example.com',
      content: 'Please update your card',
      status: 'sent',
    });

    const result = await service.updateCampaign(
      created.id,
      {
        name: 'After',
        templates: [{ name: 'Step 1', stepNumber: 1, delayHours: 0, communication: { channel: 'email', subject: 'Payment failed', content: 'Please update your card', variables: [] } }],
      },
      'usr_admin',
    );

    expect(DunningTemplateInUse.is(result)).toBe(true);
    if (!DunningTemplateInUse.is(result)) return;
    expect(result.data).toEqual({ templateId: second.id, stepNumber: 2 });
    const after = await service.getCampaign(created.id);
    expect(after?.name).toBe('Before');
    expect(after?.templates?.map(template => template.id)).toEqual([first.id, second.id]);
  });

  it('rejects an empty set and duplicate step numbers at the contract', () => {
    const [step] = campaignInput([0]).templates;
    expect(updateDunningCampaignInputSchema.safeParse({ templates: [] }).success).toBe(false);
    expect(updateDunningCampaignInputSchema.safeParse({ templates: [step, step] }).success).toBe(false);
    expect(updateDunningCampaignInputSchema.safeParse({ templates: [step] }).success).toBe(true);
  });
});

async function createdCampaign(
  name: string,
  status: 'active' | 'draft' = 'active',
  trigger?: CreateDunningCampaignInput['trigger'],
): Promise<DunningCampaignId> {
  const created = await service.createCampaign({ ...campaignInput([0], trigger), name }, 'usr_admin');
  orThrow(await service.updateCampaign(created.id, { status }, 'usr_admin'));

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

/** A customer of its own, so the eligibility queries see only the rows a test made. */
async function newCustomer(label: string) {
  const owner = orThrow(userIdFactory.create());
  const id = orThrow(createCustomerId());
  await db.insert(users).values({ id: owner });
  await db
    .insert(core.customers)
    .values({ id, userId: owner, providerCustomerId: `cus_${label}`, email: `${label}@example.com` });

  return { id, owner };
}

async function newPlan() {
  await db.insert(core.plans).values({ id: planId, name: 'Pro', tier: 'pro', priceMinor: 1999 }).onConflictDoNothing();
}

async function newSubscription(
  buyer: Awaited<ReturnType<typeof newCustomer>>,
  row: { status: 'past_due' | 'trialing'; currentPeriodEnd: ReturnType<typeof now>; trialEnd?: ReturnType<typeof now> },
) {
  await newPlan();
  const id = orThrow(createSubscriptionId());
  await db.insert(core.subscriptions).values({
    id,
    userId: buyer.owner,
    planId,
    customerId: buyer.id,
    providerSubscriptionId: `sub_${id}`,
    status: row.status,
    currentPeriodStart: sub(row.currentPeriodEnd, { hours: 720 }),
    currentPeriodEnd: row.currentPeriodEnd,
    trialEnd: row.trialEnd,
  });

  return id;
}

async function newPayment(
  buyer: Awaited<ReturnType<typeof newCustomer>>,
  status: 'failed' | 'succeeded',
  createdAt: ReturnType<typeof now>,
) {
  const id = orThrow(createPaymentId());
  await db.insert(core.payments).values({
    id,
    userId: buyer.owner,
    customerId: buyer.id,
    providerPaymentId: `pi_${id}`,
    amountMinor: 1999,
    currency: 'EUR',
    status,
    failureReason: status === 'failed' ? 'card_declined' : null,
    createdAt,
  });

  return id;
}

describe('executeCampaign refusals', () => {
  // A router passes any campaign id it is given: each refusal is a code the caller branches on, and writes nothing
  async function executionCount(campaignId: DunningCampaignId) {
    const rows = await db
      .select()
      .from(tables.dunningExecutions)
      .where(eq(tables.dunningExecutions.campaignId, campaignId));
    return rows.length;
  }

  it('an unknown campaign id returns payments.dunning_campaign_not_found', async () => {
    const unknown = orThrow(createDunningCampaignId());

    const refused = await service.executeCampaign({ campaignId: unknown, dryRun: false }, 'usr_admin');

    expect(DunningCampaignNotFound.is(refused)).toBe(true);
    expect(refused).toMatchObject({ code: 'payments.dunning_campaign_not_found', data: { campaignId: unknown } });
  });

  it('a draft campaign returns payments.dunning_campaign_not_active and schedules nothing', async () => {
    const campaignId = await createdCampaign('Refused: draft', 'draft');

    const refused = await service.executeCampaign({ campaignId, dryRun: false }, 'usr_admin');

    expect(refused).toMatchObject({
      code: 'payments.dunning_campaign_not_active',
      data: { campaignId, status: 'draft' },
    });
    expect(await executionCount(campaignId)).toBe(0);
  });

  it('an active campaign with no active step returns payments.dunning_campaign_without_steps', async () => {
    const campaignId = await createdCampaign('Refused: no steps');
    await db
      .update(tables.dunningTemplates)
      .set({ isActive: false })
      .where(eq(tables.dunningTemplates.campaignId, campaignId));

    const refused = await service.executeCampaign({ campaignId, dryRun: false }, 'usr_admin');

    expect(DunningCampaignWithoutSteps.is(refused)).toBe(true);
    expect(await executionCount(campaignId)).toBe(0);
  });
});

describe('executeCampaign finds eligible customers in a named schema', () => {
  it('payment_failure: a customer whose payment failed and who has not paid since gets the campaign', async () => {
    const buyer = await newCustomer('failed');
    await newPayment(buyer, 'failed', sub(now(), { hours: 24 }));
    const campaignId = await createdCampaign('Eligible: failed payment');

    const executions = orThrow(await service.executeCampaign({ campaignId, dryRun: false }, 'usr_admin'));

    expect(executions.map(row => row.customerId)).toEqual([buyer.id]);
    expect(executions[0]?.triggerData).toMatchObject({ failure_reasons: ['card_declined'] });
  });

  it('payment_failure: a later successful payment takes the customer out, and the exclude list works alone', async () => {
    const paid = await newCustomer('paid');
    await newPayment(paid, 'failed', sub(now(), { hours: 48 }));
    await newPayment(paid, 'succeeded', sub(now(), { hours: 24 }));
    const excluded = await newCustomer('excluded');
    await newPayment(excluded, 'failed', sub(now(), { hours: 24 }));
    const campaignId = await createdCampaign('Eligible: paid and excluded');

    const executions = orThrow(
      await service.executeCampaign(
        { campaignId, dryRun: false, customFilters: { excludeCustomerIds: [excluded.id], testMode: false } },
        'usr_admin',
      ),
    );

    expect(executions.map(row => row.customerId)).not.toContain(paid.id);
    expect(executions.map(row => row.customerId)).not.toContain(excluded.id);
  });

  it('payment_failure: failures are counted per customer and subscription, so the failure count threshold can be met', async () => {
    const repeated = await newCustomer('repeated');
    await newPayment(repeated, 'failed', sub(now(), { hours: 72 }));
    await newPayment(repeated, 'failed', sub(now(), { hours: 48 }));
    const latest = await newPayment(repeated, 'failed', sub(now(), { hours: 24 }));
    const twice = await newCustomer('twice');
    await newPayment(twice, 'failed', sub(now(), { hours: 48 }));
    await newPayment(twice, 'failed', sub(now(), { hours: 24 }));
    const campaignId = await createdCampaign('Eligible: three failures', 'active', {
      type: 'payment_failure',
      conditions: { paymentFailureCount: 3 },
    });

    const executions = orThrow(await service.executeCampaign({ campaignId, dryRun: false }, 'usr_admin'));

    expect(executions.map(row => row.customerId)).toEqual([repeated.id]);
    expect(executions[0]?.paymentId).toBe(latest);
    expect(executions[0]?.triggerData).toMatchObject({ failure_count: 3 });
  });

  it('subscription_status: an overdue subscription is returned with the customer id, not the user id', async () => {
    const buyer = await newCustomer('pastdue');
    const subscriptionId = await newSubscription(buyer, {
      status: 'past_due',
      currentPeriodEnd: sub(now(), { hours: 72 }),
    });
    const campaignId = await createdCampaign('Eligible: past due', 'active', {
      type: 'subscription_status',
      conditions: { subscriptionStatus: ['past_due'] },
    });

    const executions = orThrow(
      await service.executeCampaign(
        { campaignId, dryRun: false, customFilters: { customerIds: [buyer.id], testMode: false } },
        'usr_admin',
      ),
    );

    expect(executions.map(row => [row.customerId, row.subscriptionId])).toEqual([[buyer.id, subscriptionId]]);
    expect(executions[0]?.triggerData).toMatchObject({ subscription_status: 'past_due' });
  });

  it('time_based: a trial that ends soon is returned', async () => {
    const buyer = await newCustomer('trial');
    const subscriptionId = await newSubscription(buyer, {
      status: 'trialing',
      currentPeriodEnd: add(now(), { hours: 48 }),
      trialEnd: add(now(), { hours: 48 }),
    });
    const campaignId = await createdCampaign('Eligible: trial ending', 'active', {
      type: 'time_based',
      conditions: { trialEndingDays: 3 },
    });

    const executions = orThrow(await service.executeCampaign({ campaignId, dryRun: false }, 'usr_admin'));

    expect(executions.map(row => row.subscriptionId)).toContain(subscriptionId);
  });
});

describe('a scheduled execution in a named schema', () => {
  it('stops on a successful payment and records the recovery in the campaign analytics', async () => {
    const buyer = await newCustomer('recovered');
    const campaignId = await createdCampaign('Recovery: analytics');
    const campaign = await service.getCampaign(campaignId);
    const templateId = campaign?.templates?.[0]?.id;
    await db.insert(tables.dunningExecutions).values({
      campaignId,
      templateId,
      customerId: buyer.id,
      triggerType: 'manual',
      triggerData: {},
      status: 'scheduled',
      scheduledAt: sub(now(), { minutes: 1 }),
      startedAt: sub(now(), { hours: 1 }),
    });
    await newPayment(buyer, 'succeeded', now());

    await service.processScheduledExecutions(1000);

    const [row] = await db
      .select()
      .from(tables.dunningCampaignAnalytics)
      .where(eq(tables.dunningCampaignAnalytics.campaignId, campaignId));
    expect(row).toMatchObject({ paymentsRecovered: 1, currency: 'EUR', revenueRecoveredMinor: 1999 });
  });
});

describe('a tick reports a stored payment the stop check cannot read', () => {
  /**
   * A succeeded payment in a currency that does not exist. The message already went out, so the
   * execution stays complete; the stop check returns the money failure before it cancels anything.
   */
  async function executionWithBadPayment(label: string, row: Partial<typeof tables.dunningExecutions.$inferInsert>) {
    const buyer = await newCustomer(label);
    const campaignId = await createdCampaign(`Tick: ${label}`);
    const campaign = await service.getCampaign(campaignId);
    const templateId = campaign?.templates[0]?.id;
    await db.insert(core.payments).values({
      id: orThrow(createPaymentId()),
      userId: buyer.owner,
      customerId: buyer.id,
      providerPaymentId: `pi_${label}`,
      amountMinor: 1999,
      currency: 'ZZZ',
      status: 'succeeded',
      createdAt: now(),
    });
    const base = { campaignId, templateId, customerId: buyer.id, triggerType: 'manual', triggerData: {} } as const;
    const [inserted] = await db
      .insert(tables.dunningExecutions)
      .values({ ...base, scheduledAt: sub(now(), { minutes: 1 }), ...row })
      .returning();
    const [later] = await db
      .insert(tables.dunningExecutions)
      .values({ ...base, status: 'scheduled', scheduledAt: add(now(), { hours: 24 }) })
      .returning();
    if (!inserted || !later) throw new Error('execution not inserted');

    return { id: inserted.id, laterId: later.id, campaignId };
  }

  async function statusOf(id: (typeof tables.dunningExecutions.$inferSelect)['id']) {
    const [row] = await db.select().from(tables.dunningExecutions).where(eq(tables.dunningExecutions.id, id));
    return row?.status;
  }

  it('processScheduledExecutions lists the money failure, keeps the execution complete and cancels nothing', async () => {
    const { id, laterId, campaignId } = await executionWithBadPayment('tick-scheduled', { status: 'scheduled' });

    const report = await service.processScheduledExecutions(1000);

    const fault = report.failed.find(entry => entry.id === id);
    expect(fault?.code).toBe('money.unknown_currency');
    expect(await statusOf(id)).toBe('completed');
    expect(await statusOf(laterId)).toBe('scheduled');
    const analyticsRows = await db
      .select()
      .from(tables.dunningCampaignAnalytics)
      .where(eq(tables.dunningCampaignAnalytics.campaignId, campaignId));
    expect(analyticsRows.every(row => row.paymentsRecovered === 0)).toBe(true);
  });

  it('retryFailedExecutions lists the same failure and cancels nothing', async () => {
    const { id, laterId } = await executionWithBadPayment('tick-retry', {
      status: 'failed',
      retryCount: 0,
      nextRetryAt: sub(now(), { minutes: 1 }),
    });

    const report = await service.retryFailedExecutions(1000);

    expect(report.failed.find(entry => entry.id === id)?.code).toBe('money.unknown_currency');
    expect(await statusOf(laterId)).toBe('scheduled');
  });
});

const riskProfile = (customer: CustomerId, unsubscribedChannels: ('email' | 'sms')[]) => ({
  customerId: customer,
  riskScore: {
    overall: 0,
    factors: {},
    category: 'low' as const,
    lastCalculated: now(),
    trends: { direction: 'stable' as const, changePercent: 0, timeframe: 30 },
  },
  paymentHistory: { totalPayments: 0, successfulPayments: 0, failedPayments: 0, averageAmount: 0, streakDays: 0 },
  subscriptionHistory: {
    totalSubscriptions: 0,
    activeSubscriptions: 0,
    canceledSubscriptions: 0,
    averageDuration: 0,
  },
  engagementMetrics: { score: 0, activityFrequency: 0, featureUsage: {} },
  communicationPreferences: { unsubscribed: false, unsubscribedChannels },
});

describe('channel opt-outs', () => {
  it('never sends on a channel the customer opted out of, and still reaches a customer who opted out of another', async () => {
    const optedOut = await newCustomer('optedout');
    const otherChannel = await newCustomer('otherchannel');
    await db
      .insert(dunning.customerRiskProfiles)
      .values([riskProfile(optedOut.id, ['email']), riskProfile(otherChannel.id, ['sms'])]);
    const campaignId = await createdCampaign('Opt-out: email');
    const campaign = await service.getCampaign(campaignId);
    const templateId = campaign?.templates[0]?.id;
    for (const buyer of [optedOut, otherChannel]) {
      await db.insert(tables.dunningExecutions).values({
        campaignId,
        templateId,
        customerId: buyer.id,
        triggerType: 'manual',
        triggerData: {},
        status: 'scheduled',
        scheduledAt: sub(now(), { minutes: 1 }),
      });
    }
    // A send reaches the communication service factory, which throws here: the error lands in the result
    await service.processScheduledExecutions(1000);
    const rows = await db
      .select()
      .from(tables.dunningExecutions)
      .where(eq(tables.dunningExecutions.campaignId, campaignId));

    const byCustomer = Object.fromEntries(rows.map(row => [row.customerId, JSON.stringify(row.result)]));
    expect(byCustomer[optedOut.id]).not.toContain('no communications in this test');
    expect(byCustomer[otherChannel.id]).toContain('no communications in this test');
  });
});
