---
"@arki/payments": minor
---

Stripe provider, refunds and presets refuse hostile input. `StripeProvider`, `RefundService` and `createSubscriptionBilling` return `payments.configuration_invalid` for a bad setting instead of throwing (breaking: use `StripeProvider.create` and `RefundService.create`; their constructors are private). Text Stripe cannot take (a lone surrogate) and a bad `prorationBehavior` come back as `schema.invalid_input` before any request, so `detachPaymentMethod`, `createCustomerPortalSession` and `createCheckoutSession` now return a result. `RefundRepository.findByStatus` and `searchRefunds` answer empty for a status or reason outside the enum, and `getEntitlement` answers free for a user id holding U+0000. See `docs/upgrades/0.5.0-to-0.6.0.md`.
