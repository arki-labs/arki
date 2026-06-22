/**
 * High-level "preset" flows — opinionated assemblies of the core provider + repository for the
 * common case, so a consuming app wires a few routes instead of re-implementing the provider dance.
 *
 * Currently: the Stripe subscription preset (checkout → webhook projection → entitlement).
 */
export {
  createSubscriptionBilling,
  getEntitlement,
  projectStripeSubscription,
} from './subscription';
export type {
  Entitlement,
  PriceToPlan,
  SubscriptionBilling,
  SubscriptionBillingConfig,
} from './subscription';
