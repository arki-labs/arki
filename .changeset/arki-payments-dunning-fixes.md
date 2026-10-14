---
'@arki/payments': minor
---

Dunning, segmentation, Stripe provider and tax fixes.

- Dunning now honours the channel opt-outs a customer saved. `CustomerData.communication_preferences` is now `communicationPreferences` with camelCase keys (`unsubscribedChannels`, `preferredChannel`).
- Dunning counts payment failures per customer and subscription, so `paymentFailureCount` above 1 can match. The execution points at the latest failed payment.
- Segmentation helpers return real types instead of `any`. The average payment amount is in the customer's main currency and `paymentHistory.currency` names it. The risk trend no longer carries `factors.paymentVolumeChange`. `streakDays` is filled in.
- `StripeProvider.createCustomer`, `createCheckoutSession`, `detachPaymentMethod` and `createCustomerPortalSession` throw `PaymentProviderError`. `healthCheck` reports a rate limit as `degraded`. `validateWebhook` still returns `isValid: false` for a bad signature and throws `PaymentProviderError` for anything else.
- `StripeProvider.createPlan` (and `BasePaymentProvider.createPlan`) now require `tier` and accept `description` and `features`.
- `StripeProvider.calculateTax` breakdown lines carry `country`, `state` and `level`, and `taxCode` is the line item's tax code.
- A jurisdiction tax exemption matches on country, level and state instead of the display name.
