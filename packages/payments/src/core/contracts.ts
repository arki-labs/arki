import { userIdSchema } from './user-id.js';
import { z } from '@arki/contracts';
import { instantSchema } from '@arki/date/zod';

import { refundIdSchema } from '../refunds/primitives.js';
import { moneyJsonSchema, positiveMoneySchema, priceSchema } from './money.js';
import {
  billingIntervalValues,
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
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  tier: planTierSchema,
  /** A free plan costs zero */
  price: priceSchema,
  interval: billingIntervalSchema,
  intervalCount: z.number().positive().max(365).default(1),
  features: z.array(z.string()).default([]),
  trialPeriodDays: z.number().positive().max(365).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updatePlanInputSchema = createPlanInputSchema.partial().omit({ tier: true });

export const createCustomerInputSchema = z.object({
  userId: userIdSchema,
  email: z.email(),
  name: z.string().min(1).max(255).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateCustomerInputSchema = createCustomerInputSchema.partial().omit({ userId: true }).extend({
  defaultPaymentMethodId: z.string().optional(),
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
      .optional(),
  })
  .optional();

export const createSubscriptionInputSchema = z.object({
  userId: userIdSchema,
  planId: planIdSchema,
  paymentMethodId: z.string().optional(),
  trialPeriodDays: z.number().positive().max(365).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  customerDetails: customerDetailsSchema,
});

export const updateSubscriptionInputSchema = z.object({
  planId: planIdSchema.optional(),
  paymentMethodId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  cancelAtPeriodEnd: z.boolean().optional(),
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
  description: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const refundPaymentInputSchema = z.object({
  amount: positiveMoneySchema.optional(),
  reason: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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
  limit: z.number().min(1).max(100).default(20),
  offset: z.number().min(0).default(0),
});

export const subscriptionQuerySchema = paginationSchema.extend({
  status: subscriptionStatusSchema.optional(),
  planId: planIdSchema.optional(),
  userId: userIdSchema.optional(),
});

export const paymentQuerySchema = paginationSchema.extend({
  status: paymentStatusSchema.optional(),
  subscriptionId: subscriptionIdSchema.optional(),
  userId: userIdSchema.optional(),
  startDate: instantSchema().optional(),
  endDate: instantSchema().optional(),
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
  startDate: instantSchema().optional(),
  endDate: instantSchema().optional(),
});

// Analytics schemas
export const analyticsQuerySchema = z.object({
  startDate: instantSchema().optional(),
  endDate: instantSchema().optional(),
  groupBy: z.enum(['day', 'week', 'month', 'year']).optional().default('month'),
  metrics: z
    .array(z.enum(['revenue', 'subscriptions', 'churn', 'mrr', 'arr']))
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

export const webhookProcessingResultSchema = z.object({
  success: z.boolean(),
  webhookId: webhookIdSchema.optional(),
  error: z.string().optional(),
  retryable: z.boolean().optional(),
});

export const healthCheckSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  details: z.string().optional(),
});

export const subscriptionAccessSchema = z.object({
  requiredTiers: z.array(planTierSchema).optional().default([]),
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
  limit: z.number().min(1).max(100).default(50),
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
  reason: z.string(),
});

// Analytics router
export const getAnalyticsMetricsInputSchema = z.object({
  startDate: instantSchema().optional(),
  endDate: instantSchema().optional(),
});

// Proration router
export const prorationPreviewInputSchema = z.object({
  subscriptionId: subscriptionIdSchema,
  newPlanId: planIdSchema,
  changeDate: instantSchema().optional(),
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
