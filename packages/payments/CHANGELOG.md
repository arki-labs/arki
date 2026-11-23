# @arki/payments

## 0.6.0

### Minor Changes

- Breaking: the six `/index` alias entries are removed: `@arki/payments/index`, `/core/index`, `/dunning/index`, `/tax/index`, `/refunds/index` and `/presets/index`. Each pointed at the same file as its short path, so import `@arki/payments`, `/core`, `/dunning`, `/tax`, `/refunds` or `/presets` instead. The published API index (`dist/api.json`) listed every symbol twice under them.

- 937e762: Tax writes, tax quotes and the Stripe subscription preset return typed failures instead of throwing on data a caller or Stripe can send.

  - Breaking: `TaxJurisdictionRepository.createJurisdiction` now returns `TaxJurisdiction | TaxReferenceNotFound`. A `parentId` that names no jurisdiction returns `payments.tax_reference_not_found` (kind `jurisdiction`) instead of a raw Postgres foreign-key error. `updateJurisdiction` (new `parentId`), `TaxExemptionRepository.createExemption` and `updateExemption` (new `jurisdictionId`) return the same failure. The named jurisdiction is locked until the write, so it cannot be deleted in between.
  - Breaking: the `TaxExemptionRepository` constructor takes `{ taxExemptions, taxJurisdictions }`. `createTaxRepositories` passes both.
  - `TaxService.calculateTax`, `calculateSubscriptionTax` and `calculateOneTimeTax` return `money.provider_amount` when Stripe answers in another currency than the sale, instead of throwing `CurrencyMismatchError`. They and `createTaxTransaction` return `money.provider_amount` for a currency outside ISO 4217 (a custom currency Stripe cannot price), before Stripe is asked, instead of throwing `UnknownCurrencyError`.
  - `projectStripeSubscription` and `createSubscriptionBilling().handleWebhook` return `InvalidInput` (`schema.invalid_input`) for a period, trial or cancel time that is not whole Unix seconds up to year 9999, instead of throwing `RangeError`. Nothing is written.
  - `TaxExemptionRepository.findExpiringExemptions(days)` states its precondition: `days` from 1 to 365, as `getExpiringExemptionsInputSchema` allows. Anything else throws `FailureError` (`invariant`) before the query, not `RangeError: Invalid Date`.
  - `fromStoredNumber` documents its throws: `NumericRangeError` and `UnknownCurrencyError`.

- 111f3f1: Core services return a bad config and refuse oversized batches. `PaymentRetryService` and `DunningService` have a private constructor: build them with `static create(...)`, or with `createPaymentRetryService` / `createDunningService`; each returns the service or `payments.configuration_invalid`. `addRetryStrategy`, `updateRetryStrategy` and `DunningService.updateConfiguration` return nothing or that failure, and change nothing on failure. `previewMultiplePlanChanges` takes at most `MAX_BATCH_ITEMS` (1,000) plan ids, and the retry strategies, their lists, and the dunning `rules` and `retrySchedule` hold at most that many items. See `docs/upgrades/0.5.0-to-0.6.0.md`.
- 969c3d7: The risk profile writes refuse what Postgres refuses: `CustomerRiskProfileRepository.create`, `update` and `upsert` return `schema.invalid_input` for U+0000 or a bigint in the profile's JSON instead of a raw 22P05 or `TypeError`, and nothing is written. Breaking: their results, `updateCustomerRiskProfile` and the integration event handlers gain `SchemaFailure`. `lockReferences` returns the reference's `missing()` for a value holding U+0000 (no row can hold it) instead of a raw 22021. See `docs/upgrades/0.5.0-to-0.6.0.md`.
- 2fd3262: Audit 6, core lane. Id schemas, `userIdSchema` included, refuse an id longer than the id column (256 characters) as `schema.invalid_input`, and `PaymentRepository` lookups answer such an id as not found without a query. `PaymentRetryService.updateRetryStrategy` returns the new failure `payments.retry_strategy_not_found` for an unknown name. JSON for a jsonb column may nest at most 100 levels (`MAX_JSON_DEPTH`); deeper is `schema.invalid_input`. New `taxRecordIdSchema` and `taxAuditEntryIdSchema`.
- 7035f16: The core, tax, refunds and presets refuse what a jsonb column, an `instant` column, Stripe or `@arki/money` would refuse, as a typed failure or a documented precondition, before any write or request.

  - `pgJsonSchema` and `pgJsonRecordSchema` refuse a lone surrogate (such as `'\uD800'` alone) in any string or key, which Postgres refuses in jsonb with SQLSTATE 22P02. Every metadata, webhook body, tax JSON column and dunning JSON column built on them returns `schema.invalid_input` for one. A real surrogate pair is stored as before.
  - Journal events are jsonb, so every text a payment, subscription or refund command keeps in its event, and its stream id, refuses a lone surrogate with `schema.invalid_input` (a raw 22P02, `db.transaction_rejected` or an `ID_MISMATCH` defect before). `refundIdSchema` and `refundRejectionReasonSchema` refuse it too. `planInsertSchema`, `createPlanInputSchema` and `createPlan` refuse one in a plan feature. `lockReferences` treats a lone-surrogate id as missing (`payments.reference_not_found`), so it never matches the U+FFFD row the driver writes in its place.
  - Any `StripeProvider` call with a lone surrogate in a text it sends throws `PaymentProviderError` (`invalid_request`) before the request (a raw `URIError` from the Stripe library before).
  - `StripeProvider` throws `payments.configuration_invalid` at construction for a `maxNetworkRetries` that is not a whole number of 0 or more.
  - `createTaxTransaction` states its preconditions: a line `quantity` that is a whole number of 1 or more, and every line in the call's currency; a break throws the invariant failure (`ARKI_FAILURE_E008`) before any request (a raw money error, or quantity 0 sent to Stripe, before). `calculateTax` throws the invariant failure for a line in another currency (a raw `CurrencyMismatchError` before). Tax lines below a cent or past 2^53 minor units return `schema.invalid_input` before Stripe is asked.
  - Webhook subscription events with a time outside the years 1 to 9999 return `webhook_payload_invalid`.
  - The tax row schemas check `createdAt` and `updatedAt` on configurations, jurisdictions and exemptions and `approvedAt` on exemptions (years 1 to 9999), and every new row's `id` (no U+0000, at most 256 characters). `updateConfiguration`, `updateJurisdiction`, `updateExemption` and the five tax inserts return `schema.invalid_input` (raw 22008, 22009, 22021 or 22001 before).
  - Breaking: `TaxRecordTotal.saleTaxMinor`/`refundTaxMinor` and the same fields of `TaxRecordPaymentTotal` are exact decimal text (`string`), not `number`; two large records used to throw a raw `NumericRangeError` in the report and the summaries. Stored tax below a cent or negative in payment metadata returns `StoredTaxInvalid` (`not_money`) from `TaxReportingService.getCustomerTaxSummary`. The tax request schemas and `findExpiringExemptions`/`getCustomerTaxSummary` refuse a fractional year, quarter, month or days.
  - The refund command input schemas return `schema.invalid_input` for an amount past 2^53 - 1 minor units (a raw `NumericRangeError` before). `RefundRepository.searchRefunds` and `RefundService.searchRefunds` throw the invariant failure for a `minAmount`/`maxAmount` the column cannot hold, before any query.
  - `createSubscriptionBilling().createCheckoutSession` returns `schema.invalid_input` for a `userId` holding U+0000 or a lone surrogate, before Stripe makes a customer.
  - `toMinorColumn`, `fromMinorColumn`, `planPrice` and `paymentAmount` state their throws: they read a row this package stored or an amount its schemas accepted, so an unknown currency (`UnknownCurrencyError`), a unit count past 2^53 (`NumericRangeError`) or sub-minor digits (`RoundingNecessaryError`) is a caller bug.

- b87255b: The payments core answers caller values Postgres would refuse, and rows that do not exist, with typed failures, and stops dropping refusals into logs.

  - Journal commands look up the rows a write points at: `ReferenceNotFound` (new kind `user`) instead of `db.transaction_rejected`; `createSubscription` refuses a stored provider subscription id with `journal.conflict`; `markSubscriptionPastDue` refuses a canceled subscription.
  - Command schemas, contracts, derived insert schemas and `PaymentRepository` writes refuse U+0000, over-long text, fractional or out-of-range integers, amounts past 2^53 - 1 minor units, unknown currencies and times outside the years 1 to 9999 as `schema.invalid_input`.
  - New failures: `payments.plan_already_exists` (409), `payments.customer_in_use` (409), `payments.webhook_event_exists` (409). `updateCustomer` returns `CustomerConflict` and `ReferenceNotFound`.
  - Breaking: `deleteCustomer`, `createWebhookEvent`, `claimWebhookEvent`, `updateWebhookEvent`, `incrementWebhookEventAttempts`, `createPlan`, `updatePlan`, `createCustomer` gain failure results; `processDunningEvents` returns per-step reports; `previewMultiplePlanChanges` returns `{ previews, refused }` or `ReferenceNotFound`.
  - Breaking: `PaymentMonitoringService` `recordPaymentAttempt`, `recordRefund`, `recordSubscriptionEvent` and `recordWebhookProcessing` return the first KV failure (`kv.unavailable`, ...) instead of dropping it, or `undefined`.
  - `StripeProvider.calculateTax` and `createTaxTransaction` return `money.provider_amount` for a currency outside ISO 4217 instead of throwing; `createCustomer` sends metadata as Stripe strings; `createPlan` deletes the Stripe product when the price is refused; `previewSubscriptionChange` reads every page of invoice lines; the refund-rate alert and the health success rate count successful attempts.
  - Fixes: `handleTrialEndingSoon` finds trials, `validateSubscriptionAccess` grants trials, webhook analytics counts processed events, `retryFailedWebhooks` no longer re-reports or starves on events given up on, retry strategies no longer leak between instances, presets parse the Stripe subscription body, checkout checks the email before Stripe creates a customer.

  See `docs/upgrades/0.5.0-to-0.6.0.md`.

- f367180: Dunning and tax refusals that stored data causes are returned, and failed dunning executions are really retried. Breaking in 0.x.

  - `DunningCampaignService.deleteCampaign` returns `DunningTemplateInUse` (`payments.dunning_template_in_use`, 409) for a campaign whose step already sent a communication, instead of throwing the database's foreign-key error. Nothing is deleted; archive the campaign instead. It returns `undefined` when it deletes.
  - `TaxExemptionRepository.updateExemption` returns `InvalidInput` (`schema.invalid_input`) when the row the update leaves would name no customer, product code or jurisdiction, or would end before it starts, instead of throwing the table's CHECK error. `createExemption` returns the same failure for an end before the start. New `exemptionPeriodSchema` in `@arki/payments/tax/contracts` holds the date rule.
  - `retryFailedExecutions` now retries: an execution that throws (in `processScheduledExecutions` or in a retry) is `failed` with a `nextRetryAt` of 30, 60, then 120 minutes, each retry counts once in `retryCount`, and after 3 retries it stays failed with no `nextRetryAt`. `DunningExecutionRepository.incrementRetryCount` is replaced by `startRetry(id)` and `recordFailure(id, errorMessage, nextRetryAt)`.
  - The README and agent guide now say a refund in another currency returns `RefundCurrencyMismatch`; they said it throws.

  Migration: branch on the result of `deleteCampaign` and `updateExemption` with `isFailure`. Callers of `incrementRetryCount` call `startRetry` and `recordFailure`. See `docs/upgrades/0.5.0-to-0.6.0.md`.

  no demo impact: the package has no demo.

- 2fd3262: Every caller array in the payments contracts takes at most `MAX_BATCH_ITEMS` (1,000) items; more is `schema.invalid_input`. This covers the dunning segment criteria (`planTier`, `subscriptionStatus`, `customerSegments`, `planTiers`), plan `features`, customer `taxIds`, `metrics`, `requiredTiers`, `targetSegments`, `segmentIds`, `variables`, `unsubscribedChannels`, `campaignIds` and campaign steps. `allowedDays` takes at most 7 days.
- cd89bfe: Audit 7, dunning lane. A full counter is returned, never a raw Postgres 22003 error: `DunningExecutionRepository.startRetry`, `PaymentRepository.incrementWebhookEventAttempts` and `reclaimWebhookEvent` return the new failure `payments.counter_exhausted` (`CounterExhausted`, 409, data `{ counter, id }`) when `retryCount` or `attempts` already holds 2^31 - 1, and write nothing. The guard sits in the update itself, and `incrementWebhookEventAttempts` now raises the count in SQL. `reclaimWebhookEvent` returns `boolean | CounterExhausted`. `retryFailedExecutions` reports such an execution and stops retrying it. Every URL `fetch` is given refuses a port the WHATWG Fetch standard blocks, on every runtime (one list, `FETCH_BAD_PORTS`): `EmailProvider.create` and `SMSProvider.create` return `payments.configuration_invalid` for such an `apiBaseUrl`, `WebhookProvider.send` returns `schema.invalid_input` for such a recipient, and `SlackNotificationService.create` refuses such a `webhookUrl` (and one with credentials).
- 111f3f1: Fifth audit fixes: refusals carry failure codes, and settings `fetch` would refuse fail at boot.

  - Breaking: `WebhookSecurityService.validateWebhook` returns the checked delivery `{ provider, eventType, data }` or `WebhookRejected` (`payments.webhook_rejected`), never `{ isValid, error }`. `WebhookRejected` gains `check` (`WEBHOOK_CHECKS`: `source_ip`, `timestamp`, `replay`, `signature`) naming the check that refused. The catch-all that turned any throw into a message is gone; a `Stripe-Signature` no header can carry is refused as malformed instead of throwing inside `new Headers`. `WebhookHandler` forwards the refusal unchanged.
  - Breaking: `allowedIps` is schema-checked when the service is built: each entry must be an IPv4 or IPv6 address or CIDR range, or the constructor throws `payments.configuration_invalid`. A malformed entry (such as `'\uD800/33'`) used to let any address through. Matching uses `node:net`'s `BlockList`, so IPv6 ranges and IPv4-mapped IPv6 sources work; a source that is not an IP address is refused as `source_ip`.
  - `StripeProvider` calls that take an `idempotencyKey` (`createSubscription`, `updateSubscription`, `cancelSubscription`, `refundPayment`, `createSetupIntent`, `createPaymentIntent`) return `schema.invalid_input` before any request for a key that is empty, over 255 characters, or not printable ASCII without outer spaces. It used to fail inside Stripe's HTTP client and be thrown as a retryable `unavailable`. `BasePaymentProvider.cancelSubscription`, `createSetupIntent` and `createPaymentIntent` gain `SchemaFailure`.
  - `EmailProvider` and `SMSProvider` throw `payments.configuration_invalid` at construction for an API key, account SID or token no HTTP header can carry, or an `apiBaseUrl` that is not an http(s) URL without credentials; `WebhookProvider` does the same for a `defaultHeaders` name or value `fetch` would refuse. A thrown `unavailable` now means a real outage. Personalization values are inserted literally: `$&` and `` $` `` are no longer expanded. `WebhookProvider.send` returns `schema.invalid_input` for a recipient URL with a user name or password, which `fetch` would refuse.
  - `toInstant` and `toNullableInstant` (`core/journal/support`) state their precondition (an ISO 8601 timestamp with `Z` or an offset) and throw the invariant failure for anything else, not a raw `RangeError`.
  - `NotificationService` documents its precondition: `refund` is a stored row; a hand-built refund whose amount or currency `@arki/money` refuses rejects with that money error before anything is sent. The README now says a refund notification that did not go out returns `payments.notification_failed`.
  - Tests pin `contracts.random_source_unavailable` for every dunning id factory.

- 937e762: Dunning answers a missing or referenced row with a typed failure, never a raw Postgres error.

  - `DunningCampaignRepository.delete` returns `DunningTemplateInUse` for a campaign whose step sent a communication. It locks the campaign and its steps first. Its factory now takes `dunningTemplates` and `dunningCommunications`.
  - `DunningTemplateRepository.create` returns `DunningCampaignNotFound` for an unknown `campaignId`. `DunningTemplateRepository.delete` returns `DunningTemplateInUse` for a step that sent a communication (it locks the step first); its factory now takes `dunningCommunications`.
  - `DunningExecutionRepository.create` and `DunningCommunicationRepository.create` return the not-found failure of the reference with no row: `DunningCampaignNotFound`, the new `DunningTemplateNotFound` (`payments.dunning_template_not_found`) and `DunningExecutionNotFound` (`payments.dunning_execution_not_found`), or `ReferenceNotFound`. `executeCampaign` and `sendCommunication` pass them on.
  - `CustomerRiskProfileRepository.create` and `upsert` return `ReferenceNotFound` (`kind: 'customer'`) for an unknown customer, and never `undefined`. `updateCustomerRiskProfile` and the `DunningIntegrationService` handlers that update the profile pass it on.
  - `customer_risk_profiles.customer_id` has a unique index, and `upsert` is one `INSERT ... ON CONFLICT DO UPDATE`: two first upserts at once leave one row. Remove duplicate profiles before pushing the schema.
  - `updateCampaign` locks the steps before it checks them for sent communications, so a message written meanwhile cannot turn the refusal into a foreign-key error.
  - `handlePaymentSuccess` throws the database error when it cannot cancel an active execution, instead of logging it and resolving.
  - A notification provider that cannot be reached throws `PaymentProviderError('unavailable')` instead of a plain `Error`. A message id with a lone UTF-16 surrogate returns `schema.invalid_input`. `sendCommunication` throws an `AggregateError` of both errors when marking the row failed also fails.
  - The dunning contracts refuse U+0000 in text and stored JSON, and `stepNumber`, `delayHours` and `updateFrequency` above 2^31 - 1.

  See `docs/upgrades/0.5.0-to-0.6.0.md`.

- b87255b: Dunning never loses a failed send or a failed campaign run, and its doors refuse what Postgres refuses as typed failures. A scheduled message that does not go out fails its execution, is listed in the tick report and is retried only after an unreachable provider or a 5xx refusal (never a timeout). Executions own the resend: `retryFailedCommunications` skips a send its execution will retry, and the communication service now takes `dunningExecutions`. The event handlers throw a campaign run that threw instead of acknowledging it, and return `ReferenceNotFound` for an unknown payment or subscription. The contracts bound day, month and hour spans at 100 years; the repositories check actor ids, text, JSON and counts before writing. New failures: `payments.customer_risk_profile_exists` (409) and `payments.dunning_communication_not_found` (404). `communicationWebhookSchema` now matches `handleCommunicationWebhook`. Breaking: actor ids are `UserId`, several results gain `schema.invalid_input`. See `docs/upgrades/0.5.0-to-0.6.0.md`.
- 111f3f1: Dunning repositories refuse hostile caller values as `schema.invalid_input` instead of raw Postgres errors: unknown `sortBy`, enum values (type, status, channel, risk category), over-long reference ids and more than 1,000 trigger segment ids. `sumMinorByCurrency` returns a `SchemaFailure` for a row it cannot read as money. The list reads and `findByType`, `findActiveForTrigger`, `findByRiskCategory` now include `SchemaFailure` in their result.
- f79fa1e: Batch methods return each failure as a value, never only as a log line or its text.

  - Breaking: `PaymentRetryService.processRetries()` returns one report per due attempt, in run order (it returned `void`): `{ attemptId, status }` with `status` `succeeded`, `failed` (`failure` is the declined card, `payments.card_declined`, or `payment` is the provider's answer that did not succeed), `cancelled`, `refused` (`failure` is what the provider or the journal returned, such as `payments.configuration_invalid` from a `StripeProvider` built without `references`), or `thrown` (`error`). An attempt that an earlier attempt of the same run recovered is `cancelled` and no longer charged again.
  - Breaking: `WebhookHandler.retryFailedWebhooks()` returns one report per event read (`processed`, `skipped`, `refused` with `failure`, `thrown` with `error`; it returned `void`). A fault that stops the whole run still emits `webhook:retry_error` and is now thrown instead of swallowed.
  - Breaking: a `DunningTickReport.failed` entry is `{ id, status: 'refused', failure }` or `{ id, status: 'thrown', error }` (it was `{ id, code, message }`, with `code: null` and only the message for a thrown error). `DunningTickFault` is inferred from `tickFault`.

- b87255b: Tax and refunds return typed failures for every value a caller can send that Postgres or the money sums would refuse, and never drop a notification failure.

  - New failures: `payments.tax_line_currency_mismatch` (422, a line item in another currency than its sale), `payments.tax_jurisdiction_in_use` (409, `deleteJurisdiction` on a jurisdiction a child or an exemption names), `payments.tax_row_exists` (409, an explicit `id` another row has).
  - The tax contracts, the refund command schemas and `refundRejectionReasonSchema` refuse text holding U+0000, text over its `varchar` length and times outside the years 1 to 9999, as `schema.invalid_input`. `taxCalculationInputSchema` refuses a line item in another currency than `currency`.
  - Breaking: every tax repository write checks its row (`taxConfigurationRowSchema`, `taxJurisdictionRowSchema`, `taxExemptionRowSchema`, `taxAuditRowSchema`, `taxRecordRowSchema`) and returns `schema.invalid_input` instead of a raw Postgres error: `createConfiguration`, `updateConfiguration`, `createJurisdiction`, `updateJurisdiction`, `createExemption`, `updateExemption`, `approveExemption`, `TaxAuditRepository.record`, `recordMany` (which now returns `SchemaFailure | undefined`). `createConfiguration`, `createJurisdiction`, `createExemption` and `record` return `TaxRowExists` for a taken `id`. Reads given U+0000 find nothing.
  - Breaking: `TaxJurisdictionRepository.deleteJurisdiction` returns `TaxJurisdictionInUse | undefined`, and its constructor takes `{ taxJurisdictions, taxExemptions }`. `createTaxRepositories` passes both.
  - `TaxService.calculateTax` and `createTaxTransaction` return `TaxLineCurrencyMismatch` instead of throwing `CurrencyMismatchError`. `createTaxTransaction` checks the records before Stripe is asked (`schema.invalid_input`), so Stripe and the records never disagree, and returns `TaxCurrencyMismatch` for a reference recorded earlier in another currency.
  - Breaking: `TaxReportingService.generateComplianceReport` and `exportTaxData` return `StoredTaxInvalid` (`other_currency`) for a tax record in another currency than its payment, instead of throwing. `createAuditEntry` returns `schema.invalid_input` or `TaxRowExists`.
  - `getUpcomingDeadlines` returns for an `asOf` near the last date a `Date` holds (it looped forever). Both `getCustomerTaxSummary` methods throw `FailureError` (`invariant`) for a year outside 2000 to 2100.
  - Refund commands return `CommandNotFound` (`journal.not_found`) for a `requestedBy`, `approvedBy` or `rejectedBy` with no user, instead of `db.transaction_rejected` (23503).
  - Breaking: the customer's rejection mail is the `refund-rejection-notice` effect of `createRefundEffects`; `RefundService` and `createRefundService` no longer take a `NotificationService`. A mail the approval or rejection effect could not send is returned, never dropped: `payments.notification_failed` is retried with the journal's default backoff (`refundMailRetry`: 8 tries, 1 s up to 5 minutes), any other failure makes the job dead at once, with it as `lastError`. The `payments.refund` workflow output gains `notificationFailure` when the `notify` mail did not go out.
  - `averageTaxRate` in the compliance report leaves out a payment whose tax equals its amount (it was `Infinity`).
  - `getRefundMetrics` no longer overflows the call stack on Node with ~150,000 refunds.

- 9d345d6: Dunning checks what its types allow but Postgres, a timer or `JSON.stringify` would refuse, before any query or request.

  - `DunningTemplateRepository.create` and `update` parse `createDunningTemplateInputSchema` and `updateDunningTemplateInputSchema` and return `schema.invalid_input` (both return types gain `SchemaFailure`). `DunningCampaignRepository.create`/`update` and `CustomerSegmentRepository.create`/`update` return `schema.invalid_input` for a name, text, JSON or update frequency their columns cannot store (`CustomerSegmentRepository.update` gains `SchemaFailure`).
  - `createCampaign` and `updateCampaign` parse the steps with `dunningCampaignTemplatesSchema` before any write. `createSegment`, `updateSegment` and `getCustomersMatchingCriteria` refuse criteria the contract refuses (U+0000 in a plan tier, NaN, a span out of range) with `schema.invalid_input` (`getCustomersMatchingCriteria` gains `SchemaFailure`).
  - Every page size, offset, row count and day or hour span is a documented precondition: a value that is not a whole number in range throws the invariant failure (`ARKI_FAILURE_E008`) before any query. This covers the four `findMany` reads and the list methods over them, `findScheduledExecutions`, `findRetryableExecutions`, `findPendingCommunications`, `findRecentForCustomer`, `findByRiskCategory`, `findBySegmentId`, `getAnalyticsSummary`, `getCampaignAnalytics`, `getIntegrationMetrics`, `processScheduledExecutions`, `retryFailedExecutions`, `processPendingCommunications`, `retryFailedCommunications`, `bulkUpdateRiskProfiles`, `getCustomersInSegment` and `getCustomersByRiskCategory`. List times must fall in the years 1 to 9999. A `search` holding U+0000 matches nothing.
  - `WebhookProvider.send` returns `schema.invalid_input` for tracking data with a bigint or U+0000, and sends nothing.
  - `EmailProvider`, `SMSProvider` and `WebhookProvider` throw `payments.configuration_invalid` at construction for a `timeoutMs` that is not a whole number from 1 to 2^31 - 1.
  - The `handleSubscriptionStatusChange` and `handleTrialEnding` docs say what they return: the subscription id is not looked up.

  The core, tax, refunds and presets check the same things.

  - `StripeProvider.validateWebhook` and `constructWebhookEvent` use Stripe's `constructEventAsync`, so they work on Bun, Deno and workers (the sync check threw `CryptoProviderOnlySupportsAsyncError` there). Breaking: `constructWebhookEvent` is now async; `await` it. The cross-runtime smoke test checks both on Node, Bun and Deno.
  - `StripeProvider` calls that take `metadata` (`createCustomer`, `updateCustomer`, `createPlan`, `updatePlan`, `createSubscription`, `updateSubscription`, `createPayment`, `refundPayment`) return `schema.invalid_input` before any request for metadata with a `bigint` anywhere or U+0000 (a raw `TypeError` before). The matching `BasePaymentProvider` return types gain `SchemaFailure`, and so do `SubscriptionManager.createSubscription`, `updateSubscription` and `setCancelAtPeriodEnd`. `intervalCount` and `trialPeriodDays` (1 to 365, and 1 to 730 for `createCheckoutSession`) are documented preconditions that throw the invariant failure.
  - `userIdSchema` refuses U+0000. Every `PaymentRepository`, `StripeProvider`, tax and refund lookup or write by an id or user id that holds U+0000 returns its not-found answer (null, empty, `ReferenceNotFound`, `WebhookEventNotFound`) without a query, as the provider-id lookups already did. Journal payment and subscription commands, the core insert schemas and `claimWebhookEvent` return `schema.invalid_input` for such an id, and `reclaimWebhookEvent` returns false.
  - `findPlans`, `findSubscriptions` and `findPayments` state their precondition: a query their contract schema accepts. A fractional `limit` or a time outside the years 1 to 9999 throws the invariant failure before any query.
  - Counts and durations are checked where they are set. `WebhookHandler`, `WebhookSecurityService`, `WebhookAnalyticsService`, `PaymentRetryService` (and `addRetryStrategy`/`updateRetryStrategy`, with `maxAttempts` 1 to 10), `DunningService` rule delays, `RefundService` `refundWindowMs` and `createSubscriptionBilling` `trialDays` (1 to 730) throw `payments.configuration_invalid` for a value they cannot use. Breaking: a negative, NaN or fractional `refundWindowMs` used to be accepted. `recordPaymentAttempt`, `recordWebhookProcessing`, `recordProcessingTime`, `SubscriptionManager.createSubscription`'s `trialPeriodDays` and the event times of `projectRevenueCatEvent` are documented preconditions that throw the invariant failure (a raw `RangeError` before, for RevenueCat).

- cd89bfe: `StripeProvider` returns a missing `references` and every Stripe amount money refuses, instead of throwing.

  - Breaking: a `StripeProvider` built without `references` returns `PaymentsConfigurationInvalid` (`payments.configuration_invalid`, `data.setting` `'references'`) from every call that takes a customer, plan, subscription or payment id, and sends no request. It threw `PaymentProviderError` (`not_configured`). `getCustomer` and `getSubscription` now return `Result<T | null, ...>`; the other calls, the matching `BasePaymentProvider` methods and `SubscriptionManager`'s provider-backed methods (`syncSubscriptionWithProvider` among them) add the failure. The `not_configured` member of `PaymentProviderErrorCode` is removed.
  - `getPlan`, `updatePlan`, `listPlans`, `createPayment`, `getPayment`, `confirmPayment` and `cancelPayment` return `money.out_of_range` for a Stripe amount past 2^53 - 1 of our minor units (an MGA amount near 2^53: Stripe counts whole ariary), where `toMinorColumn` threw `NumericRangeError`. `createPlan` returns it for such an amount before any request, where it threw after Stripe had made the product and price.
  - Every Stripe amount read has a test per money code it returns: `money.unknown_currency`, `money.provider_amount`, `money.out_of_range`, `money.invalid_text` and `money.input_too_large` (the last two for an amount Stripe sends as text). `getPayment`'s money failure type narrows from `MoneyFailure` to these codes.

- 7035f16: Dunning answers every id, time, setting and spend range a caller passes, instead of a raw database or money error.

  - Every dunning repository method treats an id or text holding U+0000 as unknown, without a query (Postgres refused it with SQLSTATE 22021): reads answer `null`, `undefined`, `[]` or zero counts, updates and deletes change nothing, and a write that names such a campaign, step, execution or customer returns its not-found failure (`DunningCampaignNotFound`, `DunningTemplateNotFound`, `DunningExecutionNotFound`, `ReferenceNotFound`). This covers `DunningCampaignRepository.update`, `DunningCommunicationRepository.findById` and `findMany` (`executionId`, `customerId`), the risk profile reads and writes, and the services over them (`getCustomerRiskProfile`, `updateCustomerRiskProfile`, `getCustomerSegments`, `updateCampaign`, `executeCampaign`'s customer filters, the event handlers). `CustomerRiskProfileRepository.findBySegmentId` answers `[]` for a segment id jsonb cannot hold (also a lone surrogate).
  - Breaking: `CustomerSegmentationService.calculateCustomerRiskScore` returns `ReferenceNotFound` (`kind: 'customer'`) for an unknown customer instead of scoring nobody. `CustomerRiskProfileRepository.updateSegments` returns `schema.invalid_input` for segment ids jsonb cannot store (its return type gains `SchemaFailure`).
  - A spend range is read as a money door: digits below the currency's minor unit (`1.001 EUR`) return `money.rounding_necessary` and more than 2^53 - 1 minor units `money.out_of_range` from `createSegment`, `updateSegment`, `getCustomersMatchingCriteria` and every reader of a stored segment (`updateCustomerRiskProfile`, `getCustomerSegments`, `updateSegmentCustomerCount`, `getCustomersInSegment`), where a raw `RoundingNecessaryError` or `NumericRangeError` was thrown.
  - `DunningCampaignRepository.create`/`update` and `CustomerSegmentRepository.create`/`update` parse their contracts (`createDunningCampaignInputSchema`, `updateDunningCampaignInputSchema` without the steps, `createCustomerSegmentInputSchema`, `updateCustomerSegmentInputSchema`), so `createCampaign` and `updateCampaign` do too: a setting or trigger count outside its range, NaN, an allowed day past 6 or an invalid spend range is `schema.invalid_input` at the write, never a raw error (or an endless loop) when the campaign runs.
  - Contract changes: `campaignTriggerSchema.conditions.subscriptionStatus` takes the subscription statuses and `segmentCriteriaSchema.planTier` the plan tiers (a value the enum has not was a raw SQLSTATE 22P02 in the query); `paymentFailureCount` is at most 2^31 - 1 (SQLSTATE 22003 past bigint before). The times of `updateCommunicationStatusInputSchema`, `communicationWebhookSchema` and the execution and communication list queries fall in the years 1 to 9999.
  - Times written to an `instant` column (execution `scheduledAt`, `startedAt`, `completedAt`, `nextRetryAt` and `updateStatus`'s `customScheduledAt`; communication `sentAt`, `deliveredAt`, `openedAt`, `clickedAt`) return `schema.invalid_input` outside the years 1 to 9999 (SQLSTATE 22008/22009 before). `getAnalyticsSince`, `findTopPerformer` and `recordFailure`'s `nextRetryAt` state that precondition and throw the invariant failure before any query.
  - A step's `communication` with a lone surrogate (which its jsonb column refuses with SQLSTATE 22P02) returns `schema.invalid_input` from `DunningTemplateRepository.create` and `update`.

- 111f3f1: Tax refuses hostile input. Enum values outside their list, lone-surrogate text for Stripe and more than 1,000 batch items return `schema.invalid_input` instead of a raw Postgres error, a Stripe `invalid_request` or a stack overflow. Breaking: `exportTaxData` returns `schema.invalid_input` for a bad `format` where it threw `ARKI_FAILURE_E004`, and the tax calculation methods and `createTaxTransaction` can return `SchemaFailure`. See `docs/upgrades/0.5.0-to-0.6.0.md`.
- 111f3f1: Dunning services return failures instead of throwing: providers, the communication service and the integration service build with `create` and return `payments.configuration_invalid`; list calls return `schema.invalid_input`; `executeCampaign` caps `customerIds` at 1,000.
- 111f3f1: Core data refuses hostile input. `PaymentRepository` lookups by a status, tier, provider or event type outside its enum answer empty or null (no raw 22021 or 22P02), `claimWebhookEvent` returns `schema.invalid_input` for a provider or event type outside its enum, and `findUnprocessedWebhookEvents` takes a `belowAttempts` past the 32-bit range (no raw 22003). Breaking: the money builders (`fromMinorColumn`, `fromStoredNumber`, `planPrice`, `paymentAmount`) throw an invariant failure instead of `NumericRangeError`, `NumberFormatError` or `UnknownCurrencyError`; `lockReferences` breaks an invariant above 1,000 references. See `docs/upgrades/0.5.0-to-0.6.0.md`.
- 81983b8: A returned failure now sets the span attribute `failure.code`, the name every `@arki/*` package uses, instead of `payments.failure_code`. The span status for a returned failure (a declined card) stays unset; a throw still sets it to error. Migration: dashboards and alerts that group on `payments.failure_code` group on `failure.code`.

  Docs: README `## Observability` lists every `payments.*` span and the `payments.operations` counter.

- 111f3f1: Webhook and notification services return bad config instead of throwing. Breaking: `WebhookHandler`, `WebhookSecurityService`, `WebhookAnalyticsService`, `EmailNotificationService` and `SlackNotificationService` have a private constructor and a `static create(...)` that returns the service or `payments.configuration_invalid`; `createWebhookHandler`, `createWebhookSecurityService`, `createWebhookAnalyticsService` and `createNotificationService` return the same. `allowedIps` and `adminEmails` take at most 1,000 items. `sendRefundStatusUpdate` answers `ReferenceNotFound` for a payment id holding U+0000. See `docs/upgrades/0.5.0-to-0.6.0.md`.
- bc2da95: Dunning analytics never add past what their columns hold, and the JSON depth check measures what `JSON.stringify` writes.

  - Breaking: the campaign analytics upsert checks each sum in the statement itself. A counter that would pass 2^31 - 1 returns `payments.counter_exhausted` (`CounterExhausted`, whose `counter` may now be `paymentsRecovered`, `executions`, `customersReached` or `communicationsSent`), and recovered revenue that would pass 2^53 - 1 minor units returns `money.out_of_range`. Nothing is written then. `processScheduledExecutions` and `retryFailedExecutions` list either one as a `refused` entry; the execution stays complete and the stop check still runs.
  - Breaking: `DunningCampaignRepository.getAnalyticsSince` and `getAnalyticsSummary`, `DunningCampaignService.getCampaignAnalytics` and `getDashboardStats` return `money.out_of_range` when revenue of one currency sums past 2^53 - 1 minor units over many rows, where they threw an invariant failure. `findTopPerformer` no longer casts its sum to `int`, so a count past 2^31 - 1 reads.
  - Breaking: `pgJsonSchema`, `pgJsonRecordSchema` and `exceedsJsonDepth` follow `toJSON(key)` as `JSON.stringify` does. A `toJSON` that returns more than `MAX_JSON_DEPTH` (100) levels returns `schema.invalid_input`; a throwing `toJSON` keeps `schema.async_required`.

  no demo impact: the demos do not read dunning analytics or store values with a custom `toJSON`.

- 111f3f1: Stripe provider, refunds and presets refuse hostile input. `StripeProvider`, `RefundService` and `createSubscriptionBilling` return `payments.configuration_invalid` for a bad setting instead of throwing (breaking: use `StripeProvider.create` and `RefundService.create`; their constructors are private). Text Stripe cannot take (a lone surrogate) and a bad `prorationBehavior` come back as `schema.invalid_input` before any request, so `detachPaymentMethod`, `createCustomerPortalSession` and `createCheckoutSession` now return a result. `RefundRepository.findByStatus` and `searchRefunds` answer empty for a status or reason outside the enum, and `getEntitlement` answers free for a user id holding U+0000. See `docs/upgrades/0.5.0-to-0.6.0.md`.

### Patch Changes

- 4f24c6d: Span status now follows one rule. A returned failure always sets `failure.code`. It sets the span status to error only when `isFault(failure)` is true (status 500 or higher). An expected outcome (a 4xx, such as a missing record, a held lock or a declined card) leaves the status unset, so alerts on span errors fire only for faults. Thrown errors still set the error status. `@arki/env` and `@arki/schedule` now set `failure.code`, which they did not before. `@arki/payments` used to leave the status unset for every returned failure; a 5xx now sets error. `@arki/async`: `Cancelled` (499) no longer marks the span as an error.
- 4f24c6d: Declares the engines it supports and documents them in the README.
- Updated dependencies [937e762]
- Updated dependencies [4f24c6d]
- Updated dependencies [4f24c6d]
  - @arki/money@0.2.1
  - @arki/contracts@0.4.2
  - @arki/date@0.5.2
  - @arki/db@0.6.0
  - @arki/env@0.2.1
  - @arki/failure@0.4.0
  - @arki/http@0.5.0
  - @arki/journal@0.5.0
  - @arki/kv@0.6.0
  - @arki/log@0.4.1
  - @arki/schema@0.3.1

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
