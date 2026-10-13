import { eq } from 'drizzle-orm';

import type { UserId } from '../../core/user-id.js';
import type { Instant } from '@arki/date';
import { now } from '@arki/date';
import { getLogger } from '@arki/log';
import { Money } from '@arki/money';

import type { PaymentRetryService } from '../../core/services/payment-retry-service.js';
import type { CoreTables } from '../../core/tables.js';
import type { CustomerId, PaymentId, SubscriptionId } from '../../core/types.js';
import type { DunningCampaignId } from '../primitives.js';
import type { DunningTables } from '../tables.js';
import type {
  CampaignWithTrigger,
  DunningCampaign as DunningCampaignRow,
  DunningExecution as DunningExecutionRow,
} from '../types.js';
import type { CommunicationOrchestrationConfig } from './communication-service.js';
import { type DunningDatabase } from '../repository.js';
import { createDunningCampaignService } from './campaign-service.js';
import { createCommunicationOrchestrationService } from './communication-service.js';
import { createCustomerSegmentationService } from './segmentation-service.js';

const logger = getLogger('dunning.integration');

/**
 * Events that trigger dunning campaigns
 */
export type DunningTriggerEvent = {
  type: 'payment_failed' | 'subscription_past_due' | 'trial_ending' | 'payment_succeeded' | 'subscription_canceled';
  customerId: CustomerId;
  subscriptionId?: SubscriptionId;
  paymentId?: PaymentId;
  metadata: Record<string, unknown>;
  timestamp: Instant;
};

/**
 * Service that integrates dunning management with existing payment systems
 * Handles event-driven triggers and coordinates between payment retry and dunning
 */
export type DunningIntegrationConfig = {
  /** User ID used to attribute system-driven executions (e.g. dunning created automatically). */
  systemUserId: UserId | string;
  /** Channel-provider config forwarded to `createCommunicationOrchestrationService`. */
  communication?: CommunicationOrchestrationConfig;
};

export type DunningIntegrationCoreTables = Pick<CoreTables, 'customers' | 'payments' | 'subscriptions'>;

export type DunningIntegrationDunningTables = Pick<
  DunningTables,
  | 'dunningCampaigns'
  | 'dunningCampaignAnalytics'
  | 'dunningTemplates'
  | 'dunningExecutions'
  | 'dunningCommunications'
  | 'customerSegments'
  | 'customerRiskProfiles'
>;

export class DunningIntegrationService {
  private campaignService;
  private communicationService;
  private segmentationService;
  private readonly systemUserId: UserId | string;
  private readonly dunningExecutions: DunningTables['dunningExecutions'];

  constructor(
    private readonly db: DunningDatabase,
    coreTables: DunningIntegrationCoreTables,
    dunningTables: DunningIntegrationDunningTables,
    config: DunningIntegrationConfig,
    private readonly paymentRetryService?: PaymentRetryService,
  ) {
    this.systemUserId = config.systemUserId;
    this.dunningExecutions = dunningTables.dunningExecutions;

    this.communicationService = createCommunicationOrchestrationService(
      db,
      { dunningCommunications: dunningTables.dunningCommunications },
      config.communication,
    );

    this.campaignService = createDunningCampaignService(
      db,
      {
        dunningCampaigns: dunningTables.dunningCampaigns,
        dunningCampaignAnalytics: dunningTables.dunningCampaignAnalytics,
        dunningTemplates: dunningTables.dunningTemplates,
        dunningExecutions: dunningTables.dunningExecutions,
      },
      () => this.communicationService,
      paymentRetryService,
    );

    this.segmentationService = createCustomerSegmentationService(db, coreTables, {
      customerSegments: dunningTables.customerSegments,
      customerRiskProfiles: dunningTables.customerRiskProfiles,
    });
  }

  /**
   * Handle payment failure events from the payment system
   */
  async handlePaymentFailure(event: {
    paymentId: PaymentId;
    customerId: CustomerId;
    subscriptionId?: SubscriptionId;
    failureReason: string;
    amount: Money;
    failureCount: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    logger.info('Processing payment failure', {
      customerId: event.customerId,
      paymentId: event.paymentId,
      failureReason: event.failureReason,
      failureCount: event.failureCount,
    });

    // First, let the payment retry service handle technical retries (if available)
    if (this.paymentRetryService) {
      await this.paymentRetryService.scheduleRetries(event.paymentId, event.failureReason);
    }

    // Update customer risk profile with payment failure
    await this.segmentationService.updateCustomerRiskProfile(event.customerId);

    // Get customer segments to determine applicable campaigns
    const customerSegments = await this.segmentationService.getCustomerSegments(event.customerId);

    // Find active campaigns for payment failure trigger
    const applicableCampaigns = await this.campaignService.findActiveCampaignsForTrigger(
      'payment_failure',
      customerSegments,
    );

    // Execute applicable campaigns
    for (const campaign of applicableCampaigns) {
      try {
        // Check if campaign conditions are met
        if (this.evaluateCampaignConditions(campaign, event)) {
          await this.executeCampaignForCustomer(campaign.id, event);
        }
      } catch (error) {
        logger.error('Failed to execute campaign for payment failure', {
          campaignId: campaign.id,
          customerId: event.customerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Handle subscription status changes
   */
  async handleSubscriptionStatusChange(event: {
    subscriptionId: SubscriptionId;
    customerId: CustomerId;
    oldStatus: string;
    newStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    logger.info('Processing subscription status change', {
      customerId: event.customerId,
      subscriptionId: event.subscriptionId,
      oldStatus: event.oldStatus,
      newStatus: event.newStatus,
    });

    // Update customer risk profile
    await this.segmentationService.updateCustomerRiskProfile(event.customerId);

    // Handle different status transitions
    if (event.newStatus === 'past_due') {
      await this.handlePastDueSubscription(event);
    } else if (event.newStatus === 'canceled') {
      await this.handleSubscriptionCancellation(event);
    } else if (event.newStatus === 'active' && event.oldStatus === 'past_due') {
      await this.handleSubscriptionRecovery(event);
    }
  }

  /**
   * Handle trial ending notifications
   */
  async handleTrialEnding(event: {
    subscriptionId: SubscriptionId;
    customerId: CustomerId;
    trialEndDate: Instant;
    daysUntilEnd: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    logger.info('Processing trial ending', {
      customerId: event.customerId,
      subscriptionId: event.subscriptionId,
      daysUntilEnd: event.daysUntilEnd,
      trialEndDate: event.trialEndDate.toString(),
    });

    const customerSegments = await this.segmentationService.getCustomerSegments(event.customerId);

    const applicableCampaigns = await this.campaignService.findActiveCampaignsForTrigger(
      'trial_ending',
      customerSegments,
    );

    for (const campaign of applicableCampaigns) {
      try {
        if (this.evaluateTrialEndingConditions(campaign, event)) {
          await this.executeCampaignForCustomer(campaign.id, {
            customerId: event.customerId,
            subscriptionId: event.subscriptionId,
            triggerData: {
              daysUntilEnd: event.daysUntilEnd,
              trialEndDate: event.trialEndDate,
              ...event.metadata,
            },
          });
        }
      } catch (error) {
        logger.error('Failed to execute trial ending campaign', {
          campaignId: campaign.id,
          customerId: event.customerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Handle successful payment events (can stop dunning campaigns)
   */
  async handlePaymentSuccess(event: {
    paymentId: PaymentId;
    customerId: CustomerId;
    subscriptionId?: SubscriptionId;
    amount: Money;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    logger.info('Processing successful payment', {
      customerId: event.customerId,
      paymentId: event.paymentId,
      amount: event.amount.toString(),
    });

    // Update customer risk profile with successful payment
    await this.segmentationService.updateCustomerRiskProfile(event.customerId);

    // Stop any active dunning campaigns for this customer if configured
    await this.stopDunningCampaignsOnPaymentSuccess(event.customerId, event.subscriptionId);
  }

  /**
   * Execute a specific campaign for a customer
   */
  private async executeCampaignForCustomer(
    campaignId: DunningCampaignId,
    event: {
      customerId: CustomerId;
      subscriptionId?: SubscriptionId;
      paymentId?: PaymentId;
      triggerData?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.campaignService.executeCampaign(
      {
        campaignId,
        dryRun: false,
        customFilters: {
          customerIds: [event.customerId],
          testMode: false,
        },
      },
      this.systemUserId, // System user for automated executions
    );
  }

  /**
   * Handle past due subscription scenario
   */
  private async handlePastDueSubscription(event: {
    subscriptionId: SubscriptionId;
    customerId: CustomerId;
    oldStatus: string;
    newStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const customerSegments = await this.segmentationService.getCustomerSegments(event.customerId);

    const applicableCampaigns = await this.campaignService.findActiveCampaignsForTrigger(
      'subscription_status',
      customerSegments,
    );

    for (const campaign of applicableCampaigns) {
      try {
        // Check if campaign is for past_due status
        if (campaign.trigger.conditions.subscriptionStatus?.includes('past_due')) {
          await this.executeCampaignForCustomer(campaign.id, {
            customerId: event.customerId,
            subscriptionId: event.subscriptionId,
            triggerData: {
              oldStatus: event.oldStatus,
              newStatus: event.newStatus,
              ...event.metadata,
            },
          });
        }
      } catch (error) {
        logger.error('Failed to execute past due campaign', {
          campaignId: campaign.id,
          customerId: event.customerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Handle subscription cancellation
   */
  private async handleSubscriptionCancellation(event: {
    subscriptionId: SubscriptionId;
    customerId: CustomerId;
    oldStatus: string;
    newStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    // Stop any active dunning campaigns for this subscription
    // Update customer risk profile to reflect cancellation
    await this.segmentationService.updateCustomerRiskProfile(event.customerId);

    // Could trigger win-back campaigns (different from dunning)
    logger.info('Subscription canceled, stopping dunning campaigns', {
      subscriptionId: event.subscriptionId,
      customerId: event.customerId,
    });
  }

  /**
   * Handle subscription recovery (past_due -> active)
   */
  private async handleSubscriptionRecovery(event: {
    subscriptionId: SubscriptionId;
    customerId: CustomerId;
    oldStatus: string;
    newStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    // Stop any active dunning campaigns for this customer
    await this.stopDunningCampaignsOnPaymentSuccess(event.customerId, event.subscriptionId);

    // Update customer risk profile positively
    await this.segmentationService.updateCustomerRiskProfile(event.customerId);

    logger.info('Subscription recovered', {
      subscriptionId: event.subscriptionId,
      customerId: event.customerId,
      oldStatus: event.oldStatus,
      newStatus: event.newStatus,
    });
  }

  /**
   * Stop active dunning campaigns when payment succeeds (if configured)
   */
  private async stopDunningCampaignsOnPaymentSuccess(
    customerId: CustomerId,
    subscriptionId?: SubscriptionId,
  ): Promise<void> {
    // Find active executions for this customer. Cast through unknown because
    // the package-side `db.query.dunningExecutions` is typed against
    // `AnyRelations` and loses the relations + filter operator info — the host
    // contract guarantees the registered relations support `where` + `with`.
    const dunningQuery = this.db.query as unknown as {
      dunningExecutions: {
        findMany: (config: {
          where: Record<string, unknown>;
          with?: Record<string, true | { with?: Record<string, true> }>;
        }) => Promise<(DunningExecutionRow & { campaign?: DunningCampaignRow })[]>;
      };
    };
    const activeExecutions = await dunningQuery.dunningExecutions.findMany({
      where: {
        customerId,
        status: { in: ['scheduled', 'running'] },
        ...(subscriptionId && { subscriptionId }),
      },
      with: {
        campaign: true,
      },
    });

    for (const execution of activeExecutions) {
      // Check if the campaign is configured to stop on payment success
      if (execution.campaign?.settings.stopOnPaymentSuccess) {
        try {
          await this.db
            .update(this.dunningExecutions)
            .set({
              status: 'cancelled',
              completedAt: now(),
              result: {
                customersProcessed: 0,
                communicationsSent: 0,
                errors: [],
                performance: {
                  processingTime: 0,
                  successRate: 1,
                },
              },
            })
            .where(eq(this.dunningExecutions.id, execution.id));

          logger.info('Stopped dunning execution due to payment success', {
            executionId: execution.id,
            customerId: customerId,
            campaignId: execution.campaign?.id,
          });
        } catch (error) {
          logger.error('Failed to stop dunning execution', {
            executionId: execution.id,
            customerId: customerId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /**
   * Evaluate campaign conditions for payment failure
   */
  private evaluateCampaignConditions(
    campaign: CampaignWithTrigger,
    event: {
      paymentId: PaymentId;
      customerId: CustomerId;
      subscriptionId?: SubscriptionId;
      failureReason: string;
      amount: Money;
      failureCount: number;
      metadata?: Record<string, unknown>;
    },
  ): boolean {
    const conditions = campaign.trigger.conditions;

    // Check payment failure count condition
    if (conditions.paymentFailureCount && event.failureCount < conditions.paymentFailureCount) {
      return false;
    }

    // Check amount filters if specified
    // A range in another currency says nothing about this payment, so the campaign does not apply.
    const range = campaign.trigger.filters?.totalSpent;
    const bound = range?.min ?? range?.max;
    if (range && bound) {
      if (event.amount.currency.code !== Money.fromJSON(bound).currency.code) return false;
      if (range.min && event.amount.lt(Money.fromJSON(range.min))) return false;
      if (range.max && event.amount.gt(Money.fromJSON(range.max))) return false;
    }

    // Add more condition evaluations as needed

    return true;
  }

  /**
   * Evaluate trial ending conditions
   */
  private evaluateTrialEndingConditions(
    campaign: CampaignWithTrigger,
    event: {
      subscriptionId: SubscriptionId;
      customerId: CustomerId;
      trialEndDate: Instant;
      daysUntilEnd: number;
      metadata?: Record<string, unknown>;
    },
  ): boolean {
    const conditions = campaign.trigger.conditions;

    // Check trial ending days condition
    if (conditions.trialEndingDays && event.daysUntilEnd !== conditions.trialEndingDays) {
      return false;
    }

    return true;
  }

  /**
   * Process all scheduled dunning executions
   */
  async processScheduledExecutions(): Promise<void> {
    try {
      await this.campaignService.processScheduledExecutions();
    } catch (error) {
      logger.error('Failed to process scheduled executions', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Process pending communications
   */
  async processPendingCommunications(): Promise<void> {
    try {
      await this.communicationService.processPendingCommunications();
    } catch (error) {
      logger.error('Failed to process pending communications', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Retry failed executions
   */
  async retryFailedExecutions(): Promise<void> {
    try {
      await this.campaignService.retryFailedExecutions();
    } catch (error) {
      logger.error('Failed to retry failed executions', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update customer risk profiles in bulk
   */
  async updateRiskProfiles(): Promise<void> {
    try {
      await this.segmentationService.bulkUpdateRiskProfiles();
    } catch (error) {
      logger.error('Failed to update risk profiles', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Process auto-update segments
   */
  async processAutoUpdateSegments(): Promise<void> {
    try {
      await this.segmentationService.processAutoUpdateSegments();
    } catch (error) {
      logger.error('Failed to process auto-update segments', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Integration health check
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    services: {
      campaigns: boolean;
      communications: boolean;
      segmentation: boolean;
      paymentRetry: boolean;
    };
    providers: Record<string, boolean>;
  }> {
    const services = {
      campaigns: true, // Would check campaign service health
      communications: true, // Would check communication service health
      segmentation: true, // Would check segmentation service health
      paymentRetry: true, // Would check payment retry service health
    };

    const providers = await this.communicationService.validateProviders();

    const allServicesHealthy = Object.values(services).every(Boolean);
    const allProvidersHealthy = Object.values(providers).every(Boolean);

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (allServicesHealthy && allProvidersHealthy) {
      status = 'healthy';
    } else if (allServicesHealthy) {
      status = 'degraded'; // Services healthy but some providers down
    } else {
      status = 'unhealthy';
    }

    return {
      status,
      services,
      providers,
    };
  }

  /**
   * Get integration metrics
   */
  async getIntegrationMetrics(_days = 30): Promise<{
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    communicationsSent: number;
    successRate: number;
    averageProcessingTime: number;
  }> {
    // This would query execution and communication tables for metrics
    // Placeholder implementation
    return {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      communicationsSent: 0,
      successRate: 0,
      averageProcessingTime: 0,
    };
  }
}

/**
 * Factory function to create DunningIntegrationService.
 */
export function createDunningIntegrationService(
  db: DunningDatabase,
  coreTables: DunningIntegrationCoreTables,
  dunningTables: DunningIntegrationDunningTables,
  config: DunningIntegrationConfig,
  paymentRetryService?: PaymentRetryService,
) {
  return new DunningIntegrationService(db, coreTables, dunningTables, config, paymentRetryService);
}
