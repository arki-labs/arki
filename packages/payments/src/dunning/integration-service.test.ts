/**
 * DunningIntegrationService: a campaign's spend range is stored JSON. A range `@arki/money` refuses is
 * returned as its failure, never read as "the campaign does not apply" and never as a wrong amount.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';
import { money, UnknownCurrency } from '@arki/money';

import { createCustomerId, createPaymentId } from '../core/primitives.js';
import { core, schema } from '../test-support.js';
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
