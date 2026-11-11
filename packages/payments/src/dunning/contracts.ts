import { userIdSchema } from '../core/user-id.js';
import { z } from '@arki/contracts';
import { instantSchema } from '@arki/date/zod';

import type { SpendRange } from './types.js';
import { nonNegativeMoneySchema } from '../core/money.js';
import {
  INT4_MAX,
  MAX_BATCH_ITEMS,
  pgInstantSchema,
  pgJsonRecordSchema as jsonRecord,
  pgTextSchema as pgText,
  pgVarcharSchema,
} from '../core/pg-values.js';
import { customerIdSchema, planTierValues, subscriptionStatusValues } from '../core/primitives.js';
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

/** The user a dunning write is attributed to (`created_by`, `updated_by`): a `usr_` id Postgres can store. */
export const dunningActorSchema = pgText.pipe(userIdSchema);

/**
 * The longest span a dunning setting may name, 100 years, in days and in hours. The services turn these
 * spans into dates (a cutoff, a schedule); a longer span leaves the range of dates `@arki/date` and
 * Postgres can hold, so the contract refuses it as `schema.invalid_input`.
 */
export const MAX_DUNNING_DAYS = 36_500;
export const MAX_DUNNING_HOURS = MAX_DUNNING_DAYS * 24;
const MAX_DUNNING_MONTHS = 1200;

/** A span in days a dunning setting names: a whole number from `min` up to 100 years. */
const daysSchema = (min: number) => z.number().int().min(min).max(MAX_DUNNING_DAYS);

/** A step's delay in hours: a whole number up to 100 years. */
const delayHoursSchema = z.number().int().min(0).max(MAX_DUNNING_HOURS);

// Complex object schemas
export const campaignTriggerSchema = z.object({
  type: z.enum(['payment_failure', 'subscription_status', 'time_based', 'manual']),
  conditions: z.object({
    // Compared with a failure count in SQL: at most int4, as a count Postgres holds
    paymentFailureCount: z.number().int().min(1).max(INT4_MAX).optional(),
    // Compared with the subscriptions' status enum: a status no subscription has would be a raw SQLSTATE 22P02
    subscriptionStatus: z.array(z.enum(subscriptionStatusValues)).max(MAX_BATCH_ITEMS).optional(),
    daysSinceLastPayment: daysSchema(0).optional(),
    daysSinceFailure: daysSchema(0).optional(),
    trialEndingDays: daysSchema(0).optional(),
    renewalReminderDays: daysSchema(0).optional(),
  }),
  filters: z
    .object({
      customerSegments: z.array(customerSegmentIdSchema).max(MAX_BATCH_ITEMS).optional(),
      planTiers: z.array(pgText).max(MAX_BATCH_ITEMS).optional(),
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
  cooldownPeriod: z.number().int().min(0).max(MAX_DUNNING_HOURS), // hours
  maxExecutionsPerCustomer: z.number().int().min(1),
  stopOnPaymentSuccess: z.boolean(),
  respectUnsubscribe: z.boolean(),
  businessHoursOnly: z.boolean(),
  timezone: pgText.optional(),
  allowedDays: z.array(z.number().int().min(0).max(6)).max(7).optional(), // 0-6 for days of week
  abTestVariant: pgText.optional(),
});

export const communicationTemplateSchema = z.object({
  channel: communicationChannelSchema,
  subject: pgText.min(1).max(500).optional(),
  content: pgText.min(1),
  variables: z.array(pgText).max(MAX_BATCH_ITEMS),
  design: z
    .object({
      theme: pgText.optional(),
      brandColors: z.record(pgText, pgText).optional(),
      logoUrl: z.url().optional(),
    })
    .optional(),
});

export const segmentCriteriaSchema = z.object({
  totalSpent: spendRangeSchema.optional(),
  subscriptionDuration: z
    .object({
      min: z.number().int().min(0).max(MAX_DUNNING_MONTHS).optional(), // months
      max: z.number().int().min(0).max(MAX_DUNNING_MONTHS).optional(),
    })
    .optional(),
  paymentFailureHistory: z
    .object({
      count: z.number().int().min(0).max(INT4_MAX),
      timeframe: daysSchema(1), // days
    })
    .optional(),
  // Compared with the plans' tier enum: a tier no plan has would be a raw SQLSTATE 22P02
  planTier: z.array(z.enum(planTierValues)).max(MAX_BATCH_ITEMS).optional(),
  lastPaymentDate: z
    .object({
      daysAgo: daysSchema(0),
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
  customAttributes: jsonRecord.optional(),
});

export const riskScoreSchema = z.object({
  overall: z.number().min(0).max(100),
  factors: z.record(pgText, z.number()),
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
  name: pgText.min(1).max(255),
  stepNumber: z.number().int().min(1).max(INT4_MAX),
  delayHours: delayHoursSchema,
  communication: communicationTemplateSchema,
});

/**
 * The full set of steps of a campaign. Step numbers are unique: update matches steps by number. The
 * steps run one after another, so their delays together stay within 100 years too.
 */
export const dunningCampaignTemplatesSchema = z
  .array(dunningCampaignTemplateInputSchema)
  .min(1)
  .max(MAX_BATCH_ITEMS)
  .refine(templates => new Set(templates.map(template => template.stepNumber)).size === templates.length, {
    message: 'Template step numbers must be unique',
  })
  .refine(templates => templates.reduce((total, template) => total + template.delayHours, 0) <= MAX_DUNNING_HOURS, {
    message: `The step delays together cannot exceed ${MAX_DUNNING_HOURS} hours (100 years)`,
  });

export const createDunningCampaignInputSchema = z.object({
  name: pgText.min(1).max(255),
  description: pgText.max(1000).optional(),
  type: dunningCampaignTypeSchema,
  trigger: campaignTriggerSchema,
  settings: campaignSettingsSchema,
  targetSegments: z.array(customerSegmentIdSchema).max(MAX_BATCH_ITEMS).default([]),
  templates: dunningCampaignTemplatesSchema,
});

export const updateDunningCampaignInputSchema = z.object({
  name: pgText.min(1).max(255).optional(),
  description: pgText.max(1000).optional(),
  type: dunningCampaignTypeSchema.optional(),
  status: dunningCampaignStatusSchema.optional(),
  trigger: campaignTriggerSchema.optional(),
  settings: campaignSettingsSchema.optional(),
  targetSegments: z.array(customerSegmentIdSchema).max(MAX_BATCH_ITEMS).optional(),
  /** When given, the campaign's steps become exactly this set (see `DunningCampaignService.updateCampaign`). */
  templates: dunningCampaignTemplatesSchema.optional(),
});

export const createDunningTemplateInputSchema = z.object({
  campaignId: dunningCampaignIdSchema,
  name: pgText.min(1).max(255),
  description: pgText.max(1000).optional(),
  stepNumber: z.number().int().min(1).max(INT4_MAX),
  delayHours: delayHoursSchema,
  communication: communicationTemplateSchema,
  abTestVariant: pgText.max(50).optional(),
});

export const updateDunningTemplateInputSchema = z.object({
  name: pgText.min(1).max(255).optional(),
  description: pgText.max(1000).optional(),
  stepNumber: z.number().int().min(1).max(INT4_MAX).optional(),
  delayHours: delayHoursSchema.optional(),
  communication: communicationTemplateSchema.optional(),
  isActive: z.boolean().optional(),
  abTestVariant: pgText.max(50).optional(),
});

export const createCustomerSegmentInputSchema = z.object({
  name: pgText.min(1).max(255),
  description: pgText.max(1000).optional(),
  type: customerSegmentTypeSchema,
  criteria: segmentCriteriaSchema,
  autoUpdate: z.boolean().default(true),
  updateFrequency: z.number().int().min(1).max(INT4_MAX).default(24), // hours
});

export const updateCustomerSegmentInputSchema = z.object({
  name: pgText.min(1).max(255).optional(),
  description: pgText.max(1000).optional(),
  type: customerSegmentTypeSchema.optional(),
  criteria: segmentCriteriaSchema.optional(),
  isActive: z.boolean().optional(),
  autoUpdate: z.boolean().optional(),
  updateFrequency: z.number().int().min(1).max(INT4_MAX).optional(),
});

export const executeCampaignInputSchema = z.object({
  campaignId: dunningCampaignIdSchema,
  dryRun: z.boolean().default(false),
  customFilters: z
    .object({
      customerIds: z.array(customerIdSchema).max(MAX_BATCH_ITEMS).optional(),
      excludeCustomerIds: z.array(customerIdSchema).max(MAX_BATCH_ITEMS).optional(),
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
  metrics: z.array(pgText).max(MAX_BATCH_ITEMS).optional(),
});

export const updateExecutionStatusInputSchema = z.object({
  executionId: dunningExecutionIdSchema,
  status: executionStatusSchema,
  errorMessage: pgText.optional(),
  result: z
    .object({
      customersProcessed: z.number().int().min(0),
      communicationsSent: z.number().int().min(0),
      errors: z.array(
        z.object({
          customerId: customerIdSchema,
          error: pgText,
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
  // Stored in `instant` columns: years 1 to 9999
  sentAt: pgInstantSchema().optional(),
  deliveredAt: pgInstantSchema().optional(),
  openedAt: pgInstantSchema().optional(),
  clickedAt: pgInstantSchema().optional(),
  failureReason: pgText.optional(),
  providerMessageId: pgVarcharSchema(255).optional(),
  providerResponse: jsonRecord.optional(),
  trackingData: jsonRecord.optional(),
});

/**
 * A delivery callback from a channel provider, as `CommunicationOrchestrationService.handleCommunicationWebhook`
 * reads it: the provider's message id, the event, when it happened, and the provider's extra data.
 */
export const communicationWebhookSchema = z.object({
  providerMessageId: pgVarcharSchema(255),
  event: z.enum(['delivered', 'opened', 'clicked', 'bounced', 'complained']),
  // Stored in an `instant` column (`delivered_at`, …): years 1 to 9999
  timestamp: pgInstantSchema(),
  metadata: jsonRecord.optional(),
});

export const bulkExecuteCampaignInputSchema = z.object({
  campaignIds: z.array(dunningCampaignIdSchema).min(1).max(MAX_BATCH_ITEMS),
  dryRun: z.boolean().default(false),
  customFilters: z
    .object({
      customerIds: z.array(customerIdSchema).max(MAX_BATCH_ITEMS).optional(),
      excludeCustomerIds: z.array(customerIdSchema).max(MAX_BATCH_ITEMS).optional(),
      testMode: z.boolean().default(false),
    })
    .optional(),
});

export const customerRiskProfileInputSchema = z.object({
  customerId: customerIdSchema,
  segmentIds: z.array(customerSegmentIdSchema).max(MAX_BATCH_ITEMS).default([]),
  paymentHistory: z.object({
    totalPayments: z.number().int().min(0),
    successfulPayments: z.number().int().min(0),
    failedPayments: z.number().int().min(0),
    averageAmount: z.number().min(0),
    currency: pgText.optional(),
    lastPaymentDate: instantSchema().optional(),
    streakDays: z.number().int().min(0),
  }),
  subscriptionHistory: z.object({
    totalSubscriptions: z.number().int().min(0),
    activeSubscriptions: z.number().int().min(0),
    canceledSubscriptions: z.number().int().min(0),
    averageDuration: z.number().min(0), // months
    currentStatus: pgText.optional(),
  }),
  engagementMetrics: z.object({
    score: z.number().min(0).max(100),
    lastActivity: instantSchema().optional(),
    activityFrequency: z.number().min(0), // activities per week
    featureUsage: z.record(pgText, z.number()),
  }),
  communicationPreferences: z.object({
    preferredChannel: communicationChannelSchema.optional(),
    unsubscribed: z.boolean(),
    unsubscribedChannels: z.array(communicationChannelSchema).max(MAX_BATCH_ITEMS),
    timezone: pgText.optional(),
    language: pgText.optional(),
  }),
});

// Query parameter schemas
export const listDunningCampaignsQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  type: dunningCampaignTypeSchema.optional(),
  status: dunningCampaignStatusSchema.optional(),
  search: pgText.optional(),
  sortBy: z.enum(['name', 'type', 'status', 'createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const listCustomerSegmentsQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  type: customerSegmentTypeSchema.optional(),
  isActive: z.boolean().optional(),
  search: pgText.optional(),
  sortBy: z.enum(['name', 'type', 'customerCount', 'createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const listExecutionsQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  campaignId: dunningCampaignIdSchema.optional(),
  customerId: customerIdSchema.optional(),
  status: executionStatusSchema.optional(),
  // Compared with an `instant` column: years 1 to 9999
  scheduledAfter: pgInstantSchema().optional(),
  scheduledBefore: pgInstantSchema().optional(),
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
  // Compared with an `instant` column: years 1 to 9999
  sentAfter: pgInstantSchema().optional(),
  sentBefore: pgInstantSchema().optional(),
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
