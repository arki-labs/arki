/**
 * DunningIntegrationService: a campaign's spend range is stored JSON. A range `@arki/money` refuses is
 * returned as its failure, never read as "the campaign does not apply" and never as a wrong amount.
 */

import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { add, now, sub } from '@arki/date';
import { orThrow } from '@arki/failure';
import { money, UnknownCurrency } from '@arki/money';

import { createCustomerId, createPaymentId, createSubscriptionId } from '../core/primitives.js';
import { userIdFactory } from '../core/user-id.js';
import { core, schema, users } from '../test-support.js';
import { createDunningCampaignId } from './primitives.js';
import { DunningIntegrationService } from './services/integration-service.js';
import { createDunningTables } from './tables.js';

const dunning = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});

// The condition check reads no table, so the database is empty
const service = new DunningIntegrationService(
  drizzle({ client: new PGlite('memory://') }),
  { customers: core.customers, payments: core.payments, subscriptions: core.subscriptions, plans: core.plans },
  dunning,
  { systemUserId: 'usr_system' },
);

const event = {
  paymentId: orThrow(createPaymentId()),
  customerId: orThrow(createCustomerId()),
  failureReason: 'card_declined',
  amount: money('50', 'EUR'),
  failureCount: 1,
};

function campaignWithRange(totalSpent: { min?: { amount: string; currency: string }; max?: { amount: string; currency: string } }) {
  return {
    id: orThrow(createDunningCampaignId()),
    name: 'Win back',
    status: 'active' as const,
    trigger: { type: 'payment_failure' as const, conditions: {}, filters: { totalSpent } },
  };
}

describe('evaluateCampaignConditions: the stored spend range', () => {
  it('returns the money failure for a bound in a currency money does not know', () => {
    const answer = service['evaluateCampaignConditions'](
      campaignWithRange({ min: { amount: '10', currency: 'ZZZ' } }),
      event,
    );

    expect(UnknownCurrency.is(answer)).toBe(true);
  });

  it('returns the money failure for a max bound money refuses, even when the min bound is fine', () => {
    const answer = service['evaluateCampaignConditions'](
      campaignWithRange({ min: { amount: '10', currency: 'EUR' }, max: { amount: '100', currency: 'ZZZ' } }),
      event,
    );

    expect(UnknownCurrency.is(answer)).toBe(true);
  });

  it('still answers true or false for a valid range', () => {
    const inside = campaignWithRange({ min: { amount: '10', currency: 'EUR' }, max: { amount: '100', currency: 'EUR' } });
    const above = campaignWithRange({ min: { amount: '60', currency: 'EUR' } });
    const otherCurrency = campaignWithRange({ min: { amount: '10', currency: 'USD' } });

    expect(service['evaluateCampaignConditions'](inside, event)).toBe(true);
    expect(service['evaluateCampaignConditions'](above, event)).toBe(false);
    expect(service['evaluateCampaignConditions'](otherCurrency, event)).toBe(false);
  });
});

describe('the event handlers return the money failure of a stored segment range', () => {
  // Every handler reads the customer's segments first; a segment whose spend range money refuses
  // must come back as that failure from the handler itself, not as a crash or a silent skip
  const relations = defineRelations({ ...dunning, customers: core.customers, payments: core.payments }, () => ({}));
  const client = new PGlite('memory://');
  const db = drizzle({ client, relations });
  const handlers = new DunningIntegrationService(
    db,
    { customers: core.customers, payments: core.payments, subscriptions: core.subscriptions, plans: core.plans },
    dunning,
    { systemUserId: 'usr_system' },
  );
  const customerId = orThrow(createCustomerId());
  const subscriptionId = orThrow(createSubscriptionId());

  beforeAll(async () => {
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
        dunningCampaigns: dunning.dunningCampaigns,
        dunningCampaignAnalytics: dunning.dunningCampaignAnalytics,
        dunningTemplates: dunning.dunningTemplates,
        dunningExecutions: dunning.dunningExecutions,
        dunningCommunications: dunning.dunningCommunications,
        customerSegments: dunning.customerSegments,
        customerRiskProfiles: dunning.customerRiskProfiles,
      },
      db,
    );
    await apply();
    const owner = orThrow(userIdFactory.create());
    await db.insert(users).values({ id: owner });
    await db
      .insert(core.customers)
      .values({ id: customerId, userId: owner, providerCustomerId: 'cus_handlers', email: 'handlers@example.com' });
    await db.insert(dunning.customerSegments).values({
      name: 'Stored bad range',
      type: 'custom',
      criteria: { totalSpent: { min: { amount: '10', currency: 'ZZZ' } } },
      autoUpdate: false,
      updateFrequency: 24,
      createdBy: 'usr_admin',
    });
  });

  afterAll(async () => {
    await client.close();
  });

  it('handlePaymentFailure, handlePaymentSuccess, handleTrialEnding and handleSubscriptionStatusChange', async () => {
    const paymentId = orThrow(createPaymentId());

    const failed = await handlers.handlePaymentFailure({ ...event, paymentId, customerId });
    const succeeded = await handlers.handlePaymentSuccess({ paymentId, customerId, amount: money('50', 'EUR') });
    const trial = await handlers.handleTrialEnding({
      subscriptionId,
      customerId,
      trialEndDate: add(now(), { hours: 72 }),
      daysUntilEnd: 3,
    });
    const changed = await handlers.handleSubscriptionStatusChange({
      subscriptionId,
      customerId,
      oldStatus: 'active',
      newStatus: 'past_due',
    });

    expect(UnknownCurrency.is(failed)).toBe(true);
    expect(UnknownCurrency.is(succeeded)).toBe(true);
    expect(UnknownCurrency.is(trial)).toBe(true);
    expect(changed).toMatchObject({ code: 'money.unknown_currency' });
  });
});

/** A database with every payments and dunning table and NO relations: what a plain `drizzle({ client })` gives. */
async function plainDatabase() {
  const client = new PGlite('memory://');
  const db = drizzle({ client });
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
      dunningCampaigns: dunning.dunningCampaigns,
      dunningCampaignAnalytics: dunning.dunningCampaignAnalytics,
      dunningTemplates: dunning.dunningTemplates,
      dunningExecutions: dunning.dunningExecutions,
      dunningCommunications: dunning.dunningCommunications,
      customerSegments: dunning.customerSegments,
      customerRiskProfiles: dunning.customerRiskProfiles,
    },
    db,
  );
  await apply();
  const owner = orThrow(userIdFactory.create());
  await db.insert(users).values({ id: owner });
  const customerId = orThrow(createCustomerId());
  await db
    .insert(core.customers)
    .values({ id: customerId, userId: owner, providerCustomerId: `cus_${customerId}`, email: 'plain@example.com' });
  const service = new DunningIntegrationService(
    db,
    { customers: core.customers, payments: core.payments, subscriptions: core.subscriptions, plans: core.plans },
    dunning,
    { systemUserId: 'usr_system' },
  );
  return { client, db, service, customerId };
}

/** One campaign with one step, stored as the campaign service stores them. */
async function campaignWithStep(db: Awaited<ReturnType<typeof plainDatabase>>['db'], stopOnPaymentSuccess: boolean) {
  const [campaign] = await db
    .insert(dunning.dunningCampaigns)
    .values({
      name: 'Recover',
      type: 'payment_failed',
      status: 'active',
      trigger: { type: 'payment_failure', conditions: {} },
      settings: {
        enabled: true,
        priority: 1,
        cooldownPeriod: 24,
        maxExecutionsPerCustomer: 3,
        stopOnPaymentSuccess,
        respectUnsubscribe: true,
        businessHoursOnly: false,
      },
      createdBy: 'usr_admin',
    })
    .returning();
  if (!campaign) throw new Error('the campaign was not stored');
  const [template] = await db
    .insert(dunning.dunningTemplates)
    .values({
      campaignId: campaign.id,
      name: 'Step 1',
      stepNumber: 1,
      delayHours: 0,
      communication: { channel: 'email', content: 'Please update your card', variables: [] },
    })
    .returning();
  if (!template) throw new Error('the template was not stored');
  return { campaign, template };
}

describe('the scheduled ticks hand their faults to the scheduler', () => {
  it('a fault that stops the whole tick is thrown, not swallowed', async () => {
    // `service` runs on an empty database: the executions table does not exist
    await expect(service.processScheduledExecutions()).rejects.toThrow();
    await expect(service.retryFailedExecutions()).rejects.toThrow();
  });

  it('processAutoUpdateSegments and updateRiskProfiles list the segment and the customer they could not handle', async () => {
    const { client, db, service: ticks, customerId } = await plainDatabase();
    const [segment] = await db
      .insert(dunning.customerSegments)
      .values({
        name: 'Stored bad range',
        type: 'custom',
        criteria: { totalSpent: { min: { amount: '10', currency: 'ZZZ' } } },
        autoUpdate: true,
        updateFrequency: 24,
        createdBy: 'usr_admin',
      })
      .returning();
    if (!segment) throw new Error('the segment was not stored');

    const segments = await ticks.processAutoUpdateSegments();
    const profiles = await ticks.updateRiskProfiles();

    expect(segments.failed).toEqual([
      expect.objectContaining({ id: segment.id, code: 'money.unknown_currency' }),
    ]);
    expect(profiles).toMatchObject({
      processed: 1,
      failed: [expect.objectContaining({ id: customerId, code: 'money.unknown_currency' })],
    });
    await client.close();
  });
});

describe('on a database without relations', () => {
  it('handlePaymentSuccess stops the active execution of a campaign that stops on payment success', async () => {
    const { client, db, service: handlers, customerId } = await plainDatabase();
    const { campaign, template } = await campaignWithStep(db, true);
    const [execution] = await db
      .insert(dunning.dunningExecutions)
      .values({
        campaignId: campaign.id,
        templateId: template.id,
        customerId,
        triggerType: 'payment_failure',
        triggerData: {},
        scheduledAt: add(now(), { hours: 1 }),
      })
      .returning();
    if (!execution) throw new Error('the execution was not stored');

    const answer = await handlers.handlePaymentSuccess({
      paymentId: orThrow(createPaymentId()),
      customerId,
      amount: money('50', 'EUR'),
    });
    const [after] = await db.select().from(dunning.dunningExecutions);

    expect(answer).toBeUndefined();
    expect(after).toMatchObject({ id: execution.id, status: 'cancelled' });
    await client.close();
  });
});

describe('healthCheck and getIntegrationMetrics read the stored rows', () => {
  it('a database whose tables cannot be read is unhealthy; a working one is healthy without a retry service', async () => {
    const { client, service: working } = await plainDatabase();

    const broken = await service.healthCheck();
    const healthy = await working.healthCheck();

    expect(broken).toMatchObject({ status: 'unhealthy', services: { campaigns: false, communications: false } });
    expect(healthy).toEqual({
      status: 'healthy',
      services: { campaigns: true, communications: true, segmentation: true, paymentRetry: false },
      providers: {},
    });
    await client.close();
  });

  it('counts the executions and sent communications of the window, with the mean processing time of completed runs', async () => {
    const { client, db, service: metrics, customerId } = await plainDatabase();
    const { campaign, template } = await campaignWithStep(db, false);
    const result = (processingTime: number) => ({
      customersProcessed: 1,
      communicationsSent: 1,
      errors: [],
      performance: { processingTime, successRate: 1 },
    });
    const base = { campaignId: campaign.id, templateId: template.id, customerId, triggerType: 'manual', triggerData: {} };
    const executions = await db
      .insert(dunning.dunningExecutions)
      .values([
        { ...base, scheduledAt: now(), status: 'completed', result: result(100) },
        { ...base, scheduledAt: now(), status: 'completed', result: result(300) },
        { ...base, scheduledAt: now(), status: 'failed' },
        // Outside the window: created 40 days ago
        { ...base, scheduledAt: now(), status: 'completed', result: result(5000), createdAt: sub(now(), { hours: 40 * 24 }) },
      ])
      .returning();
    const [first] = executions;
    if (!first) throw new Error('the executions were not stored');
    await db.insert(dunning.dunningCommunications).values({
      executionId: first.id,
      customerId,
      templateId: template.id,
      channel: 'email',
      recipient: 'plain@example.com',
      content: 'Please update your card',
      status: 'sent',
      sentAt: now(),
    });

    expect(await metrics.getIntegrationMetrics(30)).toEqual({
      totalExecutions: 3,
      successfulExecutions: 2,
      failedExecutions: 1,
      communicationsSent: 1,
      successRate: 2 / 3,
      averageProcessingTime: 200,
    });
    await client.close();
  });
});
