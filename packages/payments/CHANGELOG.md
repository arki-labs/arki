# @arki/payments

## 0.4.0

### Minor Changes

- 232d3e8: Share bounded Web Crypto generation across modern and legacy IDs. Legacy
  `createId`, `createPrefixedId`, and factory `create`/`make`/`new` now return exact
  canonical generation failures. Preserve stored formats and prefixes, including
  legacy empty and punctuation prefixes, while removing the Cuid2 fallback to
  `Math.random`. Infer stored types from the successful schema and handle failures
  before side effects or string interpolation.

  Modern declarations use `defineId` with `IdOf` inferred from the canonical schema.
  Payment ID factory exports become browser-safe declarations; use `idColumns`
  for their table helpers. Payment provider creates and billing persistence return
  generation failures; webhook adapters must check these before acknowledgement.
  AI tombstone columns use modern declarations. Flow stops on returned failures;
  use `createFlow<State, Context>()(config)` to infer the exact node failure union.
  Ordinary patches cannot disguise a canonical failure through structural typing.

- 232d3e8: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

- 232d3e8: Repair schema/type agreement across Drizzle validators, ID factories and AI configuration.

  Breaking: generated table validators no longer claim phantom `$type<T>` shapes. Use a runtime schema with `jsonColumn` and reuse it in explicit validator refinements for precise input/output types. Bare JSON columns retain the native runtime validator and its honest inferred type.

  Breaking: `createIdFactory(prefix)` infers its ID from the literal prefix; remove the former second type argument. Payments ID aliases now reflect the prefixes their generators already produce. Existing generated values and stored IDs are unchanged.

  Breaking: replace AI `SearchOptionsType` with `SearchSettings`, and `AIServiceConfigType` with `RAGServiceConfig`. The `@arki/ai/types` aliases use those same distinct names. Provider configuration and sanitizer patterns now share their actual validation schemas, preserving custom `RegExp` rules.

  See `docs/features/arki-framework/migrations/defined-once.md` for migration examples and compatibility notes.

- 498dff0: Expected payment answers are returned as `@arki/failure` values, not thrown. Bugs, bad input and provider faults are still thrown.

  - `StripeProvider` (and `BasePaymentProvider`) return `CardDeclined` (`payments.card_declined`, 402, data `{ providerCode, declineCode }`) from the calls that charge or check a card: `createSubscription`, `updateSubscription`, `createPayment`, `confirmPayment`, `createPaymentIntent`, `attachPaymentMethod`. They return `IdempotencyConflict` (`payments.idempotency_conflict`, 409) from the calls that take an `idempotencyKey`, and `ReferenceNotFound` (`payments.reference_not_found`, 404, data `{ kind, id, missing }`) for an id with no row, or a plan with no Stripe price, before any request. Import them from `@arki/payments/core/providers/provider-error`.
  - `PaymentProviderError` no longer has the codes `card_declined`, `idempotency_conflict` and `reference_not_found`. A card or idempotency error from a call that cannot return those failures is thrown as `invalid_request`.
  - `RefundService.requestRefund`, `approveRefund` and `rejectRefund` return `TransactionNotFound`, `RefundWindowExceeded`, `DuplicatePendingRefund`, `RefundAmountExceeded`, `RefundNotFound` and `RefundInvalidState` (`payments.*`), in place of throwing `RefundError` or a plain `Error`. Import them from `@arki/payments/refunds`. `RefundError` keeps `REASON_REQUIRED` and `PROCESSING_FAILED`.
  - When the provider returns a failure while a refund is paid back, the refund still ends `failed` and support is told, as when the provider throws.
  - `SubscriptionManager` and `TaxService.createTaxTransaction` return the provider's failures and write nothing for a change the provider refused. `DunningService` handles them as it handled the old thrown errors: the step fails and the subscription row is left alone. `PaymentRetryService` marks the attempt failed.
  - Fix: in `PaymentRetryService`, a declined card on the last retry now ends dunning (the subscription is marked past due), as any other failed last retry does. Before, it left the subscription as it was.
  - The journal commands of `createCoreJournal` and `createRefundsJournal` return `CommandNotFound` (`journal.not_found`, 404), `CommandConflict` (`journal.conflict`, 409) and `CommandInvalid` (`journal.invalid`, 400) from `@arki/journal` when a rule says no, in place of throwing `CommandError` `NOT_FOUND`, `CONFLICT` and `BAD_REQUEST`. The message is the same, now in `detail` and `message`. Nothing is written, as before. Over oRPC the error code changes from `NOT_FOUND` to `journal.not_found` (and so on); the status stays.
  - `CoreWrites` and `RefundWrites` (from `writes(run)`) return those failures beside the row: each method's type lists the ones it can return. `syncSubscription` cannot refuse and still returns only the row.
  - `SubscriptionManager` (`updateSubscription`, `setCancelAtPeriodEnd`, `cancelSubscription`, `reactivateSubscription`, `pauseSubscription`, `resumeSubscription`) returns a refused journal write, in place of throwing `Error('Failed to ...')`. The provider change was made before, as it was then.
  - `DunningService.handlePaymentFailure` and `handleSubscriptionRecovery` return a refused write in place of throwing it. A refused write inside a dunning step is logged and the step stops, as before. `PaymentRetryService` marks the attempt `failed` with the refusal's message, as before.
  - `RefundService.approveRefund`, `rejectRefund` and the payback return a refused write in place of throwing it. A refund whose completion is refused still ends `failed` and support is told, as before.
  - `WebhookHandler` throws a refused write with `orThrow` (`UnexpectedFailure`), so the event fails and is retried, as before. The error message now starts with the failure code.

- ceaadfa: `createCoreJournal`, `createPaymentJournal`, `createSubscriptionJournal` and `createRefundsJournal` take a journal whose meta schema is any Standard Schema with a plain-record output (`StandardSchemaV1<unknown, Record<string, unknown>>`), not only `z.ZodObject`.
- 232d3e8: Breaking: `defineEnv` now validates in every environment. `CI` and `lint` runs no longer skip validation. The only implicit opt-out is `SKIP_ENV_VALIDATION=1` (exactly `1`); set it only in build stages that run without secrets. `options.skipValidation` still overrides it. The `@arki/env/dot` plugin now validates at boot and fails with `ARKI_ENV_PLUGIN_E001` (new `ENV_PLUGIN_ERROR_CODES`), and `EnvServices['env']` is derived from `defineEnv` without a cast.

### Patch Changes

- fe5a391: README follows the docs standard (install, quick start, limits and failure behaviour that match the `payments.*` failures), with `llms.txt`, an agent guide, `AGENTS.md` and `test:docs`. The nine `payments.*` failures gain `@fix` and `@verify` tags.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- 232d3e8: Signed webhooks in. `@arki/http/webhooks` adds `verifyWebhook({ scheme })`, a deriver that checks a request's signature over a clone of its body, and three schemes: `standardWebhooks`, `stripe` and `hmac` (GitHub, Slack, Shopify and most others). Each scheme also has `verify` and `sign`. Several secrets are accepted at once for rotation, the signed time must be within a tolerance, and `webhook.id` comes only from signed bytes (for `hmac`, the SHA-256 of the body), ready to be a journal idempotency key. New error codes `ARKI_HTTP_E012`, `E413`, `E420`, `E421`, `E422`.

  `@arki/payments` checks Stripe signatures through `stripe()` from `@arki/http/webhooks` and now depends on `@arki/http`. Results are unchanged, except that a `t=` that is not Unix seconds now reports `Invalid signature format` instead of a time outside the window.

- 232d3e8: Preserve typed business failures across job execution, scheduled runs and durable
  commands. BullMQ and pg-boss share outcome classification and explicit retry
  decisions; persisted refusals cannot become successful jobs. Queue submission
  returns canonical validation, unavailability or uncertain-acceptance failures.
  Middleware failure types flow from their definitions.

  Schedule clients infer success and refusal from each definition and distinguish
  refused work from overlap, lock contention and unavailability. Journal rolls back
  refused commands, supervises callback defects, returns receipt conflicts, and
  persists typed diagnostics for incompatible pinned workflows.

  Breaking migration: narrow enqueue results before using IDs or counting accepted
  work; register the exported failure definitions at RPC boundaries; handle
  `refused` schedule outcomes. Returned failures and unexpected defects are not
  retried by default. Follow each package's upgrade guidance for persisted jobs
  and workflow versions.

  Payments preserves duplicate-pending-refund handling when Journal returns a
  typed constraint rejection. Other transaction failures retain their identity,
  including uncertain commits; the service does not retry or call the provider.

- 232d3e8: Return exact canonical webhook signing, verification and request-preparation
  failures, supervise Web Crypto and add safe default tracing. Declare
  WEBHOOK_FAILURES on protected HTTP routes and narrow direct results before
  accepting a delivery. Payments fails closed on returned verification failures;
  the Journal inbox declares the new contract and outbound delivery returns signing failures without sending or acknowledging jobs. Returned signing failures need an explicit backoff retry predicate.
- Updated dependencies [9bfddf3]
- Updated dependencies [1668156]
- Updated dependencies [7922fb5]
  - @arki/money@0.1.0
  - @arki/contracts@0.2.0
  - @arki/date@0.3.0
  - @arki/db@0.4.0
  - @arki/env@0.1.0
  - @arki/failure@0.1.0
  - @arki/http@0.3.0
  - @arki/journal@0.3.0
  - @arki/kv@0.3.0
  - @arki/log@0.2.0
  - @arki/schema@0.1.0

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
