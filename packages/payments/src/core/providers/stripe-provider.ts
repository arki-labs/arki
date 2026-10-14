import Stripe from 'stripe';

import type { UserId } from '../user-id.js';
import type { Instant } from '@arki/date';
import { fromUnix, now } from '@arki/date';
import { Money, sum } from '@arki/money';
import { fromStripeAmount, toStripeAmount } from '@arki/money/stripe';

import type {
  BillingInterval,
  Customer,
  CustomerId,
  Payment,
  PaymentId,
  PaymentMethodInfo,
  PaymentStatus,
  Plan,
  PlanId,
  Subscription,
  SubscriptionId,
  SubscriptionPreview,
  WebhookEventType,
  WebhookValidationResult,
} from '../types.js';
import type { PaymentProviderConfig, ProviderRefundResult } from './base-provider.js';
import { toMinorColumn } from '../money.js';
import { createCustomerId, createPaymentId, createPlanId, createSubscriptionId, planIdSchema } from '../primitives.js';
import { BasePaymentProvider } from './base-provider.js';
import { PaymentProviderError, mapStripeError } from './provider-error.js';
import { mapStripeEventType } from './stripe-event-types.js';

/**
 * The rows the provider reads to turn our ids into Stripe ids. A `PaymentRepository` fits.
 * Without it, the calls that take a customer, plan, subscription or payment id throw `not_configured`.
 */
export type StripeReferenceReads = {
  findCustomerById(id: CustomerId): Promise<Customer | null>;
  findPlanById(id: PlanId): Promise<Plan | null>;
  findPaymentById(id: PaymentId): Promise<Payment | null>;
  findSubscriptionById(id: SubscriptionId): Promise<Subscription | null>;
};

export type StripeProviderOptions = {
  references?: StripeReferenceReads;
  /** Replaces Stripe's HTTP layer. Tests pass one that never leaves the process. */
  httpClient?: Stripe.HttpClient;
  /** Retries of network failures and 5xx answers. Stripe's default is 1. */
  maxNetworkRetries?: number;
};

/** Metadata Stripe accepts: strings only. Objects become JSON, null and undefined are left out. */
function toStripeMetadata(metadata: Record<string, unknown> | undefined): Stripe.MetadataParam | undefined {
  if (!metadata) return undefined;
  const out: Stripe.MetadataParam = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    out[key] =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
          ? String(value)
          : JSON.stringify(value);
  }
  return out;
}

export class StripeProvider extends BasePaymentProvider {
  readonly providerType = 'stripe' as const;
  private stripe: Stripe;
  private readonly references: StripeReferenceReads | undefined;

  // Declare provider features supported by Stripe
  readonly features = {
    customerPortal: true,
    automatedInvoicing: true,
    automatedDunning: true,
    taxCalculation: true,
    taxCompliance: true,
    taxReporting: true,
  };

  constructor(config: PaymentProviderConfig, options: StripeProviderOptions = {}) {
    super(config);
    this.references = options.references;
    this.stripe = new Stripe(config.apiKey, {
      apiVersion: '2026-09-30.endive',
      typescript: true,
      httpClient: options.httpClient,
      maxNetworkRetries: options.maxNetworkRetries,
    });
  }

  /** Runs a Stripe call and turns a Stripe error into a `PaymentProviderError`. */
  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw mapStripeError(error);
    }
  }

  private requireReferences(): StripeReferenceReads {
    if (!this.references) {
      throw new PaymentProviderError(
        'not_configured',
        'StripeProvider needs `references` (a repository) to turn customer, plan and subscription ids into Stripe ids',
      );
    }
    return this.references;
  }

  private async customerRef(customerId: CustomerId): Promise<Customer> {
    const customer = await this.requireReferences().findCustomerById(customerId);
    if (!customer) throw new PaymentProviderError('reference_not_found', `Customer ${customerId} not found`);
    return customer;
  }

  private async planRef(planId: PlanId): Promise<Plan> {
    const plan = await this.requireReferences().findPlanById(planId);
    if (!plan) throw new PaymentProviderError('reference_not_found', `Plan ${planId} not found`);
    return plan;
  }

  private priceIdOf(plan: Plan): string {
    const priceId = plan.metadata?.stripePriceId;
    if (typeof priceId !== 'string' || priceId === '') {
      throw new PaymentProviderError(
        'reference_not_found',
        `Plan ${plan.id} has no Stripe price id (metadata.stripePriceId)`,
      );
    }
    return priceId;
  }

  private async priceRef(planId: PlanId): Promise<string> {
    return this.priceIdOf(await this.planRef(planId));
  }

  private async paymentRef(paymentId: PaymentId): Promise<Payment> {
    const payment = await this.requireReferences().findPaymentById(paymentId);
    if (!payment) throw new PaymentProviderError('reference_not_found', `Payment ${paymentId} not found`);
    return payment;
  }

  private async subscriptionRef(subscriptionId: SubscriptionId): Promise<Subscription> {
    const subscription = await this.requireReferences().findSubscriptionById(subscriptionId);
    if (!subscription) {
      throw new PaymentProviderError('reference_not_found', `Subscription ${subscriptionId} not found`);
    }
    return subscription;
  }

  /** Our subscription shape from Stripe's. `base` carries what Stripe does not know: our ids. */
  private toSubscription(
    stripeSubscription: Stripe.Subscription,
    base: Pick<Subscription, 'id' | 'userId' | 'planId' | 'customerId' | 'metadata' | 'createdAt'>,
  ): Subscription {
    // Since Stripe's 2025 API the billing period belongs to the items, not the subscription
    const item = stripeSubscription.items.data[0];
    if (!item) {
      throw new PaymentProviderError('unknown', `Stripe subscription ${stripeSubscription.id} has no items`);
    }
    return {
      id: base.id,
      userId: base.userId,
      planId: base.planId,
      customerId: base.customerId,
      providerSubscriptionId: stripeSubscription.id,
      // A paused subscription keeps Stripe status `active`; `pause_collection` is what marks it
      status: stripeSubscription.pause_collection ? 'paused' : this.mapSubscriptionStatus(stripeSubscription.status),
      currentPeriodStart: fromUnix(item.current_period_start),
      currentPeriodEnd: fromUnix(item.current_period_end),
      trialStart: stripeSubscription.trial_start === null ? null : fromUnix(stripeSubscription.trial_start),
      trialEnd: stripeSubscription.trial_end === null ? null : fromUnix(stripeSubscription.trial_end),
      canceledAt: stripeSubscription.canceled_at === null ? null : fromUnix(stripeSubscription.canceled_at),
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
      metadata: base.metadata,
      createdAt: base.createdAt,
      updatedAt: now(),
    };
  }

  async createCustomer(params: {
    userId: UserId;
    email: string;
    name?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Customer> {
    const stripeCustomer = await this.stripe.customers.create({
      email: params.email,
      name: params.name,
      metadata: {
        userId: params.userId,
        ...params.metadata,
      },
    });

    return {
      id: createCustomerId(),
      userId: params.userId,
      providerCustomerId: stripeCustomer.id,
      provider: 'stripe',
      email: params.email,
      name: params.name ?? null,
      defaultPaymentMethodId: null,
      metadata: params.metadata ?? null,
      createdAt: fromUnix(stripeCustomer.created),
      updatedAt: now(),
    };
  }

  /** Our customer row, refreshed with what Stripe holds now. */
  private toCustomer(row: Customer, stripeCustomer: Stripe.Customer): Customer {
    const defaultPaymentMethod = stripeCustomer.invoice_settings.default_payment_method;
    return {
      ...row,
      email: stripeCustomer.email ?? row.email,
      name: stripeCustomer.name ?? null,
      defaultPaymentMethodId:
        typeof defaultPaymentMethod === 'string' ? defaultPaymentMethod : (defaultPaymentMethod?.id ?? null),
      updatedAt: now(),
    };
  }

  async getCustomer(customerId: CustomerId): Promise<Customer | null> {
    const row = await this.requireReferences().findCustomerById(customerId);
    if (!row) return null;

    const stripeCustomer = await this.call(() => this.stripe.customers.retrieve(row.providerCustomerId));
    // Stripe answers a deleted customer with a stub: the customer is gone
    if (stripeCustomer.deleted === true) return null;
    return this.toCustomer(row, stripeCustomer);
  }

  async updateCustomer(
    customerId: CustomerId,
    params: { email?: string; name?: string; metadata?: Record<string, unknown> },
  ): Promise<Customer> {
    const row = await this.customerRef(customerId);

    const stripeCustomer = await this.call(() =>
      this.stripe.customers.update(row.providerCustomerId, {
        email: params.email,
        name: params.name,
        metadata: toStripeMetadata(params.metadata),
      }),
    );

    const updated = this.toCustomer(row, stripeCustomer);
    return params.metadata === undefined ? updated : { ...updated, metadata: { ...row.metadata, ...params.metadata } };
  }

  async deleteCustomer(customerId: CustomerId): Promise<void> {
    const row = await this.customerRef(customerId);
    await this.call(() => this.stripe.customers.del(row.providerCustomerId));
  }

  /** Our plan row, refreshed with the price and product Stripe holds now. */
  private toPlan(row: Plan, price: Stripe.Price, productName?: string): Plan {
    if (price.unit_amount === null || !price.recurring) {
      throw new PaymentProviderError(
        'unknown',
        `Stripe price ${price.id} is not a flat recurring price, so it is not a plan`,
      );
    }
    const amount = fromStripeAmount(price.unit_amount, price.currency);
    return {
      ...row,
      name: productName ?? row.name,
      priceMinor: toMinorColumn(amount),
      currency: amount.currency.code,
      interval: this.mapStripeIntervalToBilling(price.recurring.interval),
      intervalCount: price.recurring.interval_count,
      isActive: price.active,
      updatedAt: now(),
    };
  }

  private productIdOf(price: Stripe.Price): string {
    return typeof price.product === 'string' ? price.product : price.product.id;
  }

  /** The product's name when the price was fetched with `expand: ['product']` and the product still exists. */
  private expandedProductName(price: Stripe.Price): string | undefined {
    const product = price.product;
    if (typeof product === 'string' || product.deleted === true) return undefined;
    return product.name;
  }

  async createPlan(params: {
    name: string;
    amount: Money;
    interval: BillingInterval;
    intervalCount?: number;
    trialPeriodDays?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Plan> {
    const planId = createPlanId();
    const stripeProduct = await this.call(() =>
      this.stripe.products.create({ name: params.name, metadata: toStripeMetadata(params.metadata) }),
    );

    const stripePrice = await this.call(() =>
      this.stripe.prices.create({
        product: stripeProduct.id,
        unit_amount: toStripeAmount(params.amount),
        currency: params.amount.currency.code.toLowerCase(),
        recurring: {
          interval: this.mapBillingIntervalToStripe(params.interval),
          interval_count: params.intervalCount || 1,
        },
        // `planId` lets `listPlans` find our row from a Stripe price
        metadata: toStripeMetadata({ ...params.metadata, planId }),
      }),
    );

    return {
      id: planId,
      name: params.name,
      description: '',
      tier: 'basic', // Would be determined by business logic
      priceMinor: toMinorColumn(params.amount),
      currency: params.amount.currency.code,
      interval: params.interval,
      intervalCount: params.intervalCount || 1,
      features: [], // Would be populated from metadata or separate config
      isActive: true,
      trialPeriodDays: params.trialPeriodDays ?? null,
      metadata: { stripeProductId: stripeProduct.id, stripePriceId: stripePrice.id, ...params.metadata },
      createdAt: now(),
      updatedAt: now(),
    };
  }

  async getPlan(planId: PlanId): Promise<Plan | null> {
    const row = await this.requireReferences().findPlanById(planId);
    if (!row) return null;

    const price = await this.call(() =>
      this.stripe.prices.retrieve(this.priceIdOf(row), { expand: ['product'] }),
    );
    return this.toPlan(row, price, this.expandedProductName(price));
  }

  async updatePlan(
    planId: PlanId,
    params: { name?: string; metadata?: Record<string, unknown> },
  ): Promise<Plan> {
    const row = await this.planRef(planId);
    const priceId = this.priceIdOf(row);
    const metadata = toStripeMetadata(params.metadata);

    const price = await this.call(() =>
      metadata === undefined
        ? this.stripe.prices.retrieve(priceId)
        : this.stripe.prices.update(priceId, { metadata }),
    );
    let name = row.name;
    if (params.name !== undefined || metadata !== undefined) {
      const product = await this.call(() =>
        this.stripe.products.update(this.productIdOf(price), { name: params.name, metadata }),
      );
      name = product.name;
    }

    const refreshed = this.toPlan(row, price, name);
    return params.metadata === undefined ? refreshed : { ...refreshed, metadata: { ...row.metadata, ...params.metadata } };
  }

  /** Stripe prices cannot be deleted, so a deleted plan is archived: the price and its product stop being sold. */
  async deletePlan(planId: PlanId): Promise<void> {
    const priceId = await this.priceRef(planId);

    const price = await this.call(() => this.stripe.prices.update(priceId, { active: false }));
    await this.call(() => this.stripe.products.update(this.productIdOf(price), { active: false }));
  }

  /**
   * The active plans Stripe sells that this package created: prices carrying our `planId` in their
   * metadata, whose row still exists. Prices made in the Stripe dashboard have no row here and are left out.
   */
  async listPlans(): Promise<Plan[]> {
    const references = this.requireReferences();
    const prices = await this.call(() =>
      this.stripe.prices
        .list({ active: true, type: 'recurring', expand: ['data.product'], limit: 100 })
        .autoPagingToArray({ limit: 10_000 }),
    );

    const plans: Plan[] = [];
    for (const price of prices) {
      const parsed = planIdSchema.safeParse(price.metadata.planId);
      if (!parsed.success) continue;
      const row = await references.findPlanById(parsed.data);
      if (row) plans.push(this.toPlan(row, price, this.expandedProductName(price)));
    }
    return plans;
  }

  async createSubscription(params: {
    customerId: CustomerId;
    planId: PlanId;
    paymentMethodId?: string;
    trialPeriodDays?: number;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<Subscription> {
    const customer = await this.customerRef(params.customerId);
    const priceId = await this.priceRef(params.planId);

    const stripeSubscription = await this.call(() =>
      this.stripe.subscriptions.create(
        {
          customer: customer.providerCustomerId,
          items: [{ price: priceId }],
          default_payment_method: params.paymentMethodId,
          trial_period_days: params.trialPeriodDays,
          metadata: toStripeMetadata({
            ...params.metadata,
            userId: customer.userId,
            customerId: customer.id,
            planId: params.planId,
          }),
        },
        params.idempotencyKey === undefined ? undefined : { idempotencyKey: params.idempotencyKey },
      ),
    );

    return this.toSubscription(stripeSubscription, {
      id: createSubscriptionId(),
      userId: customer.userId,
      planId: params.planId,
      customerId: customer.id,
      metadata: params.metadata ?? null,
      createdAt: fromUnix(stripeSubscription.created),
    });
  }

  async getSubscription(subscriptionId: SubscriptionId): Promise<Subscription | null> {
    const row = await this.requireReferences().findSubscriptionById(subscriptionId);
    if (!row) return null;

    const stripeSubscription = await this.call(() => this.stripe.subscriptions.retrieve(row.providerSubscriptionId));
    return this.toSubscription(stripeSubscription, row);
  }

  async updateSubscription(
    subscriptionId: SubscriptionId,
    params: {
      planId?: PlanId;
      paymentMethodId?: string;
      metadata?: Record<string, unknown>;
      cancelAtPeriodEnd?: boolean;
      prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice';
      idempotencyKey?: string;
    },
  ): Promise<Subscription> {
    const current = await this.subscriptionRef(subscriptionId);
    const priceId = params.planId === undefined ? undefined : await this.priceRef(params.planId);

    const update: Stripe.SubscriptionUpdateParams = {
      default_payment_method: params.paymentMethodId,
      cancel_at_period_end: params.cancelAtPeriodEnd,
      metadata: toStripeMetadata(params.metadata),
    };

    if (priceId !== undefined) {
      // A price change replaces the price of the existing item: it needs the item's id
      const existing = await this.call(() => this.stripe.subscriptions.retrieve(current.providerSubscriptionId));
      const item = existing.items.data[0];
      if (!item) {
        throw new PaymentProviderError('unknown', `Stripe subscription ${existing.id} has no items`);
      }
      update.items = [{ id: item.id, price: priceId }];
      update.proration_behavior = params.prorationBehavior;
    }

    const stripeSubscription = await this.call(() =>
      this.stripe.subscriptions.update(
        current.providerSubscriptionId,
        update,
        params.idempotencyKey === undefined ? undefined : { idempotencyKey: params.idempotencyKey },
      ),
    );

    return this.toSubscription(stripeSubscription, {
      id: current.id,
      userId: current.userId,
      planId: params.planId ?? current.planId,
      customerId: current.customerId,
      metadata: params.metadata === undefined ? current.metadata : { ...current.metadata, ...params.metadata },
      createdAt: current.createdAt,
    });
  }

  async cancelSubscription(
    subscriptionId: SubscriptionId,
    options: { immediately?: boolean; reason?: string; idempotencyKey?: string },
  ): Promise<Subscription> {
    const current = await this.subscriptionRef(subscriptionId);
    const requestOptions = options.idempotencyKey === undefined ? undefined : { idempotencyKey: options.idempotencyKey };
    const cancellationDetails = options.reason === undefined ? undefined : { comment: options.reason };

    const stripeSubscription = await this.call(() =>
      options.immediately
        ? this.stripe.subscriptions.cancel(
            current.providerSubscriptionId,
            { cancellation_details: cancellationDetails },
            requestOptions,
          )
        : this.stripe.subscriptions.update(
            current.providerSubscriptionId,
            { cancel_at_period_end: true, cancellation_details: cancellationDetails },
            requestOptions,
          ),
    );

    return this.toSubscription(stripeSubscription, {
      id: current.id,
      userId: current.userId,
      planId: current.planId,
      customerId: current.customerId,
      metadata: current.metadata,
      createdAt: current.createdAt,
    });
  }

  /** Updates the Stripe subscription and returns our subscription row as Stripe now has it. */
  private async updateStripeSubscription(
    subscriptionId: SubscriptionId,
    update: Stripe.SubscriptionUpdateParams,
  ): Promise<Subscription> {
    const current = await this.subscriptionRef(subscriptionId);
    const stripeSubscription = await this.call(() =>
      this.stripe.subscriptions.update(current.providerSubscriptionId, update),
    );
    return this.toSubscription(stripeSubscription, current);
  }

  /** Undoes a cancellation that is set to happen at the end of the paid period. */
  async reactivateSubscription(subscriptionId: SubscriptionId): Promise<Subscription> {
    return this.updateStripeSubscription(subscriptionId, { cancel_at_period_end: false });
  }

  /** Stops charging and keeps the subscription: invoices are voided until `resumeSubscription`. */
  async pauseSubscription(subscriptionId: SubscriptionId): Promise<Subscription> {
    return this.updateStripeSubscription(subscriptionId, { pause_collection: { behavior: 'void' } });
  }

  async resumeSubscription(subscriptionId: SubscriptionId): Promise<Subscription> {
    // An empty string clears `pause_collection` in Stripe's API
    return this.updateStripeSubscription(subscriptionId, { pause_collection: '' });
  }

  /**
   * What changing to `planId` would charge, from a Stripe upcoming-invoice preview (nothing is created).
   * `immediateTotal` is the net of the proration lines (a credit larger than the charge is zero),
   * `creditApplied` the unused time credited back, `nextInvoiceTotal` the lines of the new plan itself.
   */
  async previewSubscriptionChange(params: {
    subscriptionId: SubscriptionId;
    planId: PlanId;
    prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice';
  }): Promise<SubscriptionPreview> {
    const current = await this.subscriptionRef(params.subscriptionId);
    const priceId = await this.priceRef(params.planId);
    const customer = await this.customerRef(current.customerId);

    const existing = await this.call(() => this.stripe.subscriptions.retrieve(current.providerSubscriptionId));
    const item = existing.items.data[0];
    if (!item) throw new PaymentProviderError('unknown', `Stripe subscription ${existing.id} has no items`);

    const invoice = await this.call(() =>
      this.stripe.invoices.createPreview({
        customer: customer.providerCustomerId,
        subscription: existing.id,
        subscription_details: {
          items: [{ id: item.id, price: priceId }],
          proration_behavior: params.prorationBehavior,
        },
      }),
    );

    const currency = invoice.currency;
    let charged = Money.zero(currency.toUpperCase());
    let credited = Money.zero(currency.toUpperCase());
    let next = Money.zero(currency.toUpperCase());
    for (const line of invoice.lines.data) {
      const amount = fromStripeAmount(line.amount, currency);
      const proration = line.parent?.subscription_item_details?.proration ?? false;
      if (!proration) {
        next = next.plus(amount);
      } else if (amount.isNegative()) {
        credited = credited.plus(amount.abs());
      } else {
        charged = charged.plus(amount);
      }
    }
    const net = charged.minus(credited);

    return {
      planId: params.planId,
      proration: {
        immediateTotal: (net.isNegative() ? Money.zero(currency.toUpperCase()) : net).toJSON(),
        nextInvoiceTotal: next.toJSON(),
        creditApplied: credited.toJSON(),
      },
      trialEnd: existing.trial_end === null ? undefined : fromUnix(existing.trial_end),
      nextBillingDate: fromUnix(item.current_period_end),
    };
  }

  /** Our payment from a Stripe payment intent fetched with `expand: ['payment_method', 'latest_charge']`. */
  private toPayment(
    intent: Stripe.PaymentIntent,
    base: Pick<Payment, 'id' | 'userId' | 'customerId' | 'subscriptionId' | 'metadata' | 'disputeId' | 'disputeStatus' | 'createdAt'>,
  ): Payment {
    const amount = fromStripeAmount(intent.amount, intent.currency);
    const paymentMethod = intent.payment_method;
    const charge = intent.latest_charge;
    const chargeObject = charge !== null && typeof charge === 'object' ? charge : null;
    const refundedMinor = chargeObject
      ? toMinorColumn(fromStripeAmount(chargeObject.amount_refunded, intent.currency))
      : 0;

    return {
      id: base.id,
      userId: base.userId,
      customerId: base.customerId,
      subscriptionId: base.subscriptionId,
      providerPaymentId: intent.id,
      amountMinor: toMinorColumn(amount),
      currency: amount.currency.code,
      status: this.mapPaymentIntentStatus(intent),
      paymentMethod:
        paymentMethod !== null && typeof paymentMethod === 'object'
          ? this.mapPaymentMethodType(paymentMethod.type)
          : 'card',
      description: intent.description,
      failureReason: intent.last_payment_error?.message ?? null,
      receiptUrl: chargeObject?.receipt_url ?? null,
      refunded: refundedMinor > 0,
      refundedAmountMinor: refundedMinor,
      disputeId: base.disputeId,
      disputeStatus: base.disputeStatus,
      metadata: base.metadata,
      createdAt: base.createdAt,
      updatedAt: now(),
    };
  }

  private mapPaymentIntentStatus(intent: Stripe.PaymentIntent): PaymentStatus {
    switch (intent.status) {
      case 'succeeded': {
        return 'succeeded';
      }
      case 'canceled': {
        return 'canceled';
      }
      case 'processing':
      case 'requires_capture': {
        return 'processing';
      }
      case 'requires_action': {
        return 'requires_action';
      }
      case 'requires_payment_method': {
        // A fresh intent waits for a method; one that has a payment error is a failed attempt
        return intent.last_payment_error ? 'failed' : 'pending';
      }
      default: {
        return 'pending';
      }
    }
  }

  /** Charges the payment method now, with the customer present. */
  async createPayment(params: {
    customerId: CustomerId;
    amount: Money;
    paymentMethodId: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Payment> {
    const customer = await this.customerRef(params.customerId);

    const intent = await this.call(() =>
      this.stripe.paymentIntents.create({
        // Stripe's own units: JPY is sent as yen, not yen x 100
        amount: toStripeAmount(params.amount),
        currency: params.amount.currency.code.toLowerCase(),
        customer: customer.providerCustomerId,
        payment_method: params.paymentMethodId,
        confirm: true,
        // Redirect methods need a return page this call does not have
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        description: params.description,
        metadata: toStripeMetadata({ ...params.metadata, userId: customer.userId, customerId: customer.id }),
        expand: ['payment_method', 'latest_charge'],
      }),
    );

    return this.toPayment(intent, {
      id: createPaymentId(),
      userId: customer.userId,
      customerId: customer.id,
      subscriptionId: null,
      metadata: params.metadata ?? null,
      disputeId: null,
      disputeStatus: null,
      createdAt: fromUnix(intent.created),
    });
  }

  async getPayment(paymentId: PaymentId): Promise<Payment | null> {
    const row = await this.requireReferences().findPaymentById(paymentId);
    if (!row) return null;

    const intent = await this.call(() =>
      this.stripe.paymentIntents.retrieve(row.providerPaymentId, { expand: ['payment_method', 'latest_charge'] }),
    );
    return this.toPayment(intent, row);
  }

  /** Confirms the payment intent: also how a failed payment is tried again. */
  async confirmPayment(paymentId: PaymentId): Promise<Payment> {
    const row = await this.paymentRef(paymentId);
    const intent = await this.call(() =>
      this.stripe.paymentIntents.confirm(row.providerPaymentId, { expand: ['payment_method', 'latest_charge'] }),
    );
    return this.toPayment(intent, row);
  }

  async cancelPayment(paymentId: PaymentId): Promise<Payment> {
    const row = await this.paymentRef(paymentId);
    const intent = await this.call(() =>
      this.stripe.paymentIntents.cancel(row.providerPaymentId, { expand: ['payment_method', 'latest_charge'] }),
    );
    return this.toPayment(intent, row);
  }

  /**
   * Refunds the payment's Stripe charge. `paymentId` is our payment id; the Stripe payment intent comes
   * from its row. The answer holds the Stripe refund id and the payment with what Stripe now reports as
   * refunded in total (earlier refunds included). A refund Stripe fails or cancels throws.
   */
  async refundPayment(
    paymentId: PaymentId,
    params: { amount?: Money; reason?: string; metadata?: Record<string, unknown> },
  ): Promise<ProviderRefundResult> {
    const row = await this.paymentRef(paymentId);
    if (params.amount !== undefined && params.amount.currency.code !== row.currency.toUpperCase()) {
      throw new PaymentProviderError(
        'invalid_request',
        `Refund currency ${params.amount.currency.code} differs from the payment currency ${row.currency}`,
      );
    }

    const refund = await this.call(() =>
      this.stripe.refunds.create({
        payment_intent: row.providerPaymentId,
        // Stripe's own units: JPY is sent as yen, not yen x 100
        amount: params.amount === undefined ? undefined : toStripeAmount(params.amount),
        reason: this.mapRefundReasonToStripe(params.reason),
        metadata: toStripeMetadata({ ...params.metadata, paymentId: row.id }),
      }),
    );
    if (refund.status === 'failed' || refund.status === 'canceled') {
      throw new PaymentProviderError(
        'unknown',
        `Stripe refund ${refund.id} ${refund.status}${refund.failure_reason ? `: ${refund.failure_reason}` : ''}`,
      );
    }

    // The refund only knows its own amount; the payment's total refunded sits on the charge
    const intent = await this.call(() =>
      this.stripe.paymentIntents.retrieve(row.providerPaymentId, { expand: ['payment_method', 'latest_charge'] }),
    );
    return { providerRefundId: refund.id, payment: this.toPayment(intent, row) };
  }

  private toPaymentMethodInfo(method: Stripe.PaymentMethod, defaultMethodId: string | null): PaymentMethodInfo {
    return {
      id: method.id,
      type: this.mapPaymentMethodType(method.type),
      brand: method.card?.brand ?? method.us_bank_account?.bank_name ?? undefined,
      last4: method.card?.last4 ?? method.us_bank_account?.last4 ?? undefined,
      expiryMonth: method.card?.exp_month,
      expiryYear: method.card?.exp_year,
      isDefault: method.id === defaultMethodId,
    };
  }

  /** The id of the customer's default payment method in Stripe, or null. */
  private async defaultPaymentMethodOf(providerCustomerId: string): Promise<string | null> {
    const stripeCustomer = await this.call(() => this.stripe.customers.retrieve(providerCustomerId));
    if (stripeCustomer.deleted === true) {
      throw new PaymentProviderError('invalid_request', `Stripe customer ${providerCustomerId} was deleted`);
    }
    const method = stripeCustomer.invoice_settings.default_payment_method;
    return typeof method === 'string' ? method : (method?.id ?? null);
  }

  async attachPaymentMethod(params: {
    customerId: CustomerId;
    paymentMethodId: string;
  }): Promise<PaymentMethodInfo> {
    const customer = await this.customerRef(params.customerId);

    const method = await this.call(() =>
      this.stripe.paymentMethods.attach(params.paymentMethodId, { customer: customer.providerCustomerId }),
    );
    return this.toPaymentMethodInfo(method, await this.defaultPaymentMethodOf(customer.providerCustomerId));
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  async listPaymentMethods(customerId: CustomerId): Promise<PaymentMethodInfo[]> {
    const customer = await this.customerRef(customerId);

    const methods = await this.call(() =>
      this.stripe.paymentMethods
        .list({ customer: customer.providerCustomerId, limit: 100 })
        .autoPagingToArray({ limit: 10_000 }),
    );
    const defaultMethodId = await this.defaultPaymentMethodOf(customer.providerCustomerId);
    return methods.map(method => this.toPaymentMethodInfo(method, defaultMethodId));
  }

  async setDefaultPaymentMethod(params: { customerId: CustomerId; paymentMethodId: string }): Promise<void> {
    const customer = await this.customerRef(params.customerId);

    await this.call(() =>
      this.stripe.customers.update(customer.providerCustomerId, {
        invoice_settings: { default_payment_method: params.paymentMethodId },
      }),
    );
  }

  async validateWebhook(
    payload: string | Buffer,
    signature: string,
    _timestamp: string,
    _sourceIp: string,
  ): Promise<WebhookValidationResult> {
    try {
      // Validate Stripe webhook signature
      const event = this.stripe.webhooks.constructEvent(payload, signature, this.config.webhookSecret);

      return {
        isValid: true,
        provider: 'stripe',
        eventType: this.mapStripeEventType(event.type) as WebhookEventType,
        data: event.data.object as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return {
        isValid: false,
        provider: 'stripe',
        error: error instanceof Error ? error.message : 'Invalid webhook signature',
      };
    }
  }

  /**
   * Verify a webhook signature and return the **typed** Stripe event.
   *
   * `validateWebhook` (the provider-agnostic interface method) erases the event payload to
   * `Record<string, unknown>`. The subscription billing preset instead needs the discriminated
   * `Stripe.Event` so it can narrow on `event.type` and read `event.data.object` as a
   * `Stripe.Subscription` with no unsafe cast. Throws `StripeSignatureVerificationError` on a bad
   * signature — a webhook route should map that to HTTP 400.
   */
  constructWebhookEvent(payload: string | Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(payload, signature, this.config.webhookSecret);
  }

  async createSetupIntent(
    customerId: CustomerId,
    options: { idempotencyKey?: string } = {},
  ): Promise<{
    clientSecret: string;
    setupIntentId: string;
  }> {
    const customer = await this.customerRef(customerId);

    const setupIntent = await this.call(() =>
      this.stripe.setupIntents.create(
        {
          customer: customer.providerCustomerId,
          usage: 'off_session',
          automatic_payment_methods: { enabled: true },
          metadata: toStripeMetadata({ userId: customer.userId, customerId: customer.id }),
        },
        options.idempotencyKey === undefined ? undefined : { idempotencyKey: options.idempotencyKey },
      ),
    );

    if (!setupIntent.client_secret) {
      throw new PaymentProviderError('unknown', `Stripe setup intent ${setupIntent.id} has no client secret`);
    }
    return { clientSecret: setupIntent.client_secret, setupIntentId: setupIntent.id };
  }

  async createPaymentIntent(params: {
    customerId: CustomerId;
    amount: Money;
    paymentMethodId?: string;
    automatic: boolean;
    idempotencyKey?: string;
  }): Promise<{
    clientSecret: string;
    paymentIntentId: string;
  }> {
    if (params.automatic && params.paymentMethodId === undefined) {
      throw new PaymentProviderError('invalid_request', 'An automatic payment needs a payment method id');
    }
    const customer = await this.customerRef(params.customerId);

    const paymentIntent = await this.call(() =>
      this.stripe.paymentIntents.create(
        {
          // Stripe's own units: JPY is sent as yen, not yen x 100
          amount: toStripeAmount(params.amount),
          currency: params.amount.currency.code.toLowerCase(),
          customer: customer.providerCustomerId,
          payment_method: params.paymentMethodId,
          metadata: toStripeMetadata({ userId: customer.userId, customerId: customer.id }),
          ...(params.automatic
            ? { confirm: true, off_session: true }
            : { automatic_payment_methods: { enabled: true } }),
        },
        params.idempotencyKey === undefined ? undefined : { idempotencyKey: params.idempotencyKey },
      ),
    );

    if (!paymentIntent.client_secret) {
      throw new PaymentProviderError('unknown', `Stripe payment intent ${paymentIntent.id} has no client secret`);
    }
    return { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };
  }

  async createCustomerPortalSession(
    providerCustomerId: string,
    returnUrl: string,
  ): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: providerCustomerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  /**
   * Create a Stripe Checkout Session for a subscription — the modern hosted subscribe flow.
   *
   * This is the path that actually starts a paid subscription: Stripe hosts the payment page and
   * handles card entry, SCA/3DS, the free trial, tax, and promo codes, then emits
   * `customer.subscription.*` webhooks that the billing preset projects into the `subscriptions`
   * table. We deliberately use Checkout rather than the raw `subscriptions.create` API so we never
   * touch card data (no PCI scope) and get trials + Stripe Tax for free.
   */
  async createCheckoutSession(params: {
    /** Stripe Price ID for the plan being subscribed to. */
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    /** Free-trial length; omit for no trial. */
    trialPeriodDays?: number;
    /** Existing Stripe customer to attach the subscription to, if we already created one. */
    providerCustomerId?: string;
    /** Used only when no `providerCustomerId` — Stripe links/creates a customer by email. */
    customerEmail?: string;
    /** Our internal user id, echoed onto the session + subscription for webhook correlation. */
    clientReferenceId?: string;
    metadata?: Record<string, string>;
    /** Enable Stripe Tax (must be configured on the account) so EU VAT is calculated at checkout. */
    automaticTax?: boolean;
  }): Promise<{ url: string; sessionId: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: params.priceId, quantity: 1 }],
      // `customer` and `customer_email` are mutually exclusive in Checkout.
      customer: params.providerCustomerId,
      customer_email: params.providerCustomerId ? undefined : params.customerEmail,
      client_reference_id: params.clientReferenceId,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      allow_promotion_codes: true,
      ...(params.automaticTax ? { automatic_tax: { enabled: true } } : {}),
      subscription_data: {
        ...(params.trialPeriodDays ? { trial_period_days: params.trialPeriodDays } : {}),
        ...(params.metadata ? { metadata: params.metadata } : {}),
      },
      metadata: params.metadata,
    });

    if (!session.url) {
      throw new Error('Stripe Checkout did not return a session URL');
    }
    return { url: session.url, sessionId: session.id };
  }

  // Tax-related methods
  async calculateTax(params: {
    customerId: CustomerId;
    /** Every line item is in `currency`: one calculation has one currency. */
    lineItems: {
      amount: Money;
      reference: string;
      taxCode?: string;
    }[];
    currency: string;
    customerDetails?: {
      address?: {
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        postalCode?: string;
        country?: string;
      };
      taxIds?: {
        type: string;
        value: string;
      }[];
    };
  }): Promise<{
    amountTotal: Money;
    taxAmountExclusive: Money;
    taxAmountInclusive: Money;
    taxBreakdown: {
      amount: Money;
      rate: number;
      jurisdiction: string;
      taxCode?: string;
    }[];
  }> {
    const request: Stripe.Tax.CalculationCreateParams = {
      currency: params.currency.toLowerCase(),
      line_items: params.lineItems.map(item => ({
        // Throws CurrencyMismatchError for a line item in another currency
        amount: toStripeAmount(Money.of(item.amount, params.currency.toUpperCase())),
        reference: item.reference,
        tax_code: item.taxCode || 'txcd_10000000', // General tax code
      })),
      customer_details: params.customerDetails ? {
        address: params.customerDetails.address ? {
          ...params.customerDetails.address,
          country: params.customerDetails.address.country || 'US',
        } : undefined,
        address_source: 'billing' as const,
        tax_ids: params.customerDetails.taxIds?.map(taxId => ({
          type: taxId.type as Stripe.Tax.CalculationCreateParams.CustomerDetails.TaxId.Type,
          value: taxId.value,
        })),
      } : undefined,
      expand: ['line_items.data.tax_breakdown'],
    };
    const calculation = await this.call(() => this.stripe.tax.calculations.create(request));

    return {
      amountTotal: fromStripeAmount(calculation.amount_total, calculation.currency),
      taxAmountExclusive: fromStripeAmount(calculation.tax_amount_exclusive, calculation.currency),
      taxAmountInclusive: fromStripeAmount(calculation.tax_amount_inclusive, calculation.currency),
      taxBreakdown: calculation.line_items?.data?.flatMap((item: Stripe.Tax.CalculationLineItem) =>
        item.tax_breakdown?.map((breakdown: Stripe.Tax.CalculationLineItem.TaxBreakdown) => ({
          amount: fromStripeAmount(breakdown.amount, calculation.currency),
          rate: typeof breakdown.tax_rate_details?.percentage_decimal === 'number'
            ? breakdown.tax_rate_details.percentage_decimal
            : Number.parseFloat(String(breakdown.tax_rate_details?.percentage_decimal || 0)),
          jurisdiction: breakdown.jurisdiction?.display_name || '',
          taxCode: breakdown.jurisdiction?.level || undefined,
        })) || []
      ) || [],
    };
  }

  async createTaxTransaction(params: {
    reference: string;
    type: 'sale' | 'refund';
    /** Every line item is in `currency`. */
    lineItems: {
      amount: Money;
      quantity?: number;
      reference: string;
      taxCode?: string;
    }[];
    currency: string;
    customerId?: CustomerId;
    customerDetails?: {
      address?: {
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        postalCode?: string;
        country?: string;
      };
      taxIds?: {
        type: string;
        value: string;
      }[];
    };
  }): Promise<{
    id: string;
    amountTotal: Money;
    taxAmountExclusive: Money;
    taxAmountInclusive: Money;
  }> {
    // For now, we'll simulate a tax transaction since Stripe's Tax API
    // may have different endpoints for transaction recording

    // In production, this would integrate with Stripe's actual tax recording API
    const transactionId = `txn_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    // A whole quantity times an amount is exact: no rounding mode needed
    const totalAmount = sum(
      params.lineItems.map(item => Money.of(item.amount, params.currency.toUpperCase()).times(item.quantity || 1)),
      params.currency.toUpperCase(),
    );

    // This would typically call Stripe's tax transaction API
    // await this.stripe.tax.transactions.createFromCalculation(...)

    return {
      id: transactionId,
      amountTotal: totalAmount,
      taxAmountExclusive: Money.zero(params.currency.toUpperCase()), // Would be calculated by Stripe
      taxAmountInclusive: Money.zero(params.currency.toUpperCase()), // Would be calculated by Stripe
    };
  }

  async getTaxSettings(): Promise<{
    defaultTaxCode: string;
    headOfficeLocation?: {
      address: {
        country: string;
        state?: string;
        city?: string;
        line1?: string;
        postalCode?: string;
      };
    };
    taxRegistrations: {
      country: string;
      type: string;
      status: string;
    }[];
  }> {
    const settings = await this.stripe.tax.settings.retrieve({
      expand: ['head_office', 'status_details'],
    });

    return {
      defaultTaxCode: settings.defaults?.tax_code || 'txcd_10000000',
      headOfficeLocation: settings.head_office ? {
        address: {
          country: settings.head_office.address.country || 'US',
          state: settings.head_office.address.state || undefined,
          city: settings.head_office.address.city || undefined,
          line1: settings.head_office.address.line1 || undefined,
          postalCode: settings.head_office.address.postal_code || undefined,
        },
      } : undefined,
      taxRegistrations: [], // Simplified for now - would parse actual status details
    };
  }

  async getTaxReport(params: {
    reportType: 'sales_and_use_tax' | 'vat' | 'gst';
    startDate: Instant;
    endDate: Instant;
    jurisdiction?: string;
  }): Promise<{
    id: string;
    status: 'pending' | 'succeeded' | 'failed';
    url?: string;
    downloadUrl?: string;
  }> {
    // Create a tax report (this is a placeholder for the actual implementation)
    // Stripe's tax reporting might use different endpoints based on jurisdiction

    // For now, we'll simulate a tax report creation
    const reportId = `tax_report_${Date.now()}_${params.reportType}`;

    // In a real implementation, this would:
    // 1. Create a report via Stripe's tax API for the specified date range
    // 2. Poll for completion
    // 3. Return download URLs

    console.log(`Creating tax report: ${params.reportType} from ${params.startDate.toString()} to ${params.endDate.toString()}`);

    return {
      id: reportId,
      status: 'pending',
      url: `https://dashboard.stripe.com/tax/reports/${reportId}`,
    };
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; details?: string }> {
    try {
      // Simple health check - list recent events
      await this.stripe.events.list({ limit: 1 });
      return { status: 'healthy' };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // Stripe-specific helper methods
  private mapBillingIntervalToStripe(interval: BillingInterval): Stripe.PriceCreateParams.Recurring.Interval {
    switch (interval) {
      case 'daily': {
        return 'day';
      }
      case 'weekly': {
        return 'week';
      }
      case 'monthly': {
        return 'month';
      }
      case 'yearly': {
        return 'year';
      }
      default: {
        return 'month';
      }
    }
  }

  private mapStripeIntervalToBilling(interval: Stripe.Price.Recurring.Interval): BillingInterval {
    switch (interval) {
      case 'day': {
        return 'daily';
      }
      case 'week': {
        return 'weekly';
      }
      case 'month': {
        return 'monthly';
      }
      case 'year': {
        return 'yearly';
      }
      default: {
        throw new PaymentProviderError('unknown', `Stripe billing interval ${interval} is not supported`);
      }
    }
  }

  private mapStripeEventType(stripeEventType: string): string {
    return mapStripeEventType(stripeEventType) ?? stripeEventType;
  }

  private mapRefundReasonToStripe(reason?: string): Stripe.RefundCreateParams.Reason | undefined {
    if (!reason) return undefined;

    const reasonMap: Record<string, Stripe.RefundCreateParams.Reason> = {
      'customer_request': 'requested_by_customer',
      'duplicate_charge': 'duplicate',
      'fraudulent_transaction': 'fraudulent',
      'service_not_delivered': 'requested_by_customer',
      'billing_error': 'requested_by_customer',
      'technical_issue': 'requested_by_customer',
      'goodwill_gesture': 'requested_by_customer',
      'chargeback_prevention': 'requested_by_customer',
      'other': 'requested_by_customer',
    };

    return reasonMap[reason] || 'requested_by_customer';
  }
}
