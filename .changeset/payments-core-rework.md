---
"@arki/payments": minor
---

The payments core answers caller values Postgres would refuse, and rows that do not exist, with typed failures, and stops dropping refusals into logs.

- Journal commands look up the rows a write points at: `ReferenceNotFound` (new kind `user`) instead of `db.transaction_rejected`; `createSubscription` refuses a stored provider subscription id with `journal.conflict`; `markSubscriptionPastDue` refuses a canceled subscription.
- Command schemas, contracts, derived insert schemas and `PaymentRepository` writes refuse U+0000, over-long text, fractional or out-of-range integers, amounts past 2^53 - 1 minor units, unknown currencies and times outside the years 1 to 9999 as `schema.invalid_input`.
- New failures: `payments.plan_already_exists` (409), `payments.customer_in_use` (409), `payments.webhook_event_exists` (409). `updateCustomer` returns `CustomerConflict` and `ReferenceNotFound`.
- Breaking: `deleteCustomer`, `createWebhookEvent`, `claimWebhookEvent`, `updateWebhookEvent`, `incrementWebhookEventAttempts`, `createPlan`, `updatePlan`, `createCustomer` gain failure results; `processDunningEvents` returns per-step reports; `previewMultiplePlanChanges` returns `{ previews, refused }` or `ReferenceNotFound`.
- Breaking: `PaymentMonitoringService` `recordPaymentAttempt`, `recordRefund`, `recordSubscriptionEvent` and `recordWebhookProcessing` return the first KV failure (`kv.unavailable`, ...) instead of dropping it, or `undefined`.
- `StripeProvider.calculateTax` and `createTaxTransaction` return `money.provider_amount` for a currency outside ISO 4217 instead of throwing; `createCustomer` sends metadata as Stripe strings; `createPlan` deletes the Stripe product when the price is refused; `previewSubscriptionChange` reads every page of invoice lines; the refund-rate alert and the health success rate count successful attempts.
- Fixes: `handleTrialEndingSoon` finds trials, `validateSubscriptionAccess` grants trials, webhook analytics counts processed events, `retryFailedWebhooks` no longer re-reports or starves on events given up on, retry strategies no longer leak between instances, presets parse the Stripe subscription body, checkout checks the email before Stripe creates a customer.

See `docs/upgrades/0.5.0-to-0.6.0.md`.
