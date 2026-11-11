import type { IdGenerationFailure } from '@arki/contracts';
import type { FailureOf, SchemaFailure } from '@arki/failure';
import { z } from '@arki/contracts';
import { isFailure } from '@arki/failure';
import { is, parse } from '@arki/schema';
import type Stripe from 'stripe';

import type { UserId } from '../core/user-id.js';
import type { Instant } from '@arki/date';
import { fromUnix } from '@arki/date';

import type { CoreWrites } from '../core/journal.js';
import type { CustomerConflict } from '../core/failures.js';
import type { InvalidWebhookSignature, ReferenceNotFound } from '../core/providers/provider-error.js';
import type { StripeProvider } from '../core/providers/stripe-provider.js';
import type { PaymentRepository } from '../core/repository.js';
import type { PlanId, SubscriptionStatus } from '../core/types.js';
import { subscriptionStatusSchema } from '../core/contracts.js';
import { PaymentsConfigurationInvalid } from '../core/failures.js';
import { holdsLoneSurrogate, pgTextSchema, pgVarcharSchema } from '../core/pg-values.js';
import { userIdSchema } from '../core/user-id.js';
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
  | SchemaFailure
  | FailureOf<SubscriptionSync['syncSubscription']>;

/** A Stripe id the `subscriptions` and `customers` columns can hold: 1 to 255 characters, no U+0000. */
const stripeIdSchema = pgVarcharSchema(255).min(1);

/**
 * The fields of a Stripe Subscription the presets read. A webhook body is outside data even when its
 * signature checks out (A-39), so a body missing one of them is `schema.invalid_input`, not a `TypeError`.
 * Times are read by `subscriptionTimesSchema` below.
 */
const stripeSubscriptionSchema = z.object({
  id: stripeIdSchema,
  customer: z.union([stripeIdSchema, z.object({ id: stripeIdSchema })]),
  status: z.string(),
  items: z.object({
    data: z.array(
      z.object({
        price: z.object({ id: z.string() }),
        current_period_start: z.unknown(),
        current_period_end: z.unknown(),
      }),
    ),
  }),
  trial_start: z.unknown(),
  trial_end: z.unknown(),
  canceled_at: z.unknown(),
  cancel_at_period_end: z.boolean(),
  metadata: z.record(pgTextSchema, pgTextSchema),
});
type StripeSubscriptionFields = z.output<typeof stripeSubscriptionSchema>;

/**
 * The user a checkout is for. It goes to Stripe (customer metadata, `client_reference_id`) and to the
 * `customers` row, so it holds no U+0000 (the row refuses it) and no lone surrogate (Stripe refuses it).
 */
const checkoutUserIdSchema = userIdSchema.refine(id => !holdsLoneSurrogate(id), 'A user id cannot contain a lone surrogate');

/** What the checkout stores for a new customer: the `customers.email` column holds 255 characters. */
const checkoutEmailSchema = pgVarcharSchema(255).pipe(z.email());

/** The trial Stripe Checkout takes: `trial_period_days` is a whole number from 1 to 730. */
const trialDaysSchema = z.int().min(1).max(730);

/**
 * A Stripe time in Unix seconds, up to the last second of year 9999, read as an `Instant`. The
 * webhook body is outside data: `fromUnix` throws for a number that is not finite or past its
 * range (JSON can carry `1e400`, read as `Infinity`), so the schema refuses those first.
 */
const unixSecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(253_402_300_799)
  .transform(seconds => fromUnix(seconds));

/** The times `projectStripeSubscription` stores, read from the subscription and its first item. */
const subscriptionTimesSchema = z.object({
  currentPeriodStart: unixSecondsSchema,
  currentPeriodEnd: unixSecondsSchema,
  trialStart: unixSecondsSchema.nullable(),
  trialEnd: unixSecondsSchema.nullable(),
  canceledAt: unixSecondsSchema.nullable(),
});

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
 * dashboard: never invent an owner), `SubscriptionWithoutItems` (no billing period to read),
 * `UnknownSubscriptionStatus` (a status Stripe added later: never guessed) and `InvalidInput`
 * (`schema.invalid_input`: a subscription body missing a field the projection reads, an id that
 * does not fit its column, or a period, trial or cancel time that is not whole Unix seconds up to
 * year 9999). The sync's own failures come back unchanged, `ReferenceNotFound` for a plan with no row among them.
 */
export async function projectStripeSubscription(params: {
  repo: Pick<PaymentRepository, 'findCustomerByProviderCustomerId'>;
  /** The app's journal writes: `paymentsJournal.writes(run)`. */
  writes: SubscriptionSync;
  subscription: Stripe.Subscription;
  /** Our plan-row id for the price this subscription is on (resolved from the preset config). */
  planId: PlanId;
}): Promise<undefined | ProjectionFailure> {
  const sub = parse(stripeSubscriptionSchema, params.subscription);
  if (isFailure(sub)) return sub;
  return projectSubscription(params.repo, params.writes, sub, params.planId);
}

async function projectSubscription(
  repo: Pick<PaymentRepository, 'findCustomerByProviderCustomerId'>,
  writes: SubscriptionSync,
  sub: StripeSubscriptionFields,
  planId: PlanId,
): Promise<undefined | ProjectionFailure> {
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

  // `||`: a missing time is `null`, and Stripe's 0 has always meant none too
  const times = parse(subscriptionTimesSchema, {
    currentPeriodStart: item.current_period_start,
    currentPeriodEnd: item.current_period_end,
    trialStart: sub.trial_start || null,
    trialEnd: sub.trial_end || null,
    canceledAt: sub.canceled_at || null,
  });
  if (isFailure(times)) return times;

  const result = await writes.syncSubscription({
    userId: customer.userId,
    customerId: customer.id,
    planId,
    providerSubscriptionId: sub.id,
    status: status.data,
    ...times,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
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
 * A `userId` holding U+0000 names no user (no row can hold it), so it is `{ tier: 'free' }`.
 */
export async function getEntitlement(
  repo: Pick<PaymentRepository, 'findSubscriptionsByUserId'>,
  userId: UserId,
): Promise<Entitlement> {
  // A user id holding U+0000 names no row, and a lookup by it would fail in Postgres: answer free without asking
  if (!is(userId, pgTextSchema)) return { tier: 'free' };
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
  /**
   * Free-trial length applied to new subscriptions; omit for no trial. A whole number of days from 1 to
   * 730 (Stripe's range): anything else makes `createSubscriptionBilling` return `payments.configuration_invalid`.
   */
  trialDays?: number;
  /** Enable Stripe Tax at checkout (EU VAT). Requires Stripe Tax configured on the account. */
  automaticTax?: boolean;
};

export type SubscriptionBilling = ReturnType<typeof buildSubscriptionBilling>;

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
 *
 * A `trialDays` Stripe cannot take is a configuration fault: it returns `PaymentsConfigurationInvalid`
 * (`payments.configuration_invalid`) here, at boot, instead of failing every checkout.
 */
export function createSubscriptionBilling(
  config: SubscriptionBillingConfig,
): SubscriptionBilling | FailureOf<typeof PaymentsConfigurationInvalid> {
  if (config.trialDays !== undefined && !trialDaysSchema.safeParse(config.trialDays).success) {
    return PaymentsConfigurationInvalid({
      setting: 'presets.subscription.trialDays',
      problem: `must be a whole number of days from 1 to 730; got ${String(config.trialDays)}`,
    });
  }
  return buildSubscriptionBilling(config);
}

function buildSubscriptionBilling(config: SubscriptionBillingConfig) {
  const { provider, repo, writes, urls, trialDays, automaticTax } = config;
  const planByPrice = new Map(config.prices.map((p) => [p.priceId, p.planId]));

  return {
    /**
     * Start a hosted Checkout subscribe flow; returns the URL to redirect the browser to.
     * A price that is not in `prices` returns `PriceNotConfigured`, and a `userId` that holds U+0000 or a
     * lone surrogate, or an email the customer row cannot hold (not an address, or over 255 characters),
     * returns `InvalidInput`, all before any provider request, so no Stripe customer is left without a local row.
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
      | FailureOf<typeof ReferenceNotFound>
      | SchemaFailure
    > {
      if (!planByPrice.has(priceId)) return PriceNotConfigured({ priceId });
      // A user id the row refuses made a Stripe customer first and then failed to store it
      const checkedUserId = parse(checkoutUserIdSchema, userId);
      if (isFailure(checkedUserId)) return checkedUserId;

      // Find-or-create the local customer so the subscription webhook can attribute the row to a
      // user. `provider.createCustomer` also creates the Stripe-side customer.
      let customer = await repo.findCustomerByUserId(userId);
      if (!customer) {
        const checkedEmail = parse(checkoutEmailSchema, email);
        if (isFailure(checkedEmail)) return checkedEmail;
        const created = await provider.createCustomer({ userId, email: checkedEmail });
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
     * map to a plan, the failures of `projectStripeSubscription` (`InvalidInput` for a time that is not Unix seconds), and the journal's refused writes.
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
      const event = await provider.constructWebhookEvent(payload, signature);
      if (isFailure(event)) return event;

      if (
        event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted'
      ) {
        // The signature proves Stripe sent it, not that it has the shape Stripe's types promise
        const subscription = parse(stripeSubscriptionSchema, event.data.object);
        if (isFailure(subscription)) return subscription;
        const item = subscription.items.data[0];
        if (!item) return SubscriptionWithoutItems({ providerSubscriptionId: subscription.id });
        const planId = planByPrice.get(item.price.id);
        if (!planId) return PriceNotConfigured({ priceId: item.price.id });
        const result = await projectSubscription(repo, writes, subscription, planId);
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
