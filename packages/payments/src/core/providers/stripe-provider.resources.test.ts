/**
 * StripeProvider: customers, plans, payments and payment methods against a fake HTTP layer
 *
 * The real Stripe SDK runs; only its HTTP layer is replaced. Our ids are resolved to Stripe ids through
 * `references`, and every answer is mapped back to our row types, so a wrong path, a wrong unit or a
 * leftover placeholder shows up here.
 */
import { describe, expect, it } from 'vitest';

import { fromUnix, now } from '@arki/date';
import { money } from '@arki/money';

import type { Customer, Payment, Plan, Subscription } from '../types.js';
import type { RecordedStripeRequest } from './stripe-test-support.js';
import { createCustomerId, createPaymentId, createPlanId, createSubscriptionId } from '../primitives.js';
import { StripeProvider } from './stripe-provider.js';
import { createFakeStripeHttp } from './stripe-test-support.js';

const T0 = 1_767_225_600;
const T1 = 1_769_904_000;

const customer: Customer = {
  id: createCustomerId(),
  userId: 'usr_alice',
  providerCustomerId: 'cus_alice',
  provider: 'stripe',
  email: 'old@example.com',
  name: null,
  defaultPaymentMethodId: null,
  metadata: { plan: 'x' },
  createdAt: now(),
  updatedAt: now(),
};

const planId = createPlanId();
const planRow: Plan = {
  id: planId,
  name: 'Old name',
  description: null,
  tier: 'pro',
  priceMinor: 1,
  currency: 'USD',
  interval: 'monthly',
  intervalCount: 1,
  features: [],
  isActive: true,
  trialPeriodDays: null,
  metadata: { stripePriceId: 'price_pro', stripeProductId: 'prod_pro' },
  createdAt: now(),
  updatedAt: now(),
};
const otherPlanId = createPlanId();

const subscriptionRow: Subscription = {
  id: createSubscriptionId(),
  userId: customer.userId,
  planId,
  customerId: customer.id,
  providerSubscriptionId: 'sub_1',
  status: 'active',
  currentPeriodStart: fromUnix(T0),
  currentPeriodEnd: fromUnix(T1),
  trialStart: null,
  trialEnd: null,
  canceledAt: null,
  cancelAtPeriodEnd: true,
  metadata: null,
  createdAt: fromUnix(T0),
  updatedAt: fromUnix(T0),
};

const paymentRow: Payment = {
  id: createPaymentId(),
  userId: customer.userId,
  customerId: customer.id,
  subscriptionId: subscriptionRow.id,
  providerPaymentId: 'pi_1',
  amountMinor: 2000,
  currency: 'USD',
  status: 'pending',
  paymentMethod: 'card',
  description: null,
  failureReason: null,
  receiptUrl: null,
  refunded: false,
  refundedAmountMinor: 0,
  disputeId: 'dp_1',
  disputeStatus: 'needs_response',
  metadata: { order: '7' },
  createdAt: fromUnix(T0),
  updatedAt: fromUnix(T0),
};

const references = {
  findCustomerById: (id: string) => Promise.resolve(id === customer.id ? customer : null),
  findPlanById: (id: string) => Promise.resolve(id === planId ? planRow : null),
  findSubscriptionById: (id: string) => Promise.resolve(id === subscriptionRow.id ? subscriptionRow : null),
  findPaymentById: (id: string) => Promise.resolve(id === paymentRow.id ? paymentRow : null),
};

function provider(respond: (request: RecordedStripeRequest) => { status?: number; body: unknown }) {
  const http = createFakeStripeHttp(respond);
  const stripe = new StripeProvider(
    { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
    { references, httpClient: http.client, maxNetworkRetries: 0 },
  );
  return { stripe, requests: http.requests };
}

const list = (data: unknown[]) => ({ object: 'list', url: '/v1/x', has_more: false, data });

function stripeCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cus_alice',
    object: 'customer',
    created: T0,
    email: 'new@example.com',
    name: 'Alice',
    invoice_settings: { default_payment_method: 'pm_default' },
    ...overrides,
  };
}

function stripePrice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'price_pro',
    object: 'price',
    active: true,
    currency: 'jpy',
    unit_amount: 1500,
    product: { id: 'prod_pro', object: 'product', name: 'Pro (Stripe)' },
    recurring: { interval: 'year', interval_count: 2 },
    metadata: { planId },
    ...overrides,
  };
}

function stripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    object: 'subscription',
    created: T0,
    status: 'active',
    cancel_at_period_end: false,
    canceled_at: null,
    trial_start: null,
    trial_end: null,
    pause_collection: null,
    items: {
      object: 'list',
      has_more: false,
      url: '/v1/subscription_items',
      data: [{ id: 'si_1', object: 'subscription_item', current_period_start: T0, current_period_end: T1 }],
    },
    ...overrides,
  };
}

function stripeIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_1',
    object: 'payment_intent',
    created: T0,
    amount: 1500,
    currency: 'jpy',
    status: 'succeeded',
    description: 'Order 7',
    last_payment_error: null,
    payment_method: { id: 'pm_1', object: 'payment_method', type: 'card' },
    latest_charge: {
      id: 'ch_1',
      object: 'charge',
      amount_refunded: 500,
      receipt_url: 'https://pay.stripe.com/receipts/1',
    },
    ...overrides,
  };
}

const line = (amount: number, proration: boolean) => ({
  amount,
  parent: { subscription_item_details: { proration } },
});

describe('customers', () => {
  it('getCustomer reads the Stripe customer and refreshes our row with it', async () => {
    const { stripe, requests } = provider(() => ({ body: stripeCustomer() }));

    const result = await stripe.getCustomer(customer.id);

    expect(requests[0]).toMatchObject({ method: 'GET', path: '/v1/customers/cus_alice' });
    expect(result).toMatchObject({
      id: customer.id,
      userId: 'usr_alice',
      email: 'new@example.com',
      name: 'Alice',
      defaultPaymentMethodId: 'pm_default',
    });
  });

  it('getCustomer is null for an unknown id (no request) and for a customer deleted in Stripe', async () => {
    const unknown = provider(() => ({ body: {} }));
    expect(await unknown.stripe.getCustomer(createCustomerId())).toBeNull();
    expect(unknown.requests).toHaveLength(0);

    const deleted = provider(() => ({ body: { id: 'cus_alice', object: 'customer', deleted: true } }));
    expect(await deleted.stripe.getCustomer(customer.id)).toBeNull();
  });

  it('updateCustomer sends only the changed fields and merges metadata into ours', async () => {
    const { stripe, requests } = provider(() => ({ body: stripeCustomer() }));

    const result = await stripe.updateCustomer(customer.id, { email: 'new@example.com', metadata: { vip: true } });

    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/customers/cus_alice',
      form: { email: 'new@example.com', 'metadata[vip]': 'true' },
    });
    expect(requests[0]?.form).not.toHaveProperty('name');
    expect(result.metadata).toEqual({ plan: 'x', vip: true });
  });

  it('deleteCustomer deletes the Stripe customer', async () => {
    const { stripe, requests } = provider(() => ({ body: { id: 'cus_alice', object: 'customer', deleted: true } }));

    await stripe.deleteCustomer(customer.id);

    expect(requests[0]).toMatchObject({ method: 'DELETE', path: '/v1/customers/cus_alice' });
  });
});

describe('plans', () => {
  it('createPlan records our plan id on the Stripe price so listPlans can find the row', async () => {
    const { stripe, requests } = provider(request =>
      request.path === '/v1/products'
        ? { body: { id: 'prod_new', object: 'product', name: 'New' } }
        : { body: stripePrice({ id: 'price_new' }) },
    );

    const plan = await stripe.createPlan({ name: 'New', amount: money('9.99', 'USD'), interval: 'monthly' });

    expect(requests[1]?.form['metadata[planId]']).toBe(plan.id);
    expect(plan.metadata).toMatchObject({ stripePriceId: 'price_new' });
  });

  it('getPlan refreshes name, price and interval from the Stripe price and product', async () => {
    const { stripe, requests } = provider(() => ({ body: stripePrice() }));

    const plan = await stripe.getPlan(planId);

    expect(requests[0]).toMatchObject({ method: 'GET', path: '/v1/prices/price_pro' });
    expect(requests[0]?.form['expand[0]']).toBe('product');
    // JPY is whole yen: 1500 is 1500 JPY
    expect(plan).toMatchObject({
      id: planId,
      name: 'Pro (Stripe)',
      priceMinor: 1500,
      currency: 'JPY',
      interval: 'yearly',
      intervalCount: 2,
      isActive: true,
    });
  });

  it('getPlan is null for an unknown plan', async () => {
    const { stripe, requests } = provider(() => ({ body: {} }));
    expect(await stripe.getPlan(createPlanId())).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('updatePlan renames the product and writes metadata on the product and the price', async () => {
    const { stripe, requests } = provider(request =>
      request.path.startsWith('/v1/products')
        ? { body: { id: 'prod_pro', object: 'product', name: 'Renamed' } }
        : { body: stripePrice({ product: 'prod_pro' }) },
    );

    const plan = await stripe.updatePlan(planId, { name: 'Renamed', metadata: { badge: 'new' } });

    expect(requests.map(request => request.path)).toEqual(['/v1/prices/price_pro', '/v1/products/prod_pro']);
    expect(requests[0]?.form).toEqual({ 'metadata[badge]': 'new' });
    expect(requests[1]?.form).toEqual({ name: 'Renamed', 'metadata[badge]': 'new' });
    expect(plan.name).toBe('Renamed');
    expect(plan.metadata).toMatchObject({ stripePriceId: 'price_pro', badge: 'new' });
  });

  it('deletePlan archives the price and its product, because Stripe cannot delete a price', async () => {
    const { stripe, requests } = provider(request =>
      request.path.startsWith('/v1/products')
        ? { body: { id: 'prod_pro', object: 'product', active: false } }
        : { body: stripePrice({ product: 'prod_pro', active: false }) },
    );

    await stripe.deletePlan(planId);

    expect(requests).toMatchObject([
      { method: 'POST', path: '/v1/prices/price_pro', form: { active: 'false' } },
      { method: 'POST', path: '/v1/products/prod_pro', form: { active: 'false' } },
    ]);
  });

  it('listPlans returns the active Stripe prices that carry one of our plan ids, and skips the rest', async () => {
    const { stripe, requests } = provider(() => ({
      body: list([
        stripePrice(),
        stripePrice({ id: 'price_dashboard', metadata: {} }),
        stripePrice({ id: 'price_orphan', metadata: { planId: otherPlanId } }),
      ]),
    }));

    const plans = await stripe.listPlans();

    expect(requests[0]).toMatchObject({
      method: 'GET',
      path: '/v1/prices',
      form: { active: 'true', type: 'recurring' },
    });
    expect(plans.map(plan => plan.id)).toEqual([planId]);
  });
});

describe('subscriptions', () => {
  it('getSubscription reads the Stripe subscription into our row', async () => {
    const { stripe, requests } = provider(() => ({ body: stripeSubscription({ cancel_at_period_end: true }) }));

    const subscription = await stripe.getSubscription(subscriptionRow.id);

    expect(requests[0]).toMatchObject({ method: 'GET', path: '/v1/subscriptions/sub_1' });
    expect(subscription).toMatchObject({ id: subscriptionRow.id, status: 'active', cancelAtPeriodEnd: true });
  });

  it('getSubscription is null for an unknown id', async () => {
    const { stripe } = provider(() => ({ body: {} }));
    expect(await stripe.getSubscription(createSubscriptionId())).toBeNull();
  });

  it('reactivateSubscription turns off the scheduled cancellation', async () => {
    const { stripe, requests } = provider(() => ({ body: stripeSubscription() }));

    const subscription = await stripe.reactivateSubscription(subscriptionRow.id);

    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/subscriptions/sub_1',
      form: { cancel_at_period_end: 'false' },
    });
    expect(subscription.cancelAtPeriodEnd).toBe(false);
  });

  it('pauseSubscription voids invoices, and the row reads paused although Stripe says active', async () => {
    const { stripe, requests } = provider(() => ({
      body: stripeSubscription({ pause_collection: { behavior: 'void', resumes_at: null } }),
    }));

    const subscription = await stripe.pauseSubscription(subscriptionRow.id);

    expect(requests[0]?.form).toEqual({ 'pause_collection[behavior]': 'void' });
    expect(subscription.status).toBe('paused');
  });

  it('resumeSubscription clears pause_collection', async () => {
    const { stripe, requests } = provider(() => ({ body: stripeSubscription() }));

    const subscription = await stripe.resumeSubscription(subscriptionRow.id);

    expect(requests[0]?.form).toEqual({ pause_collection: '' });
    expect(subscription.status).toBe('active');
  });

  it('previewSubscriptionChange splits the upcoming invoice into proration charge, credit and next invoice', async () => {
    const { stripe, requests } = provider(request =>
      request.path === '/v1/invoices/create_preview'
        ? {
            body: {
              id: 'in_preview',
              object: 'invoice',
              currency: 'usd',
              lines: list([line(-500, true), line(1200, true), line(3000, false)]),
            },
          }
        : { body: stripeSubscription() },
    );

    const preview = await stripe.previewSubscriptionChange({
      subscriptionId: subscriptionRow.id,
      planId,
      prorationBehavior: 'create_prorations',
    });

    expect(requests[1]).toMatchObject({
      method: 'POST',
      path: '/v1/invoices/create_preview',
      form: {
        customer: 'cus_alice',
        subscription: 'sub_1',
        'subscription_details[items][0][id]': 'si_1',
        'subscription_details[items][0][price]': 'price_pro',
        'subscription_details[proration_behavior]': 'create_prorations',
      },
    });
    expect(preview.planId).toBe(planId);
    expect(preview.proration).toEqual({
      immediateTotal: { amount: '7.00', currency: 'USD' },
      creditApplied: { amount: '5.00', currency: 'USD' },
      nextInvoiceTotal: { amount: '30.00', currency: 'USD' },
    });
    expect(preview.nextBillingDate.epochMilliseconds).toBe(T1 * 1000);
  });
});

describe('payments', () => {
  it('createPayment confirms an intent for the customer and maps it, with the real receipt and refund', async () => {
    const { stripe, requests } = provider(() => ({ body: stripeIntent() }));

    const payment = await stripe.createPayment({
      customerId: customer.id,
      amount: money(1500, 'JPY'),
      paymentMethodId: 'pm_1',
      description: 'Order 7',
      metadata: { order: '7' },
    });

    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/payment_intents',
      form: {
        amount: '1500',
        currency: 'jpy',
        customer: 'cus_alice',
        payment_method: 'pm_1',
        confirm: 'true',
        description: 'Order 7',
        'metadata[order]': '7',
        'metadata[userId]': 'usr_alice',
      },
    });
    expect(payment).toMatchObject({
      userId: 'usr_alice',
      customerId: customer.id,
      providerPaymentId: 'pi_1',
      amountMinor: 1500,
      currency: 'JPY',
      status: 'succeeded',
      paymentMethod: 'card',
      receiptUrl: 'https://pay.stripe.com/receipts/1',
      refunded: true,
      refundedAmountMinor: 500,
      metadata: { order: '7' },
    });
  });

  it('createPayment shows a declined card as a failed payment with the reason', async () => {
    const { stripe } = provider(() => ({
      body: stripeIntent({
        status: 'requires_payment_method',
        last_payment_error: { message: 'Your card was declined.' },
        latest_charge: null,
      }),
    }));

    const payment = await stripe.createPayment({
      customerId: customer.id,
      amount: money(15, 'USD'),
      paymentMethodId: 'pm_1',
    });

    expect(payment).toMatchObject({ status: 'failed', failureReason: 'Your card was declined.', refunded: false });
  });

  it('getPayment keeps our ids and dispute from the row and takes the rest from Stripe', async () => {
    const { stripe, requests } = provider(() => ({
      body: stripeIntent({ amount: 2000, currency: 'usd', latest_charge: null }),
    }));

    const payment = await stripe.getPayment(paymentRow.id);

    expect(requests[0]).toMatchObject({ method: 'GET', path: '/v1/payment_intents/pi_1' });
    expect(payment).toMatchObject({
      id: paymentRow.id,
      subscriptionId: subscriptionRow.id,
      disputeId: 'dp_1',
      amountMinor: 2000,
      status: 'succeeded',
    });
  });

  it('getPayment is null for an unknown id', async () => {
    const { stripe } = provider(() => ({ body: {} }));
    expect(await stripe.getPayment(createPaymentId())).toBeNull();
  });

  it("confirmPayment confirms the row's intent", async () => {
    const { stripe, requests } = provider(() => ({
      body: stripeIntent({ status: 'processing', latest_charge: null }),
    }));

    const payment = await stripe.confirmPayment(paymentRow.id);

    expect(requests[0]).toMatchObject({ method: 'POST', path: '/v1/payment_intents/pi_1/confirm' });
    expect(payment).toMatchObject({ id: paymentRow.id, status: 'processing' });
  });

  it("cancelPayment cancels the row's intent", async () => {
    const { stripe, requests } = provider(() => ({ body: stripeIntent({ status: 'canceled', latest_charge: null }) }));

    const payment = await stripe.cancelPayment(paymentRow.id);

    expect(requests[0]).toMatchObject({ method: 'POST', path: '/v1/payment_intents/pi_1/cancel' });
    expect(payment.status).toBe('canceled');
  });

  it('maps a Stripe error to PaymentProviderError', async () => {
    const { stripe } = provider(() => ({
      status: 402,
      body: { error: { type: 'card_error', code: 'card_declined', message: 'Declined' } },
    }));

    await expect(stripe.confirmPayment(paymentRow.id)).rejects.toMatchObject({
      name: 'PaymentProviderError',
      code: 'card_declined',
    });
  });
});

describe('payment methods', () => {
  const card = {
    id: 'pm_default',
    object: 'payment_method',
    type: 'card',
    card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 },
  };

  it('attachPaymentMethod attaches to the Stripe customer and flags the default', async () => {
    const { stripe, requests } = provider(request =>
      request.path === '/v1/payment_methods/pm_default/attach' ? { body: card } : { body: stripeCustomer() },
    );

    const info = await stripe.attachPaymentMethod({ customerId: customer.id, paymentMethodId: 'pm_default' });

    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/payment_methods/pm_default/attach',
      form: { customer: 'cus_alice' },
    });
    expect(info).toEqual({
      id: 'pm_default',
      type: 'card',
      brand: 'visa',
      last4: '4242',
      expiryMonth: 4,
      expiryYear: 2030,
      isDefault: true,
    });
  });

  it("listPaymentMethods lists the customer's methods with the default flagged", async () => {
    const { stripe, requests } = provider(request =>
      request.path === '/v1/payment_methods'
        ? { body: list([card, { ...card, id: 'pm_other' }]) }
        : { body: stripeCustomer() },
    );

    const methods = await stripe.listPaymentMethods(customer.id);

    expect(requests[0]).toMatchObject({ method: 'GET', path: '/v1/payment_methods', form: { customer: 'cus_alice' } });
    expect(methods.map(method => [method.id, method.isDefault])).toEqual([
      ['pm_default', true],
      ['pm_other', false],
    ]);
  });

  it("setDefaultPaymentMethod sets the customer's invoice default", async () => {
    const { stripe, requests } = provider(() => ({ body: stripeCustomer() }));

    await stripe.setDefaultPaymentMethod({ customerId: customer.id, paymentMethodId: 'pm_9' });

    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/customers/cus_alice',
      form: { 'invoice_settings[default_payment_method]': 'pm_9' },
    });
  });
});
