/**
 * Reads the two Stripe objects the webhook handler writes state from
 *
 * `event` is the whole Stripe event, `{ id, type, data: { object } }`, as the
 * signature check hands it over. A subscription event carries a Subscription
 * object, a payment event a PaymentIntent. Only the fields the handler needs
 * are checked; any other field is ignored.
 */

import type { Instant } from '@arki/date';
import { z } from '@arki/contracts';
import { fromUnix } from '@arki/date';

import type { SubscriptionStatus } from '../types.js';
import { subscriptionStatusValues } from '../primitives.js';

const stripeSubscriptionEvent = z.object({
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      status: z.enum(subscriptionStatusValues),
      cancel_at_period_end: z.boolean(),
      canceled_at: z.number().int().nullable(),
      trial_start: z.number().int().nullable(),
      trial_end: z.number().int().nullable(),
      items: z.object({
        data: z.array(z.object({ current_period_start: z.number().int(), current_period_end: z.number().int() })),
      }),
    }),
  }),
});

const stripePaymentIntentEvent = z.object({
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      last_payment_error: z.object({ message: z.string().optional(), code: z.string().optional() }).nullish(),
    }),
  }),
});

/** What Stripe says a subscription looks like now, in the fields `syncSubscription` takes. */
export type StripeSubscriptionSnapshot = {
  providerSubscriptionId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Instant;
  currentPeriodEnd: Instant;
  trialStart: Instant | null;
  trialEnd: Instant | null;
  canceledAt: Instant | null;
  cancelAtPeriodEnd: boolean;
};

/** Which payment a PaymentIntent event is about, and why it failed when it did. */
export type StripePaymentIntentSnapshot = {
  providerPaymentId: string;
  failureReason: string | null;
};

function invalid(error: z.ZodError): Error {
  return new Error(`Invalid webhook payload: ${error.message}`);
}

function instantOrNull(seconds: number | null): Instant | null {
  return seconds === null ? null : fromUnix(seconds);
}

/** Stripe keeps the billing period on the first subscription item. */
export function parseStripeSubscription(event: Record<string, unknown>): StripeSubscriptionSnapshot {
  const result = stripeSubscriptionEvent.safeParse(event);
  if (!result.success) {
    throw invalid(result.error);
  }

  const sub = result.data.data.object;
  const item = sub.items.data[0];
  if (!item) {
    throw new Error(`Invalid webhook payload: subscription ${sub.id} has no items`);
  }

  return {
    providerSubscriptionId: sub.id,
    status: sub.status,
    currentPeriodStart: fromUnix(item.current_period_start),
    currentPeriodEnd: fromUnix(item.current_period_end),
    trialStart: instantOrNull(sub.trial_start),
    trialEnd: instantOrNull(sub.trial_end),
    canceledAt: instantOrNull(sub.canceled_at),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };
}

export function parseStripePaymentIntent(event: Record<string, unknown>): StripePaymentIntentSnapshot {
  const result = stripePaymentIntentEvent.safeParse(event);
  if (!result.success) {
    throw invalid(result.error);
  }

  const intent = result.data.data.object;

  return {
    providerPaymentId: intent.id,
    failureReason: intent.last_payment_error?.message ?? intent.last_payment_error?.code ?? null,
  };
}
