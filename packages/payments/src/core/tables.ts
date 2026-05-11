import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, type PgColumn, type PgSchema, real, text, timestamp, varchar } from 'drizzle-orm/pg-core';

import type { UserId } from '@arki/auth/ids';
import { createIdFactory } from '@arki/db/id-factory';

import {
  type BillingInterval,
  billingIntervalValues,
  customerIdFactory,
  type PaymentMethodType,
  paymentIdFactory,
  paymentMethodTypeValues,
  type PaymentProviderType,
  paymentProviderValues,
  type PaymentStatus,
  paymentStatusValues,
  planIdFactory,
  type PlanTier,
  planTierValues,
  subscriptionIdFactory,
  type SubscriptionStatus,
  subscriptionStatusValues,
  type WebhookEventType,
  webhookEventTypeValues,
  webhookIdFactory,
} from './primitives';

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

  // Reconstruct the user ID factory locally so the FK columns we build here carry the
  // same `COLUMN_ZOD_SCHEMA` tag that `@arki/auth`'s userIdFactory attaches — this is
  // what makes `createInsertSchema(customers)` auto-validate `userId` as a `usr_*` brand.
  const userIdFactory = createIdFactory<'usr_', UserId>('usr_');
  const userFk = userIdFactory.createForeignKeyFactory(userIdRef);

  const plans = schema.table(
    'plans',
    {
      id: planIdFactory.primaryColumn(),
      name: varchar('name', { length: 255 }).notNull(),
      description: text('description'),
      tier: planTierEnum('tier').$type<PlanTier>().notNull().default('basic'),
      price: real('price').notNull(),
      currency: varchar('currency', { length: 3 }).notNull().default('USD'),
      interval: billingIntervalEnum('interval').$type<BillingInterval>().notNull().default('monthly'),
      intervalCount: integer('interval_count').notNull().default(1),
      features: jsonb('features').$type<string[]>().notNull().default([]),
      isActive: boolean('is_active').notNull().default(true),
      trialPeriodDays: integer('trial_period_days'),
      metadata: jsonb('metadata').$type<Record<string, unknown>>(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (_table) => [check('plans_price_positive', sql`"price" >= 0`)],
  );

  const customers = schema.table('customers', {
    id: customerIdFactory.primaryColumn(),
    userId: userFk.required('user_id', { onDelete: 'cascade' }),
    providerCustomerId: varchar('provider_customer_id', { length: 255 }).notNull(),
    provider: paymentProviderEnum('provider').$type<PaymentProviderType>().notNull().default('stripe'),
    email: varchar('email', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }),
    defaultPaymentMethodId: varchar('default_payment_method_id', { length: 255 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  });

  const subscriptions = schema.table('subscriptions', {
    id: subscriptionIdFactory.primaryColumn(),
    userId: userFk.required('user_id', { onDelete: 'cascade' }),
    planId: planIdFactory.foreignKey('plan_id', () => plans.id, { onDelete: 'restrict' }),
    customerId: customerIdFactory.foreignKey('customer_id', () => customers.id, { onDelete: 'cascade' }),
    providerSubscriptionId: varchar('provider_subscription_id', { length: 255 }).notNull(),
    status: subscriptionStatusEnum('status').$type<SubscriptionStatus>().notNull().default('incomplete'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    trialStart: timestamp('trial_start', { withTimezone: true }),
    trialEnd: timestamp('trial_end', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  });

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
      amount: real('amount').notNull(),
      currency: varchar('currency', { length: 3 }).notNull().default('USD'),
      status: paymentStatusEnum('status').$type<PaymentStatus>().notNull().default('pending'),
      paymentMethod: paymentMethodTypeEnum('payment_method').$type<PaymentMethodType>().notNull().default('card'),
      description: text('description'),
      failureReason: text('failure_reason'),
      receiptUrl: text('receipt_url'),
      refunded: boolean('refunded').notNull().default(false),
      refundedAmount: real('refunded_amount').notNull().default(0),
      metadata: jsonb('metadata').$type<Record<string, unknown>>(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (_table) => [
      check('payments_amount_positive', sql`"amount" >= 0`),
      check('payments_refunded_amount_positive', sql`"refunded_amount" >= 0`),
      check('payments_refunded_amount_lte_amount', sql`"refunded_amount" <= "amount"`),
    ],
  );

  const webhookEvents = schema.table('webhook_events', {
    id: webhookIdFactory.primaryColumn(),
    provider: paymentProviderEnum('provider').$type<PaymentProviderType>().notNull(),
    eventType: webhookEventTypeEnum('event_type').$type<WebhookEventType>().notNull(),
    providerEventId: varchar('provider_event_id', { length: 255 }).notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    processed: boolean('processed').notNull().default(false),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    sourceIp: varchar('source_ip', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  });

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
