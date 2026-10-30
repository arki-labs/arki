import type { UserId } from '../user-id.js';
import type { Instant } from '@arki/date';
import { fromDate } from '@arki/date';
import { isFailure } from '@arki/failure';

import type { CoreWrites } from '../journal.js';
import type { BasePaymentProvider } from '../providers/base-provider.js';
import type { PaymentRepository } from '../repository.js';
import type { PlanId, Subscription, SubscriptionId, SubscriptionStatus } from '../types.js';
import { PlanInactive, SubscriptionAlreadyActive, SubscriptionInvalidState } from '../failures.js';
import { paymentAmount } from '../money.js';
import { ReferenceNotFound } from '../providers/provider-error.js';

/** What a caller asks a subscription to do, as `SubscriptionInvalidState` names it. */
type SubscriptionAction = ReturnType<typeof SubscriptionInvalidState>['data']['action'];

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

  /**
   * Start a subscription for a user who has a customer and no active subscription. Returns the
   * provider's subscription, or a failure: `ReferenceNotFound` (no customer for the user, or no
   * plan), `PlanInactive`, `SubscriptionAlreadyActive`, or what the provider returned.
   */
  async createSubscription(
    userId: UserId,
    planId: PlanId,
    options: SubscriptionCreationOptions = {},
  ) {
    const customer = await this.paymentRepository.findCustomerByUserId(userId);
    if (!customer) return ReferenceNotFound({ kind: 'customer', id: userId, missing: 'row' });

    const plan = await this.activePlan(planId);
    if (isFailure(plan)) return plan;

    const existingSubscription = await this.paymentRepository.findActiveSubscriptionByUserId(userId);
    if (existingSubscription) {
      return SubscriptionAlreadyActive({ userId, subscriptionId: existingSubscription.id });
    }

    return this.paymentProvider.createSubscription({
      customerId: customer.id,
      planId,
      paymentMethodId: options.paymentMethodId,
      trialPeriodDays: options.trialPeriodDays ?? plan.trialPeriodDays ?? undefined,
      metadata: options.metadata,
    });
  }

  /**
   * Move an active subscription to another active plan. Returns the provider's subscription and
   * the preview, or a failure: `ReferenceNotFound`, `SubscriptionInvalidState`, `PlanInactive`,
   * what the provider returned, or the refusal of the journal write.
   */
  async updateSubscription(
    subscriptionId: SubscriptionId,
    newPlanId: PlanId,
    options: SubscriptionChangeOptions = {},
  ) {
    const currentSubscription = await this.subscriptionIn(subscriptionId, ['active'], 'update');
    if (isFailure(currentSubscription)) return currentSubscription;

    const newPlan = await this.activePlan(newPlanId);
    if (isFailure(newPlan)) return newPlan;

    // Preview the change first
    const preview = await this.paymentProvider.previewSubscriptionChange({
      subscriptionId,
      planId: newPlanId,
      prorationBehavior: options.prorationBehavior || 'create_prorations',
    });
    if (isFailure(preview)) return preview;

    // Update the subscription
    const updatedSubscription = await this.paymentProvider.updateSubscription(subscriptionId, {
      planId: newPlanId,
      prorationBehavior: options.prorationBehavior || 'create_prorations',
    });
    // A refused change stored nothing: the row keeps the old plan
    if (isFailure(updatedSubscription)) return updatedSubscription;

    // The provider moved the plan; store it. The provider's answer says which plan it is on now.
    const stored = await this.writes.changeSubscriptionPlan({ subscriptionId, planId: updatedSubscription.planId });
    if (isFailure(stored)) return stored;

    return {
      subscription: updatedSubscription,
      preview,
    };
  }

  /**
   * Set or clear "ends when the paid period ends". The provider changes the flag, then the row follows.
   * Unlike `cancelSubscription` it never cancels now, and `false` undoes an earlier `true`.
   */
  async setCancelAtPeriodEnd(subscriptionId: SubscriptionId, cancelAtPeriodEnd: boolean) {
    const currentSubscription = await this.subscriptionNotCanceled(subscriptionId, 'set_cancel_at_period_end');
    if (isFailure(currentSubscription)) return currentSubscription;

    const updatedSubscription = await this.paymentProvider.updateSubscription(subscriptionId, { cancelAtPeriodEnd });
    if (isFailure(updatedSubscription)) return updatedSubscription;

    const stored = await this.writes.setSubscriptionCancelAtPeriodEnd({
      subscriptionId,
      cancelAtPeriodEnd: updatedSubscription.cancelAtPeriodEnd,
    });
    if (isFailure(stored)) return stored;

    return updatedSubscription;
  }

  async cancelSubscription(
    subscriptionId: SubscriptionId,
    options: SubscriptionCancellationOptions = {},
  ) {
    const currentSubscription = await this.subscriptionNotCanceled(subscriptionId, 'cancel');
    if (isFailure(currentSubscription)) return currentSubscription;

    // Cancel with the payment provider
    const canceledSubscription = await this.paymentProvider.cancelSubscription(subscriptionId, {
      immediately: options.immediately || false,
      reason: options.reason,
    });
    if (isFailure(canceledSubscription)) return canceledSubscription;

    // Update our database
    const stored = await this.writes.cancelSubscription({
      subscriptionId,
      status: canceledSubscription.status,
      canceledAt: canceledSubscription.canceledAt,
      cancelAtPeriodEnd: canceledSubscription.cancelAtPeriodEnd,
    });
    if (isFailure(stored)) return stored;

    return canceledSubscription;
  }

  async reactivateSubscription(subscriptionId: SubscriptionId) {
    const currentSubscription = await this.subscriptionIn(subscriptionId, ['canceled', 'past_due'], 'reactivate');
    if (isFailure(currentSubscription)) return currentSubscription;

    // Reactivate with the payment provider
    const reactivatedSubscription = await this.paymentProvider.reactivateSubscription(subscriptionId);
    if (isFailure(reactivatedSubscription)) return reactivatedSubscription;

    // Update our database. The event clears the cancellation.
    const stored = await this.writes.reactivateSubscription({
      subscriptionId,
      status: reactivatedSubscription.status,
    });
    if (isFailure(stored)) return stored;

    return reactivatedSubscription;
  }

  async pauseSubscription(subscriptionId: SubscriptionId) {
    const currentSubscription = await this.subscriptionIn(subscriptionId, ['active'], 'pause');
    if (isFailure(currentSubscription)) return currentSubscription;

    // Pause with the payment provider
    const pausedSubscription = await this.paymentProvider.pauseSubscription(subscriptionId);
    if (isFailure(pausedSubscription)) return pausedSubscription;

    // Update our database
    const stored = await this.writes.pauseSubscription({ subscriptionId, status: pausedSubscription.status });
    if (isFailure(stored)) return stored;

    return pausedSubscription;
  }

  async resumeSubscription(subscriptionId: SubscriptionId) {
    const currentSubscription = await this.subscriptionIn(subscriptionId, ['paused'], 'resume');
    if (isFailure(currentSubscription)) return currentSubscription;

    // Resume with the payment provider
    const resumedSubscription = await this.paymentProvider.resumeSubscription(subscriptionId);
    if (isFailure(resumedSubscription)) return resumedSubscription;

    // Update our database
    const stored = await this.writes.resumeSubscription({ subscriptionId, status: resumedSubscription.status });
    if (isFailure(stored)) return stored;

    return resumedSubscription;
  }

  /** The stored subscription when its status is one of `allowed`, or the failure that refuses `action`. */
  private async subscriptionIn(
    subscriptionId: SubscriptionId,
    allowed: readonly SubscriptionStatus[],
    action: SubscriptionAction,
  ) {
    const subscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
    if (!subscription) return ReferenceNotFound({ kind: 'subscription', id: subscriptionId, missing: 'row' });
    if (!allowed.includes(subscription.status)) {
      return SubscriptionInvalidState({ subscriptionId, status: subscription.status, action });
    }
    return subscription;
  }

  /** The stored subscription unless it is missing or already canceled. */
  private async subscriptionNotCanceled(subscriptionId: SubscriptionId, action: SubscriptionAction) {
    const subscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
    if (!subscription) return ReferenceNotFound({ kind: 'subscription', id: subscriptionId, missing: 'row' });
    if (subscription.status === 'canceled') {
      return SubscriptionInvalidState({ subscriptionId, status: subscription.status, action });
    }
    return subscription;
  }

  /** The plan when it exists and is offered, or `ReferenceNotFound` / `PlanInactive`. */
  private async activePlan(planId: PlanId) {
    const plan = await this.paymentRepository.findPlanById(planId);
    if (!plan) return ReferenceNotFound({ kind: 'plan', id: planId, missing: 'row' });
    if (!plan.isActive) return PlanInactive({ planId });
    return plan;
  }

  async getSubscription(subscriptionId: SubscriptionId): Promise<Subscription | null> {
    return this.paymentRepository.findSubscriptionById(subscriptionId);
  }

  async getUserSubscriptions(userId: UserId): Promise<Subscription[]> {
    return this.paymentRepository.findSubscriptionsByUserId(userId);
  }

  async getActiveSubscription(userId: UserId): Promise<Subscription | null> {
    return this.paymentRepository.findActiveSubscriptionByUserId(userId);
  }

  /**
   * What a move to `newPlanId` would cost, from the provider. Returns the preview, or a failure:
   * `ReferenceNotFound`, `PlanInactive`, or what the provider returned.
   */
  async previewSubscriptionChange(
    subscriptionId: SubscriptionId,
    newPlanId: PlanId,
    options: SubscriptionChangeOptions = {},
  ) {
    const subscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
    if (!subscription) return ReferenceNotFound({ kind: 'subscription', id: subscriptionId, missing: 'row' });

    const newPlan = await this.activePlan(newPlanId);
    if (isFailure(newPlan)) return newPlan;

    return this.paymentProvider.previewSubscriptionChange({
      subscriptionId,
      planId: newPlanId,
      prorationBehavior: options.prorationBehavior || 'create_prorations',
    });
  }

  /** Trialing subscriptions whose period ends in the local calendar day `daysBeforeExpiration` days from now. */
  async handleTrialEndingSoon(daysBeforeExpiration = 3): Promise<Subscription[]> {
    // Local-time calendar days, as before: the working values stay `Date`s until the query.
    const startDate = new Date();
    startDate.setDate(startDate.getDate() + daysBeforeExpiration - 1);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + daysBeforeExpiration);

    const subscriptions = await this.paymentRepository.findSubscriptionsEndingInRange(fromDate(startDate), fromDate(endDate));

    return subscriptions.filter(sub => sub.status === 'trialing');
  }

  /** Every past due subscription. */
  async handlePastDueSubscriptions(): Promise<Subscription[]> {
    return this.paymentRepository.findSubscriptionsByStatus('past_due');
  }

  async getSubscriptionAnalytics(startDate?: Instant, endDate?: Instant): Promise<SubscriptionAnalytics> {
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
      .filter(payment => payment.subscription?.plan?.interval === 'monthly')
      .reduce((sum, payment) => sum + paymentAmount(payment).toNumber(), 0);

    const yearlyRevenue = successfulPayments
      .filter(payment => payment.subscription?.plan?.interval === 'yearly')
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
      const tier = subscription.plan?.tier || 'unknown';
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
  }

  /**
   * Store what the provider holds for the subscription. Returns the stored row, or a failure:
   * `ReferenceNotFound` (`missing: 'row'` when we hold no such subscription, `missing: 'provider_id'`
   * when the provider has none for it), or the refusal of the journal write.
   */
  async syncSubscriptionWithProvider(subscriptionId: SubscriptionId) {
    const localSubscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
    if (!localSubscription) return ReferenceNotFound({ kind: 'subscription', id: subscriptionId, missing: 'row' });

    const providerSubscription = await this.paymentProvider.getSubscription(subscriptionId);
    if (!providerSubscription) {
      return ReferenceNotFound({ kind: 'subscription', id: subscriptionId, missing: 'provider_id' });
    }

    // Update our database with the provider data. An answer that changes nothing writes no event.
    return this.writes.syncSubscription({
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
  }

  async validateSubscriptionAccess(userId: UserId, requiredTiers: string[] = []): Promise<{
    hasAccess: boolean;
    subscription: Subscription | null;
    reason?: string;
  }> {
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
  }
}

export function createSubscriptionManager(
  paymentProvider: BasePaymentProvider,
  paymentRepository: PaymentRepository,
  writes: CoreWrites,
) {
  return new SubscriptionManager(paymentProvider, paymentRepository, writes);
}