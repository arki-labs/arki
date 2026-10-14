import type { PgColumn, PgSchema } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, integer, jsonb, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { userIdFactory } from './user-id.js';
import { instant } from '@arki/db/temporal';

import type {
  BillingInterval,
  PaymentMethodType,
  PaymentProviderType,
  PaymentStatus,
  PlanTier,
  SubscriptionStatus,
  WebhookEventType,
} from './primitives.js';
import {
  billingIntervalValues,
  customerIdFactory,
  paymentIdFactory,
  paymentMethodTypeValues,
  paymentProviderValues,
  paymentStatusValues,
  planIdFactory,
  planTierValues,
  subscriptionIdFactory,
  subscriptionStatusValues,
  webhookEventTypeValues,
  webhookIdFactory,
} from './primitives.js';

export type CreateCoreTablesDeps = {
  /** The app's own `pgSchema(...)` instance — namespaces every table created here. */
  schema: PgSchema;
  /** Reference to the host app's `User.id` column — used for FK constraints. */
  userIdRef: () => PgColumn;
};

export function createCoreTables({ schema, userIdRef }: CreateCoreTablesDeps) {
  const paymentProviderEnum = schema.enum('payment_provider', paymentProviderValues);
  const subscriptionStatusEnum = schema.enum('subscription_status', subscriptionStatusValues);
  const paymentStatusEnum = schema.enum('payment_status', paymentStatusValues);
  const billingIntervalEnum = schema.enum('billing_interval', billingIntervalValues);
  const planTierEnum = schema.enum('plan_tier', planTierValues);
  const paymentMethodTypeEnum = schema.enum('payment_method_type', paymentMethodTypeValues);
  const webhookEventTypeEnum = schema.enum('webhook_event_type', webhookEventTypeValues);

  const userFk = userIdFactory.createForeignKeyFactory(userIdRef);

  const plans = schema.table(
    'plans',
    {
      id: planIdFactory.primaryColumn(),
      name: varchar('name', { length: 255 }).notNull(),
      description: text('description'),
      tier: planTierEnum('tier').$type<PlanTier>().notNull().default('basic'),
      /** Whole minor units of `currency`: 1999 is 19.99 USD, 1500 is 1500 JPY. Read and write through `core/money.ts`. */
      priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
      currency: varchar('currency', { length: 3 }).notNull().default('USD'),
      interval: billingIntervalEnum('interval').$type<BillingInterval>().notNull().default('monthly'),
      intervalCount: integer('interval_count').notNull().default(1),
      features: jsonb('features').$type<string[]>().notNull().default([]),
      isActive: boolean('is_active').notNull().default(true),
      trialPeriodDays: integer('trial_period_days'),
      metadata: jsonb('metadata').$type<Record<string, unknown>>(),
      createdAt: instant('created_at').notNull().default(sql`now()`),
      updatedAt: instant('updated_at').notNull().default(sql`now()`),
    },
    (_table) => [check('plans_price_minor_not_negative', sql`"price_minor" >= 0`)],
  );

  const customers = schema.table(
    'customers',
    {
      id: customerIdFactory.primaryColumn(),
      userId: userFk.required('user_id', { onDelete: 'cascade' }),
      providerCustomerId: varchar('provider_customer_id', { length: 255 }).notNull(),
      provider: paymentProviderEnum('provider').$type<PaymentProviderType>().notNull().default('stripe'),
      email: varchar('email', { length: 255 }).notNull(),
      name: varchar('name', { length: 255 }),
      defaultPaymentMethodId: varchar('default_payment_method_id', { length: 255 }),
      metadata: jsonb('metadata').$type<Record<string, unknown>>(),
      createdAt: instant('created_at').notNull().default(sql`now()`),
      updatedAt: instant('updated_at').notNull().default(sql`now()`),
    },
    // One customer per user, and one row per provider customer. Two providers may hand out the same id,
    // so the id is only unique within its provider: the lookup by provider id reads a single row with `provider`.
    (table) => [
      uniqueIndex('customers_user_id_idx').on(table.userId),
      uniqueIndex('customers_provider_customer_id_idx').on(table.provider, table.providerCustomerId),
    ],
  );

  const subscriptions = schema.table(
    'subscriptions',
    {
      id: subscriptionIdFactory.primaryColumn(),
      userId: userFk.required('user_id', { onDelete: 'cascade' }),
      planId: planIdFactory.foreignKey('plan_id', () => plans.id, { onDelete: 'restrict' }),
      customerId: customerIdFactory.foreignKey('customer_id', () => customers.id, { onDelete: 'cascade' }),
      providerSubscriptionId: varchar('provider_subscription_id', { length: 255 }).notNull(),
      status: subscriptionStatusEnum('status').$type<SubscriptionStatus>().notNull().default('incomplete'),
      currentPeriodStart: instant('current_period_start').notNull(),
      currentPeriodEnd: instant('current_period_end').notNull(),
      trialStart: instant('trial_start'),
      trialEnd: instant('trial_end'),
      canceledAt: instant('canceled_at'),
      cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
      metadata: jsonb('metadata').$type<Record<string, unknown>>(),
      createdAt: instant('created_at').notNull().default(sql`now()`),
      updatedAt: instant('updated_at').notNull().default(sql`now()`),
      /** Set by `@arki/journal`. 0 means: this row was written before the journal. */
      version: integer('version').notNull().default(0),
    },
    (table) => [uniqueIndex('subscriptions_provider_subscription_id_idx').on(table.providerSubscriptionId)],
  );

  const payments = schema.table(
    'payments',
    {
      id: paymentIdFactory.primaryColumn(),
      subscriptionId: subscriptionIdFactory.optionalForeignKey('subscription_id', () => subscriptions.id, {
        onDelete: 'set null',
      }),
      userId: userFk.required('user_id', { onDelete: 'cascade' }),
      customerId: customerIdFactory.foreignKey('customer_id', () => customers.id, { onDelete: 'cascade' }),
      providerPaymentId: varchar('provider_payment_id', { length: 255 }).notNull(),
      /** Whole minor units of `currency`, like `plans.price_minor`. */
      amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
      currency: varchar('currency', { length: 3 }).notNull().default('USD'),
      status: paymentStatusEnum('status').$type<PaymentStatus>().notNull().default('pending'),
      paymentMethod: paymentMethodTypeEnum('payment_method').$type<PaymentMethodType>().notNull().default('card'),
      description: text('description'),
      failureReason: text('failure_reason'),
      receiptUrl: text('receipt_url'),
      refunded: boolean('refunded').notNull().default(false),
      refundedAmountMinor: bigint('refunded_amount_minor', { mode: 'number' }).notNull().default(0),
      /** The provider's dispute (chargeback) on this payment, set when the customer's bank opens one. */
      disputeId: varchar('dispute_id', { length: 255 }),
      /** The dispute's status as the provider reports it, such as `needs_response`. Null: no dispute. */
      disputeStatus: varchar('dispute_status', { length: 64 }),
      metadata: jsonb('metadata').$type<Record<string, unknown>>(),
      createdAt: instant('created_at').notNull().default(sql`now()`),
      updatedAt: instant('updated_at').notNull().default(sql`now()`),
      /** Set by `@arki/journal`. 0 means: this row was written before the journal. */
      version: integer('version').notNull().default(0),
    },
    (_table) => [
      check('payments_amount_minor_not_negative', sql`"amount_minor" >= 0`),
      check('payments_refunded_amount_minor_not_negative', sql`"refunded_amount_minor" >= 0`),
      check('payments_refunded_amount_minor_lte_amount_minor', sql`"refunded_amount_minor" <= "amount_minor"`),
    ],
  );

  const webhookEvents = schema.table(
    'webhook_events',
    {
      id: webhookIdFactory.primaryColumn(),
      provider: paymentProviderEnum('provider').$type<PaymentProviderType>().notNull(),
      eventType: webhookEventTypeEnum('event_type').$type<WebhookEventType>().notNull(),
      providerEventId: varchar('provider_event_id', { length: 255 }).notNull(),
      data: jsonb('data').$type<Record<string, unknown>>().notNull(),
      processed: boolean('processed').notNull().default(false),
      processedAt: instant('processed_at'),
      attempts: integer('attempts').notNull().default(0),
      lastAttemptAt: instant('last_attempt_at'),
      errorMessage: text('error_message'),
      sourceIp: varchar('source_ip', { length: 45 }),
      createdAt: instant('created_at').notNull().default(sql`now()`),
      updatedAt: instant('updated_at').notNull().default(sql`now()`),
    },
    (table) => [uniqueIndex('webhook_events_provider_event_id_idx').on(table.providerEventId)],
  );

  const planForeignKeys = planIdFactory.createForeignKeyFactory(() => plans.id);
  const subscriptionForeignKeys = subscriptionIdFactory.createForeignKeyFactory(() => subscriptions.id);
  const paymentForeignKeys = paymentIdFactory.createForeignKeyFactory(() => payments.id);
  const customerForeignKeys = customerIdFactory.createForeignKeyFactory(() => customers.id);

  return {
    enums: {
      paymentProviderEnum,
      subscriptionStatusEnum,
      paymentStatusEnum,
      billingIntervalEnum,
      planTierEnum,
      paymentMethodTypeEnum,
      webhookEventTypeEnum,
    },
    plans,
    customers,
    subscriptions,
    payments,
    webhookEvents,
    foreignKeys: {
      planForeignKeys,
      subscriptionForeignKeys,
      paymentForeignKeys,
      customerForeignKeys,
    },
  };
}

export type CoreTables = ReturnType<typeof createCoreTables>;
