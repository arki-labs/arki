import { z } from '@arki/contracts';
import { createInsertSchema, createSelectSchema } from '@arki/contracts/drizzle';
import { instantSchema } from '@arki/date/zod';
import { currencyCodeSchema } from '@arki/money/zod';

import type { CoreTables } from './tables.js';
import {
  billingIntervalSchema,
  paymentMethodTypeSchema,
  paymentStatusSchema,
  planTierSchema,
  subscriptionStatusSchema,
} from './contracts.js';
import {
  holdsLoneSurrogate,
  INT4_MAX,
  MAX_BATCH_ITEMS,
  pgInstantSchema,
  pgJsonRecordSchema,
  pgTextSchema,
  pgVarcharSchema,
} from './pg-values.js';
import {
  customerIdSchema,
  paymentIdSchema,
  planIdSchema,
  subscriptionIdSchema,
  webhookIdSchema,
} from './primitives.js';
import { userIdSchema } from './user-id.js';

/** An id schema for a written row: an id with U+0000 is refused, as Postgres would refuse it (SQLSTATE 22021). */
function storedId<S extends z.ZodType<string>>(schema: S) {
  return schema.refine(
    value => pgTextSchema.safeParse(value).success,
    'An id cannot contain the NUL character (U+0000)',
  );
}

const loneSurrogateMessage = 'A feature cannot contain a lone surrogate (such as U+D800 alone)';

/** A currency code as the columns store it: an ISO 4217 code, upper case, so `planPrice` and `paymentAmount` can read it back. */
const storedCurrencySchema = z.string().toUpperCase().pipe(currencyCodeSchema);

/** Builds the schemas. `createCoreDerivedSchemas` returns them under the name declared below. */
function buildCoreDerivedSchemas({
  plans,
  customers,
  subscriptions,
  payments,
  webhookEvents,
}: Pick<CoreTables, 'plans' | 'customers' | 'subscriptions' | 'payments' | 'webhookEvents'>) {
  // Select schemas read what a column holds; the insert schemas below write only what a column can hold
  const timestamps = {
    createdAt: () => instantSchema(),
    updatedAt: () => instantSchema(),
  };
  const writtenTimestamps = {
    createdAt: () => pgInstantSchema(),
    updatedAt: () => pgInstantSchema(),
  };
  const planFields = {
    ...timestamps,
    id: () => planIdSchema,
    features: () => z.array(z.string()).max(MAX_BATCH_ITEMS),
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
  // Each override is a function: drizzle then makes it optional or nullable exactly as its column is
  const planInsertSchema = createInsertSchema(plans, {
    ...planFields,
    ...writtenTimestamps,
    id: () => storedId(planIdSchema),
    name: () => pgVarcharSchema(255).min(1),
    description: () => pgTextSchema,
    // Whole minor units, zero for a free plan, at most Stripe's 8 digits (99,999,999), as in `core/money.ts`
    priceMinor: () => z.number().int().min(0).max(99_999_999),
    currency: () => storedCurrencySchema,
    intervalCount: () => z.number().int().positive().max(365),
    // No `.default`: the column's own default fills a new row, and an update schema (`.partial()`) must not reset it
    // A jsonb column: no U+0000 (22P05) and no lone surrogate (22P02) in any feature
    features: () =>
      z
        .array(pgTextSchema)
        .max(MAX_BATCH_ITEMS)
        .refine(features => !holdsLoneSurrogate(features), loneSurrogateMessage),
    trialPeriodDays: () => z.number().int().positive().max(365),
    metadata: () => pgJsonRecordSchema,
  });
  const planUpdateSchema = planInsertSchema.partial().omit({ id: true });

  const customerSelectSchema = createSelectSchema(customers, customerFields);
  const customerInsertSchema = createInsertSchema(customers, {
    ...customerFields,
    ...writtenTimestamps,
    id: () => storedId(customerIdSchema),
    providerCustomerId: () => pgVarcharSchema(255).min(1),
    email: () => z.email().max(255),
    name: () => pgVarcharSchema(255).min(1),
    defaultPaymentMethodId: () => pgVarcharSchema(255),
    metadata: () => pgJsonRecordSchema,
  });
  const customerUpdateSchema = customerInsertSchema.partial().omit({ id: true, userId: true });

  // `version` belongs to the journal: it is not part of what the API reads or writes
  const subscriptionSelectSchema = createSelectSchema(subscriptions, subscriptionFields).omit({ version: true });
  const subscriptionInsertSchema = createInsertSchema(subscriptions, {
    ...subscriptionFields,
    ...writtenTimestamps,
    id: () => storedId(subscriptionIdSchema),
    planId: () => storedId(planIdSchema),
    customerId: () => storedId(customerIdSchema),
    providerSubscriptionId: () => pgVarcharSchema(255).min(1),
    currentPeriodStart: () => pgInstantSchema(),
    currentPeriodEnd: () => pgInstantSchema(),
    trialStart: () => pgInstantSchema(),
    trialEnd: () => pgInstantSchema(),
    canceledAt: () => pgInstantSchema(),
    metadata: () => pgJsonRecordSchema,
  }).omit({ version: true });
  const subscriptionUpdateSchema = subscriptionInsertSchema.partial().omit({ id: true, userId: true });

  const paymentSelectSchema = createSelectSchema(payments, paymentFields).omit({ version: true });
  const paymentInsertSchema = createInsertSchema(payments, {
    ...paymentFields,
    ...writtenTimestamps,
    id: () => storedId(paymentIdSchema),
    subscriptionId: () => storedId(subscriptionIdSchema),
    customerId: () => storedId(customerIdSchema),
    providerPaymentId: () => pgVarcharSchema(255).min(1),
    amountMinor: () => z.number().int().positive().max(99_999_999),
    currency: () => storedCurrencySchema,
    description: () => pgTextSchema.max(500),
    failureReason: () => pgTextSchema.max(1000),
    receiptUrl: () => z.url().pipe(pgTextSchema),
    refundedAmountMinor: () => z.number().int().min(0).max(99_999_999),
    disputeId: () => pgVarcharSchema(255),
    disputeStatus: () => pgVarcharSchema(64),
    metadata: () => pgJsonRecordSchema,
  }).omit({ version: true });
  const paymentUpdateSchema = paymentInsertSchema.partial().omit({ id: true, userId: true });

  const webhookEventSelectSchema = createSelectSchema(webhookEvents, webhookFields);
  const webhookEventInsertSchema = createInsertSchema(webhookEvents, {
    ...webhookFields,
    ...writtenTimestamps,
    id: () => storedId(webhookIdSchema),
    processedAt: () => pgInstantSchema(),
    lastAttemptAt: () => pgInstantSchema(),
    providerEventId: () => pgVarcharSchema(255).min(1),
    data: () => pgJsonRecordSchema,
    attempts: () => z.number().int().min(0).max(INT4_MAX),
    errorMessage: () => pgTextSchema.max(2000),
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
