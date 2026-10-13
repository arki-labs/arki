/**
 * High-level "preset" flows — opinionated assemblies of the core provider + repository for the
 * common case, so a consuming app wires a few routes instead of re-implementing the provider dance.
 *
 * Currently: the Stripe subscription preset (checkout → webhook projection → entitlement) and the
 * RevenueCat projector (native webhook → the same subscriptions table — the cross-platform hub).
 */
export {
  createSubscriptionBilling,
  getEntitlement,
  projectStripeSubscription,
} from './subscription.js';
export type {
  Entitlement,
  PriceToPlan,
  SubscriptionBilling,
  SubscriptionBillingConfig,
} from './subscription.js';

export { projectRevenueCatEvent, revenueCatWebhookSchema, verifyRevenueCatAuth } from './revenuecat.js';
export type { RevenueCatEvent, RevenueCatWebhook } from './revenuecat.js';
