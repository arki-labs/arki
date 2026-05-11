import { createInsertSchema, createSelectSchema, z } from '@arki/contracts';

import type { CoreTables } from './tables';

/**
 * Factory for the Drizzle-table-derived Zod schemas. The host app calls this
 * with its `createCoreTables(...)` output so we can wire `createSelectSchema`
 * / `createInsertSchema` to the concrete table objects.
 *
 * Pure schemas (enums, input shapes, query schemas) live alongside in
 * `./contracts` and are imported directly — only the table-coupled ones are
 * factoried.
 */
export function createCoreDerivedSchemas({
  plans,
  customers,
  subscriptions,
  payments,
  webhookEvents,
}: Pick<CoreTables, 'plans' | 'customers' | 'subscriptions' | 'payments' | 'webhookEvents'>) {
  const planSelectSchema = createSelectSchema(plans);
  const planInsertSchema = createInsertSchema(plans, {
    price: z.number().positive().max(999_999.99),
    currency: z.string().length(3).toUpperCase(),
    intervalCount: z.number().positive().max(365),
    features: z.array(z.string()).default([]),
    trialPeriodDays: z.number().positive().max(365).optional(),
  });
  const planUpdateSchema = planInsertSchema.partial().omit({ id: true });

  const customerSelectSchema = createSelectSchema(customers);
  const customerInsertSchema = createInsertSchema(customers, {
    email: z.email(),
    name: z.string().min(1).max(255).optional(),
  });
  const customerUpdateSchema = customerInsertSchema.partial().omit({ id: true, userId: true });

  const subscriptionSelectSchema = createSelectSchema(subscriptions);
  const subscriptionInsertSchema = createInsertSchema(subscriptions, {
    currentPeriodStart: z.date(),
    currentPeriodEnd: z.date(),
    trialStart: z.date().optional(),
    trialEnd: z.date().optional(),
    canceledAt: z.date().optional(),
  });
  const subscriptionUpdateSchema = subscriptionInsertSchema.partial().omit({ id: true, userId: true });

  const paymentSelectSchema = createSelectSchema(payments);
  const paymentInsertSchema = createInsertSchema(payments, {
    amount: z.number().positive().max(999_999.99),
    currency: z.string().length(3).toUpperCase(),
    description: z.string().max(500).optional(),
    failureReason: z.string().max(1000).optional(),
    receiptUrl: z.url().optional(),
    refundedAmount: z.number().min(0).max(999_999.99).default(0),
  });
  const paymentUpdateSchema = paymentInsertSchema.partial().omit({ id: true, userId: true });

  const webhookEventSelectSchema = createSelectSchema(webhookEvents);
  const webhookEventInsertSchema = createInsertSchema(webhookEvents, {
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
    subscription: subscriptionResponseSchema.optional(),
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

export type CoreDerivedSchemas = ReturnType<typeof createCoreDerivedSchemas>;
