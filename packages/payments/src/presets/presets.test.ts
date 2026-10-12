/**
 * The two webhook presets on the journal
 *
 * Flow: provider webhook → preset maps the delivery → `writes.syncSubscription`
 *       → journal event → `subscriptions` row, in one transaction.
 *
 * Providers send the same delivery more than once. These tests pin that the
 * first delivery leaves one event next to the row, that a repeat leaves none
 * (so the history of a subscription holds real changes only), and that a real
 * change leaves exactly one `SubscriptionSynced` with what the provider said.
 */
import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CoreWrites } from '../core/journal';
import type { PaymentProviderType } from '../core/types';
import type { AppDb } from '../test-support';
import type { RevenueCatEvent } from './revenuecat';
import type { SubscriptionBilling } from './subscription';
import { StripeProvider } from '../core/providers/stripe-provider';
import { coreReads, runnerOn } from '../service-test-support';
import {
  core,
  countEvents,
  customerId,
  eventTypesOf,
  openDb,
  planId,
  rejectionOf,
  typed,
  userId,
} from '../test-support';
import { projectRevenueCatEvent } from './revenuecat';
import { createSubscriptionBilling } from './subscription';

const { customers, subscriptions } = core;

let db: AppDb;
let client: PGlite;
let writes: CoreWrites;

beforeAll(async () => {
  ({ db, client } = await openDb());
  writes = typed.core.writes(runnerOn(db));
});

afterAll(async () => {
  await client.close();
});

async function rowOf(providerSubscriptionId: string) {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.providerSubscriptionId, providerSubscriptionId));

  if (!row) {
    throw new Error(`no subscription stored for ${providerSubscriptionId}`);
  }

  return row;
}

describe('Stripe: createSubscriptionBilling().handleWebhook', () => {
  const WEBHOOK_SECRET = 'whsec_presets_test';
  const PRICE_ID = 'price_pro_monthly';
  const JAN_1 = Date.UTC(2026, 0, 1) / 1000;
  const JAN_8 = Date.UTC(2026, 0, 8) / 1000;
  const FEB_1 = Date.UTC(2026, 1, 1) / 1000;
  const MAR_1 = Date.UTC(2026, 2, 1) / 1000;

  // No network: the provider only checks the signature, and the signature is made here.
  const stripe = new Stripe('sk_test_presets');
  const provider = new StripeProvider({
    apiKey: 'sk_test_presets',
    webhookSecret: WEBHOOK_SECRET,
    environment: 'sandbox',
  });

  let billing: SubscriptionBilling;

  beforeAll(() => {
    billing = createSubscriptionBilling({
      provider,
      repo: {
        ...coreReads(db),
        async findCustomerByProviderCustomerId(providerCustomerId: string, providerType: PaymentProviderType) {
          const [customer] = await db
            .select()
            .from(customers)
            .where(and(eq(customers.providerCustomerId, providerCustomerId), eq(customers.provider, providerType)));

          return customer ?? null;
        },
        createCustomer: () => Promise.reject(new Error('checkout is not part of these tests')),
      },
      writes,
      prices: [{ priceId: PRICE_ID, planId }],
      urls: { success: 'https://app.test/pro?status=success', cancel: 'https://app.test/pro?status=cancelled' },
    });
  });

  /** One signed `customer.subscription.*` delivery, shaped as Stripe sends it. */
  function deliver(
    type: 'customer.subscription.created' | 'customer.subscription.updated' | 'customer.subscription.deleted',
    subscriptionId: string,
    changes: Record<string, unknown> = {},
  ) {
    const payload = JSON.stringify({
      id: 'evt_presets_test',
      object: 'event',
      type,
      data: {
        object: {
          id: subscriptionId,
          object: 'subscription',
          customer: 'cus_test',
          status: 'trialing',
          items: {
            data: [{ current_period_start: JAN_1, current_period_end: FEB_1, price: { id: PRICE_ID } }],
          },
          trial_start: JAN_1,
          trial_end: JAN_8,
          cancel_at_period_end: false,
          canceled_at: null,
          metadata: { userId },
          ...changes,
        },
      },
    });

    return billing.handleWebhook(
      payload,
      stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
    );
  }

  it('the first delivery creates the row for the owner of the Stripe customer and leaves one event', async () => {
    const before = await countEvents(db);

    const result = await deliver('customer.subscription.created', 'sub_first');

    expect(result).toEqual({ handled: true, type: 'customer.subscription.created' });
    const row = await rowOf('sub_first');
    expect(row).toMatchObject({
      userId,
      customerId,
      planId,
      status: 'trialing',
      currentPeriodStart: new Date(JAN_1 * 1000),
      currentPeriodEnd: new Date(FEB_1 * 1000),
      trialStart: new Date(JAN_1 * 1000),
      trialEnd: new Date(JAN_8 * 1000),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      metadata: { userId },
      version: 1,
    });
    expect(await eventTypesOf(db, 'subscription', row.id)).toEqual(['SubscriptionCreated']);
    expect(await countEvents(db)).toBe(before + 1);
  });

  it('an identical second delivery writes no event and keeps one row', async () => {
    await deliver('customer.subscription.created', 'sub_repeat');
    const first = await rowOf('sub_repeat');
    const before = await countEvents(db);

    const result = await deliver('customer.subscription.created', 'sub_repeat');

    expect(result.handled).toBe(true);
    expect(await countEvents(db)).toBe(before);
    expect(await rowOf('sub_repeat')).toEqual(first);
    const rows = await db.select().from(subscriptions).where(eq(subscriptions.providerSubscriptionId, 'sub_repeat'));
    expect(rows).toHaveLength(1);
  });

  it('a changed delivery writes exactly one SubscriptionSynced', async () => {
    await deliver('customer.subscription.created', 'sub_renewed');
    const before = await countEvents(db);

    await deliver('customer.subscription.updated', 'sub_renewed', {
      status: 'active',
      items: { data: [{ current_period_start: FEB_1, current_period_end: MAR_1, price: { id: PRICE_ID } }] },
    });

    const row = await rowOf('sub_renewed');
    expect(row).toMatchObject({
      status: 'active',
      currentPeriodStart: new Date(FEB_1 * 1000),
      currentPeriodEnd: new Date(MAR_1 * 1000),
      version: 2,
    });
    expect(await eventTypesOf(db, 'subscription', row.id)).toEqual(['SubscriptionCreated', 'SubscriptionSynced']);
    expect(await countEvents(db)).toBe(before + 1);
  });

  it('a status change is stored as Stripe reports it, with Stripe’s own cancel time', async () => {
    await deliver('customer.subscription.created', 'sub_status', { status: 'active' });

    await deliver('customer.subscription.updated', 'sub_status', { status: 'past_due' });
    const pastDue = await rowOf('sub_status');
    expect(pastDue.status).toBe('past_due');

    await deliver('customer.subscription.deleted', 'sub_status', { status: 'canceled', canceled_at: JAN_8 });

    const row = await rowOf('sub_status');
    expect(row).toMatchObject({ status: 'canceled', canceledAt: new Date(JAN_8 * 1000), version: 3 });
    expect(await eventTypesOf(db, 'subscription', row.id)).toEqual([
      'SubscriptionCreated',
      'SubscriptionSynced',
      'SubscriptionSynced',
    ]);
  });

  it('a subscription of a Stripe customer we do not know is rejected and nothing is written', async () => {
    const before = await countEvents(db);

    const error = await rejectionOf(
      deliver('customer.subscription.created', 'sub_orphan', { customer: 'cus_unknown' }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(await countEvents(db)).toBe(before);
    const rows = await db.select().from(subscriptions).where(eq(subscriptions.providerSubscriptionId, 'sub_orphan'));
    expect(rows).toHaveLength(0);
  });
});

describe('RevenueCat: projectRevenueCatEvent', () => {
  const JAN_1 = Date.UTC(2026, 0, 1);
  const FEB_1 = Date.UTC(2026, 1, 1);
  const MAR_1 = Date.UTC(2026, 2, 1);

  afterEach(() => {
    vi.useRealTimers();
  });

  function deliver(transactionId: string, changes: Partial<RevenueCatEvent> = {}) {
    return projectRevenueCatEvent({
      writes,
      event: {
        type: 'INITIAL_PURCHASE',
        app_user_id: userId,
        product_id: 'pro_monthly',
        period_type: 'NORMAL',
        purchased_at_ms: JAN_1,
        expiration_at_ms: FEB_1,
        store: 'APP_STORE',
        environment: 'SANDBOX',
        original_transaction_id: transactionId,
        ...changes,
      },
      customer: { id: customerId, userId },
      planId,
    });
  }

  it('the first delivery creates the row and leaves one event', async () => {
    const before = await countEvents(db);

    const result = await deliver('rc_first');

    expect(result).toEqual({ handled: true });
    const row = await rowOf('rc_first');
    expect(row).toMatchObject({
      userId,
      customerId,
      planId,
      status: 'active',
      currentPeriodStart: new Date(JAN_1),
      currentPeriodEnd: new Date(FEB_1),
      trialStart: null,
      trialEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      metadata: { provider: 'revenuecat', store: 'APP_STORE', environment: 'SANDBOX' },
      version: 1,
    });
    expect(await eventTypesOf(db, 'subscription', row.id)).toEqual(['SubscriptionCreated']);
    expect(await countEvents(db)).toBe(before + 1);
  });

  it('an identical second delivery writes no event', async () => {
    await deliver('rc_repeat');
    const first = await rowOf('rc_repeat');
    const before = await countEvents(db);

    const result = await deliver('rc_repeat');

    expect(result).toEqual({ handled: true });
    expect(await countEvents(db)).toBe(before);
    expect(await rowOf('rc_repeat')).toEqual(first);
  });

  it('a renewal writes exactly one SubscriptionSynced with the new period', async () => {
    await deliver('rc_renewed');
    const before = await countEvents(db);

    await deliver('rc_renewed', { type: 'RENEWAL', purchased_at_ms: FEB_1, expiration_at_ms: MAR_1 });

    const row = await rowOf('rc_renewed');
    expect(row).toMatchObject({
      status: 'active',
      currentPeriodStart: new Date(FEB_1),
      currentPeriodEnd: new Date(MAR_1),
      version: 2,
    });
    expect(await eventTypesOf(db, 'subscription', row.id)).toEqual(['SubscriptionCreated', 'SubscriptionSynced']);
    expect(await countEvents(db)).toBe(before + 1);
  });

  it('a repeated expiration writes no event and keeps the first cancel time', async () => {
    // RevenueCat sends no cancel time, so the preset stamps "now" on every delivery.
    // Only the clock is faked: the database keeps its real timers.
    const firstSeen = new Date('2026-02-01T10:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(firstSeen);
    await deliver('rc_expired');

    await deliver('rc_expired', { type: 'EXPIRATION' });
    const canceled = await rowOf('rc_expired');
    expect(canceled).toMatchObject({ status: 'canceled', canceledAt: firstSeen, version: 2 });
    const before = await countEvents(db);

    vi.setSystemTime(new Date('2026-02-01T11:00:00.000Z'));
    const result = await deliver('rc_expired', { type: 'EXPIRATION' });

    expect(result).toEqual({ handled: true });
    expect(await countEvents(db)).toBe(before);
    expect(await rowOf('rc_expired')).toEqual(canceled);
    expect(await eventTypesOf(db, 'subscription', canceled.id)).toEqual(['SubscriptionCreated', 'SubscriptionSynced']);
  });

  it('an event that is not a subscription change is not handled and writes nothing', async () => {
    const before = await countEvents(db);

    const result = await deliver('rc_ping', { type: 'TEST' });

    expect(result).toEqual({ handled: false });
    expect(await countEvents(db)).toBe(before);
  });
});
