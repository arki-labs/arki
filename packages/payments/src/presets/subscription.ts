import type Stripe from 'stripe';

import type { PaymentRepository } from '../core/repository';
import type { NewSubscription, PlanId, SubscriptionStatus } from '../core/types';

/**
 * Project a Stripe Subscription object onto our `subscriptions` table.
 *
 * This is the "webhook in" half of the subscription preset: Stripe Checkout creates the
 * subscription on Stripe's side, then `customer.subscription.{created,updated,deleted}` webhooks
 * carry the truth back here. We resolve our local customer row (created at checkout) by the Stripe
 * customer id, map the Stripe fields onto the table, and **upsert by `providerSubscriptionId`** so
 * repeated or out-of-order webhook deliveries converge to one row rather than duplicating.
 *
 * Cancellation needs no special case: a deleted/canceled subscription arrives with
 * `status: 'canceled'`, which the status map carries straight through.
 */
export async function projectStripeSubscription(params: {
  repo: PaymentRepository;
  subscription: Stripe.Subscription;
  /** Our plan-row id for the price this subscription is on (resolved from the preset config). */
  planId: PlanId;
  /** Provider status → our `SubscriptionStatus` (pass `provider.mapSubscriptionStatus`). */
  mapStatus: (providerStatus: string) => SubscriptionStatus;
}): Promise<void> {
  const { repo, subscription: sub, planId, mapStatus } = params;

  const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const customer = await repo.findCustomerByProviderCustomerId(stripeCustomerId, 'stripe');
  if (!customer) {
    // The local customer row is created at checkout time. A subscription event with no matching
    // customer is an out-of-band subscription we can't attribute to a user — surface loudly
    // rather than silently inventing an owner.
    throw new Error(
      `[@arki/payments] subscription ${sub.id}: no local customer for Stripe customer ${stripeCustomerId}`,
    );
  }

  // In recent Stripe API versions the billing period lives on the subscription *item*, not the
  // subscription. There is always at least one item for a subscription.
  const item = sub.items.data[0];
  if (!item) {
    throw new Error(`[@arki/payments] subscription ${sub.id}: no line items to read the period from`);
  }

  const fields: NewSubscription = {
    userId: customer.userId,
    customerId: customer.id,
    planId,
    providerSubscriptionId: sub.id,
    status: mapStatus(sub.status),
    currentPeriodStart: new Date(item.current_period_start * 1000),
    currentPeriodEnd: new Date(item.current_period_end * 1000),
    trialStart: sub.trial_start ? new Date(sub.trial_start * 1000) : null,
    trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    metadata: sub.metadata as Record<string, unknown>,
  };

  const existing = await repo.findSubscriptionByProviderSubscriptionId(sub.id);
  if (existing) {
    await repo.updateSubscription(existing.id, fields);
  } else {
    await repo.createSubscription(fields);
  }
}
