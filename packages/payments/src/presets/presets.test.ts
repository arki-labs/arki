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

import { fromMillis, fromUnix, instant, toDate } from '@arki/date';

import type { CoreWrites } from '../core/journal.js';
import type { SubscriptionStatus } from '../core/primitives.js';
import type { PaymentProviderType, Subscription } from '../core/types.js';
import type { AppDb } from '../test-support.js';
import type { RevenueCatEvent } from './revenuecat.js';
import type { SubscriptionBilling } from './subscription.js';
import { createSubscriptionId } from '../core/primitives.js';
import { StripeProvider } from '../core/providers/stripe-provider.js';
import { coreReads, runnerOn } from '../service-test-support.js';
import {
  adminId,
  core,
  countEvents,
  customerId,
  eventTypesOf,
  openDb,
  planId,
  rejectionOf,
  typed,
  userId,
} from '../test-support.js';
import { projectRevenueCatEvent, verifyRevenueCatAuth } from './revenuecat.js';
import { createSubscriptionBilling, getEntitlement } from './subscription.js';

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

function rowsOf(providerSubscriptionId: string) {
  return db.select().from(subscriptions).where(eq(subscriptions.providerSubscriptionId, providerSubscriptionId));
}

/** A delivery the preset must refuse: it throws, and no event or row is written. */
async function expectRefused(delivery: Promise<unknown>, providerSubscriptionId: string) {
  const before = await countEvents(db);

  const error = await rejectionOf(delivery);

  expect(await countEvents(db)).toBe(before);
  expect(await rowsOf(providerSubscriptionId)).toHaveLength(0);
  return error;
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

  type SubscriptionEventType =
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted';

  /** The `Stripe-Signature` header Stripe would send for this body, signed with `secret`. */
  function sign(payload: string, secret = WEBHOOK_SECRET) {
    return stripe.webhooks.generateTestHeaderString({ payload, secret });
  }

  /** The body of one `customer.subscription.*` event, shaped as Stripe sends it. */
  function subscriptionEvent(type: SubscriptionEventType, subscriptionId: string, changes: Record<string, unknown> = {}) {
    return JSON.stringify({
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
  }

  /** One signed `customer.subscription.*` delivery. */
  function deliver(type: SubscriptionEventType, subscriptionId: string, changes: Record<string, unknown> = {}) {
    const payload = subscriptionEvent(type, subscriptionId, changes);

    return billing.handleWebhook(payload, sign(payload));
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
      currentPeriodStart: fromUnix(JAN_1),
      currentPeriodEnd: fromUnix(FEB_1),
      trialStart: fromUnix(JAN_1),
      trialEnd: fromUnix(JAN_8),
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
      currentPeriodStart: fromUnix(FEB_1),
      currentPeriodEnd: fromUnix(MAR_1),
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
    expect(row).toMatchObject({ status: 'canceled', canceledAt: fromUnix(JAN_8), version: 3 });
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

  it('a delivery signed with another secret is rejected and nothing is written', async () => {
    // Anyone can POST to the webhook URL; only Stripe knows the secret.
    const payload = subscriptionEvent('customer.subscription.created', 'sub_forged');

    const error = await expectRefused(billing.handleWebhook(payload, sign(payload, 'whsec_someone_else')), 'sub_forged');

    expect(error).toBeInstanceOf(Stripe.errors.StripeSignatureVerificationError);
  });

  it('a body changed after Stripe signed it is rejected and nothing is written', async () => {
    const signed = subscriptionEvent('customer.subscription.created', 'sub_tampered');
    const tampered = subscriptionEvent('customer.subscription.created', 'sub_tampered', { status: 'active' });

    const error = await expectRefused(billing.handleWebhook(tampered, sign(signed)), 'sub_tampered');

    expect(error).toBeInstanceOf(Stripe.errors.StripeSignatureVerificationError);
  });

  it('a price the app does not sell is rejected by name and nothing is written', async () => {
    // Granting Pro for an unknown price would hand out a plan nobody configured.
    const error = await expectRefused(
      deliver('customer.subscription.created', 'sub_other_price', {
        items: { data: [{ current_period_start: JAN_1, current_period_end: FEB_1, price: { id: 'price_elsewhere' } }] },
      }),
      'sub_other_price',
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('"price_elsewhere" is not a configured plan');
  });

  it('a subscription whose first line item has no price is rejected and nothing is written', async () => {
    const error = await expectRefused(
      deliver('customer.subscription.created', 'sub_no_price', { items: { data: [] } }),
      'sub_no_price',
    );

    expect(String(error)).toContain('first line item has no price');
  });

  it('a status Stripe adds later is rejected loudly instead of being guessed', async () => {
    const error = await expectRefused(
      deliver('customer.subscription.created', 'sub_new_status', { status: 'on_vacation' }),
      'sub_new_status',
    );

    expect(String(error)).toContain('unmapped Stripe subscription status: "on_vacation"');
  });

  it('a signed event that is not a subscription change is acknowledged as not handled and writes nothing', async () => {
    const payload = JSON.stringify({
      id: 'evt_invoice',
      object: 'event',
      type: 'invoice.paid',
      data: { object: { id: 'in_test', object: 'invoice', customer: 'cus_test' } },
    });
    const before = await countEvents(db);

    const result = await billing.handleWebhook(payload, sign(payload));

    expect(result).toEqual({ handled: false, type: 'invoice.paid' });
    expect(await countEvents(db)).toBe(before);
  });

  it('a user with no subscription rows is on the free tier', async () => {
    expect(await billing.getEntitlement(adminId)).toEqual({ tier: 'free' });
  });
});

/** `getEntitlement` over rows as `findSubscriptionsByUserId` returns them: newest first. */
function entitlementOf(...newestFirst: Subscription[]) {
  return getEntitlement({ findSubscriptionsByUserId: () => Promise.resolve(newestFirst) }, userId);
}

describe('getEntitlement', () => {
  const JAN_1 = instant('2026-01-01T00:00:00.000Z');
  const JAN_8 = instant('2026-01-08T00:00:00.000Z');
  const FEB_1 = instant('2026-02-01T00:00:00.000Z');

  function subscription(status: SubscriptionStatus, changes: Partial<Subscription> = {}): Subscription {
    return {
      id: createSubscriptionId(),
      userId,
      planId,
      customerId,
      providerSubscriptionId: `sub_${status}`,
      status,
      currentPeriodStart: JAN_1,
      currentPeriodEnd: FEB_1,
      trialStart: null,
      trialEnd: null,
      canceledAt: null,
      cancelAtPeriodEnd: false,
      metadata: null,
      createdAt: JAN_1,
      updatedAt: JAN_1,
      ...changes,
    };
  }

  it('an active subscription grants Pro until the end of its period', async () => {
    expect(await entitlementOf(subscription('active', { cancelAtPeriodEnd: true }))).toEqual({
      tier: 'pro',
      status: 'active',
      renews: FEB_1,
      cancelAtPeriodEnd: true,
      trialEnd: null,
    });
  });

  it('a trialing subscription grants Pro, so the trial meant to sell Pro actually shows it', async () => {
    expect(await entitlementOf(subscription('trialing', { trialStart: JAN_1, trialEnd: JAN_8 }))).toEqual({
      tier: 'pro',
      status: 'trialing',
      renews: FEB_1,
      cancelAtPeriodEnd: false,
      trialEnd: JAN_8,
    });
  });

  it('a past-due subscription alone does not grant Pro', async () => {
    expect(await entitlementOf(subscription('past_due'))).toEqual({ tier: 'free' });
  });

  it('a newer canceled subscription does not hide an older one that is still active', async () => {
    const canceled = subscription('canceled', { canceledAt: JAN_8 });
    const active = subscription('active');

    expect(await entitlementOf(canceled, active)).toMatchObject({ tier: 'pro', status: 'active' });
  });
});

describe('verifyRevenueCatAuth', () => {
  const SECRET = 'Bearer rc_shared_secret';

  it('accepts the exact header configured in RevenueCat', () => {
    expect(verifyRevenueCatAuth(SECRET, SECRET)).toBe(true);
  });

  it('rejects everything when no secret is configured, so an unset env var cannot open the webhook', () => {
    expect(verifyRevenueCatAuth('', '')).toBe(false);
    expect(verifyRevenueCatAuth(SECRET, '')).toBe(false);
  });

  it('rejects a request with no Authorization header', () => {
    expect(verifyRevenueCatAuth(null, SECRET)).toBe(false);
  });

  it('rejects a header of another length without throwing', () => {
    expect(verifyRevenueCatAuth('Bearer short', SECRET)).toBe(false);
  });

  it('rejects a header of the same length with different content', () => {
    const forged = SECRET.slice(0, -1) + 'X';
    expect(forged).toHaveLength(SECRET.length);

    expect(verifyRevenueCatAuth(forged, SECRET)).toBe(false);
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
      currentPeriodStart: fromMillis(JAN_1),
      currentPeriodEnd: fromMillis(FEB_1),
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
      currentPeriodStart: fromMillis(FEB_1),
      currentPeriodEnd: fromMillis(MAR_1),
      version: 2,
    });
    expect(await eventTypesOf(db, 'subscription', row.id)).toEqual(['SubscriptionCreated', 'SubscriptionSynced']);
    expect(await countEvents(db)).toBe(before + 1);
  });

  it('a repeated expiration writes no event and keeps the first cancel time', async () => {
    // RevenueCat sends no cancel time, so the preset stamps "now" on every delivery.
    // Only the clock is faked: the database keeps its real timers.
    const firstSeen = instant('2026-02-01T10:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(toDate(firstSeen));
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

  it('a purchase inside a trial period is stored as trialing with the trial window', async () => {
    await deliver('rc_trial', { period_type: 'TRIAL' });

    expect(await rowOf('rc_trial')).toMatchObject({
      status: 'trialing',
      trialStart: fromMillis(JAN_1),
      trialEnd: fromMillis(FEB_1),
      cancelAtPeriodEnd: false,
    });
  });

  it('a cancellation keeps access until the period ends', async () => {
    await deliver('rc_cancel');

    await deliver('rc_cancel', { type: 'CANCELLATION' });

    expect(await rowOf('rc_cancel')).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: fromMillis(FEB_1),
    });
  });

  it('a billing issue moves the subscription to past due', async () => {
    await deliver('rc_billing');

    await deliver('rc_billing', { type: 'BILLING_ISSUE' });

    expect(await rowOf('rc_billing')).toMatchObject({ status: 'past_due' });
  });

  it('a purchase that never expires gets a period end about 100 years out', async () => {
    await deliver('rc_lifetime', { type: 'NON_RENEWING_PURCHASE', expiration_at_ms: null });

    expect(await rowOf('rc_lifetime')).toMatchObject({
      status: 'active',
      currentPeriodStart: fromMillis(JAN_1),
      currentPeriodEnd: fromMillis(JAN_1 + 100 * 365 * 24 * 60 * 60 * 1000),
    });
  });

  it('an event with no transaction ids is keyed by user and product, so repeats converge to one row', async () => {
    const event = {
      type: 'INITIAL_PURCHASE',
      app_user_id: userId,
      product_id: 'pro_yearly',
      period_type: 'NORMAL',
      purchased_at_ms: JAN_1,
      expiration_at_ms: FEB_1,
    };

    await projectRevenueCatEvent({ writes, event, customer: { id: customerId, userId }, planId });
    await projectRevenueCatEvent({ writes, event, customer: { id: customerId, userId }, planId });

    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.providerSubscriptionId, `${userId}:pro_yearly`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'active', currentPeriodEnd: fromMillis(FEB_1) });
  });

  it('an event that is not a subscription change is not handled and writes nothing', async () => {
    const before = await countEvents(db);

    const result = await deliver('rc_ping', { type: 'TEST' });

    expect(result).toEqual({ handled: false });
    expect(await countEvents(db)).toBe(before);
  });
});
