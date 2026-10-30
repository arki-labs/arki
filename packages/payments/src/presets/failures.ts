import { z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

/**
 * A Stripe price id that is not one of the subscription preset's `prices`. Returned by
 * `createCheckoutSession` before any provider request, and by `handleWebhook` for a subscription
 * on a price the app does not sell, so no plan nobody configured is granted.
 *
 * @fix Add the price to `prices` with the plan row it sells, or check the price id the client sent.
 * @verify bun run test -- src/presets
 */
export const PriceNotConfigured = /* @__PURE__ */ defineFailure('payments.price_not_configured', {
  status: 422,
  data: z.object({ priceId: z.string() }),
  message: ({ priceId }) => `Price ${priceId} is not a configured plan`,
  remediation: 'Add the price to the preset prices with the plan row it sells, or check the price id.',
});

/**
 * A provider subscription event names a provider customer with no local customer row, so no user
 * owns it. The row is made at checkout; a subscription made outside checkout (in the Stripe
 * dashboard) has none. Returned by `projectStripeSubscription` before anything is written.
 *
 * @fix Start subscriptions through `createCheckoutSession`, or create the customer row for the provider customer first.
 * @verify bun run test -- src/presets
 */
export const UnknownProviderCustomer = /* @__PURE__ */ defineFailure('payments.unknown_provider_customer', {
  status: 404,
  data: z.object({ providerCustomerId: z.string() }),
  message: ({ providerCustomerId }) => `No local customer for provider customer ${providerCustomerId}`,
  remediation: 'Start subscriptions through checkout, or create the customer row for the provider customer first.',
});

/**
 * A provider subscription event has no subscription items, so it has no price and no billing
 * period to store. Returned by `handleWebhook` and `projectStripeSubscription` before anything is written.
 *
 * @fix Check the subscription in the provider dashboard: a Stripe subscription always has at least one item.
 * @verify bun run test -- src/presets
 */
export const SubscriptionWithoutItems = /* @__PURE__ */ defineFailure('payments.subscription_without_items', {
  status: 422,
  data: z.object({ providerSubscriptionId: z.string() }),
  message: ({ providerSubscriptionId }) => `Subscription ${providerSubscriptionId} has no items`,
  remediation: 'Check the subscription with the provider: it should have at least one item.',
});

/**
 * A provider subscription status this package does not model, such as one Stripe added after this
 * release. Returned by `projectStripeSubscription` instead of guessing a status.
 *
 * @fix Upgrade `@arki/payments`, or add the status to `subscriptionStatusValues`.
 * @verify bun run test -- src/presets
 */
export const UnknownSubscriptionStatus = /* @__PURE__ */ defineFailure('payments.unknown_subscription_status', {
  status: 422,
  data: z.object({ status: z.string() }),
  message: ({ status }) => `Subscription status ${status} is not one this package models`,
  remediation: 'Upgrade @arki/payments, or add the status to subscriptionStatusValues.',
});
