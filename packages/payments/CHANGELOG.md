# @arki/payments

## 0.3.2

### Patch Changes

- Updated dependencies [0e2ed57]
  - @arki/contracts@0.1.0
  - @arki/db@0.3.1
  - @arki/kv@0.2.1
  - @arki/env@0.0.11
  - @arki/journal@0.2.1

## 0.3.1

### Patch Changes

- d0ba607: Replaces the `"./*"` wildcard in `exports` with one explicit entry per public module. Every import path that worked before still works, so nothing breaks. New tools can now list and check the exact set of entries.
- Updated dependencies [13bb516]
- Updated dependencies [228b4f5]
- Updated dependencies [1668156]
- Updated dependencies [9fa13ce]
- Updated dependencies [ec0bf8b]
  - @arki/db@0.3.0
  - @arki/journal@0.2.0
  - @arki/kv@0.2.0
  - @arki/env@0.0.10

## 0.3.0

### Minor Changes

- 9062fab: Dunning, segmentation, Stripe provider and tax fixes.

  - Dunning now honours the channel opt-outs a customer saved. `CustomerData.communication_preferences` is now `communicationPreferences` with camelCase keys (`unsubscribedChannels`, `preferredChannel`).
  - Dunning counts payment failures per customer and subscription, so `paymentFailureCount` above 1 can match. The execution points at the latest failed payment.
  - Segmentation helpers return real types instead of `any`. The average payment amount is in the customer's main currency and `paymentHistory.currency` names it. The risk trend no longer carries `factors.paymentVolumeChange`. `streakDays` is filled in.
  - `StripeProvider.createCustomer`, `createCheckoutSession`, `detachPaymentMethod` and `createCustomerPortalSession` throw `PaymentProviderError`. `healthCheck` reports a rate limit as `degraded`. `validateWebhook` still returns `isValid: false` for a bad signature and throws `PaymentProviderError` for anything else.
  - `StripeProvider.createPlan` (and `BasePaymentProvider.createPlan`) now require `tier` and accept `description` and `features`.
  - `StripeProvider.calculateTax` breakdown lines carry `country`, `state` and `level`, and `taxCode` is the line item's tax code.
  - A jurisdiction tax exemption matches on country, level and state instead of the display name.

- 1d5f853: No stub, placeholder or fake result is left in the package, and the bugs found by kapodopera's tests are fixed.

  - `StripeProvider` implements every method on the `stripe@23` API (customers, plans, subscriptions incl. pause/resume/preview, payments, payment methods, tax transactions and tax settings). `getTaxReport` is removed (Stripe has no report endpoint); `refundPayment(paymentId)` takes our payment id and returns `{ providerRefundId, payment }`; `createTaxTransaction` takes `originalTransactionId` for refunds. The `references` read needs `findPaymentById`.
  - Tax: per-jurisdiction tax is stored (`tax_records`) and the customer summary is computed from it; reports, CSV/XML exports, the audit trail (`tax_audit_entries`) and the compliance check come from stored data. `createTaxService(stripeProvider, reads)` takes reads. Exemptions are applied in `calculateTax`, start pending review, are validated (dates, negative rates, tax-ID formats), and a global exemption must be product- or jurisdiction-scoped.
  - Refunds: the Stripe refund id is stored on the refund row and `charge.refunded`, `refund.created` and `refund.updated` webhooks reconcile it. Blank rejection reasons and duplicate pending refunds are refused (partial unique index), approval notes are kept (`approval_notes`), and a payment cannot be refunded beyond its amount.
  - Dunning: campaign execution and segment queries work in a named schema; `DunningCampaignServiceTables` also needs `customerRiskProfiles`, `customers`, `payments`, `subscriptions`, and the segmentation/integration core tables need `plans`.
  - Stats counts are numbers, `paymentResponseSchema` accepts `subscription: null`, and the customers table is unique per `userId` and per `providerCustomerId`.

  Migration: new tables `tax_records` and `tax_audit_entries`; new columns and indexes as listed above (`refunds.approval_notes`, `refunds_one_pending_per_payment_idx`, customers unique indexes, `customers_user_id_idx`, `customers_provider_customer_id_idx`).

- 0f294e1: The Stripe provider and the paths around it no longer stub or swallow.

  - `StripeProvider` creates and changes subscriptions and intents for real: `createSubscription`, `updateSubscription` (plan change with `prorationBehavior`, `cancelAtPeriodEnd`), `cancelSubscription` (now, or at period end), `createPaymentIntent` and `createSetupIntent`. They take an optional `idempotencyKey`. The constructor takes a second argument `{ references, httpClient, maxNetworkRetries }`; `references` (a `PaymentRepository` fits) turns our customer, plan and subscription ids into Stripe ids, and a plan needs `metadata.stripePriceId`. Stripe errors become `PaymentProviderError` with a `code` and `retryable`.
  - Webhooks record `charge.refunded` (`payment.refunded`) and `charge.dispute.created` (`payment.dispute_created`) on the payment through the new `recordPaymentRefund` and `recordPaymentDispute` journal commands. This needs a migration: two new `webhook_event_type` enum values and the `payments.dispute_id` and `payments.dispute_status` columns.
  - `TaxService.calculateTax` rejects when the provider fails. It used to return zero tax.
  - `TaxReportingService.getCustomerTaxSummary` is computed from the customer's succeeded payments and the tax recorded in their metadata, plus the exemptions in force that year. Its constructor takes `{ payments, exemptions }` reads, its totals are one `Money` per currency, and exemptions no longer carry an amount.
  - `DunningCampaignService.listExecutions` and `getDashboardStats` read the tables. `DunningDashboardStats` money is a `MoneyBag`.
  - `PaymentRepository.findPlans`, `findSubscriptions` and `findPayments` take the `PlanQuery`, `SubscriptionQuery` and `PaymentQuery` filters. `PaymentQuery` gains `customerId`.
  - `createCampaign` writes the campaign and its templates inside its transaction.

- f8359a1: Three fixes. (1) `DunningCampaignService.updateCampaign` takes optional `templates`, the same step shape and rules as create (at least one step, unique step numbers). The steps become exactly that set, in one transaction: a step with the same `stepNumber` is updated in place (its id and history stay), a new number is added, a missing number is deleted. `updateDunningCampaignInputSchema` gains `templates`; create and update share `dunningCampaignTemplatesSchema`, and create now also rejects duplicate step numbers. (2) New `SubscriptionManager.setCancelAtPeriodEnd(subscriptionId, flag)` sets or clears cancel-at-period-end with the provider and stores it through the new `setSubscriptionCancelAtPeriodEnd` journal command (event `SubscriptionCancelAtPeriodEndSet`). `SubscriptionManager.updateSubscription` now stores the new plan (new `changeSubscriptionPlan` command, event `SubscriptionPlanChanged`); before, the provider changed but the row kept the old plan. `CoreWrites` gains both commands. `updateSubscriptionInputSchema` now requires a `planId` or a `cancelAtPeriodEnd`. (3) `customers_provider_customer_id_idx` is unique on `(provider, provider_customer_id)` instead of `provider_customer_id` alone, so two providers may use the same id. Apps that already applied the old index must drop it and create the new one.
- 6a3537f: `@arki/payments/core/security/webhook-security` now re-exports `core/services/webhook-security`. It used to hold a second verifier whose Stripe and Razorpay signature checks always returned `true`, so an app that imported it accepted unsigned webhooks.

  Migration: `createWebhookSecurityService(config)` and `new WebhookSecurityService(config)` take a `WebhookSecurityConfig` (`allowedIps`, `replayWindowSeconds`, `maxRetries`). `WebhookSecurityError`, `WebhookSecurityErrorCode` and `WebhookSecurityValidationResult` are removed; `validateWebhook` returns `WebhookValidationResult` and does not throw. `verifyWithProvider`, `checkRateLimit`, `logSecurityEvent` and `getSecurityMetrics` are removed.

- ebfd53f: The old webhook handler updates subscriptions and payments for six Stripe event types, through journal commands.

  Breaking:

  - `WebhookHandler` and `createWebhookHandler` take the journal writes as their third argument: `paymentsJournal.writes(run)`.
  - `WebhookEventStore` also needs `findSubscriptionByProviderSubscriptionId` and `findPaymentByProviderPaymentId`.
  - `completePayment` also accepts a payment in `requires_action` or `failed` (the customer retried and the money was collected). `failPayment` also accepts `requires_action`, and still never a `succeeded` payment.

  Also in this release (plans 002 and 008):

  - Stripe webhook signatures are checked with a real HMAC over the signed `t.payload`, against the timestamp Stripe signed. An empty or missing webhook secret is refused. PayPal and Square verification fail as not implemented.
  - `WebhookHandler` processes events synchronously by default (`enableAsync: false`): a failure returns `retryable: true`, so the provider resends. A delivery that arrives while the same event is still in flight is also retryable. New options: `skipIpValidation`, `processingLeaseMs` (default 5 minutes).
  - An event is processed at most once at a time: claimed by `provider_event_id`, and taken over only after a failure or an expired lease.

  Added:

  - `markPaymentRequiresAction` command and `PaymentRequiresAction` event: the payment waits for the customer (for example 3-D Secure).

### Patch Changes

- 4bfc947: The risk-profile, campaign and segment queries that use raw SQL no longer crash with `invalid reference to FROM-clause entry`. `findByRiskCategory`, `findBySegmentId`, `findActiveForTrigger` and `findSegmentsForAutoUpdate` now read columns from the table the query builder hands them. The sorted `findMany` lists of campaigns, executions, communications and segments did the same wrong thing and are fixed too. `findActiveForTrigger` with segment ids also stopped sending the id list as one malformed array. `DunningDatabase` now also accepts a PGlite database.
- Fix: `@arki/payments@0.2.0` could not be imported from npm. Its compiled code calls `getLogger` from `@arki/log`, but its manifest pinned `@arki/log@0.0.3`, which has no `getLogger`. This release depends on `@arki/log@0.1.0`, the version that has it.
- Updated dependencies [3c2cc9d]
- Updated dependencies [e115648]
- Updated dependencies [11f2ba7]
- Updated dependencies [0685dfa]
- Updated dependencies [91efd52]
- Updated dependencies
- Updated dependencies [0fac2e0]
- Updated dependencies [2854df5]
  - @arki/date@0.2.0
  - @arki/db@0.2.0
  - @arki/env@0.0.9
  - @arki/journal@0.1.1
  - @arki/kv@0.1.8
  - @arki/log@0.1.0

## 0.2.0

### Minor Changes

- First public release. The package now compiles to `dist/` and owns its user id: `UserId`, `userIdSchema` and `userIdFactory` come from `@arki/payments/core` instead of `@arki/auth`, with the same `usr_` shape, so apps on `@arki/auth` pass their ids through unchanged and the package no longer depends on `@arki/auth`.

## 0.1.3

### Patch Changes

- Updated dependencies
  - @arki/contracts@0.0.2
  - @arki/log@0.0.2
  - @arki/env@0.0.3
  - @arki/db@0.1.2
  - @arki/kv@0.1.2
  - @arki/event-sourcing@0.1.2
  - @arki/auth@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies
  - @arki/env@0.0.2
  - @arki/kv@0.1.1
  - @arki/db@0.1.1
  - @arki/event-sourcing@0.1.1
  - @arki/auth@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @arki/contracts@1.0.0
  - @arki/log@1.0.0
  - @arki/db@0.1.1
  - @arki/auth@0.1.1
  - @arki/event-sourcing@0.1.1
  - @arki/kv@0.1.1
