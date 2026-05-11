import type { PaymentRepository } from '../repository';
import type { Plan, PlanId, Subscription, SubscriptionId, SubscriptionPreview } from '../types';

type PlanLike = Partial<Plan> & Pick<Plan, 'id' | 'name' | 'price' | 'interval' | 'intervalCount' | 'isActive'>;
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
  remainingTime: {
    days: number;
    percentage: number;
  };
  costs: {
    unusedCredit: number;
    newPlanProrated: number;
    immediateCharge: number;
    nextInvoiceTotal: number;
  };
  effectiveDate: Date;
};

export type ProrationOptions = {
  effectiveDate?: Date;
  prorationBehavior: 'create_prorations' | 'none' | 'always_invoice';
  previewOnly?: boolean;
};

export class ProrationService {
  constructor(private readonly paymentRepository: PaymentRepository) {}

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
    const effectiveDate = options.effectiveDate || new Date();

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
        immediateTotal: proration.costs.immediateCharge,
        nextInvoiceTotal: proration.costs.nextInvoiceTotal,
        creditApplied: proration.costs.unusedCredit,
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
      savings?: number;
    };
  }> {
    const immediate = await this.calculateProration(subscriptionId, newPlanId, {
      prorationBehavior: 'create_prorations',
      effectiveDate: new Date(),
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
    let savings: number | undefined;

    const immediateCost = immediate.costs.immediateCharge;
    const nextCycleCost = nextBillingCycle.costs.nextInvoiceTotal;

    if (nextCycleCost < immediateCost) {
      bestOption = 'next_cycle';
      reason = 'Waiting until next billing cycle saves money';
      savings = immediateCost - nextCycleCost;
    } else if (immediate.newPlan.price < immediate.currentPlan.price) {
      bestOption = 'immediate';
      reason = 'Start saving immediately with lower-tier plan';
    } else if (
      immediate.newPlan.price > immediate.currentPlan.price &&
      immediateCost > immediate.newPlan.price
    ) {
      bestOption = 'next_cycle';
      reason = 'Avoid double-billing by waiting for next cycle';
      savings = immediateCost - nextCycleCost;
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

  private calculateRemainingTime(
    subscription: Subscription,
    effectiveDate: Date,
  ): { days: number; percentage: number } {
    const currentPeriodStart = new Date(subscription.currentPeriodStart);
    const currentPeriodEnd = new Date(subscription.currentPeriodEnd);
    const effective = new Date(effectiveDate);

    if (effective < currentPeriodStart) {
      throw new Error('Effective date cannot be before current period start');
    }

    if (effective > currentPeriodEnd) {
      throw new Error('Effective date cannot be after current period end');
    }

    const totalPeriodMs = currentPeriodEnd.getTime() - currentPeriodStart.getTime();
    const remainingMs = currentPeriodEnd.getTime() - effective.getTime();

    const days = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
    const percentage = (remainingMs / totalPeriodMs) * 100;

    return { days, percentage: Math.round(percentage * 100) / 100 };
  }

  private calculateProrationCosts(
    currentPlan: Plan,
    newPlan: Plan,
    remainingTime: { days: number; percentage: number },
    prorationBehavior: 'create_prorations' | 'none' | 'always_invoice',
  ): {
    unusedCredit: number;
    newPlanProrated: number;
    immediateCharge: number;
    nextInvoiceTotal: number;
  } {
    const currentPlanProrated = (currentPlan.price * remainingTime.percentage) / 100;
    const newPlanProrated = (newPlan.price * remainingTime.percentage) / 100;

    let unusedCredit = 0;
    let immediateCharge = 0;
    let nextInvoiceTotal = newPlan.price;

    switch (prorationBehavior) {
      case 'create_prorations': {
        unusedCredit = currentPlanProrated;
        immediateCharge = Math.max(0, newPlanProrated - unusedCredit);
        break;
      }
      case 'none': {
        unusedCredit = 0;
        immediateCharge = 0;
        nextInvoiceTotal = newPlan.price;
        break;
      }
      case 'always_invoice': {
        unusedCredit = 0;
        immediateCharge = newPlanProrated;
        break;
      }
    }

    return {
      unusedCredit: Math.round(unusedCredit * 100) / 100,
      newPlanProrated: Math.round(newPlanProrated * 100) / 100,
      immediateCharge: Math.round(immediateCharge * 100) / 100,
      nextInvoiceTotal: Math.round(nextInvoiceTotal * 100) / 100,
    };
  }

  private calculateNextBillingDate(
    subscription: Subscription,
    currentPlan: Plan,
    newPlan: Plan,
    effectiveDate: Date,
  ): Date {
    const effective = new Date(effectiveDate);

    if (newPlan.interval !== currentPlan.interval) {
      const nextBilling = new Date(effective);

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

      return nextBilling;
    }

    return new Date(subscription.currentPeriodEnd);
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
      amount: number;
      description?: string;
    }[];
    totalChange: number;
    effectiveDate: string;
  }> {
    const proration = await this.calculateProration(subscriptionId, newPlanId, options);

    const isUpgrade = proration.newPlan.price > proration.currentPlan.price;
    const title = isUpgrade ? 'Plan Upgrade' : 'Plan Downgrade';

    const breakdown: {
      label: string;
      amount: number;
      description?: string;
    }[] = [];

    if (proration.costs.unusedCredit > 0) {
      breakdown.push({
        label: 'Unused credit from current plan',
        amount: -proration.costs.unusedCredit,
        description: `${proration.remainingTime.days} days remaining on ${proration.currentPlan.name}`,
      });
    }

    if (proration.costs.newPlanProrated > 0) {
      breakdown.push({
        label: `Prorated charge for ${proration.newPlan.name}`,
        amount: proration.costs.newPlanProrated,
        description: `${proration.remainingTime.days} days at $${proration.newPlan.price}/${proration.newPlan.interval}`,
      });
    }

    const totalChange = proration.costs.immediateCharge;

    let description = `Your plan will change from ${proration.currentPlan.name} to ${proration.newPlan.name}`;
    if (totalChange > 0) {
      description += ` with an immediate charge of $${totalChange.toFixed(2)}.`;
    } else if (totalChange < 0) {
      description += ` with a credit of $${Math.abs(totalChange).toFixed(2)}.`;
    } else {
      description += ' with no immediate charge.';
    }

    return {
      title,
      description,
      breakdown,
      totalChange,
      effectiveDate: proration.effectiveDate.toISOString().split('T')[0]!,
    };
  }
}

export function createProrationService(paymentRepository: PaymentRepository): ProrationService {
  return new ProrationService(paymentRepository);
}
