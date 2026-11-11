---
'@arki/payments': minor
---

`StripeProvider` returns a missing `references` and every Stripe amount money refuses, instead of throwing.

- Breaking: a `StripeProvider` built without `references` returns `PaymentsConfigurationInvalid` (`payments.configuration_invalid`, `data.setting` `'references'`) from every call that takes a customer, plan, subscription or payment id, and sends no request. It threw `PaymentProviderError` (`not_configured`). `getCustomer` and `getSubscription` now return `Result<T | null, ...>`; the other calls, the matching `BasePaymentProvider` methods and `SubscriptionManager`'s provider-backed methods (`syncSubscriptionWithProvider` among them) add the failure. The `not_configured` member of `PaymentProviderErrorCode` is removed.
- `getPlan`, `updatePlan`, `listPlans`, `createPayment`, `getPayment`, `confirmPayment` and `cancelPayment` return `money.out_of_range` for a Stripe amount past 2^53 - 1 of our minor units (an MGA amount near 2^53: Stripe counts whole ariary), where `toMinorColumn` threw `NumericRangeError`. `createPlan` returns it for such an amount before any request, where it threw after Stripe had made the product and price.
- Every Stripe amount read has a test per money code it returns: `money.unknown_currency`, `money.provider_amount`, `money.out_of_range`, `money.invalid_text` and `money.input_too_large` (the last two for an amount Stripe sends as text). `getPayment`'s money failure type narrows from `MoneyFailure` to these codes.
