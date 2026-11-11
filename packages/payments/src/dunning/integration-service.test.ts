/**
 * DunningIntegrationService: a campaign's spend range is stored JSON. A range `@arki/money` refuses is
 * returned as its failure, never read as "the campaign does not apply" and never as a wrong amount.
 */

import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { defineRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { add, now, sub } from '@arki/date';
import { findDatabaseError } from '@arki/db/errors';
import { FAILURE_ERROR_CODES, orThrow } from '@arki/failure';
import { money, UnknownCurrency } from '@arki/money';

import { createCustomerId, createPaymentId, createSubscriptionId } from '../core/primitives.js';
import { userIdFactory } from '../core/user-id.js';
import { PaymentRetryService } from '../core/services/payment-retry-service.js';
import { coreReads, runnerOn } from '../service-test-support.js';
import { core, customerId as fixtureCustomerId, openDb, planId, schema, typed, users } from '../test-support.js';
import { createDunningCampaignId } from './primitives.js';
import { createDunningIntegrationService, DunningIntegrationService } from './services/integration-service.js';
import { createDunningTables } from './tables.js';

const dunning = createDunningTables({
  schema,
  customerIdRef: () => core.customers.id,
  paymentIdRef: () => core.payments.id,
  subscriptionIdRef: () => core.subscriptions.id,
});

// The condition check reads no table, so the database is empty
const service = orThrow(
DunningIntegrationService.create(
  drizzle({ client: new PGlite('memory://') }),
  { customers: core.customers, payments: core.payments, subscriptions: core.subscriptions, plans: core.plans },
  dunning,
  { systemUserId: 'usr_system' },
),
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
  const handlers = orThrow(
  DunningIntegrationService.create(
    db,
    { customers: core.customers, payments: core.payments, subscriptions: core.subscriptions, plans: core.plans },
    dunning,
    { systemUserId: 'usr_system' },
  ),
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
  const service = orThrow(
  DunningIntegrationService.create(
    db,
    { customers: core.customers, payments: core.payments, subscriptions: core.subscriptions, plans: core.plans },
    dunning,
    { systemUserId: 'usr_system' },
  ),
  );
  return { client, db, service, customerId };
}

type StoredTrigger = (typeof dunning.dunningCampaigns.$inferInsert)['trigger'];

/** One campaign with one step, stored as the campaign service stores them. */
async function campaignWithStep(
  db: Awaited<ReturnType<typeof plainDatabase>>['db'],
  stopOnPaymentSuccess: boolean,
  trigger?: StoredTrigger,
) {
  const [campaign] = await db
    .insert(dunning.dunningCampaigns)
    .values({
      name: 'Recover',
      type: 'payment_failed',
      status: 'active',
      trigger: trigger ?? { type: 'payment_failure', conditions: {} },
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
      { id: segment.id, status: 'refused', failure: expect.objectContaining({ code: 'money.unknown_currency' }) },
    ]);
    expect(profiles).toMatchObject({
      processed: 1,
      failed: [{ id: customerId, status: 'refused', failure: { code: 'money.unknown_currency' } }],
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

describe('handlePaymentSuccess never drops a failed cancel', () => {
  // A customer who paid must stop getting dunning mail: when the cancel fails, the caller has to know so it can retry
  it('throws the database error when the active execution cannot be cancelled, and the execution stays scheduled', async () => {
    const { client, db, service: handlers, customerId } = await plainDatabase();
    const { campaign, template } = await campaignWithStep(db, true);
    await db.insert(dunning.dunningExecutions).values({
      campaignId: campaign.id,
      templateId: template.id,
      customerId,
      triggerType: 'payment_failure',
      triggerData: {},
      scheduledAt: add(now(), { hours: 1 }),
    });
    // The database refuses the cancel, as it would on a lock timeout or a lost connection
    await db.execute(
      sql`alter table ${dunning.dunningExecutions} add constraint executions_never_cancelled check (status <> 'cancelled')`,
    );

    const answer = handlers.handlePaymentSuccess({
      paymentId: orThrow(createPaymentId()),
      customerId,
      amount: money('50', 'EUR'),
    });

    await expect(answer).rejects.toSatisfy(error => findDatabaseError(error)?.sqlState === '23514');
    const [after] = await db.select().from(dunning.dunningExecutions);
    expect(after).toMatchObject({ status: 'scheduled' });
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

    // days is a whole number from 0 to 100 years: anything else is a caller bug, refused before any query
    for (const bad of [Number.NaN, 1e12, 0.01, -1]) {
      await expect(metrics.getIntegrationMetrics(bad)).rejects.toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
    }
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

/** The database refuses every new dunning execution, as an outage in the middle of a campaign run would. */
async function refuseExecutions(db: Awaited<ReturnType<typeof plainDatabase>>['db']) {
  await db.execute(
    sql.raw(
      "CREATE FUNCTION refuse_execution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the database refused the execution'; END $$",
    ),
  );
  await db.execute(
    sql`CREATE TRIGGER refuse_execution BEFORE INSERT ON ${dunning.dunningExecutions} FOR EACH ROW EXECUTE FUNCTION refuse_execution()`,
  );
}

/** The error the refusing trigger raises (SQLSTATE P0001, raise_exception). */
function refusedByTheDatabase(error: unknown) {
  return findDatabaseError(error)?.sqlState === 'P0001';
}

describe('an event handler never acknowledges a campaign run that threw', () => {
  it('handlePaymentFailure, handleSubscriptionStatusChange and handleTrialEnding throw the database error', async () => {
    const { client, db, service, customerId } = await plainDatabase();
    try {
      const [customer] = await db.select().from(core.customers).where(sql`${core.customers.id} = ${customerId}`);
      if (!customer) throw new Error('the customer was not stored');
      await campaignWithStep(db, false);
      await campaignWithStep(db, false, { type: 'subscription_status', conditions: { subscriptionStatus: ['past_due'] } });
      await campaignWithStep(db, false, { type: 'time_based', conditions: { trialEndingDays: 3 } });
      await db.insert(core.plans).values({ id: planId, name: 'Pro', priceMinor: 1000 });
      const [pastDue, trialing] = await db
        .insert(core.subscriptions)
        .values(
          (['past_due', 'trialing'] as const).map(status => ({
            id: orThrow(createSubscriptionId()),
            userId: customer.userId,
            planId,
            customerId,
            providerSubscriptionId: `sub_${status}`,
            status,
            // The past due period has ended; the trialing one runs on
            currentPeriodStart: sub(now(), { hours: 720 }),
            currentPeriodEnd: status === 'past_due' ? sub(now(), { hours: 1 }) : add(now(), { hours: 720 }),
            trialEnd: status === 'trialing' ? add(now(), { hours: 60 }) : undefined,
          })),
        )
        .returning();
      if (!pastDue || !trialing) throw new Error('the subscriptions were not stored');
      const paymentId = orThrow(createPaymentId());
      await db.insert(core.payments).values({
        id: paymentId,
        userId: customer.userId,
        customerId,
        providerPaymentId: `pi_${paymentId}`,
        amountMinor: 1999,
        currency: 'EUR',
        status: 'failed',
        createdAt: now(),
      });
      await refuseExecutions(db);

      await expect(service.handlePaymentFailure({ ...event, paymentId, customerId })).rejects.toSatisfy(
        refusedByTheDatabase,
      );
      await expect(
        service.handleSubscriptionStatusChange({
          subscriptionId: pastDue.id,
          customerId,
          oldStatus: 'active',
          newStatus: 'past_due',
        }),
      ).rejects.toSatisfy(refusedByTheDatabase);
      await expect(
        service.handleTrialEnding({
          subscriptionId: trialing.id,
          customerId,
          trialEndDate: add(now(), { hours: 60 }),
          daysUntilEnd: 3,
        }),
      ).rejects.toSatisfy(refusedByTheDatabase);
    } finally {
      await client.close();
    }
  });
});

describe('an event handler names what the event refers to and has no row', () => {
  it('an unknown customer returns payments.reference_not_found (customer) from each handler, and nothing is written', async () => {
    const { client, db, service } = await plainDatabase();
    try {
      const unknown = orThrow(createCustomerId());
      const subscriptionId = orThrow(createSubscriptionId());
      const paymentId = orThrow(createPaymentId());

      const answers = [
        await service.handlePaymentFailure({ ...event, paymentId, customerId: unknown }),
        await service.handlePaymentSuccess({ paymentId, customerId: unknown, amount: money('50', 'EUR') }),
        await service.handleSubscriptionStatusChange({
          subscriptionId,
          customerId: unknown,
          oldStatus: 'active',
          newStatus: 'past_due',
        }),
      ];

      for (const answer of answers) {
        expect(answer).toMatchObject({ code: 'payments.reference_not_found', data: { kind: 'customer', id: unknown } });
      }
      expect(await db.select().from(dunning.customerRiskProfiles)).toEqual([]);
      expect(await db.select().from(dunning.dunningExecutions)).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('the subscription id is not looked up: an unknown one, or an unknown trial customer, returns no failure', async () => {
    const { client, db, service, customerId } = await plainDatabase();
    try {
      const unknownSubscription = orThrow(createSubscriptionId());

      const changed = await service.handleSubscriptionStatusChange({
        subscriptionId: unknownSubscription,
        customerId,
        oldStatus: 'active',
        newStatus: 'past_due',
      });
      const trial = await service.handleTrialEnding({
        subscriptionId: unknownSubscription,
        customerId: orThrow(createCustomerId()),
        trialEndDate: add(now(), { hours: 72 }),
        daysUntilEnd: 3,
      });

      expect(changed).toBeUndefined();
      expect(trial).toBeUndefined();
      expect(await db.select().from(dunning.dunningExecutions)).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('handlePaymentFailure returns payments.reference_not_found (payment) when the retry service has no such payment', async () => {
    const { db, client } = await openDb({
      ...dunning.enums,
      dunningCampaigns: dunning.dunningCampaigns,
      dunningCampaignAnalytics: dunning.dunningCampaignAnalytics,
      dunningTemplates: dunning.dunningTemplates,
      dunningExecutions: dunning.dunningExecutions,
      dunningCommunications: dunning.dunningCommunications,
      customerSegments: dunning.customerSegments,
      customerRiskProfiles: dunning.customerRiskProfiles,
    });
    try {
      // The retry service only reads the payment here; it never reaches the payment provider
      const provider: Parameters<typeof PaymentRetryService.create>[0] = {
        async confirmPayment() {
          throw new Error('scheduling a retry never confirms a payment');
        },
      };
      const retries = orThrow(PaymentRetryService.create(provider, coreReads(db), typed.core.writes(runnerOn(db))));
      const handlers = orThrow(
      DunningIntegrationService.create(
        db,
        { customers: core.customers, payments: core.payments, subscriptions: core.subscriptions, plans: core.plans },
        dunning,
        { systemUserId: 'usr_system' },
        retries,
      ),
      );
      const paymentId = orThrow(createPaymentId());

      const answer = await handlers.handlePaymentFailure({ ...event, paymentId, customerId: fixtureCustomerId });

      expect(answer).toMatchObject({ code: 'payments.reference_not_found', data: { kind: 'payment', id: paymentId } });
      expect(await db.select().from(dunning.customerRiskProfiles)).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe('the event handlers answer an id holding U+0000 without a raw SQLSTATE 22021 (audit 4)', () => {
  const NUL = '\u0000';

  it('a customer id is unknown (payments.reference_not_found or no campaign), a subscription id stops nothing', async () => {
    const { client, db, service, customerId } = await plainDatabase();
    try {
      const subscriptionId = orThrow(createSubscriptionId());
      const paymentId = orThrow(createPaymentId());
      const customerNotFound = { code: 'payments.reference_not_found', data: { kind: 'customer' } };
      // A trial-ending campaign with no condition would run for any customer the event names
      await campaignWithStep(db, true, { type: 'time_based', conditions: {} });

      expect(await service.handlePaymentFailure({ ...event, paymentId, customerId: `cust${NUL}` })).toMatchObject(customerNotFound);
      expect(await service.handlePaymentSuccess({ paymentId, customerId: `cust${NUL}`, amount: money('5', 'EUR') })).toMatchObject(
        customerNotFound,
      );
      expect(
        await service.handleTrialEnding({
          subscriptionId,
          customerId: `cust${NUL}`,
          trialEndDate: add(now(), { hours: 72 }),
          daysUntilEnd: 3,
        }),
      ).toBeUndefined();
      // The recovery path stops executions by customer and subscription before anything else
      expect(
        await service.handleSubscriptionStatusChange({
          subscriptionId: `sub_${NUL}`,
          customerId,
          oldStatus: 'past_due',
          newStatus: 'active',
        }),
      ).toBeUndefined();
      expect(
        await service.handlePaymentSuccess({ paymentId, customerId, subscriptionId: `sub_${NUL}`, amount: money('5', 'EUR') }),
      ).toBeUndefined();
      expect(await db.select().from(dunning.dunningExecutions)).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe('building the service', () => {
  it('create and createDunningIntegrationService return payments.configuration_invalid for a channel setting no provider can use', () => {
    const tables = { customers: core.customers, payments: core.payments, subscriptions: core.subscriptions, plans: core.plans };
    const config = { systemUserId: 'usr_system', communication: { webhook: { allowedHosts: [] } } };
    const db = drizzle({ client: new PGlite('memory://') });

    expect(DunningIntegrationService.create(db, tables, dunning, config)).toMatchObject({ code: 'payments.configuration_invalid' });
    expect(createDunningIntegrationService(db, tables, dunning, config)).toMatchObject({ code: 'payments.configuration_invalid' });
  });
});
