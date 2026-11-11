import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { expect } from 'vitest';

import { fromUnix, now } from '@arki/date';
import { orThrow } from '@arki/failure';
import { money } from '@arki/money';

import type { RecordedStripeRequest } from '../core/providers/stripe-test-support.js';
import type { Customer, Payment, PaymentProviderType, Plan, Subscription } from '../core/types.js';
import type { UserId } from '../core/user-id.js';
import type { SubscriptionBilling } from '../presets/subscription.js';
import type { AppDb } from '../test-support.js';
import { createCustomerId, createPaymentId, createPlanId, createSubscriptionId } from '../core/primitives.js';
import {
  cardDeclinedOf,
  idempotencyConflictOf,
  mapStripeError,
  PaymentProviderError,
} from '../core/providers/provider-error.js';
import { mapStripeEventType } from '../core/providers/stripe-event-types.js';
import { StripeProvider } from '../core/providers/stripe-provider.js';
import { createFakeStripeHttp, stripeProviderOf } from '../core/providers/stripe-test-support.js';
import { PaymentRepository } from '../core/repository.js';
import { projectRevenueCatEvent, verifyRevenueCatAuth } from '../presets/revenuecat.js';
import { createSubscriptionBilling, getEntitlement, projectStripeSubscription } from '../presets/subscription.js';
import { createRefundId } from '../refunds/primitives.js';
import { coreReads, runnerOn } from '../service-test-support.js';
import { core, customerId, openDb, planId, typed, userId, users } from '../test-support.js';
import { area, args, op } from './engine.js';

const CREATED = 1_767_225_600;
const PERIOD_END = 1_769_904_000;
const WEBHOOK_SECRET = 'whsec_hostile_cases';
const PRICE_ID = 'price_hostile_monthly';

/** The in-memory rows `StripeProvider` reads through its `references`, and what the Stripe answers need to know. */
type World = {
  customers: Map<string, Customer>;
  plans: Map<string, Plan>;
  payments: Map<string, Payment>;
  subscriptions: Map<string, Subscription>;
  /** The refund id the next `refunds.list` answer carries in its metadata. */
  refundIdOnStripe: string;
  /** The plan id the next `prices.list` answer carries in its metadata. */
  planIdOnStripe: string;
};

type Ctx = {
  db: AppDb;
  client: PGlite;
  world: World;
  stripe: StripeProvider;
  /** A bare SDK over the same fake HTTP layer, to get real `Stripe.Subscription` objects. */
  sdk: Stripe;
  billing: SubscriptionBilling;
};

let sequence = 0;
const nextNumber = () => {
  sequence += 1;
  return sequence;
};

const list = (data: unknown[]) => ({ object: 'list', url: '/v1/x', has_more: false, data });

function stripeCustomer(id: string) {
  return {
    id,
    object: 'customer',
    email: 'buyer@example.com',
    name: 'Buyer',
    created: CREATED,
    metadata: {},
    invoice_settings: { default_payment_method: 'pm_default' },
  };
}

function stripePrice(id: string, form: Record<string, string> = {}) {
  return {
    id,
    object: 'price',
    active: true,
    currency: form['currency'] ?? 'usd',
    unit_amount: form['unit_amount'] === undefined ? 1000 : Number(form['unit_amount']),
    product: 'prod_hostile',
    recurring: { interval: form['recurring[interval]'] ?? 'month', interval_count: 1 },
    metadata: {},
  };
}

function stripeSubscription(id: string, changes: Record<string, unknown> = {}) {
  return {
    id,
    object: 'subscription',
    customer: 'cus_hostile',
    status: 'active',
    created: CREATED,
    items: {
      object: 'list',
      data: [
        {
          id: 'si_hostile',
          object: 'subscription_item',
          price: { id: PRICE_ID },
          current_period_start: CREATED,
          current_period_end: PERIOD_END,
        },
      ],
    },
    trial_start: null,
    trial_end: null,
    canceled_at: null,
    cancel_at_period_end: false,
    pause_collection: null,
    metadata: {},
    ...changes,
  };
}

function stripeIntent(id: string, form: Record<string, string>, status: string) {
  return {
    id,
    object: 'payment_intent',
    amount: form['amount'] === undefined ? 5000 : Number(form['amount']),
    currency: form['currency'] ?? 'usd',
    status,
    client_secret: `${id}_secret`,
    description: null,
    created: CREATED,
    latest_charge: null,
    payment_method: null,
    last_payment_error: null,
  };
}

function stripeRefund(id: string, refundId: string, form: Record<string, string>) {
  return {
    id,
    object: 'refund',
    amount: form['amount'] === undefined ? 1500 : Number(form['amount']),
    currency: 'usd',
    status: 'succeeded',
    created: CREATED,
    metadata: { refundId },
  };
}

const stripePaymentMethod = {
  id: 'pm_hostile',
  object: 'payment_method',
  type: 'card',
  card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
};

const stripeTaxLines = (amount: number, tax: number) =>
  list([{ amount, amount_tax: tax, tax_behavior: 'exclusive', tax_code: 'txcd_10103001' }]);

function pathParts(path: string) {
  return path.replace('/v1/', '').split('/');
}

/** Stripe's API as far as these cases reach it: one realistic answer per path. */
function stripeAnswers(world: World) {
  return (request: RecordedStripeRequest): { status?: number; body: unknown } => {
    const { method, path, form } = request;
    const parts = pathParts(path);
    const resource = parts[0];
    const id = parts[1] ?? '';
    const action = parts[2];

    if (resource === 'customers') {
      if (parts.length === 1) return { body: stripeCustomer(`cus_new_${nextNumber()}`) };
      if (method === 'DELETE') return { body: { id, object: 'customer', deleted: true } };
      return { body: stripeCustomer(id) };
    }
    if (resource === 'products') {
      if (method === 'DELETE') return { body: { id, object: 'product', deleted: true } };
      return {
        body: {
          id: parts.length === 1 ? 'prod_new' : id,
          object: 'product',
          name: form['name'] ?? 'Pro',
          active: true,
        },
      };
    }
    if (resource === 'prices') {
      if (parts.length === 1 && method === 'GET') {
        return { body: list([{ ...stripePrice(PRICE_ID), metadata: { planId: world.planIdOnStripe } }]) };
      }
      return { body: stripePrice(parts.length === 1 ? 'price_new' : id, form) };
    }
    if (resource === 'subscriptions') {
      if (parts.length === 1) return { body: stripeSubscription('sub_new', { trial_end: null }) };
      if (method === 'DELETE') return { body: stripeSubscription(id, { status: 'canceled', canceled_at: CREATED }) };
      if (method === 'POST') {
        return {
          body: stripeSubscription(id, {
            cancel_at_period_end: form['cancel_at_period_end'] === 'true',
            pause_collection: form['pause_collection[behavior]'] === 'void' ? { behavior: 'void' } : null,
          }),
        };
      }
      return { body: stripeSubscription(id) };
    }
    if (resource === 'invoices') {
      const prorated = { parent: { subscription_item_details: { proration: true } } };
      return {
        body: {
          id: 'in_upcoming',
          object: 'invoice',
          currency: 'usd',
          lines: {
            object: 'list',
            has_more: false,
            data: [
              { id: 'il_credit', amount: -500, ...prorated },
              { id: 'il_charge', amount: 700, ...prorated },
              { id: 'il_next', amount: 1000, parent: { subscription_item_details: { proration: false } } },
            ],
          },
        },
      };
    }
    if (resource === 'payment_intents') {
      if (parts.length === 1) return { body: stripeIntent('pi_new', form, 'succeeded') };
      if (action === 'cancel') return { body: stripeIntent(id, form, 'canceled') };
      return { body: stripeIntent(id, form, 'succeeded') };
    }
    if (resource === 'refunds') {
      if (method === 'GET') return { body: list([stripeRefund('re_found', world.refundIdOnStripe, form)]) };
      return { body: stripeRefund('re_new', form['metadata[refundId]'] ?? 'unknown', form) };
    }
    if (resource === 'payment_methods') {
      if (parts.length === 1) return { body: list([stripePaymentMethod]) };
      return { body: { ...stripePaymentMethod, id } };
    }
    if (resource === 'setup_intents') {
      return { body: { id: 'seti_new', object: 'setup_intent', client_secret: 'seti_new_secret' } };
    }
    if (resource === 'billing_portal') {
      return {
        body: { id: 'bps_new', object: 'billing_portal.session', url: 'https://billing.stripe.test/p/session' },
      };
    }
    if (resource === 'checkout') {
      return { body: { id: 'cs_new', object: 'checkout.session', url: 'https://checkout.stripe.test/cs_new' } };
    }
    if (resource === 'tax') {
      if (id === 'calculations') {
        return {
          body: {
            id: 'taxcalc_new',
            object: 'tax.calculation',
            currency: form['currency'] ?? 'usd',
            amount_total: 1100,
            tax_amount_exclusive: 100,
            tax_amount_inclusive: 0,
            line_items: list([
              {
                tax_code: 'txcd_10103001',
                tax_breakdown: [
                  {
                    amount: 100,
                    jurisdiction: { display_name: 'Germany', country: 'DE', state: null, level: 'country' },
                    tax_rate_details: { percentage_decimal: '19' },
                  },
                ],
              },
            ]),
          },
        };
      }
      if (id === 'transactions') {
        return {
          body: {
            id: 'tax_txn_new',
            object: 'tax.transaction',
            currency: 'usd',
            line_items: stripeTaxLines(1000, 100),
          },
        };
      }
      if (id === 'settings') {
        return {
          body: {
            object: 'tax.settings',
            status: 'active',
            defaults: { tax_code: null },
            head_office: {
              address: { country: 'US', state: 'CA', city: 'San Francisco', line1: '1 Main St', postal_code: '94105' },
            },
          },
        };
      }
      return { body: list([]) };
    }
    if (resource === 'events') return { body: list([]) };
    return { status: 404, body: { error: { type: 'invalid_request_error', message: `No route for ${path}` } } };
  };
}

function seedCustomer(world: World): Customer {
  const row: Customer = {
    id: orThrow(createCustomerId()),
    userId: 'usr_hostile',
    providerCustomerId: `cus_row_${nextNumber()}`,
    provider: 'stripe',
    email: 'buyer@example.com',
    name: null,
    defaultPaymentMethodId: null,
    metadata: null,
    createdAt: fromUnix(CREATED),
    updatedAt: now(),
  };
  world.customers.set(row.id, row);
  return row;
}

function seedPlan(world: World): Plan {
  const row: Plan = {
    id: orThrow(createPlanId()),
    name: 'Pro',
    description: null,
    tier: 'pro',
    priceMinor: 1000,
    currency: 'USD',
    interval: 'monthly',
    intervalCount: 1,
    features: [],
    isActive: true,
    trialPeriodDays: null,
    metadata: { stripePriceId: PRICE_ID, stripeProductId: 'prod_hostile' },
    createdAt: fromUnix(CREATED),
    updatedAt: now(),
  };
  world.plans.set(row.id, row);
  return row;
}

function seedSubscriptionRow(world: World): Subscription {
  const owner = seedCustomer(world);
  const plan = seedPlan(world);
  const row: Subscription = {
    id: orThrow(createSubscriptionId()),
    userId: owner.userId,
    planId: plan.id,
    customerId: owner.id,
    providerSubscriptionId: `sub_row_${nextNumber()}`,
    status: 'active',
    currentPeriodStart: fromUnix(CREATED),
    currentPeriodEnd: fromUnix(PERIOD_END),
    trialStart: null,
    trialEnd: null,
    canceledAt: null,
    cancelAtPeriodEnd: false,
    metadata: null,
    createdAt: fromUnix(CREATED),
    updatedAt: now(),
  };
  world.subscriptions.set(row.id, row);
  return row;
}

function seedPaymentRow(world: World): Payment {
  const owner = seedCustomer(world);
  const row: Payment = {
    id: orThrow(createPaymentId()),
    userId: owner.userId,
    customerId: owner.id,
    subscriptionId: null,
    providerPaymentId: `pi_row_${nextNumber()}`,
    amountMinor: 5000,
    currency: 'USD',
    status: 'succeeded',
    paymentMethod: 'card',
    description: null,
    failureReason: null,
    receiptUrl: null,
    refunded: false,
    refundedAmountMinor: 0,
    disputeId: null,
    disputeStatus: null,
    metadata: null,
    createdAt: fromUnix(CREATED),
    updatedAt: now(),
  };
  world.payments.set(row.id, row);
  return row;
}

/** One signed `Stripe-Signature` header for the body, as Stripe would send it. */
function signed(payload: string) {
  const signer = new Stripe('sk_test_hostile_signer');
  return signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
}

const eventBody = (type: string) =>
  JSON.stringify({
    id: 'evt_hostile',
    object: 'event',
    type,
    data: { object: { id: 'cus_hostile', object: 'customer' } },
  });

/** The body of one `customer.subscription.*` event, shaped as Stripe sends it, for the customer seeded in test-support. */
function subscriptionBody(subscriptionId: string, type = 'customer.subscription.created') {
  return JSON.stringify({
    id: 'evt_hostile_sub',
    object: 'event',
    type,
    data: { object: stripeSubscription(subscriptionId, { customer: 'cus_test', metadata: { userId } }) },
  });
}

const noArgs = (): [] => [];

/** An owner id the way the package types it: `usr_` and a label. */
const userIdOf = (label: string): UserId => `usr_${label}`;

export const stripeArea = area<Ctx>({
  area: 'stripe',
  async open() {
    const { db, client } = await openDb();
    const world: World = {
      customers: new Map(),
      plans: new Map(),
      payments: new Map(),
      subscriptions: new Map(),
      refundIdOnStripe: 'unset',
      planIdOnStripe: 'unset',
    };
    const http = createFakeStripeHttp(stripeAnswers(world));
    const stripe = stripeProviderOf(
      { apiKey: 'sk_test_hostile', webhookSecret: WEBHOOK_SECRET, environment: 'sandbox' },
      {
        references: {
          findCustomerById: id => Promise.resolve(world.customers.get(id) ?? null),
          findPlanById: id => Promise.resolve(world.plans.get(id) ?? null),
          findPaymentById: id => Promise.resolve(world.payments.get(id) ?? null),
          findSubscriptionById: id => Promise.resolve(world.subscriptions.get(id) ?? null),
        },
        httpClient: http.client,
        maxNetworkRetries: 0,
      },
    );
    const sdk = new Stripe('sk_test_hostile_sdk', { httpClient: http.client, maxNetworkRetries: 0 });
    const repository = new PaymentRepository(db, core);
    const billing = orThrow(
      createSubscriptionBilling({
        provider: stripe,
        repo: {
          ...coreReads(db),
          async findCustomerByProviderCustomerId(providerCustomerId: string, providerType: PaymentProviderType) {
            const [row] = await db
              .select()
              .from(core.customers)
              .where(
                and(
                  eq(core.customers.providerCustomerId, providerCustomerId),
                  eq(core.customers.provider, providerType),
                ),
              );
            return row ?? null;
          },
          createCustomer: customer => repository.createCustomer(customer),
        },
        writes: typed.core.writes(runnerOn(db)),
        prices: [{ priceId: PRICE_ID, planId }],
        urls: { success: 'https://app.test/ok', cancel: 'https://app.test/cancel' },
      }),
    );
    return { db, client, world, stripe, sdk, billing };
  },
  close: ctx => ctx.client.close(),
  cases: [
    // ---------------------------------------------------------------- provider-error.ts, stripe-event-types.ts
    op('core/providers/provider-error.ts::cardDeclinedOf', {
      arrange: () =>
        args(
          new Stripe.errors.StripeCardError({
            type: 'card_error',
            message: 'Your card was declined.',
            code: 'card_declined',
            decline_code: 'generic_decline',
          }),
        ),
      call: (_ctx, error) => cardDeclinedOf(error),
      valid: result => expect(result).toMatchObject({ code: 'payments.card_declined' }),
    }),
    op('core/providers/provider-error.ts::idempotencyConflictOf', {
      arrange: () =>
        args(
          new Stripe.errors.StripeIdempotencyError({
            type: 'idempotency_error',
            message: 'Keys for idempotent requests can only be used with the same parameters.',
          }),
        ),
      call: (_ctx, error) => idempotencyConflictOf(error),
      valid: result => expect(result).toMatchObject({ code: 'payments.idempotency_conflict' }),
    }),
    op('core/providers/provider-error.ts::mapStripeError', {
      arrange: () => args(new Stripe.errors.StripeRateLimitError({ type: 'rate_limit_error', message: 'Slow down' })),
      call: (_ctx, error) => mapStripeError(error),
      valid: result => {
        expect(result).toBeInstanceOf(PaymentProviderError);
        expect(result).toMatchObject({ code: 'rate_limited' });
      },
    }),
    op('core/providers/stripe-event-types.ts::mapStripeEventType', {
      arrange: () => args('payment_intent.succeeded'),
      call: (_ctx, type) => mapStripeEventType(type),
      valid: result => expect(result).toBe('payment.succeeded'),
    }),

    // ---------------------------------------------------------------- StripeProvider
    op('core/providers/stripe-provider.ts::StripeProvider.create', {
      arrange: () =>
        args(
          { apiKey: 'sk_test_ctor', webhookSecret: WEBHOOK_SECRET, environment: 'sandbox' as const },
          { maxNetworkRetries: 2 },
        ),
      call: (_ctx, config, options) => StripeProvider.create(config, options),
      valid: result => expect(result).toMatchObject({ providerType: 'stripe' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.createCustomer', {
      arrange: () =>
        args({
          userId: userIdOf('hostile'),
          email: 'new@example.com',
          name: 'New Buyer',
          metadata: { source: 'cases' },
        }),
      call: (ctx, params) => ctx.stripe.createCustomer(params),
      valid: result =>
        expect(result).toMatchObject({
          provider: 'stripe',
          email: 'new@example.com',
          providerCustomerId: expect.stringMatching(/^cus_new_/),
        }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.getCustomer', {
      arrange: ctx => args(seedCustomer(ctx.world).id),
      call: (ctx, id) => ctx.stripe.getCustomer(id),
      valid: result => expect(result).toMatchObject({ defaultPaymentMethodId: 'pm_default', name: 'Buyer' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.updateCustomer', {
      arrange: ctx =>
        args(seedCustomer(ctx.world).id, { email: 'changed@example.com', name: 'Changed', metadata: { tag: 'vip' } }),
      call: (ctx, id, params) => ctx.stripe.updateCustomer(id, params),
      valid: result => expect(result).toMatchObject({ metadata: { tag: 'vip' } }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.deleteCustomer', {
      arrange: ctx => args(seedCustomer(ctx.world).id),
      call: (ctx, id) => ctx.stripe.deleteCustomer(id),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.createPlan', {
      arrange: () =>
        args({
          name: 'Pro',
          description: 'The pro plan',
          tier: 'pro' as const,
          features: ['Everything'],
          amount: money('9.99', 'USD'),
          interval: 'monthly' as const,
          intervalCount: 1,
          trialPeriodDays: 7,
          metadata: { source: 'cases' },
        }),
      call: (ctx, params) => ctx.stripe.createPlan(params),
      valid: result =>
        expect(result).toMatchObject({ priceMinor: 999, currency: 'USD', metadata: { stripePriceId: 'price_new' } }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.getPlan', {
      arrange: ctx => args(seedPlan(ctx.world).id),
      call: (ctx, id) => ctx.stripe.getPlan(id),
      valid: result => expect(result).toMatchObject({ priceMinor: 1000, currency: 'USD' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.updatePlan', {
      arrange: ctx => args(seedPlan(ctx.world).id, { name: 'Renamed', metadata: { tag: 'new' } }),
      call: (ctx, id, params) => ctx.stripe.updatePlan(id, params),
      valid: result => expect(result).toMatchObject({ name: 'Renamed', metadata: { tag: 'new' } }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.deletePlan', {
      arrange: ctx => args(seedPlan(ctx.world).id),
      call: (ctx, id) => ctx.stripe.deletePlan(id),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.listPlans', {
      arrange: ctx => {
        ctx.world.planIdOnStripe = seedPlan(ctx.world).id;
        return noArgs();
      },
      call: (ctx, ...none) => ctx.stripe.listPlans(...none),
      valid: (result, ctx) => expect(result).toMatchObject([{ id: ctx.world.planIdOnStripe, priceMinor: 1000 }]),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.createSubscription', {
      arrange: ctx =>
        args({
          customerId: seedCustomer(ctx.world).id,
          planId: seedPlan(ctx.world).id,
          paymentMethodId: 'pm_hostile',
          trialPeriodDays: 7,
          metadata: { source: 'cases' },
          idempotencyKey: `sub-create-${nextNumber()}`,
        }),
      call: (ctx, params) => ctx.stripe.createSubscription(params),
      valid: result => expect(result).toMatchObject({ providerSubscriptionId: 'sub_new', status: 'active' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.getSubscription', {
      arrange: ctx => args(seedSubscriptionRow(ctx.world).id),
      call: (ctx, id) => ctx.stripe.getSubscription(id),
      valid: result => expect(result).toMatchObject({ status: 'active', cancelAtPeriodEnd: false }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.updateSubscription', {
      arrange: ctx =>
        args(seedSubscriptionRow(ctx.world).id, {
          planId: seedPlan(ctx.world).id,
          paymentMethodId: 'pm_hostile',
          metadata: { tag: 'changed' },
          cancelAtPeriodEnd: true,
          prorationBehavior: 'none' as const,
          idempotencyKey: `sub-update-${nextNumber()}`,
        }),
      call: (ctx, id, params) => ctx.stripe.updateSubscription(id, params),
      valid: result => expect(result).toMatchObject({ cancelAtPeriodEnd: true, metadata: { tag: 'changed' } }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.cancelSubscription', {
      arrange: ctx =>
        args(seedSubscriptionRow(ctx.world).id, {
          immediately: false,
          reason: 'too expensive',
          idempotencyKey: `sub-cancel-${nextNumber()}`,
        }),
      call: (ctx, id, options) => ctx.stripe.cancelSubscription(id, options),
      valid: result => expect(result).toMatchObject({ cancelAtPeriodEnd: true }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.reactivateSubscription', {
      arrange: ctx => args(seedSubscriptionRow(ctx.world).id),
      call: (ctx, id) => ctx.stripe.reactivateSubscription(id),
      valid: result => expect(result).toMatchObject({ cancelAtPeriodEnd: false, status: 'active' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.pauseSubscription', {
      arrange: ctx => args(seedSubscriptionRow(ctx.world).id),
      call: (ctx, id) => ctx.stripe.pauseSubscription(id),
      valid: result => expect(result).toMatchObject({ status: 'paused' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.resumeSubscription', {
      arrange: ctx => args(seedSubscriptionRow(ctx.world).id),
      call: (ctx, id) => ctx.stripe.resumeSubscription(id),
      valid: result => expect(result).toMatchObject({ status: 'active' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.previewSubscriptionChange', {
      arrange: ctx =>
        args({
          subscriptionId: seedSubscriptionRow(ctx.world).id,
          planId: seedPlan(ctx.world).id,
          prorationBehavior: 'create_prorations' as const,
        }),
      call: (ctx, params) => ctx.stripe.previewSubscriptionChange(params),
      valid: result => expect(result).toMatchObject({ nextBillingDate: fromUnix(PERIOD_END) }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.createPayment', {
      arrange: ctx =>
        args({
          customerId: seedCustomer(ctx.world).id,
          amount: money('50.00', 'USD'),
          paymentMethodId: 'pm_hostile',
          description: 'One time charge',
          metadata: { source: 'cases' },
        }),
      call: (ctx, params) => ctx.stripe.createPayment(params),
      valid: result =>
        expect(result).toMatchObject({ providerPaymentId: 'pi_new', amountMinor: 5000, status: 'succeeded' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.getPayment', {
      arrange: ctx => args(seedPaymentRow(ctx.world).id),
      call: (ctx, id) => ctx.stripe.getPayment(id),
      valid: result => expect(result).toMatchObject({ amountMinor: 5000, status: 'succeeded' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.confirmPayment', {
      arrange: ctx => args(seedPaymentRow(ctx.world).id),
      call: (ctx, id) => ctx.stripe.confirmPayment(id),
      valid: result => expect(result).toMatchObject({ status: 'succeeded' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.cancelPayment', {
      arrange: ctx => args(seedPaymentRow(ctx.world).id),
      call: (ctx, id) => ctx.stripe.cancelPayment(id),
      valid: result => expect(result).toMatchObject({ status: 'canceled' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.refundPayment', {
      arrange: ctx =>
        args(seedPaymentRow(ctx.world).id, {
          refundId: orThrow(createRefundId()),
          idempotencyKey: `refund-${nextNumber()}`,
          amount: money('15.00', 'USD'),
          reason: 'customer_request',
          metadata: { source: 'cases' },
        }),
      call: (ctx, id, params) => ctx.stripe.refundPayment(id, params),
      valid: result => expect(result).toMatchObject({ providerRefundId: 're_new', status: 'succeeded' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.findRefund', {
      arrange: ctx => {
        const refundId = orThrow(createRefundId());
        ctx.world.refundIdOnStripe = refundId;
        return args(seedPaymentRow(ctx.world).id, refundId);
      },
      call: (ctx, paymentId, refundId) => ctx.stripe.findRefund(paymentId, refundId),
      valid: result => expect(result).toMatchObject({ providerRefundId: 're_found' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.attachPaymentMethod', {
      arrange: ctx => args({ customerId: seedCustomer(ctx.world).id, paymentMethodId: 'pm_hostile' }),
      call: (ctx, params) => ctx.stripe.attachPaymentMethod(params),
      valid: result => expect(result).toMatchObject({ id: 'pm_hostile', type: 'card', last4: '4242' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.detachPaymentMethod', {
      arrange: () => args('pm_hostile'),
      call: (ctx, paymentMethodId) => ctx.stripe.detachPaymentMethod(paymentMethodId),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.listPaymentMethods', {
      arrange: ctx => args(seedCustomer(ctx.world).id),
      call: (ctx, id) => ctx.stripe.listPaymentMethods(id),
      valid: result => expect(result).toMatchObject([{ id: 'pm_hostile', last4: '4242', isDefault: false }]),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.setDefaultPaymentMethod', {
      arrange: ctx => args({ customerId: seedCustomer(ctx.world).id, paymentMethodId: 'pm_hostile' }),
      call: (ctx, params) => ctx.stripe.setDefaultPaymentMethod(params),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.validateWebhook', {
      arrange: () => {
        const payload = eventBody('customer.created');
        return args(payload, signed(payload), '1767225600', '203.0.113.7');
      },
      call: (ctx, payload, signature, timestamp, sourceIp) =>
        ctx.stripe.validateWebhook(payload, signature, timestamp, sourceIp),
      valid: result =>
        expect(result).toMatchObject({ isValid: true, provider: 'stripe', eventType: 'customer.created' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.constructWebhookEvent', {
      arrange: () => {
        const payload = eventBody('customer.created');
        return args(payload, signed(payload));
      },
      call: (ctx, payload, signature) => ctx.stripe.constructWebhookEvent(payload, signature),
      valid: result => expect(result).toMatchObject({ id: 'evt_hostile', type: 'customer.created' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.createSetupIntent', {
      arrange: ctx => args(seedCustomer(ctx.world).id, { idempotencyKey: `setup-${nextNumber()}` }),
      call: (ctx, id, options) => ctx.stripe.createSetupIntent(id, options),
      valid: result => expect(result).toEqual({ clientSecret: 'seti_new_secret', setupIntentId: 'seti_new' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.createPaymentIntent', {
      arrange: ctx =>
        args({
          customerId: seedCustomer(ctx.world).id,
          amount: money('20.00', 'USD'),
          paymentMethodId: 'pm_hostile',
          automatic: true,
          idempotencyKey: `intent-${nextNumber()}`,
        }),
      call: (ctx, params) => ctx.stripe.createPaymentIntent(params),
      valid: result => expect(result).toEqual({ clientSecret: 'pi_new_secret', paymentIntentId: 'pi_new' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.createCustomerPortalSession', {
      arrange: () => args('cus_hostile', 'https://app.test/account'),
      call: (ctx, providerCustomerId, returnUrl) =>
        ctx.stripe.createCustomerPortalSession(providerCustomerId, returnUrl),
      valid: result => expect(result).toEqual({ url: 'https://billing.stripe.test/p/session' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.createCheckoutSession', {
      arrange: () =>
        args({
          priceId: PRICE_ID,
          successUrl: 'https://app.test/ok',
          cancelUrl: 'https://app.test/cancel',
          trialPeriodDays: 7,
          providerCustomerId: 'cus_hostile',
          customerEmail: 'buyer@example.com',
          clientReferenceId: 'usr_hostile',
          metadata: { userId: 'usr_hostile' },
          automaticTax: true,
        }),
      call: (ctx, params) => ctx.stripe.createCheckoutSession(params),
      valid: result => expect(result).toEqual({ url: 'https://checkout.stripe.test/cs_new', sessionId: 'cs_new' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.calculateTax', {
      arrange: ctx =>
        args({
          customerId: seedCustomer(ctx.world).id,
          lineItems: [{ amount: money('10.00', 'EUR'), reference: 'plan', taxCode: 'txcd_10103001' }],
          currency: 'EUR',
          customerDetails: {
            address: { line1: '1 Hauptstrasse', city: 'Berlin', postalCode: '10115', country: 'DE' },
            taxIds: [{ type: 'eu_vat', value: 'DE123456789' }],
          },
        }),
      call: (ctx, params) => ctx.stripe.calculateTax(params),
      valid: result =>
        expect(result).toMatchObject({ taxBreakdown: [{ jurisdiction: 'Germany', country: 'DE', rate: 19 }] }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.createTaxTransaction', {
      arrange: ctx =>
        args({
          reference: `order_${nextNumber()}`,
          type: 'sale' as const,
          customerId: seedCustomer(ctx.world).id,
          currency: 'USD',
          lineItems: [{ amount: money('10.00', 'USD'), quantity: 1, reference: 'plan', taxCode: 'txcd_10103001' }],
          customerDetails: { address: { country: 'US', postalCode: '94105', state: 'CA' } },
        }),
      call: (ctx, params) => ctx.stripe.createTaxTransaction(params),
      valid: result => expect(result).toMatchObject({ id: 'tax_txn_new' }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.getTaxSettings', {
      arrange: noArgs,
      call: (ctx, ...none) => ctx.stripe.getTaxSettings(...none),
      valid: result =>
        expect(result).toMatchObject({
          defaultTaxCode: 'txcd_10000000',
          headOfficeLocation: { address: { country: 'US' } },
          taxRegistrations: [],
        }),
    }),
    op('core/providers/stripe-provider.ts::StripeProvider.healthCheck', {
      arrange: noArgs,
      call: (ctx, ...none) => ctx.stripe.healthCheck(...none),
      valid: result => expect(result).toEqual({ status: 'healthy' }),
    }),

    // ---------------------------------------------------------------- presets
    op('presets/subscription.ts::getEntitlement', {
      arrange: () => args(userIdOf(`entitlement_${nextNumber()}`)),
      call: (ctx, ownerId) => getEntitlement(coreReads(ctx.db), ownerId),
      valid: result => expect(result).toEqual({ tier: 'free' }),
    }),
    op('presets/subscription.ts::projectStripeSubscription', {
      arrange: async ctx => {
        const subscription = await ctx.sdk.subscriptions.retrieve(`sub_project_${nextNumber()}`);
        return args(subscription);
      },
      call: (ctx, subscription) =>
        projectStripeSubscription({
          repo: {
            async findCustomerByProviderCustomerId() {
              const [row] = await ctx.db.select().from(core.customers).where(eq(core.customers.id, customerId));
              return row ?? null;
            },
          },
          writes: typed.core.writes(runnerOn(ctx.db)),
          subscription,
          planId,
        }),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('presets/subscription.ts::createSubscriptionBilling', {
      arrange: ctx =>
        args({
          provider: ctx.stripe,
          repo: {
            findCustomerByUserId: () => Promise.resolve(null),
            createCustomer: () => Promise.reject(new Error('not reached: the factory only builds the object')),
            findCustomerByProviderCustomerId: () => Promise.resolve(null),
            findSubscriptionsByUserId: () => Promise.resolve([]),
          },
          writes: typed.core.writes(runnerOn(ctx.db)),
          prices: [{ priceId: PRICE_ID, planId }],
          urls: { success: 'https://app.test/ok', cancel: 'https://app.test/cancel' },
          trialDays: 14,
          automaticTax: false,
        }),
      call: (_ctx, config) => createSubscriptionBilling(config),
      surface: true,
      keep: {
        'args[0].provider': 'a dependency, not input',
        'args[0].repo': 'a dependency, not input',
        'args[0].writes': 'a dependency, not input',
      },
      valid: result => {
        expect(result).toMatchObject({
          createCheckoutSession: expect.any(Function),
          handleWebhook: expect.any(Function),
          getEntitlement: expect.any(Function),
        });
      },
    }),
    op('presets/subscription.ts::createSubscriptionBilling().createCheckoutSession', {
      arrange: async ctx => {
        const owner = userIdOf(`checkout_${nextNumber()}`);
        await ctx.db.insert(users).values({ id: owner });
        return args({ userId: owner, email: `${owner}@example.com`, priceId: PRICE_ID });
      },
      call: (ctx, params) => ctx.billing.createCheckoutSession(params),
      valid: result => expect(result).toEqual({ url: 'https://checkout.stripe.test/cs_new', sessionId: 'cs_new' }),
    }),
    op('presets/subscription.ts::createSubscriptionBilling().handleWebhook', {
      arrange: () => {
        const payload = subscriptionBody(`sub_webhook_${nextNumber()}`);
        return args(payload, signed(payload));
      },
      call: (ctx, payload, signature) => ctx.billing.handleWebhook(payload, signature),
      valid: result => expect(result).toEqual({ handled: true, type: 'customer.subscription.created' }),
    }),
    op('presets/subscription.ts::createSubscriptionBilling().getEntitlement', {
      arrange: () => args(userIdOf(`billing_entitlement_${nextNumber()}`)),
      call: (ctx, ownerId) => ctx.billing.getEntitlement(ownerId),
      valid: result => expect(result).toEqual({ tier: 'free' }),
    }),
    op('presets/revenuecat.ts::verifyRevenueCatAuth', {
      arrange: () => args('Bearer secret-token', 'Bearer secret-token'),
      call: (_ctx, header, secret) => verifyRevenueCatAuth(header, secret),
      valid: result => expect(result).toBe(true),
    }),
    op('presets/revenuecat.ts::projectRevenueCatEvent', {
      arrange: () =>
        args({
          event: {
            type: 'INITIAL_PURCHASE',
            app_user_id: userId,
            product_id: 'pro_monthly',
            period_type: 'NORMAL',
            purchased_at_ms: Date.UTC(2026, 0, 1),
            expiration_at_ms: Date.UTC(2026, 1, 1),
            store: 'APP_STORE',
            environment: 'SANDBOX',
            original_transaction_id: `rc_hostile_${nextNumber()}`,
          },
          customer: { id: customerId, userId },
          planId,
        }),
      call: (ctx, params) => projectRevenueCatEvent({ writes: typed.core.writes(runnerOn(ctx.db)), ...params }),
      valid: result => expect(result).toEqual({ handled: true }),
    }),
  ],
});
