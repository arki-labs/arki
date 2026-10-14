import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

import type { Instant } from '@arki/date';
import type { MoneyJSON } from '@arki/money';
import type { MoneyBag } from '@arki/money/bag';

import type { CustomerId, PaymentId, SubscriptionId } from '../core/primitives.js';
import type {
  CommunicationChannel,
  CommunicationStatus,
  CustomerSegmentId,
  DunningCampaignId,
  DunningCampaignStatus,
  DunningCampaignType,
  DunningTemplateId,
  ExecutionStatus,
} from './primitives.js';
import type { DunningTables } from './tables.js';

export type CampaignTrigger = {
  type: 'payment_failure' | 'subscription_status' | 'time_based' | 'manual';
  conditions: {
    paymentFailureCount?: number;
    subscriptionStatus?: string[];
    daysSinceLastPayment?: number;
    daysSinceFailure?: number;
    trialEndingDays?: number;
    renewalReminderDays?: number;
  };
  filters?: {
    customerSegments?: CustomerSegmentId[];
    planTiers?: string[];
    subscriptionAge?: { min?: number; max?: number };
    totalSpent?: SpendRange;
  };
};

export type CampaignSettings = {
  enabled: boolean;
  priority: number; // Higher numbers = higher priority
  cooldownPeriod: number; // Hours between executions for same customer
  maxExecutionsPerCustomer: number; // Per campaign
  stopOnPaymentSuccess: boolean;
  respectUnsubscribe: boolean;
  businessHoursOnly: boolean;
  timezone?: string;
  allowedDays?: number[]; // 0-6 (Sunday-Saturday)
  abTestVariant?: string;
};

export type CommunicationTemplate = {
  channel: CommunicationChannel;
  subject?: string;
  content: string;
  variables: string[]; // e.g., ['customer_name', 'amount_due', 'payment_link']
  design?: {
    theme?: string;
    brandColors?: Record<string, string>;
    logoUrl?: string;
  };
};

/**
 * A range of money spent, kept as JSON because criteria live in a jsonb
 * column. Both bounds share one currency; only payments in it count.
 */
export type SpendRange = { min?: MoneyJSON; max?: MoneyJSON };

export type SegmentCriteria = {
  totalSpent?: SpendRange;
  subscriptionDuration?: { min?: number; max?: number }; // months
  paymentFailureHistory?: { count: number; timeframe: number }; // failures in days
  planTier?: string[];
  lastPaymentDate?: { daysAgo: number };
  lifetimeValue?: { min?: number; max?: number };
  churnRisk?: 'low' | 'medium' | 'high';
  engagementScore?: { min?: number; max?: number }; // 0-100
  customAttributes?: Record<string, unknown>;
};

// Risk Scoring Types
export type RiskFactor = {
  name: string;
  weight: number; // 0-1
  calculation: 'payment_history' | 'engagement' | 'demographic' | 'custom';
  parameters: Record<string, unknown>;
};

export type RiskScore = {
  overall: number; // 0-100
  factors: Record<string, number>;
  category: 'low' | 'medium' | 'high' | 'critical';
  lastCalculated: Instant;
  trends: {
    direction: 'improving' | 'stable' | 'declining';
    changePercent: number;
    timeframe: number; // days
  };
};

// Database execution result type (with string IDs for JSON storage)
export type ExecutionResultDb = {
  customersProcessed: number;
  communicationsSent: number;
  errors: {
    customerId: string;
    error: string;
    timestamp: Instant;
  }[];
  performance: {
    processingTime: number; // milliseconds
    successRate: number; // 0-1
  };
};

// Domain execution result type (with branded IDs)
export type ExecutionResult = {
  customersProcessed: number;
  communicationsSent: number;
  errors: {
    customerId: CustomerId;
    error: string;
    timestamp: Instant;
  }[];
  performance: {
    processingTime: number; // milliseconds
    successRate: number; // 0-1
  };
};

// Analytics Types
export type CampaignMetrics = {
  period: { start: Instant; end: Instant };
  executions: number;
  customersReached: number;
  communicationsSent: number;
  openRate?: number; // Email specific
  clickRate?: number; // Email specific
  responseRate: number; // Any positive response
  paymentsRecovered: {
    count: number;
    totalAmount: number;
  };
  conversionRate: number; // Customers who paid after dunning
  unsubscribeRate: number;
  complaintRate: number;
  costs: {
    communicationCosts: number;
    processingCosts: number;
    total: number;
  };
  roi: number; // Return on investment
};

export type DunningCampaign = InferSelectModel<DunningTables['dunningCampaigns']>;
export type NewDunningCampaign = InferInsertModel<DunningTables['dunningCampaigns']>;

export type DunningTemplate = InferSelectModel<DunningTables['dunningTemplates']>;
export type NewDunningTemplate = InferInsertModel<DunningTables['dunningTemplates']>;

export type DunningExecution = InferSelectModel<DunningTables['dunningExecutions']>;
export type NewDunningExecution = InferInsertModel<DunningTables['dunningExecutions']>;

export type DunningCommunication = InferSelectModel<DunningTables['dunningCommunications']>;
export type NewDunningCommunication = InferInsertModel<DunningTables['dunningCommunications']>;

export type CustomerSegment = InferSelectModel<DunningTables['customerSegments']>;
export type NewCustomerSegment = InferInsertModel<DunningTables['customerSegments']>;

export type CustomerRiskProfile = InferSelectModel<DunningTables['customerRiskProfiles']>;
export type NewCustomerRiskProfile = InferInsertModel<DunningTables['customerRiskProfiles']>;

// Domain Model Types (uses undefined for optional fields)
// Removed manual domain models in favor of Drizzle inferred types

// Domain Model Types (with templates included)
export type DunningCampaignWithTemplates = DunningCampaign & {
  templates?: DunningTemplate[];
};

// Response Types for API
export type DunningCampaignSummary = {
  id: DunningCampaignId;
  name: string;
  type: DunningCampaignType;
  status: DunningCampaignStatus;
  executions: number;
  customersReached: number;
  conversionRate: number;
  revenueRecovered: number;
  lastExecuted?: Instant;
  createdAt: Instant;
};

// Input/Query types (UpdateDunningCampaignInput, CreateCustomerSegmentInput, etc.)
// are now sourced from ./contracts via z.infer of the matching Zod schemas.
// Re-exported through the package barrel.

// Type conversion utilities - Removed as we use Drizzle types directly

// Additional types to replace 'any' usage throughout the system

// Customer data structures
export type CustomerData = {
  id: CustomerId;
  name?: string;
  email?: string;
  phone?: string;
  communicationPreferences?: {
    unsubscribed?: boolean;
    unsubscribedChannels?: string[];
    preferredChannel?: string;
  };
  metadata?: Record<string, unknown>;
};

// Payment history structures
export type PaymentHistoryData = {
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  averageAmount: number;
  lastPaymentDate?: Instant;
  streakDays: number;
  payments: PaymentRecord[];
};

export type PaymentRecord = {
  id: PaymentId;
  amount: number;
  status: 'succeeded' | 'failed' | 'pending' | 'canceled';
  createdAt: Instant;
  failureReason?: string;
};

// Subscription history structures
export type SubscriptionHistoryData = {
  totalSubscriptions: number;
  activeSubscriptions: number;
  canceledSubscriptions: number;
  averageDuration: number;
  currentStatus?: string;
  subscriptions: SubscriptionRecord[];
};

export type SubscriptionRecord = {
  id: SubscriptionId;
  status: string;
  planTier?: string;
  createdAt: Instant;
  updatedAt: Instant;
  canceledAt?: Instant;
};

// Engagement metrics structures
export type EngagementMetricsData = {
  score: number;
  lastActivity?: Instant;
  activityFrequency: number;
  featureUsage: Record<string, number>;
};

// Database query result types
export type DatabaseQueryResult<T = Record<string, unknown>> = {
  rows: T[];
};

export type CampaignQueryRow = {
  id: string;
  name: string;
  type: DunningCampaignType;
  status: DunningCampaignStatus;
  settings: CampaignSettings;
  trigger: CampaignTrigger;
  target_segments: string[];
  created_by: string;
  created_at: Instant;
  updated_at: Instant;
};

export type CustomerQueryRow = {
  customer_id: string;
  subscription_id?: string;
  payment_id?: string;
  trigger_data: Record<string, unknown>;
};

export type SegmentCondition = {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in';
  value: unknown;
};

// Campaign evaluation types
export type CampaignEvaluationContext = {
  customerId: CustomerId;
  subscriptionId?: SubscriptionId;
  paymentId?: PaymentId;
  eventData: Record<string, unknown>;
};

export type TrialEndingEventData = {
  customerId: CustomerId;
  subscriptionId: SubscriptionId;
  daysUntilEnd: number;
  trialEndDate: Instant;
};

export type PaymentFailureEventData = {
  customerId: CustomerId;
  paymentId: PaymentId;
  subscriptionId?: SubscriptionId;
  failureReason: string;
  amount: number;
  attemptCount: number;
};

// Communication template data
export type TemplateData = {
  id: DunningTemplateId;
  name: string;
  stepNumber: number;
  delayHours: number;
  communication: CommunicationTemplate;
  isActive: boolean;
  abTestVariant?: string;
};

// Risk calculation factors
export type RiskFactors = {
  paymentFailureRate: number;
  subscriptionChurnRisk: number;
  engagementRisk: number;
  recencyRisk: number;
  volatilityRisk: number;
  customerLifetimeValueRisk: number;
};

export type RiskWeights = {
  paymentFailureRate: number;
  subscriptionChurnRisk: number;
  engagementRisk: number;
  recencyRisk: number;
  volatilityRisk: number;
  customerLifetimeValueRisk: number;
};

// Update operation types
export type CommunicationUpdateData = {
  status?: CommunicationStatus;
  sentAt?: Instant;
  deliveredAt?: Instant;
  openedAt?: Instant;
  clickedAt?: Instant;
  failureReason?: string;
  providerMessageId?: string;
  providerResponse?: Record<string, unknown>;
  trackingData?: Record<string, unknown>;
  updatedAt: Instant;
};

export type ExecutionUpdateData = {
  status?: ExecutionStatus;
  startedAt?: Instant;
  completedAt?: Instant;
  result?: ExecutionResultDb;
  errorMessage?: string;
  retryCount?: number;
  nextRetryAt?: Instant;
  updatedAt: Instant;
};

// Campaign execution condition types
export type PaymentFailureConditions = {
  paymentFailureCount?: number;
  daysSinceFailure?: number;
  daysSinceLastPayment?: number;
};

export type SubscriptionStatusConditions = {
  subscriptionStatus?: string[];
};

export type TimeBasedConditions = {
  trialEndingDays?: number;
  renewalReminderDays?: number;
};

export type CampaignExecutionFilters = {
  customerIds?: CustomerId[];
  excludeCustomerIds?: CustomerId[];
  testMode?: boolean;
};

// Campaign and event types for integration service
export type CampaignWithTrigger = {
  id: DunningCampaignId;
  name: string;
  status: DunningCampaignStatus;
  trigger: {
    type: 'payment_failure' | 'subscription_status' | 'time_based' | 'manual';
    conditions: {
      paymentFailureCount?: number;
      subscriptionStatus?: string[];
      daysSinceLastPayment?: number;
      daysSinceFailure?: number;
      trialEndingDays?: number;
      renewalReminderDays?: number;
    };
    filters?: {
      customerSegments?: string[]; // Raw DB format, not typed IDs
      planTiers?: string[];
      subscriptionAge?: { min?: number; max?: number };
      totalSpent?: SpendRange;
    };
  };
};

export type PaymentFailureEvent = {
  type: 'payment_failure';
  customerId: CustomerId;
  paymentId: PaymentId;
  subscriptionId?: SubscriptionId;
  failureCount: number;
  amount: number;
  failureReason: string;
  timestamp: Instant;
};

export type TrialEndingEvent = {
  type: 'trial_ending';
  customerId: CustomerId;
  subscriptionId: SubscriptionId;
  daysUntilEnd: number;
  trialEndDate: Instant;
  timestamp: Instant;
};

export type DunningEvent = PaymentFailureEvent | TrialEndingEvent;

// Database result interfaces for segmentation service - matches actual DB schema
// Removed CustomerSegmentDbModel and CustomerRiskProfileDbModel in favor of Drizzle inferred types

export type EngagementMetrics = {
  lastLoginDate?: Instant;
  lastActivity?: Instant;
  sessionCount: number;
  pageViews: number;
  featureUsage: Record<string, number>;
  supportTickets: number;
  loginFrequency: number;
  averageSessionDuration: number;
  score: number; // 0-100 engagement score
};

/** What the dunning dashboard shows. Money is a balance per currency: currencies are never added. */
export type DunningDashboardStats = {
  totalCampaigns: number;
  activeCampaigns: number;
  /** Counted since 00:00 UTC. */
  executionsToday: number;
  customersReachedToday: number;
  revenueRecoveredToday: MoneyBag;
  /** Since the first of the month, 00:00 UTC. */
  revenueRecoveredThisMonth: MoneyBag;
  /** Mean conversion rate over the last 30 days. */
  averageConversionRate: number;
  /** Most payments recovered in the last 30 days; null when none recovered any. */
  topPerformingCampaign: {
    id: DunningCampaignId;
    name: string;
    paymentsRecovered: number;
    conversionRate: number;
    revenueRecovered: MoneyBag;
  } | null;
  /** The ten newest, newest first. */
  recentExecutions: DunningExecution[];
};
