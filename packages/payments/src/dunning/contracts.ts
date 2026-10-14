import { userIdSchema } from '../core/user-id.js';
import { z } from '@arki/contracts';
import { instantSchema } from '@arki/date/zod';

import type { SpendRange } from './types.js';
import { nonNegativeMoneySchema } from '../core/money.js';
import { customerIdSchema } from '../core/primitives.js';
import {
  communicationChannelValues,
  communicationStatusValues,
  customerSegmentIdSchema,
  customerSegmentTypeValues,
  dunningCampaignIdSchema,
  dunningCampaignStatusValues,
  dunningCampaignTypeValues,
  dunningCommunicationIdSchema,
  dunningExecutionIdSchema,
  executionStatusValues,
  riskCategoryValues,
} from './primitives.js';

// Base validation schemas for enums

/**
 * Money spent, `{ min?, max? }` as `{ amount, currency }` in one currency.
 * Kept as JSON because segment criteria are stored in a jsonb column.
 */
const spendRangeSchema = z
  .object({ min: nonNegativeMoneySchema.optional(), max: nonNegativeMoneySchema.optional() })
  .refine(
    ({ min, max }) => min === undefined || max === undefined || min.currency.code === max.currency.code,
    'min and max must use the same currency',
  )
  .transform(({ min, max }): SpendRange => ({
    ...(min === undefined ? {} : { min: min.toJSON() }),
    ...(max === undefined ? {} : { max: max.toJSON() }),
  }));

export const dunningCampaignTypeSchema = z.enum(dunningCampaignTypeValues);

export const dunningCampaignStatusSchema = z.enum(dunningCampaignStatusValues);

export const communicationChannelSchema = z.enum(communicationChannelValues);

export const communicationStatusSchema = z.enum(communicationStatusValues);

export const executionStatusSchema = z.enum(executionStatusValues);

export const customerSegmentTypeSchema = z.enum(customerSegmentTypeValues);

export const riskCategorySchema = z.enum(riskCategoryValues);

// Complex object schemas
export const campaignTriggerSchema = z.object({
  type: z.enum(['payment_failure', 'subscription_status', 'time_based', 'manual']),
  conditions: z.object({
    paymentFailureCount: z.number().int().min(1).optional(),
    subscriptionStatus: z.array(z.string()).optional(),
    daysSinceLastPayment: z.number().int().min(0).optional(),
    daysSinceFailure: z.number().int().min(0).optional(),
    trialEndingDays: z.number().int().min(0).optional(),
    renewalReminderDays: z.number().int().min(0).optional(),
  }),
  filters: z
    .object({
      customerSegments: z.array(customerSegmentIdSchema).optional(),
      planTiers: z.array(z.string()).optional(),
      subscriptionAge: z
        .object({
          min: z.number().int().min(0).optional(),
          max: z.number().int().min(0).optional(),
        })
        .optional(),
      totalSpent: spendRangeSchema.optional(),
    })
    .optional(),
});

export const campaignSettingsSchema = z.object({
  enabled: z.boolean(),
  priority: z.number().int().min(1).max(10),
  cooldownPeriod: z.number().int().min(0), // hours
  maxExecutionsPerCustomer: z.number().int().min(1),
  stopOnPaymentSuccess: z.boolean(),
  respectUnsubscribe: z.boolean(),
  businessHoursOnly: z.boolean(),
  timezone: z.string().optional(),
  allowedDays: z.array(z.number().int().min(0).max(6)).optional(), // 0-6 for days of week
  abTestVariant: z.string().optional(),
});

export const communicationTemplateSchema = z.object({
  channel: communicationChannelSchema,
  subject: z.string().min(1).max(500).optional(),
  content: z.string().min(1),
  variables: z.array(z.string()),
  design: z
    .object({
      theme: z.string().optional(),
      brandColors: z.record(z.string(), z.string()).optional(),
      logoUrl: z.url().optional(),
    })
    .optional(),
});

export const segmentCriteriaSchema = z.object({
  totalSpent: spendRangeSchema.optional(),
  subscriptionDuration: z
    .object({
      min: z.number().int().min(0).optional(), // months
      max: z.number().int().min(0).optional(),
    })
    .optional(),
  paymentFailureHistory: z
    .object({
      count: z.number().int().min(0),
      timeframe: z.number().int().min(1), // days
    })
    .optional(),
  planTier: z.array(z.string()).optional(),
  lastPaymentDate: z
    .object({
      daysAgo: z.number().int().min(0),
    })
    .optional(),
  lifetimeValue: z
    .object({
      min: z.number().min(0).optional(),
      max: z.number().min(0).optional(),
    })
    .optional(),
  churnRisk: z.enum(['low', 'medium', 'high']).optional(),
  engagementScore: z
    .object({
      min: z.number().min(0).max(100).optional(),
      max: z.number().min(0).max(100).optional(),
    })
    .optional(),
  customAttributes: z.record(z.string(), z.unknown()).optional(),
});

export const riskScoreSchema = z.object({
  overall: z.number().min(0).max(100),
  factors: z.record(z.string(), z.number()),
  category: riskCategorySchema,
  lastCalculated: instantSchema(),
  trends: z.object({
    direction: z.enum(['improving', 'stable', 'declining']),
    changePercent: z.number(),
    timeframe: z.number().int().min(1), // days
  }),
});

// Input validation schemas for API operations
/** One step of a campaign, as create and update accept it. */
export const dunningCampaignTemplateInputSchema = z.object({
  name: z.string().min(1).max(255),
  stepNumber: z.number().int().min(1),
  delayHours: z.number().int().min(0),
  communication: communicationTemplateSchema,
});

/** The full set of steps of a campaign. Step numbers are unique: update matches steps by number. */
export const dunningCampaignTemplatesSchema = z
  .array(dunningCampaignTemplateInputSchema)
  .min(1)
  .refine(templates => new Set(templates.map(template => template.stepNumber)).size === templates.length, {
    message: 'Template step numbers must be unique',
  });

export const createDunningCampaignInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  type: dunningCampaignTypeSchema,
  trigger: campaignTriggerSchema,
  settings: campaignSettingsSchema,
  targetSegments: z.array(customerSegmentIdSchema).default([]),
  templates: dunningCampaignTemplatesSchema,
});

export const updateDunningCampaignInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  type: dunningCampaignTypeSchema.optional(),
  status: dunningCampaignStatusSchema.optional(),
  trigger: campaignTriggerSchema.optional(),
  settings: campaignSettingsSchema.optional(),
  targetSegments: z.array(customerSegmentIdSchema).optional(),
  /** When given, the campaign's steps become exactly this set (see `DunningCampaignService.updateCampaign`). */
  templates: dunningCampaignTemplatesSchema.optional(),
});

export const createDunningTemplateInputSchema = z.object({
  campaignId: dunningCampaignIdSchema,
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  stepNumber: z.number().int().min(1),
  delayHours: z.number().int().min(0),
  communication: communicationTemplateSchema,
  abTestVariant: z.string().max(50).optional(),
});

export const updateDunningTemplateInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  stepNumber: z.number().int().min(1).optional(),
  delayHours: z.number().int().min(0).optional(),
  communication: communicationTemplateSchema.optional(),
  isActive: z.boolean().optional(),
  abTestVariant: z.string().max(50).optional(),
});

export const createCustomerSegmentInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  type: customerSegmentTypeSchema,
  criteria: segmentCriteriaSchema,
  autoUpdate: z.boolean().default(true),
  updateFrequency: z.number().int().min(1).default(24), // hours
});

export const updateCustomerSegmentInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  type: customerSegmentTypeSchema.optional(),
  criteria: segmentCriteriaSchema.optional(),
  isActive: z.boolean().optional(),
  autoUpdate: z.boolean().optional(),
  updateFrequency: z.number().int().min(1).optional(),
});

export const executeCampaignInputSchema = z.object({
  campaignId: dunningCampaignIdSchema,
  dryRun: z.boolean().default(false),
  customFilters: z
    .object({
      customerIds: z.array(customerIdSchema).optional(),
      excludeCustomerIds: z.array(customerIdSchema).optional(),
      testMode: z.boolean().default(false),
    })
    .optional(),
});

export const campaignAnalyticsInputSchema = z.object({
  campaignId: dunningCampaignIdSchema.optional(),
  period: z.object({
    start: instantSchema(),
    end: instantSchema(),
  }),
  granularity: z.enum(['hour', 'day', 'week', 'month']).default('day'),
  metrics: z.array(z.string()).optional(),
});

export const updateExecutionStatusInputSchema = z.object({
  executionId: dunningExecutionIdSchema,
  status: executionStatusSchema,
  errorMessage: z.string().optional(),
  result: z
    .object({
      customersProcessed: z.number().int().min(0),
      communicationsSent: z.number().int().min(0),
      errors: z.array(
        z.object({
          customerId: customerIdSchema,
          error: z.string(),
          timestamp: instantSchema(),
        }),
      ),
      performance: z.object({
        processingTime: z.number().min(0), // milliseconds
        successRate: z.number().min(0).max(1),
      }),
    })
    .optional(),
});

export const updateCommunicationStatusInputSchema = z.object({
  communicationId: dunningCommunicationIdSchema,
  status: communicationStatusSchema,
  sentAt: instantSchema().optional(),
  deliveredAt: instantSchema().optional(),
  openedAt: instantSchema().optional(),
  clickedAt: instantSchema().optional(),
  failureReason: z.string().optional(),
  providerMessageId: z.string().optional(),
  providerResponse: z.record(z.string(), z.unknown()).optional(),
  trackingData: z.record(z.string(), z.unknown()).optional(),
});

export const communicationWebhookSchema = z.object({
  communicationId: dunningCommunicationIdSchema,
  event: z.enum(['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained']),
  timestamp: instantSchema(),
  providerData: z.record(z.string(), z.unknown()).optional(),
});

export const bulkExecuteCampaignInputSchema = z.object({
  campaignIds: z.array(dunningCampaignIdSchema).min(1),
  dryRun: z.boolean().default(false),
  customFilters: z
    .object({
      customerIds: z.array(customerIdSchema).optional(),
      excludeCustomerIds: z.array(customerIdSchema).optional(),
      testMode: z.boolean().default(false),
    })
    .optional(),
});

export const customerRiskProfileInputSchema = z.object({
  customerId: customerIdSchema,
  segmentIds: z.array(customerSegmentIdSchema).default([]),
  paymentHistory: z.object({
    totalPayments: z.number().int().min(0),
    successfulPayments: z.number().int().min(0),
    failedPayments: z.number().int().min(0),
    averageAmount: z.number().min(0),
    currency: z.string().optional(),
    lastPaymentDate: instantSchema().optional(),
    streakDays: z.number().int().min(0),
  }),
  subscriptionHistory: z.object({
    totalSubscriptions: z.number().int().min(0),
    activeSubscriptions: z.number().int().min(0),
    canceledSubscriptions: z.number().int().min(0),
    averageDuration: z.number().min(0), // months
    currentStatus: z.string().optional(),
  }),
  engagementMetrics: z.object({
    score: z.number().min(0).max(100),
    lastActivity: instantSchema().optional(),
    activityFrequency: z.number().min(0), // activities per week
    featureUsage: z.record(z.string(), z.number()),
  }),
  communicationPreferences: z.object({
    preferredChannel: communicationChannelSchema.optional(),
    unsubscribed: z.boolean(),
    unsubscribedChannels: z.array(communicationChannelSchema),
    timezone: z.string().optional(),
    language: z.string().optional(),
  }),
});

// Query parameter schemas
export const listDunningCampaignsQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  type: dunningCampaignTypeSchema.optional(),
  status: dunningCampaignStatusSchema.optional(),
  search: z.string().optional(),
  sortBy: z.enum(['name', 'type', 'status', 'createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const listCustomerSegmentsQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  type: customerSegmentTypeSchema.optional(),
  isActive: z.boolean().optional(),
  search: z.string().optional(),
  sortBy: z.enum(['name', 'type', 'customerCount', 'createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const listExecutionsQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  campaignId: dunningCampaignIdSchema.optional(),
  customerId: customerIdSchema.optional(),
  status: executionStatusSchema.optional(),
  scheduledAfter: instantSchema().optional(),
  scheduledBefore: instantSchema().optional(),
  sortBy: z.enum(['scheduledAt', 'startedAt', 'completedAt', 'createdAt']).default('scheduledAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const listCommunicationsQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  executionId: dunningExecutionIdSchema.optional(),
  customerId: customerIdSchema.optional(),
  channel: communicationChannelSchema.optional(),
  status: communicationStatusSchema.optional(),
  sentAfter: instantSchema().optional(),
  sentBefore: instantSchema().optional(),
  sortBy: z.enum(['sentAt', 'deliveredAt', 'createdAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// Response schemas for type safety
export const dunningCampaignResponseSchema = z.object({
  id: dunningCampaignIdSchema,
  name: z.string(),
  description: z.string().optional(),
  type: dunningCampaignTypeSchema,
  status: dunningCampaignStatusSchema,
  trigger: campaignTriggerSchema,
  settings: campaignSettingsSchema,
  targetSegments: z.array(customerSegmentIdSchema),
  createdBy: userIdSchema,
  updatedBy: userIdSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: instantSchema(),
  updatedAt: instantSchema(),
});

export const customerSegmentResponseSchema = z.object({
  id: customerSegmentIdSchema,
  name: z.string(),
  description: z.string().optional(),
  type: customerSegmentTypeSchema,
  criteria: segmentCriteriaSchema,
  isActive: z.boolean(),
  customerCount: z.number().int().optional(),
  lastCalculated: instantSchema().optional(),
  autoUpdate: z.boolean(),
  updateFrequency: z.number().int().optional(),
  createdBy: userIdSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: instantSchema(),
  updatedAt: instantSchema(),
});

// Type inference from schemas
export type CreateDunningCampaignInput = z.infer<typeof createDunningCampaignInputSchema>;
export type UpdateDunningCampaignInput = z.infer<typeof updateDunningCampaignInputSchema>;
export type CreateDunningTemplateInput = z.infer<typeof createDunningTemplateInputSchema>;
export type UpdateDunningTemplateInput = z.infer<typeof updateDunningTemplateInputSchema>;
export type CreateCustomerSegmentInput = z.infer<typeof createCustomerSegmentInputSchema>;
export type UpdateCustomerSegmentInput = z.infer<typeof updateCustomerSegmentInputSchema>;
export type ExecuteCampaignInput = z.infer<typeof executeCampaignInputSchema>;
export type CampaignAnalyticsInput = z.infer<typeof campaignAnalyticsInputSchema>;
export type UpdateExecutionStatusInput = z.infer<typeof updateExecutionStatusInputSchema>;
export type UpdateCommunicationStatusInput = z.infer<typeof updateCommunicationStatusInputSchema>;
export type CommunicationWebhookInput = z.infer<typeof communicationWebhookSchema>;
export type BulkExecuteCampaignInput = z.infer<typeof bulkExecuteCampaignInputSchema>;
export type CustomerRiskProfileInput = z.infer<typeof customerRiskProfileInputSchema>;
export type ListDunningCampaignsQuery = z.infer<typeof listDunningCampaignsQuerySchema>;
export type ListCustomerSegmentsQuery = z.infer<typeof listCustomerSegmentsQuerySchema>;
export type ListExecutionsQuery = z.infer<typeof listExecutionsQuerySchema>;
export type ListCommunicationsQuery = z.infer<typeof listCommunicationsQuerySchema>;
export type DunningCampaignResponse = z.infer<typeof dunningCampaignResponseSchema>;
export type CustomerSegmentResponse = z.infer<typeof customerSegmentResponseSchema>;

// ============================================
// Router API Input Schemas
// ============================================

// Campaigns router
export const getCampaignInputSchema = z.object({
  id: dunningCampaignIdSchema,
});

export const updateCampaignWrapperInputSchema = z.object({
  id: dunningCampaignIdSchema,
  data: updateDunningCampaignInputSchema,
});

export const deleteCampaignInputSchema = z.object({
  id: dunningCampaignIdSchema,
});

export const updateCampaignStatusInputSchema = z.object({
  id: dunningCampaignIdSchema,
  status: z.enum(['active', 'paused', 'archived', 'draft']),
});

export const getCampaignAnalyticsInputSchema = z.object({
  campaignId: dunningCampaignIdSchema.optional(),
  days: z.number().int().min(1).max(365).default(30),
});

// Segments router
export const getSegmentInputSchema = z.object({
  id: customerSegmentIdSchema,
});

export const updateSegmentWrapperInputSchema = z.object({
  id: customerSegmentIdSchema,
  data: updateCustomerSegmentInputSchema,
});

export const deleteSegmentInputSchema = z.object({
  id: customerSegmentIdSchema,
});

export const getSegmentCustomersInputSchema = z.object({
  id: customerSegmentIdSchema,
  limit: z.number().int().min(1).max(100).default(50),
});

export const updateSegmentCustomerCountInputSchema = z.object({
  id: customerSegmentIdSchema,
});

// Risk Profiles router
export const getRiskProfileByCustomerInputSchema = z.object({
  customerId: customerIdSchema,
});

export const updateRiskProfileForCustomerInputSchema = z.object({
  customerId: customerIdSchema,
});

export const getRiskProfilesByCategoryInputSchema = z.object({
  category: z.enum(['low', 'medium', 'high', 'critical']),
  limit: z.number().int().min(1).max(100).default(50),
});

// Executions router
export const bulkUpdateExecutionsInputSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
});

export const processScheduledExecutionsInputSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
});

export const retryFailedExecutionsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
});

export const getExecutionMetricsInputSchema = z.object({
  executionId: dunningExecutionIdSchema,
});

// Communications router
export const getCommunicationInputSchema = z.object({
  id: dunningCommunicationIdSchema,
});

export const processPendingCommunicationsInputSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
});

export const retryFailedCommunicationsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
});

// Dashboard router
export const getDashboardMetricsInputSchema = z.object({
  days: z.number().int().min(1).max(365).default(30),
});

export {
  communicationChannelValues,
  communicationStatusValues,
  customerSegmentTypeValues,
  dunningCampaignStatusValues,
  dunningCampaignTypeValues,
  executionStatusValues,
  riskCategoryValues,
} from './primitives.js';
