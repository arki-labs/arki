# @arki/payments

## 0.5.0

### Minor Changes

- c55a254: Expected outcomes return typed failures from `@arki/failure` instead of plain `Error`s, strings or raw throws (T08 fix lane). Breaking in 0.x.

  ## Webhooks

  Webhook processing returns typed failures instead of strings and throws.

  Breaking:

  - `WebhookHandler.processWebhook` returns `{ status: 'processed' | 'queued' | 'duplicate' | 'ignored', webhookId? }` when the route may answer 2xx, and a returned failure otherwise. The old `{ success, error, retryable }` result is gone, and so is the hand-written `WebhookProcessingResult` type in `core/services/webhook-handler` (use the one inferred from `webhookProcessingResultSchema`).
  - `webhookProcessingResultSchema` (the route's 2xx answer) is now `{ status: 'processed' | 'queued' | 'duplicate' | 'ignored' | 'refused', webhookId?, code? }`. `refused` carries the code of a webhook failure whose `retryable` is false.
  - New webhook failures, exported from `core/services/webhook-handler`, each with `retryable` in its data: `payments.webhook_rejected` (validator refused the delivery; not retryable), `payments.webhook_payload_invalid` (no `id`/`type`, or a body the event's schema refuses; not retryable; `cause` is the `InvalidInput`), `payments.webhook_retries_exhausted` (not retryable), `payments.webhook_in_progress` (retryable), `payments.webhook_target_not_found` (no local payment or subscription for the provider id; retryable, because the webhook can arrive before the app's own insert commits), `payments.webhook_claim_conflict` (retryable). Also `WEBHOOK_FAILURES` and `isWebhookFailure`.
  - A journal write the handler makes is returned when refused (`journal.conflict`, ...), and so is a refund signal failure; they are no longer thrown. A fault (database, registered handler) now propagates as a throw after it is recorded on the event row, instead of a `{ success: false, retryable: true }` result.
  - `parseStripeSubscription`, `parseStripePaymentIntent`, `parseStripeCharge`, `parseStripeRefund` and `parseStripeDispute` return `InvalidInput` (from `@arki/schema`'s `parse`) instead of throwing. A subscription with no items, or a timestamp outside the `fromUnix` range, is refused by the schema.
  - `claimWebhookEvent` (and `PaymentRepository.claimWebhookEvent`) returns `payments.webhook_claim_conflict` instead of throwing.
  - `registerEventHandler` now overrides the built-in handling of its event type, and `removeEventHandler` restores it. `getProcessingStats` reports every event type.
  - `WebhookSecurityService` starts no timer; old replay entries are pruned during `validateWebhook`, at most hourly.

  Also: `processWebhook` runs in a `payments.webhook.process` span and each claimed event in a `payments.webhook.event` span (attributes `payments.provider`, `payments.event_type`). `WebhookAnalyticsService` logs through `arki:payments:webhook` instead of `console`.

  ## Stripe provider and presets

  Stripe provider and presets return typed failures for outside input instead of throwing, and every Stripe request is traced.

  Breaking changes:

  - `StripeProvider.constructWebhookEvent` returns `InvalidWebhookSignature` (`payments.invalid_signature`) for a bad, missing or stale signature instead of throwing `StripeSignatureVerificationError`.
  - `createSubscriptionBilling().handleWebhook` returns `InvalidWebhookSignature`, `SubscriptionWithoutItems` (`payments.subscription_without_items`) and `PriceNotConfigured` (`payments.price_not_configured`) instead of throwing. `createCheckoutSession` returns `PriceNotConfigured` for a price that is not in `prices`, and the `CustomerConflict` of `repo.createCustomer`.
  - `projectStripeSubscription` no longer takes `mapStatus`: it parses the Stripe status with `subscriptionStatusSchema` and returns `UnknownSubscriptionStatus` (`payments.unknown_subscription_status`). A subscription event for a Stripe customer with no local row returns `UnknownProviderCustomer` (`payments.unknown_provider_customer`); one with no items returns `SubscriptionWithoutItems`.
  - `createPlan`, `createPayment`, `createPaymentIntent`, `refundPayment`, `calculateTax` and `createTaxTransaction` return `money.provider_amount` (negative amount, a currency Stripe has no rule for, a fraction Stripe does not take) or `money.out_of_range` (past 2^53 Stripe units) before any request, instead of throwing `ProviderAmountError`. `createPlan` no longer leaves a product behind when the price amount is refused.
  - `createPaymentIntent` returns `PaymentMethodRequired` (`payments.payment_method_required`) for `automatic: true` without a `paymentMethodId`, instead of throwing `PaymentProviderError('invalid_request')`.
  - `calculateTax` and `createTaxTransaction` return `TaxAddressIncomplete` (`payments.tax_address_incomplete`) for a customer address with no country, instead of throwing.
  - `revenueCatWebhookSchema` accepts `purchased_at_ms` and `expiration_at_ms` only as whole milliseconds from 0 to the end of year 9999, so `projectRevenueCatEvent` never throws a range error.
  - `validateWebhook` gives no `eventType` for a Stripe event type the package does not model, instead of passing the Stripe name off as one of ours.

  Every Stripe request runs in a `payments.stripe.<resource>.<method>` span with `payments.provider: stripe`; a returned failure sets `payments.failure_code`.

  ## Subscriptions, proration, dunning, retries, repository, notifications

  Subscriptions, proration, dunning, retries, the core repository and refund notifications return typed failures instead of throwing plain `Error`s for expected outcomes.

  Breaking changes:

  - `SubscriptionManager`: every change returns a failure instead of throwing. `createSubscription` returns `payments.reference_not_found` (no customer for the user, or no plan), `payments.plan_inactive` or `payments.subscription_already_active`; `updateSubscription`, `setCancelAtPeriodEnd`, `cancelSubscription`, `reactivateSubscription`, `pauseSubscription` and `resumeSubscription` return `payments.reference_not_found` or `payments.subscription_invalid_state`; `previewSubscriptionChange` returns `payments.reference_not_found` or `payments.plan_inactive`; `syncSubscriptionWithProvider` returns `payments.reference_not_found` (`missing: 'provider_id'` when the provider has no such subscription) and the journal's refusal instead of hiding it. Provider and database errors are no longer rewrapped as `Failed to ...`: they reach the caller unchanged. `validateSubscriptionAccess` no longer turns a database error into `hasAccess: false`. The `get*` reads return the stored rows unchanged (nulls stay null).
  - `ProrationService`: `calculateProration`, `previewSubscriptionChange`, `getOptimalChangeTimings` and `generateProrationSummary` return `payments.reference_not_found`, `payments.plan_inactive`, `payments.plan_currency_mismatch` (plans in different currencies, for every proration behaviour; `CurrencyMismatchError` no longer escapes) or `payments.effective_date_outside_period`. `previewMultiplePlanChanges` leaves out a refused plan and logs it at WARN.
  - `PaymentRepository`: `updatePlan`, `deactivatePlan` and `updateCustomer` return `payments.reference_not_found` for an unknown id; `createCustomer` returns `payments.customer_conflict` for a clash; `updateWebhookEvent`, `markWebhookEventAsProcessed` and `incrementWebhookEventAttempts` return `payments.webhook_event_not_found`.
  - `DunningService.handlePaymentFailure` returns `payments.reference_not_found` for an unknown payment or subscription. A dunning step that throws now stays scheduled for the next run instead of counting as done.
  - `PaymentRetryService.scheduleRetries` returns `payments.reference_not_found` or `payments.payment_without_subscription`, and picks the strategy from the stored subscription status. `getRetryAnalytics` with a date range no longer throws on Temporal instants.
  - Notifications: `EmailNotificationService` sends through a transport the app passes in (`send(mail: { to, subject, text })`, such as `@arki/mail`'s `sendRaw`) and reads the customer's address from `reads` (`findPaymentById`, `findCustomerById`); `fromEmail` is gone (the app's mailer owns the sender). `SlackNotificationService` really POSTs to `webhookUrl` with a timeout (`timeoutMs`, default 10 s). Every send returns `payments.notification_failed` when it did not go out, and the `NotificationService` methods resolve with `void | Failure`. `createNotificationService` takes a discriminated config and throws `AssertError` at boot for a config that cannot send. Sends run in a `payments.notification` span.
  - `PaymentMonitoringService` starts no timer and `destroy()` is removed; a refused `kv.set` is logged at WARN; alerts run in a `payments.alert` span and log through `@arki/log` instead of `console.error`.

  New failure codes (in `@arki/payments/core/failures`): `payments.subscription_invalid_state`, `payments.subscription_already_active`, `payments.plan_inactive`, `payments.plan_currency_mismatch`, `payments.effective_date_outside_period`, `payments.payment_without_subscription`, `payments.customer_conflict`, `payments.webhook_event_not_found`, `payments.notification_failed`.

  ## Dunning campaigns, segments and communication providers

  Dunning returns typed failures for expected outcomes and checks every notification provider answer.

  Breaking changes:

  - `DunningCampaignService.executeCampaign` returns `DunningCampaignNotFound` (`payments.dunning_campaign_not_found`), `DunningCampaignNotActive` (`payments.dunning_campaign_not_active`) or `DunningCampaignWithoutSteps` (`payments.dunning_campaign_without_steps`) instead of throwing. Each writes nothing.
  - `CustomerSegmentationService.updateSegmentCustomerCount` and `getCustomersInSegment` return `CustomerSegmentNotFound` (`payments.customer_segment_not_found`) instead of throwing. `updateSegmentCustomerCount` now returns the new count. `createSegment` and `updateSegment` can return it too (a segment deleted while it is counted).
  - `CommunicationProvider.send` returns `CommunicationSent` (`{ messageId, providerResponse }`) or a `NotificationProviderFailure`: `NotificationProviderRejected` (`payments.notification_provider_rejected`, with `upstreamStatus` and `upstreamMessage`), `NotificationProviderTimeout` (`payments.notification_provider_timeout`), `NotificationProviderResponseInvalid` (`payments.notification_provider_response_invalid`, cause = the schema failure) or `schema.invalid_input` for a webhook recipient that is not an http or https URL. `CommunicationResult` (`{ success, errorMessage }`) is removed. A provider that cannot be reached at all throws, with the network error as its cause.
  - `getDeliveryStatus` on `EmailProvider` and `SMSProvider` returns the same failures instead of a made-up `sent` status; `CommunicationOrchestrationService.getDeliveryStatus` returns them instead of `null`.
  - `CommunicationOrchestrationService.sendCommunication` returns `NotificationChannelUnavailable` (`payments.notification_channel_unavailable`) when no provider is registered for the step's channel (nothing written), returns the provider failure after marking the row `failed`, and returns the row as it is after the send (`sent`), not the `pending` row it created.
  - `WebhookProvider` config `timeout` is renamed `timeoutMs`. `EmailProvider` and `SMSProvider` take optional `timeoutMs` (default 30 000) and `apiBaseUrl`; `createCommunicationOrchestrationService` passes `email.timeoutMs` and `sms.timeoutMs`.
  - `validateProviders` returns `Partial<Record<CommunicationChannel, boolean>>` (only registered channels have an entry). `DunningIntegrationConfig.systemUserId` is `string`.

  Fixes: the engagement score no longer divides by zero for a customer with no payment in the last 30 days (`updateCustomerRiskProfile` threw a raw Postgres error). Every provider send and delivery status call runs in a `payments.notification.send` or `payments.notification.delivery_status` span with only the channel and provider name. The eligibility query rows are checked by a schema instead of cast.

  ## Tax and refunds

  Tax and refunds return typed failures for expected outcomes instead of throwing.

  Breaking changes:

  - `TaxConfigurationRepository.updateConfiguration` and `setDefaultConfiguration`, `TaxJurisdictionRepository.updateJurisdiction`, and `TaxExemptionRepository.updateExemption`, `approveExemption` and `revokeExemption` return `TaxReferenceNotFound` (`payments.tax_reference_not_found`) for an id with no row, in place of throwing. `setDefaultConfiguration` with an unknown id now leaves the current default as it is.
  - `TaxExemptionRepository.createExemption` checks the row with the new `exemptionTargetSchema` and returns its `InvalidInput` for an exemption with no customer, product code or jurisdiction, in place of throwing. `createExemptionSchema` uses the same rule, so an empty `customerId`, `productCode` or `jurisdictionId` no longer counts as naming one.
  - `TaxService.createTaxTransaction` returns `TaxCurrencyMismatch` (`payments.tax_currency_mismatch`) for a tax line in another currency than the transaction, and `TaxRefundSaleNotFound` (`payments.tax_refund_sale_not_found`) for a refund with no `originalReference` or one that names a sale never recorded. `calculateTax`, `calculateSubscriptionTax`, `calculateOneTimeTax` and `createTaxTransaction` now infer their failure unions.
  - `TaxReportingService.getCustomerTaxSummary` returns `StoredTaxInvalid` (`payments.stored_tax_invalid`) when a payment's stored `taxAmount` metadata is not `Money` JSON or is in another currency than the payment. `exportTaxData` takes `format` as `ExportTaxDataInput['format']`; an unknown format is a caller bug (`unreachable`).
  - `RefundService.requestRefund` and the `requestRefund` journal command return `RefundCurrencyMismatch` (`payments.refund_currency_mismatch`) for a refund in another currency than the payment. The command used to store such a refund.
  - `RefundService.rejectRefund` returns the schema's `InvalidInput` for a blank reason, checked by the new `refundRejectionReasonSchema`, in place of throwing `RefundError('REASON_REQUIRED')`. `RefundErrorCode` loses `REASON_REQUIRED`.
  - New exports: `TaxReferenceNotFound`, `TaxCurrencyMismatch`, `TaxRefundSaleNotFound`, `StoredTaxInvalid`, `exemptionTargetSchema` from `@arki/payments/tax`; `RefundCurrencyMismatch` and `refundRejectionReasonSchema` from `@arki/payments/refunds`.
  - `RefundRepository` and the tax repositories return Drizzle's inferred rows, without casts.

  ## Also
  - `getSubscriptionAnalytics` counted no monthly or yearly recurring revenue: `PaymentRepository.getPaymentStats` loaded each payment's subscription without its plan. It now loads the plan, and the analytics read it without a cast.
  - `DunningEvent` gains `action` (the rule step a scheduled event runs; a recovery event has none). `data` no longer repeats it.

  Docs updated by the lane orchestrator in README, llms.txt and the agent guide.

  ## Follow-up: no stubs, no made-up numbers, no casts (R-4 to R-9)

  Breaking changes:

  - `DunningService` (and `createDunningService`) takes `senders: DunningSenders` (`sendEmail`, `sendWebhook`) after the config. An `email` step sends its template to the customer's stored address through `sendEmail`; a `webhook` step hands its config to `sendWebhook`. Before, both only logged. An enabled rule whose sender is missing, or an `email` rule with no `template`, throws `payments.configuration_invalid` when the service is built or `updateConfiguration` runs, so the default rules need `sendEmail`. A sender's returned failure is logged and the step counts as done; a throw leaves it scheduled.
  - `DunningStats` drops `averageRecoveryTime` (always 5) and `revenueRecovered` (an estimate): no stored data holds either. The recovery note names the subscription's user instead of `''`.
  - `InAppProvider` takes `{ appUrl, store }`, where `store: InAppNotificationStore` (`save`, `find`) is the app's notifications table; it no longer takes the database. `send` stores through it, and `getDeliveryStatus` reports what the store holds (`delivered`, `opened` once read, `payments.notification_provider_rejected` with status 404 for an unknown id) instead of always `delivered`. `CommunicationOrchestrationConfig.inApp.store` is required.
  - `WebhookProvider` and `CommunicationOrchestrationConfig.webhook` take `allowedHosts`: the hostnames a customer's `webhookUrl` may reach, compared exactly and lowercased after URL parsing. Any other host returns `payments.notification_webhook_host_not_allowed` and nothing is sent. An empty list, or an entry that is not a bare hostname, throws `payments.configuration_invalid` at boot. The webhook channel is registered only when `webhook` is configured (before: always).
  - `WebhookProvider` never reads or keeps the receiver's reply: a refusal has `upstreamMessage: null`, and `providerResponse` holds the status only (no headers).
  - Resend and Twilio answers are read up to `MAX_PROVIDER_BODY_BYTES` (64 KiB); the rest is cancelled.
  - `PaymentRetryService.getRetryAnalytics().revenueRecovered` is a `MoneyBag` of the stored amounts of the recovered payments (before: `successfulRetries * 50`).
  - `PaymentMonitoringService` (and `createPaymentMonitoringService`) takes `reads` (a `PaymentRepository`) after `kv`. `getSystemHealth().payments.activeSubscriptions` is the stored count (before: 1000) and `providers` is gone (it was always `{ stripe: true }`). `detectAnomalies` compares the payments stored in the last hour with the hourly average of the 24 hours before (before: a constant 100). New `PaymentRepository.countPaymentsCreatedBetween(start, end)`.
  - `DunningIntegrationService.healthCheck` reads each table instead of answering `true`; `paymentRetry` says whether a retry service was passed. `getIntegrationMetrics(days)` counts the stored executions and sent communications instead of returning zeros.
  - `DunningIntegrationService.processScheduledExecutions`, `processPendingCommunications`, `retryFailedExecutions`, `updateRiskProfiles` and `processAutoUpdateSegments`, and the service methods behind them (`DunningCampaignService.processScheduledExecutions`, `retryFailedExecutions`, `CommunicationOrchestrationService.processPendingCommunications`, `retryFailedCommunications`, `CustomerSegmentationService.bulkUpdateRiskProfiles`, `processAutoUpdateSegments`), return a `DunningTickReport` (`{ processed, failed: { id, code, message }[] }`) instead of `void`. A fault that stops a whole tick is logged and thrown instead of swallowed.
  - `DunningCampaignService.updateCampaign` returns `payments.dunning_template_in_use` before any write when the new steps drop one that already sent a communication (before: a raw foreign-key error). `DunningCampaignServiceTables` needs `dunningCommunications`.
  - `PaymentRepository`, the six dunning repositories and `CustomerSegmentationService` read with `db.select()` and joins instead of `db.query` behind an `as unknown as` cast, so they work on a database with no relations registered. A payment with no subscription reads `subscription: undefined` (before: `null`).
  - `StripeProvider.getPlan`, `updatePlan` and `listPlans` return `payments.plan_price_not_flat` for a plan whose Stripe price is not flat recurring, instead of throwing `PaymentProviderError('unknown')`.
  - An insert that returns no row (repositories, tax repositories, `writtenRow`) throws `invariant`'s `FailureError` instead of a plain `Error`. `readCustomerRiskProfile` throws `@arki/schema`'s `AssertError` for a stored date that is not an instant, instead of a raw `ZodError`.
  - Every payments boot check that rejects bad configuration throws `payments.configuration_invalid` (setting and problem in its data): `createNotificationService`, `EmailNotificationService`, `SlackNotificationService` (before: `AssertError`) and `RefundService` for a bad `autoApproveLimits` (before: `AssertError` `ARKI_SCHEMA_E004`). New `misconfigured(setting, problem)` in `core/failures` builds the thrown form.
  - `DunningCampaignService.processScheduledExecutions` and `retryFailedExecutions`: the stop-on-payment-success check reads and validates the succeeded payment (a row of the wrong shape is an `AssertError` bug; a stored currency `@arki/money` refuses is a returned `MoneyFailure`) before it cancels any later execution. A bad stored currency now cancels nothing, leaves the execution `completed` (its message went out), and is listed in the tick report with the money failure's code (before: a raw error after the cancels, and the execution marked `failed`).

  New failure codes: `payments.configuration_invalid` (`core/failures`), `payments.notification_webhook_host_not_allowed` and `payments.dunning_template_in_use` (`dunning/failures`), `payments.plan_price_not_flat` (`core/providers/provider-error`).

- e41e096: Amounts from Stripe, webhooks and stored JSON are no longer turned into throws. A bad one is returned as the `@arki/money` failure: `StripeProvider.getPlan`, `updatePlan`, `listPlans`, `previewSubscriptionChange`, `getPayment`, `createPayment`, `confirmPayment`, `cancelPayment`, `calculateTax` and `createTaxTransaction`; `TaxService.calculateTax`, `calculateSubscriptionTax`, `calculateOneTimeTax` and `createTaxTransaction`; `TaxReportingService.getCustomerTaxSummary`; `WebhookHandler.processWebhook` (a `payment.refunded` charge with a bad amount is not acknowledged and writes no refund); and the dunning segment and campaign calls that read stored spend ranges. Check `isFailure` before reading the result.

### Patch Changes

- 86250e6: `RefundService.requestRefund` returns `DuplicatePendingRefund` again when two requests for one payment race. The journal now reports a row insert's unique violation as `JournalError('CONFLICT')`, so the losing write came back as `TransactionDefect` and reached the caller as a defect. The service now knows the race in that shape too, and still in the `TransactionRejected` 23505 shape from a plain database write.

  no docs impact: behaviour fix; the documented failure is unchanged.
  no demo impact: no demo covers refund races.

- b435e76: A command declares the events it writes. Breaking (0.x, no shims):

  - `j.command(name, input, options, handler)` replaces `j.command(name, input, handler, options?)`. `options.writes` is required: `{ writes: [OrderPaid] }`, or `{ writes: [] }` for a command that only runs child commands. `authorize` moves into the same object.
  - `write` in a handler takes only the declared events: anything else is a type error. At run time an undeclared event fails the run with `BAD_DEFINITION`, naming the command and the event, and nothing commits, even when the handler catches the error.
  - `Command` has a fifth type parameter, `Writes`, and a read-only `writes` field that keeps the exact tuple, so code can read it before boot. `CommandContext` has a third, `Declared`. `CommandOptions` has a fifth.
  - New type `CommandWrite<MetaOut, Tx, Declared>`, the type of `context.write`. A helper that takes `write` names what it writes; a command can pass its `write` only when it declares at least those events.

  `@arki/payments` moves its commands to the new form; its API does not change. The `@arki/dot` app-stack template and the `@arki/db` README show the new form.

  See `docs/upgrades/0.3.0-to-0.4.0.md`, step 12.

  docs: README (Quick start, Commands, Idempotent commands, Failures, Workflows, Dot), `docs/agent-guide.md` (model, write a command, rules that bite, errors, shared packages), `llms.txt`.
  demo impact: `demos/faultline` (commands and lesson 02) moves to the new form.

- e132ad3: Hand-written object guards now come from `@arki/schema` (`is(value, recordSchema)` or `plainObjectSchema`), per A-39. Replaced: the `isRecord`/`isPlainObject`/`isObject` helpers in `dot`, `cli`, `http`, `expr`, `lock`, `mail`, `embeddings` (its internal `isRecord`, not a public export), `testing` and `payments`, plus inline `typeof x === 'object' && x !== null` checks on unknown values. Behaviour is the same, except that the inline checks and `lock`'s guard no longer let arrays through. `@arki/expr` and `@arki/lock` now depend on `@arki/schema`.
- b435e76: Effects only reach out, `startOn` says when a run starts, and workflows get a command node. Breaking (0.x, no shims):

  - An effect's context has no `run` and no `accept`: `{ jobId, attempt, signal, db }`. An event that must run a command starts a `j.task` or a `j.workflow` with `startOn`. `Effect` and `EffectHandlers` lose their runner type argument, and `RootCommandRunner` is no longer exported.
  - `startOn.timing` is required: `'after-commit'` (the behaviour so far) or `'with-event'`. `'with-event'` writes `RunStarted`, the first scheduled node and its job in the event's transaction, so a rollback of the command removes the run. No body runs inline. `onBusy: 'refuse'` with `'with-event'` is a type error. A standalone `workflow()` now types its `startOn` mapping.

  New:

  - `.command(name, command, ({ input, results }) => commandInput, { accept?, undo?, when?, retry? })` runs one command as a savepoint inside the checkpoint's transaction: exactly once per node, even when the job runs again after a crash. A refused command rolls back and the failure transition commits. `accept` names failures the run goes on from, and they join the typed result. `undo` runs in compensation, in reverse order.
  - `j.command(name, input, { writes, output }, handler)` takes a schema of the plain result. A command node stores it, and `results.x` and `def.read` are typed from it. Stored JSON is checked by the schema, never cast.

  Shape hashes of existing node kinds do not change. `@arki/payments`: the refund workflow names `timing: 'after-commit'`. Its steps stay steps, because none has a body of exactly one command.

- 5d55e12: Docs only: `llms.txt` import paths list `./refunds/effects`. No code change.
- Updated dependencies [b5cc408]
- Updated dependencies [c55a254]
  - @arki/money@0.2.0
  - @arki/contracts@0.4.1
  - @arki/date@0.5.0
  - @arki/db@0.5.1
  - @arki/env@0.2.0
  - @arki/failure@0.3.0
  - @arki/http@0.4.1
  - @arki/journal@0.4.1
  - @arki/kv@0.5.0
  - @arki/log@0.4.0
  - @arki/schema@0.3.0

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
