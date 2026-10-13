import { timingSafeEqual } from 'node:crypto';

import type { UserId } from '../core/user-id.js';
import { z } from '@arki/contracts';
import { fromMillis, now, toMillis } from '@arki/date';

import type { CoreWrites } from '../core/journal.js';
import type { CustomerId, PlanId, SubscriptionStatus } from '../core/types.js';

/**
 * RevenueCat → our `subscriptions` table — the "native in" half of the cross-platform entitlement
 * hub. A native StoreKit/Play purchase is made on-device via the RevenueCat SDK; RevenueCat then
 * POSTs a webhook here, which we project into the SAME `subscriptions` table the web Stripe rail
 * writes to, so `getEntitlement` stays one source of truth regardless of where the purchase happened.
 *
 * Two things differ from Stripe and shape this API:
 *  1. **No server checkout** creates a customer first, so the *consuming app's webhook route* must
 *     find-or-create the customer (it knows its own user table + email) and hand the resolved
 *     `{ customerId, userId }` here — this projector does not look it up.
 *  2. **No single subscription id** — RevenueCat identifies a subscription by `original_transaction_id`
 *     (stable across renewals), which we upsert on so renewals converge to one row.
 */

/** Minimal validated shape of a RevenueCat webhook body (unknown keys are stripped). */
export const revenueCatWebhookSchema = z.object({
  api_version: z.string().optional(),
  event: z.object({
    /** Event type — kept as a string (RevenueCat may add types); mapped below, unknown → ignored. */
    type: z.string(),
    id: z.string().optional(),
    /** The id we set as RevenueCat's `appUserID` — our user id. */
    app_user_id: z.string(),
    original_app_user_id: z.string().optional(),
    /** Store product identifier — the app maps this to a local plan. */
    product_id: z.string().optional(),
    /** NORMAL | TRIAL | INTRO | PROMOTIONAL. */
    period_type: z.string().optional(),
    purchased_at_ms: z.number().optional(),
    expiration_at_ms: z.number().nullable().optional(),
    store: z.string().optional(),
    environment: z.string().optional(),
    transaction_id: z.string().optional(),
    /** Stable subscription identifier across renewals → our `providerSubscriptionId`. */
    original_transaction_id: z.string().optional(),
    cancel_reason: z.string().nullable().optional(),
  }),
});

export type RevenueCatWebhook = z.infer<typeof revenueCatWebhookSchema>;
export type RevenueCatEvent = RevenueCatWebhook['event'];

/**
 * Verify a RevenueCat webhook. RevenueCat sends the exact `Authorization` header value you configure
 * on the webhook in its dashboard — so this is a shared-secret comparison (there is no HMAC signature
 * like Stripe's). Uses a constant-time compare so the secret can't be recovered via response timing.
 * Returns false on any mismatch or when no secret is configured.
 */
export function verifyRevenueCatAuth(authHeader: string | null, expectedSecret: string): boolean {
  if (expectedSecret.length === 0 || authHeader === null) return false;
  const provided = Buffer.from(authHeader);
  const expected = Buffer.from(expectedSecret);
  // Lengths must match for timingSafeEqual (it throws otherwise) — the standard guard before compare.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Map a RevenueCat event type + period to our subscription status. Returns `null` for events that
 * aren't a subscription-state change we project (aliases, transfers, test pings) so the caller can
 * 200-ack them without touching the table.
 */
/** Event types that mean "the subscription is current" (active, or trialing inside a trial period). */
const ACTIVE_EVENT_TYPES = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
  'NON_RENEWING_PURCHASE',
]);

function mapRevenueCatStatus(
  type: string,
  periodType: string | undefined,
): { status: SubscriptionStatus; cancelAtPeriodEnd: boolean } | null {
  const trialing = periodType === 'TRIAL';
  if (ACTIVE_EVENT_TYPES.has(type)) {
    return { status: trialing ? 'trialing' : 'active', cancelAtPeriodEnd: false };
  }
  // Auto-renew turned off — access continues until expiration (like Stripe's cancel-at-period-end).
  if (type === 'CANCELLATION') {
    return { status: trialing ? 'trialing' : 'active', cancelAtPeriodEnd: true };
  }
  if (type === 'BILLING_ISSUE') return { status: 'past_due', cancelAtPeriodEnd: false };
  if (type === 'SUBSCRIPTION_PAUSED') return { status: 'paused', cancelAtPeriodEnd: false };
  if (type === 'EXPIRATION') return { status: 'canceled', cancelAtPeriodEnd: false };
  // SUBSCRIBER_ALIAS, TRANSFER, TEST, or anything new → not a subscription-state change we project.
  return null;
}

/** ~100 years out — a stand-in period end for a non-expiring (non-renewing/lifetime) entitlement. */
const NON_EXPIRING_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/**
 * Project a (validated) RevenueCat event onto our `subscriptions` table through the journal command
 * `syncSubscription`, which upserts by `original_transaction_id`. `customer` and `planId` are
 * resolved by the consuming app (the customer find-or-created from its user table, the plan mapped
 * from `product_id`).
 *
 * A repeated delivery writes no event. RevenueCat sends no cancel time, so `canceledAt` is "now" on
 * every `EXPIRATION`; the command keeps the time of the first one once the row is canceled.
 *
 * Returns `{ handled: false }` for event types that aren't a subscription-state change.
 */
export async function projectRevenueCatEvent(params: {
  /** The app's journal writes: `paymentsJournal.writes(run)`. */
  writes: Pick<CoreWrites, 'syncSubscription'>;
  event: RevenueCatEvent;
  customer: { id: CustomerId; userId: UserId };
  planId: PlanId;
}): Promise<{ handled: boolean }> {
  const { writes, event, customer, planId } = params;

  const mapped = mapRevenueCatStatus(event.type, event.period_type);
  if (!mapped) return { handled: false };

  const providerSubscriptionId =
    event.original_transaction_id ??
    event.transaction_id ??
    `${event.app_user_id}:${event.product_id ?? 'unknown'}`;

  const periodStart = event.purchased_at_ms ? fromMillis(event.purchased_at_ms) : now();
  const periodEnd = event.expiration_at_ms
    ? fromMillis(event.expiration_at_ms)
    : fromMillis(toMillis(periodStart) + NON_EXPIRING_MS);
  const isTrial = event.period_type === 'TRIAL';

  await writes.syncSubscription({
    userId: customer.userId,
    customerId: customer.id,
    planId,
    providerSubscriptionId,
    status: mapped.status,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    trialStart: isTrial ? periodStart : null,
    trialEnd: isTrial ? periodEnd : null,
    cancelAtPeriodEnd: mapped.cancelAtPeriodEnd,
    canceledAt: mapped.status === 'canceled' ? now() : null,
    metadata: { provider: 'revenuecat', store: event.store ?? null, environment: event.environment ?? null },
  });
  return { handled: true };
}
