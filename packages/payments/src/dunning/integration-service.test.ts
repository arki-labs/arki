/**
 * DunningIntegrationService: a campaign's spend range is stored JSON. A range `@arki/money` refuses is
 * returned as its failure, never read as "the campaign does not apply" and never as a wrong amount.
 */

import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { add, now } from '@arki/date';
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
