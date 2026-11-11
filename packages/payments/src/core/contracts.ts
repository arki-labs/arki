import { userIdSchema } from './user-id.js';
import { z } from '@arki/contracts';
import { instantSchema } from '@arki/date/zod';

import { INT4_MAX, MAX_BATCH_ITEMS, holdsLoneSurrogate, pgInstantSchema, pgJsonRecordSchema, pgTextSchema, pgVarcharSchema } from './pg-values.js';

import { refundIdSchema } from '../refunds/primitives.js';
import { moneyJsonSchema, positiveMoneySchema, priceSchema } from './money.js';
import {
  billingIntervalValues,
  customerIdSchema,
  paymentIdSchema,
  paymentMethodTypeValues,
  paymentProviderValues,
  paymentStatusValues,
  planIdSchema,
  planTierValues,
  subscriptionIdSchema,
  subscriptionStatusValues,
  webhookEventTypeValues,
  webhookIdSchema,
} from './primitives.js';

// Base enum schemas
export const paymentProviderSchema = z.enum(paymentProviderValues);
export const subscriptionStatusSchema = z.enum(subscriptionStatusValues);
export const paymentStatusSchema = z.enum(paymentStatusValues);
export const billingIntervalSchema = z.enum(billingIntervalValues);
export const planTierSchema = z.enum(planTierValues);
export const paymentMethodTypeSchema = z.enum(paymentMethodTypeValues);
export const webhookEventTypeSchema = z.enum(webhookEventTypeValues);

// API input schemas
export const createPlanInputSchema = z.object({
  name: pgVarcharSchema(255).min(1),
  description: pgTextSchema.max(1000).optional(),
  tier: planTierSchema,
  /** A free plan costs zero */
  price: priceSchema,
  interval: billingIntervalSchema,
  intervalCount: z.number().int().positive().max(365).default(1),
  /** Stored in a jsonb column: no U+0000 and no lone surrogate in a feature */
  features: z
    .array(pgTextSchema)
    .max(MAX_BATCH_ITEMS)
    .refine(features => !holdsLoneSurrogate(features), 'A feature cannot contain a lone surrogate (such as U+D800 alone)')
    .default([]),
  trialPeriodDays: z.number().int().positive().max(365).optional(),
  metadata: pgJsonRecordSchema.optional(),
});

export const updatePlanInputSchema = createPlanInputSchema.partial().omit({ tier: true });

export const createCustomerInputSchema = z.object({
  userId: userIdSchema,
  email: z.email().max(255),
  name: pgVarcharSchema(255).min(1).optional(),
  metadata: pgJsonRecordSchema.optional(),
});

export const updateCustomerInputSchema = createCustomerInputSchema.partial().omit({ userId: true }).extend({
  defaultPaymentMethodId: pgVarcharSchema(255).optional(),
});

const customerDetailsSchema = z
  .object({
    address: z
      .object({
        line1: z.string().optional(),
        line2: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string().optional(),
      })
      .optional(),
    taxIds: z
      .array(
        z.object({
          type: z.string(),
          value: z.string(),
        }),
      )
      .max(MAX_BATCH_ITEMS)
      .optional(),
  })
  .optional();

export const createSubscriptionInputSchema = z.object({
  userId: userIdSchema,
  planId: planIdSchema,
  paymentMethodId: z.string().optional(),
  trialPeriodDays: z.number().int().positive().max(365).optional(),
  metadata: pgJsonRecordSchema.optional(),
  customerDetails: customerDetailsSchema,
});

export const updateSubscriptionInputSchema = z
  .object({
    planId: planIdSchema.optional(),
    paymentMethodId: z.string().optional(),
    metadata: pgJsonRecordSchema.optional(),
    cancelAtPeriodEnd: z.boolean().optional(),
  })
  .refine(data => data.planId !== undefined || data.cancelAtPeriodEnd !== undefined, {
    message: 'Give a planId, a cancelAtPeriodEnd, or both',
  });

export const cancelSubscriptionInputSchema = z.object({
  immediately: z.boolean().default(false),
  reason: z.string().max(500).optional(),
  provideFeedback: z.boolean().default(false),
});

export const createPaymentInputSchema = z.object({
  subscriptionId: subscriptionIdSchema.optional(),
  userId: userIdSchema,
  amount: positiveMoneySchema,
  paymentMethodId: z.string().min(1),
  description: pgTextSchema.max(500).optional(),
  metadata: pgJsonRecordSchema.optional(),
});

export const refundPaymentInputSchema = z.object({
  amount: positiveMoneySchema.optional(),
  reason: z.string().max(500).optional(),
  metadata: pgJsonRecordSchema.optional(),
});

export const createPaymentIntentInputSchema = z.object({
  amount: positiveMoneySchema,
  paymentMethodId: z.string().optional(),
  automatic: z.boolean().default(true),
  description: z.string().optional(),
  taxCode: z.string().optional(),
  customerDetails: customerDetailsSchema,
});

export const webhookInputSchema = z.object({
  provider: paymentProviderSchema,
  signature: z.string().min(1),
  timestamp: z.string().min(1),
  payload: z.string().min(1),
});

// Query parameter schemas
export const paginationSchema = z.object({
  /** Whole numbers: Postgres refuses a fraction in LIMIT or OFFSET (SQLSTATE 22P02). */
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(INT4_MAX).default(0),
});

export const subscriptionQuerySchema = paginationSchema.extend({
  status: subscriptionStatusSchema.optional(),
  planId: planIdSchema.optional(),
  userId: userIdSchema.optional(),
});

export const paymentQuerySchema = paginationSchema.extend({
  status: paymentStatusSchema.optional(),
  subscriptionId: subscriptionIdSchema.optional(),
  customerId: customerIdSchema.optional(),
  userId: userIdSchema.optional(),
  startDate: pgInstantSchema().optional(),
  endDate: pgInstantSchema().optional(),
});

export const planQuerySchema = paginationSchema.extend({
  tier: planTierSchema.optional(),
  interval: billingIntervalSchema.optional(),
  isActive: z.boolean().optional(),
});

export const customerQuerySchema = paginationSchema.extend({
  provider: paymentProviderSchema.optional(),
  email: z.email().optional(),
});

export const webhookEventQuerySchema = paginationSchema.extend({
  provider: paymentProviderSchema.optional(),
  eventType: webhookEventTypeSchema.optional(),
  processed: z.boolean().optional(),
  startDate: pgInstantSchema().optional(),
  endDate: pgInstantSchema().optional(),
});

// Analytics schemas
export const analyticsQuerySchema = z.object({
  startDate: pgInstantSchema().optional(),
  endDate: pgInstantSchema().optional(),
  groupBy: z.enum(['day', 'week', 'month', 'year']).optional().default('month'),
  metrics: z
    .array(z.enum(['revenue', 'subscriptions', 'churn', 'mrr', 'arr']))
    .max(MAX_BATCH_ITEMS)
    .optional()
    .default(['revenue', 'subscriptions']),
});

export const subscriptionAnalyticsSchema = analyticsQuerySchema.extend({
  tier: planTierSchema.optional(),
  status: subscriptionStatusSchema.optional(),
});

export const paymentAnalyticsSchema = analyticsQuerySchema.extend({
  status: paymentStatusSchema.optional(),
  paymentMethod: paymentMethodTypeSchema.optional(),
});

// Response schemas that don't depend on table-derived schemas
export const subscriptionPreviewSchema = z.object({
  planId: planIdSchema,
  proration: z.object({
    immediateTotal: moneyJsonSchema,
    nextInvoiceTotal: moneyJsonSchema,
    creditApplied: moneyJsonSchema,
  }),
  trialEnd: instantSchema().optional(),
  nextBillingDate: instantSchema(),
});

export const subscriptionAnalyticsResponseSchema = z.object({
  totalSubscriptions: z.number(),
  activeSubscriptions: z.number(),
  churnRate: z.number(),
  averageRevenuePerUser: z.number(),
  monthlyRecurringRevenue: z.number(),
  annualRecurringRevenue: z.number(),
  subscriptionsByTier: z.record(z.string(), z.number()),
  subscriptionsByStatus: z.record(subscriptionStatusSchema, z.number()),
});

export const paymentMethodInfoSchema = z.object({
  id: z.string(),
  type: paymentMethodTypeSchema,
  brand: z.string().optional(),
  last4: z.string().optional(),
  expiryMonth: z.number().optional(),
  expiryYear: z.number().optional(),
  isDefault: z.boolean(),
});

export const setupIntentResponseSchema = z.object({
  clientSecret: z.string(),
  setupIntentId: z.string(),
});

export const paymentIntentResponseSchema = z.object({
  clientSecret: z.string(),
  paymentIntentId: z.string(),
});

/**
 * What a webhook route answers with a 2xx. `processed`: the event ran now. `queued`: it runs after the
 * answer (`enableAsync`). `duplicate`: it already ran. `ignored`: an event type the handler does not
 * handle. `refused`: a webhook failure whose `retryable` is false, by its `code`; the provider stops resending.
 * A retryable outcome is never a 2xx: the route answers non-2xx, so the provider resends.
 */
export const webhookProcessingResultSchema = z.object({
  status: z.enum(['processed', 'queued', 'duplicate', 'ignored', 'refused']),
  webhookId: webhookIdSchema.optional(),
  code: z.string().optional(),
});

export const healthCheckSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  details: z.string().optional(),
});

export const subscriptionAccessSchema = z.object({
  requiredTiers: z.array(planTierSchema).max(MAX_BATCH_ITEMS).optional().default([]),
});

// ============================================
// Router API Input Schemas (wrapper shapes)
// ============================================

// Plans router
export const getPlanInputSchema = z.object({
  id: planIdSchema,
});

export const updatePlanWrapperInputSchema = z.object({
  id: planIdSchema,
  data: updatePlanInputSchema,
});

export const deactivatePlanInputSchema = z.object({
  id: planIdSchema,
});

// Subscriptions router
export const subscriptionPreviewTaxInputSchema = z.object({
  planId: planIdSchema,
  customerDetails: z.object({
    address: z
      .object({
        line1: z.string().optional(),
        line2: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string().optional(),
      })
      .optional(),
    taxIds: z
      .array(
        z.object({
          type: z.string(),
          value: z.string(),
        }),
      )
      .max(MAX_BATCH_ITEMS)
      .optional(),
  }),
});

export const updateSubscriptionWrapperInputSchema = z.object({
  id: subscriptionIdSchema,
  data: updateSubscriptionInputSchema,
});

export const cancelSubscriptionWrapperInputSchema = z.object({
  id: subscriptionIdSchema,
  options: cancelSubscriptionInputSchema.optional(),
});

// Payments router
export const paymentPreviewInputSchema = z.object({
  subscriptionId: subscriptionIdSchema,
  planId: planIdSchema,
});

export const paymentPreviewTaxInputSchema = z.object({
  amount: positiveMoneySchema,
  description: z.string().optional(),
  taxCode: z.string().optional(),
  customerDetails: customerDetailsSchema,
});

// Refunds router
export const requestRefundInputSchema = z.object({
  paymentId: paymentIdSchema,
  /** In the payment's currency */
  amount: positiveMoneySchema,
  reason: z.enum([
    'customer_request',
    'duplicate_charge',
    'fraudulent_transaction',
    'service_not_delivered',
    'billing_error',
    'technical_issue',
    'goodwill_gesture',
    'chargeback_prevention',
    'other',
  ]),
  customerNote: z.string().optional(),
  internalNotes: z.string().optional(),
});

export const listRefundsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  status: z.enum(['pending', 'approved', 'processing', 'completed', 'failed', 'rejected', 'canceled']).optional(),
});

export const getRefundInputSchema = z.object({
  id: refundIdSchema,
});

export const approveRefundInputSchema = z.object({
  refundId: refundIdSchema,
  approvedBy: userIdSchema.optional(),
});

export const rejectRefundInputSchema = z.object({
  refundId: refundIdSchema,
  rejectedBy: userIdSchema.optional(),
  reason: pgTextSchema,
});

// Analytics router
export const getAnalyticsMetricsInputSchema = z.object({
  startDate: pgInstantSchema().optional(),
  endDate: pgInstantSchema().optional(),
});

// Proration router
export const prorationPreviewInputSchema = z.object({
  subscriptionId: subscriptionIdSchema,
  newPlanId: planIdSchema,
  changeDate: pgInstantSchema().optional(),
  prorationMode: z.enum(['immediate', 'next_cycle']).default('immediate'),
});

// Inferred type exports
export type CreatePlanInput = z.infer<typeof createPlanInputSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanInputSchema>;
export type CreateCustomerInput = z.infer<typeof createCustomerInputSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerInputSchema>;
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionInputSchema>;
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionInputSchema>;
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionInputSchema>;
export type CreatePaymentInput = z.infer<typeof createPaymentInputSchema>;
export type RefundPaymentInput = z.infer<typeof refundPaymentInputSchema>;
export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentInputSchema>;
export type WebhookInput = z.infer<typeof webhookInputSchema>;
export type SubscriptionQuery = z.infer<typeof subscriptionQuerySchema>;
export type PaymentQuery = z.infer<typeof paymentQuerySchema>;
export type PlanQuery = z.infer<typeof planQuerySchema>;
export type CustomerQuery = z.infer<typeof customerQuerySchema>;
export type WebhookEventQuery = z.infer<typeof webhookEventQuerySchema>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type SubscriptionAnalytics = z.infer<typeof subscriptionAnalyticsSchema>;
export type PaymentAnalytics = z.infer<typeof paymentAnalyticsSchema>;
export type SubscriptionPreview = z.infer<typeof subscriptionPreviewSchema>;
export type SubscriptionAnalyticsResponse = z.infer<typeof subscriptionAnalyticsResponseSchema>;
export type PaymentMethodInfo = z.infer<typeof paymentMethodInfoSchema>;
export type SetupIntentResponse = z.infer<typeof setupIntentResponseSchema>;
export type PaymentIntentResponse = z.infer<typeof paymentIntentResponseSchema>;
export type WebhookProcessingResult = z.infer<typeof webhookProcessingResultSchema>;
export type HealthCheck = z.infer<typeof healthCheckSchema>;
export type SubscriptionAccess = z.infer<typeof subscriptionAccessSchema>;
