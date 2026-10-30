// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
/**
 * StripeProvider: subscriptions and intents against a fake HTTP layer
 *
 * The real Stripe SDK runs; only its HTTP layer is replaced. Each test pins the
 * request Stripe would receive (path, form fields, idempotency key) and how the
 * answer becomes our types, so a rename in the SDK or a wrong unit shows up here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';
import { fromUnix, now } from '@arki/date';
import { orThrow } from '@arki/failure';
import { money } from '@arki/money';

import type { Customer, Plan, Subscription } from '../types.js';
import type { RecordedStripeRequest } from './stripe-test-support.js';
import { createRefundId } from '../../refunds/primitives.js';
import { createCustomerId, createPaymentId, createPlanId, createSubscriptionId } from '../primitives.js';
import { CardDeclined, IdempotencyConflict, ReferenceNotFound } from './provider-error.js';
import { StripeProvider } from './stripe-provider.js';
import { createFakeStripeHttp } from './stripe-test-support.js';

const PERIOD_START = 1_767_225_600;
const PERIOD_END = 1_769_904_000;

const customer: Customer = {
  id: orThrow(createCustomerId()),
  userId: 'usr_alice',
  providerCustomerId: 'cus_alice',
  provider: 'stripe',
  email: 'alice@example.com',
  name: null,
  defaultPaymentMethodId: null,
  metadata: null,
  createdAt: now(),
  updatedAt: now(),
};

function planRow(priceId: string | null): Plan {
  return {
    id: orThrow(createPlanId()),
    name: 'Pro',
    description: null,
    tier: 'pro',
    priceMinor: 1999,
    currency: 'USD',
    interval: 'monthly',
    intervalCount: 1,
    features: [],
    isActive: true,
    trialPeriodDays: null,
    metadata: priceId === null ? null : { stripePriceId: priceId },
    createdAt: now(),
    updatedAt: now(),
  };
}

const proPlan = planRow('price_pro');
const teamPlan = planRow('price_team');

const subscriptionRow: Subscription = {
  id: orThrow(createSubscriptionId()),
  userId: customer.userId,
  planId: proPlan.id,
  customerId: customer.id,
  providerSubscriptionId: 'sub_stripe_1',
  status: 'active',
  currentPeriodStart: fromUnix(PERIOD_START),
  currentPeriodEnd: fromUnix(PERIOD_END),
  trialStart: null,
  trialEnd: null,
  canceledAt: null,
  cancelAtPeriodEnd: false,
  metadata: { source: 'test' },
  createdAt: fromUnix(PERIOD_START),
  updatedAt: fromUnix(PERIOD_START),
};

const references = {
  findCustomerById: (id: string) => Promise.resolve(id === customer.id ? customer : null),
  findPlanById: (id: string) =>
    Promise.resolve([proPlan, teamPlan, planRow(null)].find(plan => plan.id === id) ?? null),
  findSubscriptionById: (id: string) => Promise.resolve(id === subscriptionRow.id ? subscriptionRow : null),
  findPaymentById: () => Promise.resolve(null),
};

function stripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_stripe_1',
    object: 'subscription',
    created: PERIOD_START,
    status: 'active',
    cancel_at_period_end: false,
    canceled_at: null,
    trial_start: null,
    trial_end: null,
    items: {
      object: 'list',
      has_more: false,
      url: '/v1/subscription_items',
      data: [
        { id: 'si_1', object: 'subscription_item', current_period_start: PERIOD_START, current_period_end: PERIOD_END },
      ],
    },
    ...overrides,
  };
}

function provider(respond: (request: RecordedStripeRequest) => { status?: number; body: unknown }) {
  const http = createFakeStripeHttp(respond);
  const stripe = new StripeProvider(
    { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
    { references, httpClient: http.client, maxNetworkRetries: 0 },
  );
  return { stripe, requests: http.requests };
}

describe('createSubscription', () => {
  it('subscribes the Stripe customer to the plan price and maps the answer', async () => {
    const { stripe, requests } = provider(() => ({
      body: stripeSubscription({ status: 'trialing', trial_start: PERIOD_START, trial_end: PERIOD_END }),
    }));

    const subscription = await orThrow(
      stripe.createSubscription({
        customerId: customer.id,
        planId: proPlan.id,
        paymentMethodId: 'pm_1',
        trialPeriodDays: 14,
        metadata: { source: 'checkout' },
        idempotencyKey: 'key-1',
      }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/subscriptions',
      form: {
        customer: 'cus_alice',
        'items[0][price]': 'price_pro',
        default_payment_method: 'pm_1',
        trial_period_days: '14',
        'metadata[source]': 'checkout',
        'metadata[userId]': 'usr_alice',
        'metadata[planId]': proPlan.id,
      },
      headers: { 'idempotency-key': 'key-1' },
    });
    expect(subscription).toMatchObject({
      userId: 'usr_alice',
      planId: proPlan.id,
      customerId: customer.id,
      providerSubscriptionId: 'sub_stripe_1',
      status: 'trialing',
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
    expect(subscription.currentPeriodStart.epochMilliseconds).toBe(PERIOD_START * 1000);
    expect(subscription.currentPeriodEnd.epochMilliseconds).toBe(PERIOD_END * 1000);
    expect(subscription.trialEnd?.epochMilliseconds).toBe(PERIOD_END * 1000);
  });

  it('returns ReferenceNotFound before any request when the plan has no Stripe price', async () => {
    const noPrice = planRow(null);
    const http = createFakeStripeHttp(() => ({ body: stripeSubscription() }));
    const direct = new StripeProvider(
      { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
      { references: { ...references, findPlanById: () => Promise.resolve(noPrice) }, httpClient: http.client },
    );

    const result = await direct.createSubscription({ customerId: customer.id, planId: noPrice.id });

    expect(ReferenceNotFound.is(result)).toBe(true);
    expect(result).toMatchObject({ data: { kind: 'plan', id: noPrice.id, missing: 'provider_id' } });
    expect(http.requests).toHaveLength(0);
  });

  it('says not_configured when the provider has no references', async () => {
    const bare = new StripeProvider({ apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' });

    await expect(bare.createSubscription({ customerId: customer.id, planId: proPlan.id })).rejects.toMatchObject({
      name: 'PaymentProviderError',
      code: 'not_configured',
    });
  });

  /** A declined card is an answer the caller must branch on (ask for another card), so it is returned, not thrown. */
  it('returns a declined card as CardDeclined with the Stripe codes', async () => {
    const { stripe } = provider(() => ({
      status: 402,
      body: {
        error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: 'Your card was declined.',
        },
      },
    }));

    const result = await stripe.createSubscription({
      customerId: customer.id,
      planId: proPlan.id,
      paymentMethodId: 'pm_bad',
    });

    expect(CardDeclined.is(result)).toBe(true);
    expect(result).toMatchObject({
      status: 402,
      data: { providerCode: 'card_declined', declineCode: 'insufficient_funds' },
    });
  });

  it('returns a reused idempotency key as IdempotencyConflict', async () => {
    const { stripe } = provider(() => ({
      status: 400,
      body: { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used once.' } },
    }));

    const result = await stripe.createSubscription({
      customerId: customer.id,
      planId: proPlan.id,
      idempotencyKey: 'key-1',
    });

    expect(IdempotencyConflict.is(result)).toBe(true);
  });

  it('marks a Stripe server error as retryable', async () => {
    const { stripe } = provider(() => ({ status: 500, body: { error: { type: 'api_error', message: 'boom' } } }));

    await expect(stripe.createSubscription({ customerId: customer.id, planId: proPlan.id })).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
  });
});

describe('cancelSubscription', () => {
  it('ends it now with DELETE when immediately', async () => {
    const { stripe, requests } = provider(() => ({
      body: stripeSubscription({ status: 'canceled', canceled_at: PERIOD_START + 10 }),
    }));

    const canceled = await orThrow(
      stripe.cancelSubscription(subscriptionRow.id, { immediately: true, reason: 'too pricey' }),
    );

    expect(requests[0]).toMatchObject({
      method: 'DELETE',
      path: '/v1/subscriptions/sub_stripe_1',
      form: { 'cancellation_details[comment]': 'too pricey' },
    });
    expect(canceled).toMatchObject({ id: subscriptionRow.id, status: 'canceled', cancelAtPeriodEnd: false });
    expect(canceled.canceledAt?.epochMilliseconds).toBe((PERIOD_START + 10) * 1000);
  });

  it('keeps it active until the period ends otherwise', async () => {
    const { stripe, requests } = provider(() => ({
      body: stripeSubscription({ cancel_at_period_end: true, canceled_at: PERIOD_START + 10 }),
    }));

    const canceled = await stripe.cancelSubscription(subscriptionRow.id, { idempotencyKey: 'cancel-1' });

    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/subscriptions/sub_stripe_1',
      form: { cancel_at_period_end: 'true' },
      headers: { 'idempotency-key': 'cancel-1' },
    });
    expect(canceled).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
  });

  it('returns ReferenceNotFound for an unknown subscription without calling Stripe', async () => {
    const { stripe, requests } = provider(() => ({ body: stripeSubscription() }));
    const subscriptionId = orThrow(createSubscriptionId());

    const result = await stripe.cancelSubscription(subscriptionId, {});

    expect(result).toMatchObject({
      code: 'payments.reference_not_found',
      status: 404,
      data: { kind: 'subscription', id: subscriptionId, missing: 'row' },
    });
    expect(requests).toHaveLength(0);
  });
});

describe('updateSubscription', () => {
  it('swaps the item price with the proration setting and returns the new plan', async () => {
    const { stripe, requests } = provider(() => ({ body: stripeSubscription() }));

    const updated = await orThrow(
      stripe.updateSubscription(subscriptionRow.id, {
        planId: teamPlan.id,
        prorationBehavior: 'none',
      }),
    );

    expect(requests.map(request => `${request.method} ${request.path}`)).toEqual([
      'GET /v1/subscriptions/sub_stripe_1',
      'POST /v1/subscriptions/sub_stripe_1',
    ]);
    expect(requests[1]?.form).toMatchObject({
      'items[0][id]': 'si_1',
      'items[0][price]': 'price_team',
      proration_behavior: 'none',
    });
    expect(updated.planId).toBe(teamPlan.id);
    expect(updated.id).toBe(subscriptionRow.id);
  });

  it('sets cancelAtPeriodEnd without touching the price', async () => {
    const { stripe, requests } = provider(() => ({ body: stripeSubscription({ cancel_at_period_end: true }) }));

    const updated = await orThrow(
      stripe.updateSubscription(subscriptionRow.id, {
        cancelAtPeriodEnd: true,
        metadata: { note: 'win-back' },
      }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.form).toMatchObject({ cancel_at_period_end: 'true', 'metadata[note]': 'win-back' });
    expect(requests[0]?.form).not.toHaveProperty('items[0][price]');
    expect(updated).toMatchObject({ planId: proPlan.id, cancelAtPeriodEnd: true });
    expect(updated.metadata).toEqual({ source: 'test', note: 'win-back' });
  });
});

describe('createPaymentIntent', () => {
  it('sends JPY in yen, not yen x 100, and lets the client finish the payment', async () => {
    const { stripe, requests } = provider(() => ({
      body: { id: 'pi_1', object: 'payment_intent', client_secret: 'pi_1_secret' },
    }));

    const intent = await stripe.createPaymentIntent({
      customerId: customer.id,
      amount: money(1500, 'JPY'),
      automatic: false,
      idempotencyKey: 'pay-1',
    });

    expect(requests[0]).toMatchObject({
      path: '/v1/payment_intents',
      form: {
        amount: '1500',
        currency: 'jpy',
        customer: 'cus_alice',
        'automatic_payment_methods[enabled]': 'true',
      },
      headers: { 'idempotency-key': 'pay-1' },
    });
    expect(requests[0]?.form).not.toHaveProperty('confirm');
    expect(intent).toEqual({ clientSecret: 'pi_1_secret', paymentIntentId: 'pi_1' });
  });

  it('charges at once, off session, for an automatic payment', async () => {
    const { stripe, requests } = provider(() => ({
      body: { id: 'pi_2', object: 'payment_intent', client_secret: 'pi_2_secret' },
    }));

    await orThrow(
      stripe.createPaymentIntent({
        customerId: customer.id,
        amount: money('19.99', 'USD'),
        paymentMethodId: 'pm_1',
        automatic: true,
      }),
    );

    expect(requests[0]?.form).toMatchObject({
      amount: '1999',
      currency: 'usd',
      payment_method: 'pm_1',
      confirm: 'true',
      off_session: 'true',
    });
  });

  it('refuses an automatic payment without a payment method', async () => {
    const { stripe, requests } = provider(() => ({ body: {} }));

    await expect(
      stripe.createPaymentIntent({ customerId: customer.id, amount: money('5', 'USD'), automatic: true }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });
});

describe('createSetupIntent', () => {
  it('saves a payment method for later use', async () => {
    const { stripe, requests } = provider(() => ({
      body: { id: 'seti_1', object: 'setup_intent', client_secret: 'seti_1_secret' },
    }));

    const intent = await stripe.createSetupIntent(customer.id, { idempotencyKey: 'setup-1' });

    expect(requests[0]).toMatchObject({
      path: '/v1/setup_intents',
      form: { customer: 'cus_alice', usage: 'off_session', 'automatic_payment_methods[enabled]': 'true' },
      headers: { 'idempotency-key': 'setup-1' },
    });
    expect(intent).toEqual({ clientSecret: 'seti_1_secret', setupIntentId: 'seti_1' });
  });

  it('throws when Stripe sends no client secret', async () => {
    const { stripe } = provider(() => ({ body: { id: 'seti_2', object: 'setup_intent', client_secret: null } }));

    await expect(stripe.createSetupIntent(customer.id)).rejects.toMatchObject({ code: 'unknown' });
  });
});

describe('ID failure before charge requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the canonical refusal before creating subscriptions or payment intents', async () => {
    const http = createFakeStripeHttp(() => ({ body: {} }));
    const stripe = new StripeProvider(
      { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
      {
        httpClient: http.client,
        maxNetworkRetries: 0,
        references: { ...references, findPlanById: () => Promise.resolve(proPlan) },
      },
    );
    vi.stubGlobal('crypto', {});
    expect(
      RandomSourceUnavailable.is(await stripe.createSubscription({ customerId: customer.id, planId: proPlan.id })),
    ).toBe(true);
    expect(
      RandomSourceUnavailable.is(
        await stripe.createPayment({
          customerId: customer.id,
          amount: money('9.99', 'USD'),
          paymentMethodId: 'pm_1',
        }),
      ),
    ).toBe(true);
    expect(http.requests).toHaveLength(0);
  });
});

/**
 * T08 ledger proof: every provider call that takes one of our ids returns `ReferenceNotFound` for an id with no row,
 * before any Stripe request. A call that asks Stripe to move money returns `CardDeclined` or `IdempotencyConflict`
 * when Stripe says so. Each row is asserted by its exact failure code.
 */
describe('failures returned by every call that takes our ids', () => {
  const unknownCustomerId = orThrow(createCustomerId());
  const unknownPlanId = orThrow(createPlanId());
  const unknownSubscriptionId = orThrow(createSubscriptionId());

  const missingCustomerCalls = {
    updateCustomer: (stripe: StripeProvider) => stripe.updateCustomer(unknownCustomerId, { name: 'x' }),
    deleteCustomer: (stripe: StripeProvider) => stripe.deleteCustomer(unknownCustomerId),
    listPaymentMethods: (stripe: StripeProvider) => stripe.listPaymentMethods(unknownCustomerId),
    setDefaultPaymentMethod: (stripe: StripeProvider) =>
      stripe.setDefaultPaymentMethod({ customerId: unknownCustomerId, paymentMethodId: 'pm_1' }),
    attachPaymentMethod: (stripe: StripeProvider) =>
      stripe.attachPaymentMethod({ customerId: unknownCustomerId, paymentMethodId: 'pm_1' }),
    createSetupIntent: (stripe: StripeProvider) => stripe.createSetupIntent(unknownCustomerId),
    createPaymentIntent: (stripe: StripeProvider) =>
      stripe.createPaymentIntent({
        customerId: unknownCustomerId,
        amount: money('9.99', 'USD'),
        paymentMethodId: 'pm_1',
        automatic: true,
      }),
    createPayment: (stripe: StripeProvider) =>
      stripe.createPayment({ customerId: unknownCustomerId, amount: money('9.99', 'USD'), paymentMethodId: 'pm_1' }),
    createSubscription: (stripe: StripeProvider) =>
      stripe.createSubscription({ customerId: unknownCustomerId, planId: proPlan.id }),
  };

  it.each(Object.entries(missingCustomerCalls))('%s returns ReferenceNotFound for an unknown customer', async (_name, call) => {
    const { stripe, requests } = provider(() => ({ body: {} }));

    const result = await call(stripe);

    expect(result).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'customer', id: unknownCustomerId, missing: 'row' },
    });
    expect(requests).toHaveLength(0);
  });

  const missingPlanCalls = {
    updatePlan: (stripe: StripeProvider) => stripe.updatePlan(unknownPlanId, { name: 'x' }),
    deletePlan: (stripe: StripeProvider) => stripe.deletePlan(unknownPlanId),
    updateSubscriptionToUnknownPlan: (stripe: StripeProvider) =>
      stripe.updateSubscription(subscriptionRow.id, { planId: unknownPlanId }),
    previewSubscriptionChange: (stripe: StripeProvider) =>
      stripe.previewSubscriptionChange({ subscriptionId: subscriptionRow.id, planId: unknownPlanId }),
  };

  it.each(Object.entries(missingPlanCalls))('%s returns ReferenceNotFound for an unknown plan', async (_name, call) => {
    const { stripe, requests } = provider(() => ({ body: {} }));

    const result = await call(stripe);

    expect(result).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'plan', id: unknownPlanId, missing: 'row' },
    });
    expect(requests).toHaveLength(0);
  });

  it('getPlan returns null for an unknown plan row and ReferenceNotFound for a plan with no Stripe price', async () => {
    const { stripe, requests } = provider(() => ({ body: {} }));
    const noPrice = planRow(null);
    const withoutPrice = new StripeProvider(
      { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
      { references: { ...references, findPlanById: () => Promise.resolve(noPrice) } },
    );

    expect(await stripe.getPlan(unknownPlanId)).toBeNull();
    expect(await withoutPrice.getPlan(noPrice.id)).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'plan', id: noPrice.id, missing: 'provider_id' },
    });
    expect(requests).toHaveLength(0);
  });

  const missingSubscriptionCalls = {
    updateSubscription: (stripe: StripeProvider) => stripe.updateSubscription(unknownSubscriptionId, {}),
    reactivateSubscription: (stripe: StripeProvider) => stripe.reactivateSubscription(unknownSubscriptionId),
    pauseSubscription: (stripe: StripeProvider) => stripe.pauseSubscription(unknownSubscriptionId),
    resumeSubscription: (stripe: StripeProvider) => stripe.resumeSubscription(unknownSubscriptionId),
    previewSubscriptionChange: (stripe: StripeProvider) =>
      stripe.previewSubscriptionChange({ subscriptionId: unknownSubscriptionId, planId: proPlan.id }),
  };

  it.each(Object.entries(missingSubscriptionCalls))(
    '%s returns ReferenceNotFound for an unknown subscription',
    async (_name, call) => {
      const { stripe, requests } = provider(() => ({ body: {} }));

      const result = await call(stripe);

      expect(result).toMatchObject({
        code: 'payments.reference_not_found',
        data: { kind: 'subscription', id: unknownSubscriptionId, missing: 'row' },
      });
      expect(requests).toHaveLength(0);
    },
  );

  const unknownPaymentId = orThrow(createPaymentId());
  const missingPaymentCalls = {
    confirmPayment: (stripe: StripeProvider) => stripe.confirmPayment(unknownPaymentId),
    cancelPayment: (stripe: StripeProvider) => stripe.cancelPayment(unknownPaymentId),
    refundPayment: (stripe: StripeProvider) =>
      stripe.refundPayment(unknownPaymentId, { refundId: orThrow(createRefundId()), idempotencyKey: 'k1' }),
    findRefund: (stripe: StripeProvider) => stripe.findRefund(unknownPaymentId, orThrow(createRefundId())),
  };

  it.each(Object.entries(missingPaymentCalls))('%s returns ReferenceNotFound for an unknown payment', async (_name, call) => {
    const { stripe, requests } = provider(() => ({ body: {} }));

    expect(await call(stripe)).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'payment', id: unknownPaymentId, missing: 'row' },
    });
    expect(requests).toHaveLength(0);
  });

  const declinedCalls = {
    createPayment: (stripe: StripeProvider) =>
      stripe.createPayment({ customerId: customer.id, amount: money('9.99', 'USD'), paymentMethodId: 'pm_bad' }),
    attachPaymentMethod: (stripe: StripeProvider) =>
      stripe.attachPaymentMethod({ customerId: customer.id, paymentMethodId: 'pm_bad' }),
    createPaymentIntent: (stripe: StripeProvider) =>
      stripe.createPaymentIntent({
        customerId: customer.id,
        amount: money('9.99', 'USD'),
        paymentMethodId: 'pm_bad',
        automatic: true,
      }),
    updateSubscription: (stripe: StripeProvider) =>
      stripe.updateSubscription(subscriptionRow.id, { paymentMethodId: 'pm_bad' }),
  };

  it.each(Object.entries(declinedCalls))('%s returns a declined card as payments.card_declined', async (_name, call) => {
    const { stripe } = provider(() => ({
      status: 402,
      body: { error: { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'no' } },
    }));

    expect(await call(stripe)).toMatchObject({ code: 'payments.card_declined', status: 402 });
  });

  const conflictCalls = {
    cancelSubscription: (stripe: StripeProvider) =>
      stripe.cancelSubscription(subscriptionRow.id, { idempotencyKey: 'k1' }),
    updateSubscription: (stripe: StripeProvider) =>
      stripe.updateSubscription(subscriptionRow.id, { cancelAtPeriodEnd: true, idempotencyKey: 'k1' }),
    createSetupIntent: (stripe: StripeProvider) => stripe.createSetupIntent(customer.id, { idempotencyKey: 'k1' }),
    createPaymentIntent: (stripe: StripeProvider) =>
      stripe.createPaymentIntent({
        customerId: customer.id,
        amount: money('9.99', 'USD'),
        paymentMethodId: 'pm_1',
        automatic: true,
        idempotencyKey: 'k1',
      }),
  };

  it.each(Object.entries(conflictCalls))('%s returns a reused key as payments.idempotency_conflict', async (_name, call) => {
    const { stripe } = provider(() => ({
      status: 400,
      body: { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used once.' } },
    }));

    expect(await call(stripe)).toMatchObject({ code: 'payments.idempotency_conflict', status: 409 });
  });
});
