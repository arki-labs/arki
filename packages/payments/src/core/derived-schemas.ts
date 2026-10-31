import { z } from '@arki/contracts';
import { createInsertSchema, createSelectSchema } from '@arki/contracts/drizzle';
import { instantSchema } from '@arki/date/zod';

import type { CoreTables } from './tables.js';
import {
  billingIntervalSchema,
  paymentMethodTypeSchema,
  paymentStatusSchema,
  planTierSchema,
  subscriptionStatusSchema,
} from './contracts.js';
import {
  customerIdSchema,
  paymentIdSchema,
  planIdSchema,
  subscriptionIdSchema,
  webhookIdSchema,
} from './primitives.js';
import { userIdSchema } from './user-id.js';

/** Builds the schemas. `createCoreDerivedSchemas` returns them under the name declared below. */
function buildCoreDerivedSchemas({
  plans,
  customers,
  subscriptions,
  payments,
  webhookEvents,
}: Pick<CoreTables, 'plans' | 'customers' | 'subscriptions' | 'payments' | 'webhookEvents'>) {
  const timestamps = {
    createdAt: () => instantSchema(),
    updatedAt: () => instantSchema(),
  };
  const planFields = {
    ...timestamps,
    id: () => planIdSchema,
    features: () => z.array(z.string()),
    interval: () => billingIntervalSchema,
    tier: () => planTierSchema,
  };
  const customerFields = {
    ...timestamps,
    id: () => customerIdSchema,
    userId: () => userIdSchema,
  };
  const subscriptionFields = {
    ...timestamps,
    id: () => subscriptionIdSchema,
    userId: () => userIdSchema,
    planId: () => planIdSchema,
    customerId: () => customerIdSchema,
    status: () => subscriptionStatusSchema,
    currentPeriodStart: () => instantSchema(),
    currentPeriodEnd: () => instantSchema(),
    trialStart: () => instantSchema(),
    trialEnd: () => instantSchema(),
    canceledAt: () => instantSchema(),
  };
  const paymentFields = {
    ...timestamps,
    id: () => paymentIdSchema,
    subscriptionId: () => subscriptionIdSchema,
    status: () => paymentStatusSchema,
    paymentMethod: () => paymentMethodTypeSchema,
    userId: () => userIdSchema,
    customerId: () => customerIdSchema,
  };
  const webhookFields = {
    ...timestamps,
    id: () => webhookIdSchema,
    processedAt: () => instantSchema(),
    lastAttemptAt: () => instantSchema(),
  };

  const planSelectSchema = createSelectSchema(plans, planFields);
  const planInsertSchema = createInsertSchema(plans, {
    ...planFields,
    // Whole minor units, at most Stripe's 8 digits (99,999,999), as in `core/money.ts`
    priceMinor: z.number().int().positive().max(99_999_999),
    currency: z.string().length(3).toUpperCase(),
    intervalCount: z.number().positive().max(365),
    features: z.array(z.string()).default([]),
    trialPeriodDays: z.number().positive().max(365).optional(),
  });
  const planUpdateSchema = planInsertSchema.partial().omit({ id: true });

  const customerSelectSchema = createSelectSchema(customers, customerFields);
  const customerInsertSchema = createInsertSchema(customers, {
    ...customerFields,
    email: z.email(),
    name: z.string().min(1).max(255).optional(),
  });
  const customerUpdateSchema = customerInsertSchema.partial().omit({ id: true, userId: true });

  // `version` belongs to the journal: it is not part of what the API reads or writes
  const subscriptionSelectSchema = createSelectSchema(subscriptions, subscriptionFields).omit({ version: true });
  const subscriptionInsertSchema = createInsertSchema(subscriptions, {
    ...subscriptionFields,
    currentPeriodStart: instantSchema(),
    currentPeriodEnd: instantSchema(),
    trialStart: instantSchema().optional(),
    trialEnd: instantSchema().optional(),
    canceledAt: instantSchema().optional(),
  }).omit({ version: true });
  const subscriptionUpdateSchema = subscriptionInsertSchema.partial().omit({ id: true, userId: true });

  const paymentSelectSchema = createSelectSchema(payments, paymentFields).omit({ version: true });
  const paymentInsertSchema = createInsertSchema(payments, {
    ...paymentFields,
    amountMinor: z.number().int().positive().max(99_999_999),
    currency: z.string().length(3).toUpperCase(),
    description: z.string().max(500).optional(),
    failureReason: z.string().max(1000).optional(),
    receiptUrl: z.url().optional(),
    refundedAmountMinor: z.number().int().min(0).max(99_999_999).default(0),
  }).omit({ version: true });
  const paymentUpdateSchema = paymentInsertSchema.partial().omit({ id: true, userId: true });

  const webhookEventSelectSchema = createSelectSchema(webhookEvents, webhookFields);
  const webhookEventInsertSchema = createInsertSchema(webhookEvents, {
    ...webhookFields,
    providerEventId: z.string().min(1).max(255),
    data: z.record(z.string(), z.unknown()),
    attempts: z.number().min(0).default(0),
    errorMessage: z.string().max(2000).optional(),
    sourceIp: z
      .string()
      .regex(
        /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d{1,2})$|^(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}$/i,
        'Invalid IP address',
      )
      .optional(),
  });
  const webhookEventUpdateSchema = webhookEventInsertSchema.partial().omit({ id: true });

  const planResponseSchema = planSelectSchema;
  const customerResponseSchema = customerSelectSchema;
  const subscriptionResponseSchema = subscriptionSelectSchema.extend({
    plan: planResponseSchema.optional(),
    customer: customerResponseSchema.optional(),
  });
  const paymentResponseSchema = paymentSelectSchema.extend({
    /** Null for a one-off payment: it belongs to no subscription. */
    subscription: subscriptionResponseSchema.nullish(),
    customer: customerResponseSchema.optional(),
  });

  const subscriptionAccessResponseSchema = z.object({
    hasAccess: z.boolean(),
    subscription: subscriptionResponseSchema.optional().nullable(),
    reason: z.string().optional(),
  });

  return {
    planSelectSchema,
    planInsertSchema,
    planUpdateSchema,
    customerSelectSchema,
    customerInsertSchema,
    customerUpdateSchema,
    subscriptionSelectSchema,
    subscriptionInsertSchema,
    subscriptionUpdateSchema,
    paymentSelectSchema,
    paymentInsertSchema,
    paymentUpdateSchema,
    webhookEventSelectSchema,
    webhookEventInsertSchema,
    webhookEventUpdateSchema,
    planResponseSchema,
    customerResponseSchema,
    subscriptionResponseSchema,
    paymentResponseSchema,
    subscriptionAccessResponseSchema,
  };
}

// A name for the schemas, so declaration files, docs and editor hovers say `CoreDerivedSchemas` instead
// of twenty expanded Zod object types. The types are still built by `buildCoreDerivedSchemas` above.
type BuiltCoreDerivedSchemas = ReturnType<typeof buildCoreDerivedSchemas>;

/** What `createCoreDerivedSchemas` returns: the select, insert, update and response schemas of the core tables. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions
export interface CoreDerivedSchemas extends BuiltCoreDerivedSchemas {}

/**
 * Factory for the Drizzle-table-derived Zod schemas. The host app calls this
 * with its `createCoreTables(...)` output so we can wire `createSelectSchema`
 * / `createInsertSchema` to the concrete table objects.
 *
 * Pure schemas (enums, input shapes, query schemas) live alongside in
 * `./contracts` and are imported directly — only the table-coupled ones are
 * factoried.
 */
export function createCoreDerivedSchemas(
  tables: Pick<CoreTables, 'plans' | 'customers' | 'subscriptions' | 'payments' | 'webhookEvents'>,
): CoreDerivedSchemas {
  return buildCoreDerivedSchemas(tables);
}
