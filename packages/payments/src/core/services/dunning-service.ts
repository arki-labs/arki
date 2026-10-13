import type { Instant } from '@arki/date';
import { fromDate, isSameOrBefore, now, toDate, toMillis } from '@arki/date';

import type { CoreWrites } from '../journal.js';
import type { BasePaymentProvider } from '../providers/base-provider.js';
import type { PaymentRepository } from '../repository.js';
import type { PaymentId, SubscriptionId } from '../types.js';
import { paymentAmount } from '../money.js';

export type DunningRule = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: {
    event: 'payment_failed' | 'invoice_payment_failed' | 'subscription_past_due';
    delayDays: number;
  };
  action: {
    type: 'email' | 'retry_payment' | 'pause_subscription' | 'cancel_subscription' | 'webhook';
    config: Record<string, unknown>;
  };
  retryCount?: number;
  maxRetries?: number;
}

export type DunningConfiguration = {
  gracePeriodDays: number;
  maxRetryAttempts: number;
  retrySchedule: number[]; // Days after failure to retry
  emailTemplates: {
    paymentFailed: string;
    trialEnding: string;
    subscriptionPaused: string;
    finalNotice: string;
  };
  rules: DunningRule[];
}

export type DunningEvent = {
  id: string;
  subscriptionId: SubscriptionId;
  paymentId?: PaymentId;
  userId: string;
  eventType: 'payment_failed' | 'retry_scheduled' | 'grace_period_ended' | 'subscription_recovered';
  data: Record<string, unknown>;
  scheduledFor?: Instant;
  processedAt?: Instant;
  createdAt: Instant;
}

export type DunningStats = {
  totalFailedPayments: number;
  recoveredPayments: number;
  recoveryRate: number;
  subscriptionsInDunning: number;
  averageRecoveryTime: number; // days
  revenueAtRisk: number;
  revenueRecovered: number;
}

const DEFAULT_DUNNING_CONFIG: DunningConfiguration = {
  gracePeriodDays: 7,
  maxRetryAttempts: 3,
  retrySchedule: [1, 3, 7], // Retry after 1, 3, and 7 days
  emailTemplates: {
    paymentFailed: 'payment_failed_template',
    trialEnding: 'trial_ending_template',
    subscriptionPaused: 'subscription_paused_template',
    finalNotice: 'final_notice_template',
  },
  rules: [
    {
      id: 'initial_payment_failure',
      name: 'Initial Payment Failure',
      enabled: true,
      trigger: {
        event: 'payment_failed',
        delayDays: 0,
      },
      action: {
        type: 'email',
        config: { template: 'payment_failed_template' },
      },
    },
    {
      id: 'retry_payment_day_1',
      name: 'Retry Payment - Day 1',
      enabled: true,
      trigger: {
        event: 'payment_failed',
        delayDays: 1,
      },
      action: {
        type: 'retry_payment',
        config: { attempt: 1 },
      },
    },
    {
      id: 'retry_payment_day_3',
      name: 'Retry Payment - Day 3',
      enabled: true,
      trigger: {
        event: 'payment_failed',
        delayDays: 3,
      },
      action: {
        type: 'retry_payment',
        config: { attempt: 2 },
      },
    },
    {
      id: 'final_notice_day_7',
      name: 'Final Notice - Day 7',
      enabled: true,
      trigger: {
        event: 'payment_failed',
        delayDays: 7,
      },
      action: {
        type: 'email',
        config: { template: 'final_notice_template' },
      },
    },
    {
      id: 'pause_subscription_day_10',
      name: 'Pause Subscription - Day 10',
      enabled: true,
      trigger: {
        event: 'payment_failed',
        delayDays: 10,
      },
      action: {
        type: 'pause_subscription',
        config: {},
      },
    },
    {
      id: 'cancel_subscription_day_30',
      name: 'Cancel Subscription - Day 30',
      enabled: true,
      trigger: {
        event: 'payment_failed',
        delayDays: 30,
      },
      action: {
        type: 'cancel_subscription',
        config: { reason: 'payment_failure' },
      },
    },
  ],
};

/** The provider calls dunning makes. A `BasePaymentProvider` fits. */
type DunningProvider = Pick<BasePaymentProvider, 'confirmPayment' | 'pauseSubscription' | 'cancelSubscription'>;

/** The repository reads dunning makes. A `PaymentRepository` fits. */
type DunningReads = Pick<
  PaymentRepository,
  'findPaymentById' | 'findSubscriptionById' | 'getPaymentStats' | 'getSubscriptionStats'
>;

/**
 * The schedule of dunning steps lives in memory. Every change of a
 * `subscriptions` row goes through `writes`: one journal command each.
 */
export class DunningService {
  private config: DunningConfiguration;
  private dunningEvents = new Map<string, DunningEvent>();

  constructor(
    private readonly paymentProvider: DunningProvider,
    private readonly paymentRepository: DunningReads,
    private readonly writes: CoreWrites,
    config: Partial<DunningConfiguration> = {},
  ) {
    this.config = { ...DEFAULT_DUNNING_CONFIG, ...config };
  }

  /**
   * Handle a payment failure and initiate dunning process
   */
  async handlePaymentFailure(
    paymentId: PaymentId,
    subscriptionId: SubscriptionId,
    failureReason?: string,
  ): Promise<void> {
    try {
      const payment = await this.paymentRepository.findPaymentById(paymentId);
      const subscription = await this.paymentRepository.findSubscriptionById(subscriptionId);

      if (!payment || !subscription) {
        throw new Error('Payment or subscription not found');
      }

      // Create dunning events based on configured rules
      const failureDate = now();
      for (const rule of this.config.rules.filter(r => r.enabled && r.trigger.event === 'payment_failed')) {
        // Local-time calendar days, as before: the working value stays a `Date` until it is stored.
        const scheduledDate = toDate(failureDate);
        scheduledDate.setDate(scheduledDate.getDate() + rule.trigger.delayDays);

        const dunningEvent: DunningEvent = {
          id: `${paymentId}_${rule.id}_${Date.now()}`,
          subscriptionId,
          paymentId,
          userId: subscription.userId,
          eventType: 'payment_failed',
          data: {
            ruleId: rule.id,
            ruleName: rule.name,
            action: rule.action,
            failureReason,
            attempt: rule.retryCount || 0,
          },
          scheduledFor: fromDate(scheduledDate),
          createdAt: failureDate,
        };

        this.dunningEvents.set(dunningEvent.id, dunningEvent);
      }

      // Update subscription status to past_due
      await this.writes.markSubscriptionPastDue({ subscriptionId });

      console.log(`Initiated dunning process for payment ${paymentId} on subscription ${subscriptionId}`);
    } catch (error) {
      console.error('Error handling payment failure:', error);
      throw error;
    }
  }

  /**
   * Process scheduled dunning events
   */
  async processDunningEvents(): Promise<void> {
    const current = now();
    const eventsToProcess = [...this.dunningEvents.values()]
      .filter(event => !event.processedAt && event.scheduledFor && isSameOrBefore(event.scheduledFor, current))
      .sort((a, b) => (a.scheduledFor ? toMillis(a.scheduledFor) : 0) - (b.scheduledFor ? toMillis(b.scheduledFor) : 0));

    for (const event of eventsToProcess) {
      try {
        await this.processEvent(event);
        event.processedAt = now();
        console.log(`Processed dunning event ${event.id}`);
      } catch (error) {
        console.error(`Failed to process dunning event ${event.id}:`, error);
      }
    }
  }

  /**
   * Process an individual dunning event
   */
  private async processEvent(event: DunningEvent): Promise<void> {
    const { action } = event.data as { action: DunningRule['action'] };

    switch (action.type) {
      case 'email': {
        await this.sendDunningEmail(event, action.config);
        break;
      }

      case 'retry_payment': {
        await this.retryPayment(event, action.config);
        break;
      }

      case 'pause_subscription': {
        await this.pauseSubscription(event);
        break;
      }

      case 'cancel_subscription': {
        await this.cancelSubscription(event, action.config);
        break;
      }

      case 'webhook': {
        await this.triggerWebhook(event, action.config);
        break;
      }

      default: {
        console.warn(`Unknown dunning action type: ${action.type}`);
      }
    }
  }

  /**
   * Send dunning email to customer
   */
  private async sendDunningEmail(event: DunningEvent, config: Record<string, unknown>): Promise<void> {
    // In a real implementation, this would integrate with your email service
    console.log(`Sending dunning email for subscription ${event.subscriptionId}`, {
      template: config['template'],
      userId: event.userId,
    });

    // Example email integration:
    // await emailService.sendTemplate({
    //   to: subscription.customer.email,
    //   template: config.template as string,
    //   data: {
    //     subscriptionId: event.subscriptionId,
    //     amount: payment.amount,
    //     retryDate: nextRetryDate,
    //   }
    // });
  }

  /**
   * Retry failed payment
   */
  private async retryPayment(event: DunningEvent, _config: Record<string, unknown>): Promise<void> {
    if (!event.paymentId) {
      throw new Error('Payment ID required for retry');
    }

    try {
      const payment = await this.paymentRepository.findPaymentById(event.paymentId);
      if (!payment) {
        throw new Error('Payment not found');
      }

      // Attempt to retry the payment through the provider
      const retryResult = await this.paymentProvider.confirmPayment(event.paymentId);

      if (retryResult.status === 'succeeded') {
        // Payment recovered - update subscription status.
        // A canceled subscription stays canceled: the command rejects and the catch below logs it.
        await this.writes.activateSubscription({ subscriptionId: event.subscriptionId });

        // Remove remaining dunning events for this subscription
        this.cancelDunningEventsForSubscription(event.subscriptionId);

        console.log(`Payment ${event.paymentId} recovered on retry`);
      } else {
        console.log(`Payment retry failed for ${event.paymentId}: ${retryResult.status}`);
      }
    } catch (error) {
      console.error(`Payment retry error for ${event.paymentId}:`, error);
    }
  }

  /**
   * Pause subscription due to payment failure
   */
  private async pauseSubscription(event: DunningEvent): Promise<void> {
    try {
      await this.paymentProvider.pauseSubscription(event.subscriptionId);

      // Update local database
      await this.writes.pauseSubscription({ subscriptionId: event.subscriptionId });

      console.log(`Paused subscription ${event.subscriptionId} due to payment failure`);
    } catch (error) {
      console.error(`Failed to pause subscription ${event.subscriptionId}:`, error);
    }
  }

  /**
   * Cancel subscription due to payment failure
   */
  private async cancelSubscription(event: DunningEvent, config: Record<string, unknown>): Promise<void> {
    try {
      await this.paymentProvider.cancelSubscription(event.subscriptionId, {
        immediately: true,
        reason: config['reason'] as string || 'payment_failure',
      });

      // Update local database
      await this.writes.cancelSubscription({
        subscriptionId: event.subscriptionId,
        status: 'canceled',
        canceledAt: now(),
      });

      // Remove remaining dunning events
      this.cancelDunningEventsForSubscription(event.subscriptionId);

      console.log(`Canceled subscription ${event.subscriptionId} due to payment failure`);
    } catch (error) {
      console.error(`Failed to cancel subscription ${event.subscriptionId}:`, error);
    }
  }

  /**
   * Trigger external webhook for custom dunning logic
   */
  private async triggerWebhook(event: DunningEvent, config: Record<string, unknown>): Promise<void> {
    // In a real implementation, this would call an external webhook
    console.log(`Triggering webhook for dunning event ${event.id}`, config);
  }

  /**
   * Cancel all pending dunning events for a subscription
   */
  private cancelDunningEventsForSubscription(subscriptionId: SubscriptionId): void {
    for (const [eventId] of [...this.dunningEvents.entries()]
      .filter(([_, event]) => event.subscriptionId === subscriptionId && !event.processedAt)) {
        this.dunningEvents.delete(eventId);
      }
  }

  /**
   * Handle subscription recovery (payment succeeded after failure)
   */
  async handleSubscriptionRecovery(subscriptionId: SubscriptionId): Promise<void> {
    // Cancel remaining dunning events
    this.cancelDunningEventsForSubscription(subscriptionId);

    // Update subscription status. A canceled subscription is not brought back: the command rejects.
    await this.writes.activateSubscription({ subscriptionId });

    // Create recovery event for analytics
    const recoveryEvent: DunningEvent = {
      id: `recovery_${subscriptionId}_${Date.now()}`,
      subscriptionId,
      userId: '', // Would need to get from subscription
      eventType: 'subscription_recovered',
      data: { recoveredAt: now() },
      createdAt: now(),
    };

    this.dunningEvents.set(recoveryEvent.id, recoveryEvent);

    console.log(`Subscription ${subscriptionId} recovered from dunning`);
  }

  /**
   * Get dunning statistics for analytics
   */
  async getDunningStats(startDate?: Instant, endDate?: Instant): Promise<DunningStats> {
    const payments = await this.paymentRepository.getPaymentStats(startDate, endDate);
    const subscriptions = await this.paymentRepository.getSubscriptionStats(startDate, endDate);

    const failedPayments = payments.filter(p => p.status === 'failed');
    void payments.filter(p => p.status === 'succeeded'); // For future use
    const pastDueSubscriptions = subscriptions.filter(s => s.status === 'past_due');

    // Calculate recovery metrics from dunning events
    const recoveryEvents = [...this.dunningEvents.values()]
      .filter(e => e.eventType === 'subscription_recovered');

    const totalFailedPayments = failedPayments.length;
    const recoveredPayments = recoveryEvents.length;
    const recoveryRate = totalFailedPayments > 0 ? (recoveredPayments / totalFailedPayments) * 100 : 0;

    const revenueAtRisk = failedPayments.reduce((sum, p) => sum + paymentAmount(p).toNumber(), 0);
    const revenueRecovered = recoveredPayments * (revenueAtRisk / totalFailedPayments || 0);

    // Calculate average recovery time (simplified)
    const averageRecoveryTime = recoveryEvents.length > 0 ? 5 : 0; // Days - would calculate from actual data

    return {
      totalFailedPayments,
      recoveredPayments,
      recoveryRate: Math.round(recoveryRate * 100) / 100,
      subscriptionsInDunning: pastDueSubscriptions.length,
      averageRecoveryTime,
      revenueAtRisk: Math.round(revenueAtRisk * 100) / 100,
      revenueRecovered: Math.round(revenueRecovered * 100) / 100,
    };
  }

  /**
   * Get pending dunning events for a subscription
   */
  getPendingEventsForSubscription(subscriptionId: SubscriptionId): DunningEvent[] {
    return [...this.dunningEvents.values()]
      .filter(event => event.subscriptionId === subscriptionId && !event.processedAt)
      .sort((a, b) => (a.scheduledFor ? toMillis(a.scheduledFor) : 0) - (b.scheduledFor ? toMillis(b.scheduledFor) : 0));
  }

  /**
   * Update dunning configuration
   */
  updateConfiguration(config: Partial<DunningConfiguration>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current dunning configuration
   */
  getConfiguration(): DunningConfiguration {
    return { ...this.config };
  }
}

export function createDunningService(
  paymentProvider: BasePaymentProvider,
  paymentRepository: PaymentRepository,
  writes: CoreWrites,
  config?: Partial<DunningConfiguration>,
) {
  return new DunningService(paymentProvider, paymentRepository, writes, config);
}