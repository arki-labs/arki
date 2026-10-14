import type { UserId } from '../user-id.js';
import type { Instant } from '@arki/date';
import { fromDate } from '@arki/date';

import type { CoreWrites } from '../journal.js';
import type { BasePaymentProvider } from '../providers/base-provider.js';
import type { PaymentRepository } from '../repository.js';
import type { Plan, PlanId, Subscription, SubscriptionId, SubscriptionPreview, SubscriptionStatus } from '../types.js';
import { paymentAmount } from '../money.js';

// Utility functions to convert between database and domain types
function convertSubscriptionToDomain(dbSubscription: any): Subscription {
  return {
    ...dbSubscription,
    trialStart: dbSubscription.trialStart ?? undefined,
    trialEnd: dbSubscription.trialEnd ?? undefined,
    canceledAt: dbSubscription.canceledAt ?? undefined,
    metadata: dbSubscription.metadata ?? undefined,
  };
}

function convertSubscriptionArrayToDomain(dbSubscriptions: any[]): Subscription[] {
  return dbSubscriptions.map(convertSubscriptionToDomain);
}

export type SubscriptionChangeOptions = {
  prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice';
  immediateChange?: boolean;
  effectiveDate?: Instant;
}

export type SubscriptionCreationOptions = {
  trialPeriodDays?: number;
  paymentMethodId?: string;
  metadata?: Record<string, unknown>;
  automaticTax?: boolean;
}

export type SubscriptionCancellationOptions = {
  immediately?: boolean;
  reason?: string;
  provideFeedback?: boolean;
  effectiveDate?: Instant;
}

export type SubscriptionAnalytics = {
  totalSubscriptions: number;
  activeSubscriptions: number;
  churnRate: number;
  averageRevenuePerUser: number;
  monthlyRecurringRevenue: number;
  annualRecurringRevenue: number;
  subscriptionsByTier: Record<string, number>;
  subscriptionsByStatus: Record<SubscriptionStatus, number>;
}

/** The provider calls the manager makes. A `BasePaymentProvider` fits. */
type SubscriptionProvider = Pick<
  BasePaymentProvider,
  | 'createSubscription'
  | 'updateSubscription'
  | 'cancelSubscription'
  | 'reactivateSubscription'
  | 'pauseSubscription'
  | 'resumeSubscription'
  | 'getSubscription'
  | 'previewSubscriptionChange'
>;

/** The repository reads the manager makes. A `PaymentRepository` fits. */
type SubscriptionReads = Pick<
  PaymentRepository,
  | 'findCustomerByUserId'
  | 'findPlanById'
  | 'findActiveSubscriptionByUserId'
  | 'findSubscriptionById'
  | 'findSubscriptionsByUserId'
  | 'findSubscriptionsEndingInRange'
  | 'findSubscriptionsByStatus'
  | 'getSubscriptionStats'
  | 'getPaymentStats'
>;

/**
 * Reads come from the repository. Every change of a `subscriptions` row goes
 * through `writes`: one journal command each, so each change leaves an event.
 */
export class SubscriptionManager {
  constructor(
    private readonly paymentProvider: SubscriptionProvider,
    private readonly paymentRepository: SubscriptionReads,
    private readonly writes: CoreWrites,
  ) {}

  async createSubscription(
    userId: UserId,
    planId: PlanId,
    options: SubscriptionCreationOptions = {},
  ): Promise<Subscription> {
    try {
      // Get or create customer
      const customer = await this.paymentRepository.findCustomerByUserId(userId);
      if (!customer) {
        // This would typically get user info from the auth system
        throw new Error('Customer not found and user info not available');
      }

      // Get plan details
      const plan = await this.paymentRepository.findPlanById(planId);
      if (!plan || !plan.isActive) {
        throw new Error('Plan not found or inactive');
      }

      // Check for existing active subscription
      const existingSubscription = await this.paymentRepository.findActiveSubscriptionByUserId(userId);
      if (existingSubscription) {
        throw new Error('User already has an active subscription');
      }

      // Create subscription with the payment provider
      const providerSubscription = await this.paymentProvider.createSubscription({
        customerId: customer.id,
        planId,
        paymentMethodId: options.paymentMethodId,
        trialPeriodDays: options.trialPeriodDays ?? plan.trialPeriodDays ?? undefined,
        metadata: options.metadata,
      });

      return providerSubscription;
    } catch (error) {
      throw new Error(`Failed to create subscription: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async updateSubscription(
    subscriptionId: SubscriptionId,
    newPlanId: PlanId,
    options: SubscriptionChangeOptions = {},
  ): Promise<{
    subscription: Subscription;
    preview: SubscriptionPreview;
  }> {
    try {
      // Validate subscription exists
      const currentSubscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
      if (!currentSubscription) {
        throw new Error('Subscription not found');
      }

      if (currentSubscription.status !== 'active') {
        throw new Error('Only active subscriptions can be updated');
      }

      // Validate new plan exists
      const newPlan = await this.paymentRepository.findPlanById(newPlanId);
      if (!newPlan || !newPlan.isActive) {
        throw new Error('New plan not found or inactive');
      }

      // Preview the change first
      const preview = await this.paymentProvider.previewSubscriptionChange({
        subscriptionId,
        planId: newPlanId,
        prorationBehavior: options.prorationBehavior || 'create_prorations',
      });

      // Update the subscription
      const updatedSubscription = await this.paymentProvider.updateSubscription(subscriptionId, {
        planId: newPlanId,
        prorationBehavior: options.prorationBehavior || 'create_prorations',
      });

      // The provider moved the plan; store it. The provider's answer says which plan it is on now.
      await this.writes.changeSubscriptionPlan({ subscriptionId, planId: updatedSubscription.planId });

      return {
        subscription: updatedSubscription,
        preview,
      };
    } catch (error) {
      throw new Error(
        `Failed to update subscription: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Set or clear "ends when the paid period ends". The provider changes the flag, then the row follows.
   * Unlike `cancelSubscription` it never cancels now, and `false` undoes an earlier `true`.
   */
  async setCancelAtPeriodEnd(subscriptionId: SubscriptionId, cancelAtPeriodEnd: boolean): Promise<Subscription> {
    try {
      const currentSubscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
      if (!currentSubscription) {
        throw new Error('Subscription not found');
      }

      if (currentSubscription.status === 'canceled') {
        throw new Error('Subscription is already canceled');
      }

      const updatedSubscription = await this.paymentProvider.updateSubscription(subscriptionId, { cancelAtPeriodEnd });

      await this.writes.setSubscriptionCancelAtPeriodEnd({
        subscriptionId,
        cancelAtPeriodEnd: updatedSubscription.cancelAtPeriodEnd,
      });

      return updatedSubscription;
    } catch (error) {
      throw new Error(
        `Failed to set cancel at period end: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error },
      );
    }
  }

  async cancelSubscription(
    subscriptionId: SubscriptionId,
    options: SubscriptionCancellationOptions = {},
  ): Promise<Subscription> {
    try {
      // Validate subscription exists
      const currentSubscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
      if (!currentSubscription) {
        throw new Error('Subscription not found');
      }

      if (currentSubscription.status === 'canceled') {
        throw new Error('Subscription is already canceled');
      }

      // Cancel with the payment provider
      const canceledSubscription = await this.paymentProvider.cancelSubscription(subscriptionId, {
        immediately: options.immediately || false,
        reason: options.reason,
      });

      // Update our database
      await this.writes.cancelSubscription({
        subscriptionId,
        status: canceledSubscription.status,
        canceledAt: canceledSubscription.canceledAt,
        cancelAtPeriodEnd: canceledSubscription.cancelAtPeriodEnd,
      });

      return canceledSubscription;
    } catch (error) {
      throw new Error(
        `Failed to cancel subscription: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async reactivateSubscription(subscriptionId: SubscriptionId): Promise<Subscription> {
    try {
      // Validate subscription exists and can be reactivated
      const currentSubscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
      if (!currentSubscription) {
        throw new Error('Subscription not found');
      }

      if (!['canceled', 'past_due'].includes(currentSubscription.status)) {
        throw new Error('Only canceled or past due subscriptions can be reactivated');
      }

      // Reactivate with the payment provider
      const reactivatedSubscription = await this.paymentProvider.reactivateSubscription(subscriptionId);

      // Update our database. The event clears the cancellation.
      await this.writes.reactivateSubscription({ subscriptionId, status: reactivatedSubscription.status });

      return reactivatedSubscription;
    } catch (error) {
      throw new Error(
        `Failed to reactivate subscription: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async pauseSubscription(subscriptionId: SubscriptionId): Promise<Subscription> {
    try {
      // Validate subscription exists and is active
      const currentSubscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
      if (!currentSubscription) {
        throw new Error('Subscription not found');
      }

      if (currentSubscription.status !== 'active') {
        throw new Error('Only active subscriptions can be paused');
      }

      // Pause with the payment provider
      const pausedSubscription = await this.paymentProvider.pauseSubscription(subscriptionId);

      // Update our database
      await this.writes.pauseSubscription({ subscriptionId, status: pausedSubscription.status });

      return pausedSubscription;
    } catch (error) {
      throw new Error(
        `Failed to pause subscription: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async resumeSubscription(subscriptionId: SubscriptionId): Promise<Subscription> {
    try {
      // Validate subscription exists and is paused
      const currentSubscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
      if (!currentSubscription) {
        throw new Error('Subscription not found');
      }

      if (currentSubscription.status !== 'paused') {
        throw new Error('Only paused subscriptions can be resumed');
      }

      // Resume with the payment provider
      const resumedSubscription = await this.paymentProvider.resumeSubscription(subscriptionId);

      // Update our database
      await this.writes.resumeSubscription({ subscriptionId, status: resumedSubscription.status });

      return resumedSubscription;
    } catch (error) {
      throw new Error(
        `Failed to resume subscription: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async getSubscription(subscriptionId: SubscriptionId): Promise<Subscription | null> {
    const dbSubscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
    return dbSubscription ? convertSubscriptionToDomain(dbSubscription) : null;
  }

  async getUserSubscriptions(userId: UserId): Promise<Subscription[]> {
    const dbSubscriptions = await this.paymentRepository.findSubscriptionsByUserId(userId);
    return convertSubscriptionArrayToDomain(dbSubscriptions);
  }

  async getActiveSubscription(userId: UserId): Promise<Subscription | null> {
    const dbSubscription = await this.paymentRepository.findActiveSubscriptionByUserId(userId);
    return dbSubscription ? convertSubscriptionToDomain(dbSubscription) : null;
  }

  async previewSubscriptionChange(
    subscriptionId: SubscriptionId,
    newPlanId: PlanId,
    options: SubscriptionChangeOptions = {},
  ): Promise<SubscriptionPreview> {
    try {
      // Validate subscription and plan exist
      const subscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
      if (!subscription) {
        throw new Error('Subscription not found');
      }

      const newPlan = await this.paymentRepository.findPlanById(newPlanId);
      if (!newPlan || !newPlan.isActive) {
        throw new Error('New plan not found or inactive');
      }

      // Get preview from payment provider
      return this.paymentProvider.previewSubscriptionChange({
        subscriptionId,
        planId: newPlanId,
        prorationBehavior: options.prorationBehavior || 'create_prorations',
      });
    } catch (error) {
      throw new Error(
        `Failed to preview subscription change: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async handleTrialEndingSoon(daysBeforeExpiration = 3): Promise<Subscription[]> {
    try {
      // Local-time calendar days, as before: the working values stay `Date`s until the query.
      const startDate = new Date();
      startDate.setDate(startDate.getDate() + daysBeforeExpiration - 1);
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + daysBeforeExpiration);

      const subscriptions = await this.paymentRepository.findSubscriptionsEndingInRange(fromDate(startDate), fromDate(endDate));

      // Filter for trialing subscriptions
      const trialingSubscriptions = subscriptions.filter(sub => sub.status === 'trialing');

      // Here you would typically send notifications or trigger other actions
      // For now, just return the list
      return convertSubscriptionArrayToDomain(trialingSubscriptions);
    } catch (error) {
      throw new Error(
        `Failed to handle trial ending soon: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async handlePastDueSubscriptions(): Promise<Subscription[]> {
    try {
      const pastDueSubscriptions = await this.paymentRepository.findSubscriptionsByStatus('past_due');

      // Here you would implement business logic for handling past due subscriptions
      // - Send notifications
      // - Retry payments
      // - Grace period management
      // - Automatic cancellation after certain period

      return convertSubscriptionArrayToDomain(pastDueSubscriptions);
    } catch (error) {
      throw new Error(
        `Failed to handle past due subscriptions: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async getSubscriptionAnalytics(startDate?: Instant, endDate?: Instant): Promise<SubscriptionAnalytics> {
    try {
      const subscriptions = await this.paymentRepository.getSubscriptionStats(startDate, endDate);
      const payments = await this.paymentRepository.getPaymentStats(startDate, endDate);

      const totalSubscriptions = subscriptions.length;
      const activeSubscriptions = subscriptions.filter(sub => sub.status === 'active').length;

      // Calculate churn rate (simplified)
      const canceledSubscriptions = subscriptions.filter(sub => sub.status === 'canceled').length;
      const churnRate = totalSubscriptions > 0 ? (canceledSubscriptions / totalSubscriptions) * 100 : 0;

      // Calculate revenue metrics
      const successfulPayments = payments.filter(payment => payment.status === 'succeeded');
      const totalRevenue = successfulPayments.reduce((sum, payment) => sum + paymentAmount(payment).toNumber(), 0);
      const averageRevenuePerUser = activeSubscriptions > 0 ? totalRevenue / activeSubscriptions : 0;

      // Calculate MRR and ARR (simplified)
      const monthlyRevenue = successfulPayments
        .filter(payment => {
          const subscription = payment.subscription as { plan?: Plan } | undefined;
          return subscription?.plan?.interval === 'monthly';
        })
        .reduce((sum, payment) => sum + paymentAmount(payment).toNumber(), 0);

      const yearlyRevenue = successfulPayments
        .filter(payment => {
          const subscription = payment.subscription as { plan?: Plan } | undefined;
          return subscription?.plan?.interval === 'yearly';
        })
        .reduce((sum, payment) => sum + paymentAmount(payment).toNumber(), 0);

      const monthlyRecurringRevenue = monthlyRevenue + yearlyRevenue / 12;
      const annualRecurringRevenue = monthlyRecurringRevenue * 12;

      // Group by tier and status
      const subscriptionsByTier: Record<string, number> = {};
      const subscriptionsByStatus: Record<SubscriptionStatus, number> = {
        active: 0,
        canceled: 0,
        incomplete: 0,
        incomplete_expired: 0,
        past_due: 0,
        paused: 0,
        trialing: 0,
        unpaid: 0,
      };

      for (const subscription of subscriptions) {
        // Group by tier
        const plan = subscription.plan as Plan | undefined;
        const tier = plan?.tier || 'unknown';
        subscriptionsByTier[tier] = (subscriptionsByTier[tier] || 0) + 1;

        // Group by status
        subscriptionsByStatus[subscription.status]++;
      }

      return {
        totalSubscriptions,
        activeSubscriptions,
        churnRate,
        averageRevenuePerUser,
        monthlyRecurringRevenue,
        annualRecurringRevenue,
        subscriptionsByTier,
        subscriptionsByStatus,
      };
    } catch (error) {
      throw new Error(
        `Failed to get subscription analytics: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async syncSubscriptionWithProvider(subscriptionId: SubscriptionId): Promise<Subscription> {
    try {
      // Get the subscription from our database
      const localSubscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
      if (!localSubscription) {
        throw new Error('Subscription not found in local database');
      }

      // Get the subscription from the payment provider
      const providerSubscription = await this.paymentProvider.getSubscription(subscriptionId);
      if (!providerSubscription) {
        throw new Error('Subscription not found in payment provider');
      }

      // Update our database with the provider data. An answer that changes nothing writes no event.
      const updatedSubscription = await this.writes.syncSubscription({
        userId: localSubscription.userId,
        planId: localSubscription.planId,
        customerId: localSubscription.customerId,
        providerSubscriptionId: localSubscription.providerSubscriptionId,
        status: providerSubscription.status,
        currentPeriodStart: providerSubscription.currentPeriodStart,
        currentPeriodEnd: providerSubscription.currentPeriodEnd,
        trialStart: providerSubscription.trialStart,
        trialEnd: providerSubscription.trialEnd,
        canceledAt: providerSubscription.canceledAt,
        cancelAtPeriodEnd: providerSubscription.cancelAtPeriodEnd,
        metadata: providerSubscription.metadata,
      });

      return convertSubscriptionToDomain(updatedSubscription);
    } catch (error) {
      throw new Error(
        `Failed to sync subscription with provider: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async validateSubscriptionAccess(userId: UserId, requiredTiers: string[] = []): Promise<{
    hasAccess: boolean;
    subscription: Subscription | null;
    reason?: string;
  }> {
    try {
      const subscription = await this.getActiveSubscription(userId);

      if (!subscription) {
        return {
          hasAccess: false,
          subscription: null,
          reason: 'No active subscription found',
        };
      }

      if (subscription.status !== 'active' && subscription.status !== 'trialing') {
        return {
          hasAccess: false,
          subscription,
          reason: `Subscription is ${subscription.status}`,
        };
      }

      // If we need to check tiers, we need to get plan data
      if (requiredTiers.length > 0) {
        const subscriptionWithPlan = await this.paymentRepository.findSubscriptionById(subscription.id);
        if (!subscriptionWithPlan?.plan) {
          return {
            hasAccess: false,
            subscription,
            reason: 'Subscription plan not found',
          };
        }

        if (!requiredTiers.includes(subscriptionWithPlan.plan.tier)) {
          return {
            hasAccess: false,
            subscription,
            reason: `Subscription tier ${subscriptionWithPlan.plan.tier} not in required tiers: ${requiredTiers.join(', ')}`,
          };
        }
      }

      return {
        hasAccess: true,
        subscription,
      };
    } catch (error) {
      return {
        hasAccess: false,
        subscription: null,
        reason: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}

export function createSubscriptionManager(
  paymentProvider: BasePaymentProvider,
  paymentRepository: PaymentRepository,
  writes: CoreWrites,
) {
  return new SubscriptionManager(paymentProvider, paymentRepository, writes);
}