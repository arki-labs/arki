---
'@arki/payments': minor
---

Expected payment answers are returned as `@arki/failure` values, not thrown. Bugs, bad input and provider faults are still thrown.

- `StripeProvider` (and `BasePaymentProvider`) return `CardDeclined` (`payments.card_declined`, 402, data `{ providerCode, declineCode }`) from the calls that charge or check a card: `createSubscription`, `updateSubscription`, `createPayment`, `confirmPayment`, `createPaymentIntent`, `attachPaymentMethod`. They return `IdempotencyConflict` (`payments.idempotency_conflict`, 409) from the calls that take an `idempotencyKey`, and `ReferenceNotFound` (`payments.reference_not_found`, 404, data `{ kind, id, missing }`) for an id with no row, or a plan with no Stripe price, before any request. Import them from `@arki/payments/core/providers/provider-error`.
- `PaymentProviderError` no longer has the codes `card_declined`, `idempotency_conflict` and `reference_not_found`. A card or idempotency error from a call that cannot return those failures is thrown as `invalid_request`.
- `RefundService.requestRefund`, `approveRefund` and `rejectRefund` return `TransactionNotFound`, `RefundWindowExceeded`, `DuplicatePendingRefund`, `RefundAmountExceeded`, `RefundNotFound` and `RefundInvalidState` (`payments.*`), in place of throwing `RefundError` or a plain `Error`. Import them from `@arki/payments/refunds`. `RefundError` keeps `REASON_REQUIRED` and `PROCESSING_FAILED`.
- When the provider returns a failure while a refund is paid back, the refund still ends `failed` and support is told, as when the provider throws.
- `SubscriptionManager` and `TaxService.createTaxTransaction` return the provider's failures and write nothing for a change the provider refused. `DunningService` and `PaymentRetryService` handle them as they handled the old thrown errors: the step or attempt fails and the subscription row is left alone.
