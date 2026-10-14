import type { WebhookEventType } from '../primitives.js';

/** Stripe event types we model, mapped to our internal event names. */
const STRIPE_EVENT_TYPES: Readonly<Record<string, WebhookEventType>> = {
  'customer.subscription.created': 'subscription.created',
  'customer.subscription.updated': 'subscription.updated',
  'customer.subscription.deleted': 'subscription.canceled',
  'customer.subscription.trial_will_end': 'subscription.trial_will_end',
  'payment_intent.succeeded': 'payment.succeeded',
  'payment_intent.payment_failed': 'payment.failed',
  'payment_intent.requires_action': 'payment.requires_action',
  'charge.refunded': 'payment.refunded',
  'charge.dispute.created': 'payment.dispute_created',
  // Stripe API versions without `refunds` on the charge report each refund on its own
  'refund.created': 'refund.updated',
  'refund.updated': 'refund.updated',
  'customer.created': 'customer.created',
  'customer.updated': 'customer.updated',
  'customer.deleted': 'customer.deleted',
  'invoice.created': 'invoice.created',
  'invoice.finalized': 'invoice.finalized',
  'invoice.payment_succeeded': 'invoice.paid',
  'invoice.payment_failed': 'invoice.payment_failed',
};

/** Our internal event name for a Stripe event type, or `null` when we do not model it. */
export function mapStripeEventType(stripeEventType: string): WebhookEventType | null {
  // `hasOwn`, not a bare lookup: `constructor` or `__proto__` would otherwise hit Object.prototype.
  return Object.hasOwn(STRIPE_EVENT_TYPES, stripeEventType) ? (STRIPE_EVENT_TYPES[stripeEventType] ?? null) : null;
}
