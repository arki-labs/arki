import type { IdGenerationFailure } from '@arki/contracts';
import type { FailureOf } from '@arki/failure';
import { isFailure } from '@arki/failure';
import type Stripe from 'stripe';

import type { UserId } from '../core/user-id.js';
import type { Instant } from '@arki/date';
import { fromUnix } from '@arki/date';

import type { CoreWrites } from '../core/journal.js';
import type { JournalWriteFailure } from '../core/journal/support.js';
import type { CustomerConflict } from '../core/failures.js';
import type { InvalidWebhookSignature } from '../core/providers/provider-error.js';
import type { StripeProvider } from '../core/providers/stripe-provider.js';
import type { PaymentRepository } from '../core/repository.js';
import type { PlanId, SubscriptionStatus } from '../core/types.js';
import { subscriptionStatusSchema } from '../core/contracts.js';
import {
  PriceNotConfigured,
  SubscriptionWithoutItems,
  UnknownProviderCustomer,
  UnknownSubscriptionStatus,
} from './failures.js';

/** The one journal write a webhook preset makes. A `CoreWrites` fits. */
type SubscriptionSync = Pick<CoreWrites, 'syncSubscription'>;

/** Why `projectStripeSubscription` stored nothing. */
type ProjectionFailure =
  | FailureOf<typeof UnknownProviderCustomer>
  | FailureOf<typeof SubscriptionWithoutItems>
  | FailureOf<typeof UnknownSubscriptionStatus>
  | JournalWriteFailure;

/**
 * Project a Stripe Subscription object onto our `subscriptions` table.
 *
 * This is the "webhook in" half of the subscription preset: Stripe Checkout creates the
 * subscription on Stripe's side, then `customer.subscription.{created,updated,deleted}` webhooks
 * carry the truth back here. We resolve our local customer row (created at checkout) by the Stripe
 * customer id, map the Stripe fields to a provider snapshot, and hand it to the journal command
 * `syncSubscription`. The command **upserts by `providerSubscriptionId`**, so repeated or
 * out-of-order webhook deliveries converge to one row, and a delivery that changes nothing
 * writes no event. A refused write is returned unchanged; the webhook route must reject it.
 *
 * Cancellation needs no special case: a deleted/canceled subscription arrives with
 * `status: 'canceled'`, which is stored as it is.
 *
 * The event is outside data, so what cannot be stored is returned before anything is written:
 * `UnknownProviderCustomer` (no local customer row, such as a subscription made in the Stripe
 * dashboard: never invent an owner), `SubscriptionWithoutItems` (no billing period to read) and
 * `UnknownSubscriptionStatus` (a status Stripe added later: never guessed).
 */
export async function projectStripeSubscription(params: {
  repo: Pick<PaymentRepository, 'findCustomerByProviderCustomerId'>;
  /** The app's journal writes: `paymentsJournal.writes(run)`. */
  writes: SubscriptionSync;
  subscription: Stripe.Subscription;
  /** Our plan-row id for the price this subscription is on (resolved from the preset config). */
  planId: PlanId;
}): Promise<undefined | ProjectionFailure> {
  const { repo, writes, subscription: sub, planId } = params;

  const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const customer = await repo.findCustomerByProviderCustomerId(stripeCustomerId, 'stripe');
  // The local customer row is created at checkout time
  if (!customer) return UnknownProviderCustomer({ providerCustomerId: stripeCustomerId });

  // In recent Stripe API versions the billing period lives on the subscription *item*, not the subscription
  const item = sub.items.data[0];
  if (!item) return SubscriptionWithoutItems({ providerSubscriptionId: sub.id });

  // Stripe's subscription statuses are ours: the enum was modeled on them
  const status = subscriptionStatusSchema.safeParse(sub.status);
  if (!status.success) return UnknownSubscriptionStatus({ status: sub.status });

  const result = await writes.syncSubscription({
    userId: customer.userId,
    customerId: customer.id,
    planId,
    providerSubscriptionId: sub.id,
    status: status.data,
    currentPeriodStart: fromUnix(item.current_period_start),
    currentPeriodEnd: fromUnix(item.current_period_end),
    trialStart: sub.trial_start ? fromUnix(sub.trial_start) : null,
    trialEnd: sub.trial_end ? fromUnix(sub.trial_end) : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: sub.canceled_at ? fromUnix(sub.canceled_at) : null,
    metadata: sub.metadata,
  });
  if (isFailure(result)) return result;
  return;
}

/* ── entitlement ────────────────────────────────────────────────────────────────────────────── */

/** What the app asks for: is this user Pro, and if so, the period/trial/cancel facts behind it. */
export type Entitlement =
  | { tier: 'free' }
  | {
      tier: 'pro';
      status: SubscriptionStatus;
      /** End of the current paid-or-trial period — when Pro renews or lapses. */
      renews: Instant;
      /** Canceled but retains Pro until `renews`. */
      cancelAtPeriodEnd: boolean;
      /** Trial end if this subscription has/had a trial; null otherwise. */
      trialEnd: Instant | null;
    };

/**
 * Statuses that grant Pro access. **`trialing` is included on purpose** — Stripe marks a
 * free-trial subscription `trialing`, not `active`, so omitting it would lock users out of Pro
 * during the exact trial window meant to sell them on it. `past_due` is deliberately excluded:
 * granting access through a dunning/retry window is a separate policy decision, not the default.
 */
const PRO_GRANTING_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([
  'active',
  'trialing',
]);

/**
 * Read a user's current entitlement straight from our own `subscriptions` table — the single
 * source of truth. Both rails (web Stripe webhooks, native RevenueCat webhooks) project into this
 * table, so this one read answers "is Pro?" regardless of where the purchase happened.
 */
export async function getEntitlement(
  repo: Pick<PaymentRepository, 'findSubscriptionsByUserId'>,
  userId: UserId,
): Promise<Entitlement> {
  const subscriptions = await repo.findSubscriptionsByUserId(userId);
  // findSubscriptionsByUserId returns newest-first; the first granting row is the live one.
  const granting = subscriptions.find((s) => PRO_GRANTING_STATUSES.has(s.status));
  if (!granting) return { tier: 'free' };
  return {
    tier: 'pro',
    status: granting.status,
    renews: granting.currentPeriodEnd,
    cancelAtPeriodEnd: granting.cancelAtPeriodEnd,
    trialEnd: granting.trialEnd,
  };
}

/* ── billing preset ─────────────────────────────────────────────────────────────────────────── */

/** A Stripe price wired to the local plan row it represents (monthly + yearly can share a plan). */
export type PriceToPlan = { priceId: string; planId: PlanId };

export type SubscriptionBillingConfig = {
  provider: StripeProvider;
  /** Reads, and the customer row made at checkout. A `PaymentRepository` fits. */
  repo: Pick<
    PaymentRepository,
    'findCustomerByUserId' | 'createCustomer' | 'findCustomerByProviderCustomerId' | 'findSubscriptionsByUserId'
  >;
  /** Every change of a `subscriptions` row goes through the journal: `paymentsJournal.writes(run)`. */
  writes: SubscriptionSync;
  /** Every price the app sells, each mapped to its local plan row. */
  prices: readonly PriceToPlan[];
  /** Where Checkout sends the browser back to. */
  urls: { success: string; cancel: string };
  /** Free-trial length applied to new subscriptions; omit for no trial. */
  trialDays?: number;
  /** Enable Stripe Tax at checkout (EU VAT). Requires Stripe Tax configured on the account. */
  automaticTax?: boolean;
};

export type SubscriptionBilling = ReturnType<typeof createSubscriptionBilling>;

/** The three Stripe events `handleWebhook` projects onto the `subscriptions` table. */
type SubscriptionEventType =
  'customer.subscription.created' | 'customer.subscription.updated' | 'customer.subscription.deleted';

/** What `handleWebhook` returns for a verified event: whether it changed a subscription, and the event's type. */
export type StripeWebhookOutcome =
  | { handled: boolean; type: SubscriptionEventType }
  | { handled: boolean; type: Exclude<Stripe.Event['type'], SubscriptionEventType> };

/**
 * The high-level subscription-billing preset: the whole web Stripe flow — checkout, webhook
 * projection, entitlement — behind three methods, so a consuming app wires routes instead of
 * re-implementing the Stripe dance.
 *
 * Customers are found-or-created at checkout: the `subscriptions` table's `customerId`/`planId`
 * are NOT NULL, so a local customer row must exist *before* the subscription webhook arrives (the
 * projection resolves the owning user via the Stripe customer id).
 */
export function createSubscriptionBilling(config: SubscriptionBillingConfig) {
  const { provider, repo, writes, urls, trialDays, automaticTax } = config;
  const planByPrice = new Map(config.prices.map((p) => [p.priceId, p.planId]));

  return {
    /**
     * Start a hosted Checkout subscribe flow; returns the URL to redirect the browser to.
     * A price that is not in `prices` returns `PriceNotConfigured` before any provider request.
     */
    async createCheckoutSession({
      userId,
      email,
      priceId,
    }: {
      userId: UserId;
      email: string;
      priceId: string;
    }): Promise<
      | Awaited<ReturnType<StripeProvider['createCheckoutSession']>>
      | IdGenerationFailure
      | FailureOf<typeof PriceNotConfigured>
      | FailureOf<typeof CustomerConflict>
    > {
      if (!planByPrice.has(priceId)) return PriceNotConfigured({ priceId });

      // Find-or-create the local customer so the subscription webhook can attribute the row to a
      // user. `provider.createCustomer` also creates the Stripe-side customer.
      let customer = await repo.findCustomerByUserId(userId);
      if (!customer) {
        const created = await provider.createCustomer({ userId, email });
        if (isFailure(created)) return created;
        const stored = await repo.createCustomer(created);
        if (isFailure(stored)) return stored;
        customer = stored;
      }

      return provider.createCheckoutSession({
        priceId,
        providerCustomerId: customer.providerCustomerId,
        successUrl: urls.success,
        cancelUrl: urls.cancel,
        trialPeriodDays: trialDays,
        clientReferenceId: userId,
        metadata: { userId },
        automaticTax,
      });
    },

    /**
     * Verify + project a Stripe webhook. Returns `InvalidWebhookSignature` for a bad signature (answer
     * it with HTTP 400), `SubscriptionWithoutItems` or `PriceNotConfigured` for a subscription it cannot
     * map to a plan, the failures of `projectStripeSubscription`, and the journal's refused writes.
     * Nothing is written for any of them; a webhook route must not acknowledge them.
     */
    async handleWebhook(
      payload: string | Buffer,
      signature: string,
    ): Promise<
      | StripeWebhookOutcome
      | FailureOf<typeof InvalidWebhookSignature>
      | FailureOf<typeof SubscriptionWithoutItems>
      | FailureOf<typeof PriceNotConfigured>
      | ProjectionFailure
    > {
      const event = provider.constructWebhookEvent(payload, signature);
      if (isFailure(event)) return event;

      if (
        event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted'
      ) {
        // Narrowed by Stripe's discriminated `Event` union — `data.object` is a
        // `Stripe.Subscription` here with no cast.
        const subscription = event.data.object;
        const item = subscription.items.data[0];
        if (!item) return SubscriptionWithoutItems({ providerSubscriptionId: subscription.id });
        const planId = planByPrice.get(item.price.id);
        if (!planId) return PriceNotConfigured({ priceId: item.price.id });
        const result = await projectStripeSubscription({ repo, writes, subscription, planId });
        if (isFailure(result)) return result;
        return { handled: true, type: event.type };
      }

      return { handled: false, type: event.type };
    },

    /** Current Pro/free entitlement for a user, read from our table. */
    getEntitlement(userId: UserId) {
      return getEntitlement(repo, userId);
    },
  };
}
