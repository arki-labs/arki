import type { Instant } from '@arki/date';
import { fromDate, isAfter, isBefore, now, toDate, toMillis } from '@arki/date';
import { max, Money } from '@arki/money';
import { formatMoney } from '@arki/money/format';

import type { PaymentRepository } from '../repository.js';
import type { Plan, PlanId, Subscription, SubscriptionId, SubscriptionPreview } from '../types.js';
import { planPrice } from '../money.js';

type PlanLike = Partial<Plan> & Pick<Plan, 'id' | 'name' | 'priceMinor' | 'interval' | 'intervalCount' | 'isActive'>;
type SubscriptionLike = Partial<Subscription> &
  Pick<Subscription, 'id' | 'currentPeriodStart' | 'currentPeriodEnd' | 'status'>;

// Utility functions to convert between database and domain types
function convertPlanToDomain(dbPlan: PlanLike): Plan {
  return {
    ...dbPlan,
    description: dbPlan.description ?? '',
    trialPeriodDays: dbPlan.trialPeriodDays ?? null,
    metadata: dbPlan.metadata ?? null,
  } as Plan;
}

function convertSubscriptionToDomain(dbSubscription: SubscriptionLike): Subscription {
  return {
    ...dbSubscription,
    trialStart: dbSubscription.trialStart ?? null,
    trialEnd: dbSubscription.trialEnd ?? null,
    canceledAt: dbSubscription.canceledAt ?? null,
    metadata: dbSubscription.metadata ?? null,
  } as Subscription;
}

export type ProrationCalculation = {
  currentPlan: Plan;
  newPlan: Plan;
  subscription: Subscription;
  remainingTime: RemainingTime;
  costs: ProrationCosts;
  effectiveDate: Instant;
};

/** What is left of the current period. `percentage` is for display; costs use the exact milliseconds. */
type RemainingTime = {
  days: number;
  percentage: number;
  remainingMs: number;
  totalPeriodMs: number;
};

/** All in the plans' currency. Plans in two currencies throw `CurrencyMismatchError`. */
export type ProrationCosts = {
  unusedCredit: Money;
  newPlanProrated: Money;
  immediateCharge: Money;
  nextInvoiceTotal: Money;
};

export type ProrationOptions = {
  effectiveDate?: Instant;
  prorationBehavior: 'create_prorations' | 'none' | 'always_invoice';
  previewOnly?: boolean;
};

/** The reads the service makes. A `PaymentRepository` fits. */
type ProrationReads = Pick<PaymentRepository, 'findSubscriptionById' | 'findPlanById'>;

export class ProrationService {
  constructor(private readonly paymentRepository: ProrationReads) {}

  async calculateProration(
    subscriptionId: SubscriptionId,
    newPlanId: PlanId,
    options: ProrationOptions,
  ): Promise<ProrationCalculation> {
    const dbSubscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
    if (!dbSubscription || !dbSubscription.plan) {
      throw new Error('Subscription not found or missing plan');
    }

    const dbNewPlan = await this.paymentRepository.findPlanById(newPlanId);
    if (!dbNewPlan || !dbNewPlan.isActive) {
      throw new Error('New plan not found or inactive');
    }

    const currentPlan = convertPlanToDomain(dbSubscription.plan);
    const newPlan = convertPlanToDomain(dbNewPlan);
    const subscription = convertSubscriptionToDomain(dbSubscription);
    const effectiveDate = options.effectiveDate || now();

    const remainingTime = this.calculateRemainingTime(subscription, effectiveDate);

    const costs = this.calculateProrationCosts(
      currentPlan,
      newPlan,
      remainingTime,
      options.prorationBehavior,
    );

    return {
      currentPlan,
      newPlan,
      subscription,
      remainingTime,
      costs,
      effectiveDate,
    };
  }

  async previewSubscriptionChange(
    subscriptionId: SubscriptionId,
    newPlanId: PlanId,
    options: ProrationOptions = { prorationBehavior: 'create_prorations' },
  ): Promise<SubscriptionPreview> {
    const proration = await this.calculateProration(subscriptionId, newPlanId, options);

    const nextBillingDate = this.calculateNextBillingDate(
      proration.subscription,
      proration.currentPlan,
      proration.newPlan,
      proration.effectiveDate,
    );

    return {
      planId: newPlanId,
      proration: {
        immediateTotal: proration.costs.immediateCharge.toJSON(),
        nextInvoiceTotal: proration.costs.nextInvoiceTotal.toJSON(),
        creditApplied: proration.costs.unusedCredit.toJSON(),
      },
      trialEnd: proration.subscription.trialEnd ?? undefined,
      nextBillingDate,
    };
  }

  async previewMultiplePlanChanges(
    subscriptionId: SubscriptionId,
    planIds: PlanId[],
    options: ProrationOptions = { prorationBehavior: 'create_prorations' },
  ): Promise<Record<string, SubscriptionPreview>> {
    const previews: Record<string, SubscriptionPreview> = {};

    for (const planId of planIds) {
      try {
        previews[planId] = await this.previewSubscriptionChange(subscriptionId, planId, options);
      } catch (error) {
        console.warn(`Failed to preview plan ${planId}:`, error);
      }
    }

    return previews;
  }

  async getOptimalChangeTimings(
    subscriptionId: SubscriptionId,
    newPlanId: PlanId,
  ): Promise<{
    immediate: ProrationCalculation;
    nextBillingCycle: ProrationCalculation;
    recommendations: {
      bestOption: 'immediate' | 'next_cycle';
      reason: string;
      savings?: Money;
    };
  }> {
    const immediate = await this.calculateProration(subscriptionId, newPlanId, {
      prorationBehavior: 'create_prorations',
      effectiveDate: now(),
    });

    const subscription = await this.paymentRepository.findSubscriptionById(subscriptionId);
    if (!subscription) {
      throw new Error('Subscription not found');
    }

    const nextBillingCycle = await this.calculateProration(subscriptionId, newPlanId, {
      prorationBehavior: 'none',
      effectiveDate: subscription.currentPeriodEnd,
    });

    let bestOption: 'immediate' | 'next_cycle' = 'immediate';
    let reason = 'Immediate change provides better value';
    let savings: Money | undefined;

    const immediateCost = immediate.costs.immediateCharge;
    const nextCycleCost = nextBillingCycle.costs.nextInvoiceTotal;
    const newPrice = planPrice(immediate.newPlan);
    const currentPrice = planPrice(immediate.currentPlan);

    if (nextCycleCost.lt(immediateCost)) {
      bestOption = 'next_cycle';
      reason = 'Waiting until next billing cycle saves money';
      savings = immediateCost.minus(nextCycleCost);
    } else if (newPrice.lt(currentPrice)) {
      bestOption = 'immediate';
      reason = 'Start saving immediately with lower-tier plan';
    } else if (newPrice.gt(currentPrice) && immediateCost.gt(newPrice)) {
      bestOption = 'next_cycle';
      reason = 'Avoid double-billing by waiting for next cycle';
      savings = immediateCost.minus(nextCycleCost);
    }

    return {
      immediate,
      nextBillingCycle,
      recommendations: {
        bestOption,
        reason,
        savings,
      },
    };
  }

  private calculateRemainingTime(subscription: Subscription, effectiveDate: Instant): RemainingTime {
    const currentPeriodStart = subscription.currentPeriodStart;
    const currentPeriodEnd = subscription.currentPeriodEnd;
    const effective = effectiveDate;

    if (isBefore(effective, currentPeriodStart)) {
      throw new Error('Effective date cannot be before current period start');
    }

    if (isAfter(effective, currentPeriodEnd)) {
      throw new Error('Effective date cannot be after current period end');
    }

    const totalPeriodMs = toMillis(currentPeriodEnd) - toMillis(currentPeriodStart);
    const remainingMs = toMillis(currentPeriodEnd) - toMillis(effective);

    const days = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
    const percentage = (remainingMs / totalPeriodMs) * 100;

    return { days, percentage: Math.round(percentage * 100) / 100, remainingMs, totalPeriodMs };
  }

  /**
   * The part of `price` for the time left, split by `allocate`: the part left
   * and the part used always add up to the price exactly, so a credit never
   * gives back a cent more or less than was paid for the period.
   */
  private remainingShare(price: Money, remainingTime: RemainingTime): Money {
    const [remaining] = price.allocate([
      remainingTime.remainingMs,
      remainingTime.totalPeriodMs - remainingTime.remainingMs,
    ]);
    if (!remaining) {
      throw new Error('allocate returned no parts');
    }
    return remaining;
  }

  private calculateProrationCosts(
    currentPlan: Plan,
    newPlan: Plan,
    remainingTime: RemainingTime,
    prorationBehavior: 'create_prorations' | 'none' | 'always_invoice',
  ): ProrationCosts {
    const currentPrice = planPrice(currentPlan);
    const newPrice = planPrice(newPlan);
    // Plans in two currencies throw CurrencyMismatchError where a credit meets a charge
    const zero = Money.zero(newPrice.currency);
    const currentPlanProrated = this.remainingShare(currentPrice, remainingTime);
    const newPlanProrated = this.remainingShare(newPrice, remainingTime);

    let unusedCredit = zero;
    let immediateCharge = zero;
    const nextInvoiceTotal = newPrice;

    switch (prorationBehavior) {
      case 'create_prorations': {
        unusedCredit = currentPlanProrated;
        immediateCharge = max(zero, newPlanProrated.minus(unusedCredit));
        break;
      }
      case 'none': {
        break;
      }
      case 'always_invoice': {
        immediateCharge = newPlanProrated;
        break;
      }
    }

    return { unusedCredit, newPlanProrated, immediateCharge, nextInvoiceTotal };
  }

  private calculateNextBillingDate(
    subscription: Subscription,
    currentPlan: Plan,
    newPlan: Plan,
    effectiveDate: Instant,
  ): Instant {
    if (newPlan.interval !== currentPlan.interval) {
      // Local-time calendar steps, as before: the working value stays a `Date` until it is returned.
      const nextBilling = toDate(effectiveDate);

      switch (newPlan.interval) {
        case 'monthly': {
          nextBilling.setMonth(nextBilling.getMonth() + (newPlan.intervalCount || 1));
          break;
        }
        case 'yearly': {
          nextBilling.setFullYear(nextBilling.getFullYear() + (newPlan.intervalCount || 1));
          break;
        }
        case 'weekly': {
          nextBilling.setDate(nextBilling.getDate() + 7 * (newPlan.intervalCount || 1));
          break;
        }
        case 'daily': {
          nextBilling.setDate(nextBilling.getDate() + (newPlan.intervalCount || 1));
          break;
        }
      }

      return fromDate(nextBilling);
    }

    return subscription.currentPeriodEnd;
  }

  async generateProrationSummary(
    subscriptionId: SubscriptionId,
    newPlanId: PlanId,
    options: ProrationOptions,
  ): Promise<{
    title: string;
    description: string;
    breakdown: {
      label: string;
      amount: Money;
      description?: string;
    }[];
    totalChange: Money;
    effectiveDate: string;
  }> {
    const proration = await this.calculateProration(subscriptionId, newPlanId, options);
    const newPrice = planPrice(proration.newPlan);

    const isUpgrade = newPrice.gt(planPrice(proration.currentPlan));
    const title = isUpgrade ? 'Plan Upgrade' : 'Plan Downgrade';

    const breakdown: {
      label: string;
      amount: Money;
      description?: string;
    }[] = [];

    if (proration.costs.unusedCredit.isPositive()) {
      breakdown.push({
        label: 'Unused credit from current plan',
        amount: proration.costs.unusedCredit.negated(),
        description: `${proration.remainingTime.days} days remaining on ${proration.currentPlan.name}`,
      });
    }

    if (proration.costs.newPlanProrated.isPositive()) {
      breakdown.push({
        label: `Prorated charge for ${proration.newPlan.name}`,
        amount: proration.costs.newPlanProrated,
        description: `${proration.remainingTime.days} days at ${formatMoney(newPrice)}/${proration.newPlan.interval}`,
      });
    }

    const totalChange = proration.costs.immediateCharge;

    let description = `Your plan will change from ${proration.currentPlan.name} to ${proration.newPlan.name}`;
    if (totalChange.isPositive()) {
      description += ` with an immediate charge of ${formatMoney(totalChange)}.`;
    } else if (totalChange.isNegative()) {
      description += ` with a credit of ${formatMoney(totalChange.abs())}.`;
    } else {
      description += ' with no immediate charge.';
    }

    return {
      title,
      description,
      breakdown,
      totalChange,
      effectiveDate: proration.effectiveDate.toString().split('T')[0]!,
    };
  }
}

export function createProrationService(paymentRepository: ProrationReads): ProrationService {
  return new ProrationService(paymentRepository);
}
