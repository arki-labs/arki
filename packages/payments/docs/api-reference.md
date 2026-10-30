# @arki/payments API reference

The [README](../README.md) and the [agent guide](agent-guide.md) show how to wire the package. This page names every export and says when you need it. Exports are grouped by purpose. Import paths follow the folders: `core`, `dunning`, `refunds`, `tax`, `presets`, plus the root `repositories` helper.

Naming pattern you will see everywhere:

- `create<X>Id`, `<x>IdSchema`, `<x>IdFactory`: make a prefixed id, validate one, or hold the id definition. They come from one `defineId` call per id.
- `<x>Values`: the allowed values of an enum as one `as const` array. `<x>Schema` is the Zod schema over the same array. Table enums and the schema share the array, so they cannot drift.
- `<x>InputSchema`: the schema of one procedure's input. Your router imports it so the contract lives in this package.
- `create<X>Service`, `create<X>Repository`: factories. Pass the database, tables and provider. Nothing reads `env` for you.

## Setup: tables, derived schemas, repositories

- `createRefundsTables`, `createDunningTables`, `createTaxTables`: build the Drizzle tables of one area inside your own `pgSchema`. `createRefundsTables` and `createDunningTables` take references to your payments and user id columns. Call them in your schema module so drizzle-kit can generate the migrations.
- `createCoreDerivedSchemas`: builds the Zod select and insert schemas that depend on your concrete core tables. Call it once with your core tables.
- `createPaymentRepositories`: builds the core, dunning, refunds and tax repositories in one call from one database and one tables object. Use it when you want every repository. Use the single factories below when you want one.
- `createPaymentRepository` and `PaymentRepository`: reads and writes for plans, customers, subscriptions, payments and webhook events. Most services take it.
- `createRefundRepository` and `RefundRepository`: reads, lists and searches for refund rows.
- `createDunningRepository`: builds all dunning repositories in one object.
- `createDunningCampaignRepository`, `createDunningTemplateRepository`, `createDunningExecutionRepository`, `createDunningCommunicationRepository`, `createCustomerSegmentRepository`, `createCustomerRiskProfileRepository`: one factory for each dunning table group.
- `DunningCampaignRepository`, `DunningTemplateRepository`, `DunningExecutionRepository`, `DunningCommunicationRepository`, `CustomerSegmentRepository`, `CustomerRiskProfileRepository`: the classes those factories return. Import them as types or for tests.
- `createTaxRepositories`: builds all tax repositories in one object.
- `TaxConfigurationRepository` (global settings), `TaxJurisdictionRepository` (jurisdictions and rates), `TaxExemptionRepository` (exemptions for customers, products and places), `TaxRecordRepository` (the per-jurisdiction tax of each sale and refund), `TaxAuditRepository` (the append-only trail of tax actions): the classes inside it.

## Ids

- Core: `createPlanId`, `createSubscriptionId`, `createPaymentId`, `createCustomerId`, `createWebhookId`, with `planIdSchema`, `subscriptionIdSchema`, `paymentIdSchema`, `customerIdSchema`, `webhookIdSchema` and `planIdFactory`, `subscriptionIdFactory`, `paymentIdFactory`, `customerIdFactory`, `webhookIdFactory`.
- Refunds: `createRefundId`, `refundIdSchema`, `refundIdFactory`.
- Dunning: `createDunningCampaignId`, `createDunningTemplateId`, `createDunningExecutionId`, `createDunningCommunicationId`, `createCustomerSegmentId`, `createCustomerRiskProfileId`, their `...IdSchema` forms (`dunningCampaignIdSchema`, `dunningTemplateIdSchema`, `dunningExecutionIdSchema`, `dunningCommunicationIdSchema`, `customerSegmentIdSchema`, `customerRiskProfileIdSchema`) and their `...IdFactory` forms (`dunningCampaignIdFactory`, `dunningTemplateIdFactory`, `dunningExecutionIdFactory`, `dunningCommunicationIdFactory`, `customerSegmentIdFactory`, `customerRiskProfileIdFactory`).
- Tax: `createTaxConfigId`, `createTaxJurisdictionId`, `createTaxExemptionId`, `createTaxRecordId`, `createTaxAuditEntryId`, with `taxConfigIdSchema`, `taxJurisdictionIdSchema`, `taxExemptionIdSchema` and `taxConfigIdFactory`, `taxJurisdictionIdFactory`, `taxExemptionIdFactory`, `taxRecordIdFactory`, `taxAuditEntryIdFactory`.
- `createCustomerRiskProfileId` and the other `create...Id` functions give you a fresh id when you insert a row. The `...IdSchema` forms validate an id that arrives from a client.

## Enum values and schemas

- Core: `paymentProviderValues`, `subscriptionStatusValues`, `paymentStatusValues`, `billingIntervalValues`, `planTierValues`, `paymentMethodTypeValues`, `webhookEventTypeValues` and the matching `paymentProviderSchema`, `subscriptionStatusSchema`, `paymentStatusSchema`, `billingIntervalSchema`, `planTierSchema`, `paymentMethodTypeSchema`, `webhookEventTypeSchema`.
- Refunds: `refundReasonValues`, `refundStatusValues`, `refundReasonSchema`, `refundStatusSchema`. `REFUND_SETTLED_STATUSES` is the subset of Stripe refund statuses that are final. `pending` and `requires_action` are not in it.
- Dunning: `dunningCampaignTypeValues`, `dunningCampaignStatusValues`, `communicationChannelValues`, `communicationStatusValues`, `executionStatusValues`, `customerSegmentTypeValues`, `riskCategoryValues`, with `dunningCampaignTypeSchema`, `dunningCampaignStatusSchema`, `communicationChannelSchema`, `communicationStatusSchema`, `executionStatusSchema`, `customerSegmentTypeSchema`, `riskCategorySchema`.
- Tax: `taxConfigStatusValues`, `taxCalculationModeValues`, `taxBusinessTypeValues`, `jurisdictionTypeValues`, `exemptionTypeValues`, `exemptionStatusValues`, `taxRecordTypeValues`, with `taxConfigStatusSchema`, `taxCalculationModeSchema`, `taxBusinessTypeSchema`, `jurisdictionTypeSchema`, `exemptionTypeSchema`, `exemptionStatusSchema`.
- Dunning shapes: `campaignTriggerSchema` (when a campaign starts), `campaignSettingsSchema` (its retry and timing settings), `communicationTemplateSchema` (one message template), `segmentCriteriaSchema` (the rules of a customer segment), `riskScoreSchema` (a score with its category), `dunningCampaignTemplateInputSchema` and `dunningCampaignTemplatesSchema` (ready-made campaign templates you can offer).

## Money

Amounts are `Money`. Columns hold whole minor units.

- `moneyJsonSchema`: the JSON shape of a `Money`. Use it in contracts that carry amounts.
- `positiveMoneySchema`, `nonNegativeMoneySchema`, `priceSchema`: `Money` that must be above zero, zero or more, or a plan price.
- `toMinorColumn`: `Money` as the whole minor units a column stores. Exact for amounts the schemas accepted.
- `fromMinorColumn`: a column read back as `Money`. It also takes the text Postgres returns for `SUM(bigint)`.
- `fromStoredNumber`: reads an old major-unit float from a journal event written before the minor-unit columns, rounded half-even to the currency's decimals. You need it when you replay old events.
- `paymentAmount`, `planPrice`: a payment row's or plan row's amount as `Money`.
- `refundAmountOf`: a refund row's amount as `Money`. The currency defaults to USD, as the column does.
- `sumMinorByCurrency`: sums `(currency, minor units)` pairs into one balance per currency. Use it for analytics so currencies never mix.
- `DEFAULT_ANALYTICS_CURRENCY`: `'USD'`. Counters with no payment behind them (customers reached, messages sent) go to this currency row with zero money.
- `analyticsRowId`: the row id of one campaign, one day (`YYYY-MM-DD`) and one currency.

## Request and response schemas (core)

- Plans and customers: `createPlanInputSchema`, `updatePlanInputSchema`, `getPlanInputSchema`, `updatePlanWrapperInputSchema`, `deactivatePlanInputSchema`, `createCustomerInputSchema`, `updateCustomerInputSchema`.
- Subscriptions: `createSubscriptionInputSchema`, `updateSubscriptionInputSchema`, `cancelSubscriptionInputSchema`, `updateSubscriptionWrapperInputSchema`, `cancelSubscriptionWrapperInputSchema`, `prorationPreviewInputSchema`, `subscriptionPreviewTaxInputSchema`, `subscriptionPreviewSchema`, `subscriptionAccessSchema` (does this user have access, and why not).
- Payments: `createPaymentInputSchema`, `refundPaymentInputSchema`, `createPaymentIntentInputSchema`, `paymentPreviewInputSchema`, `paymentPreviewTaxInputSchema`, `paymentIntentResponseSchema`, `setupIntentResponseSchema`, `paymentMethodInfoSchema`.
- Refund procedures: `requestRefundInputSchema`, `listRefundsInputSchema`, `getRefundInputSchema`, `approveRefundInputSchema`, `rejectRefundInputSchema`.
- Webhooks and health: `webhookInputSchema`, `webhookProcessingResultSchema`, `healthCheckSchema`.
- Lists and analytics: `paginationSchema`, `subscriptionQuerySchema`, `paymentQuerySchema`, `planQuerySchema`, `customerQuerySchema`, `webhookEventQuerySchema`, `analyticsQuerySchema`, `getAnalyticsMetricsInputSchema`, `subscriptionAnalyticsSchema`, `subscriptionAnalyticsResponseSchema`, `paymentAnalyticsSchema`.

## Journal command inputs

These are the inputs of the journal commands behind the services. A command returns a failure when a rule says no.

- Payments: `initiatePaymentInputSchema`, `completePaymentInputSchema`, `failPaymentInputSchema`, `cancelPaymentInputSchema`, `markPaymentRequiresActionInputSchema`, `recordPaymentRefundInputSchema`, `recordPaymentDisputeInputSchema`.
- Subscriptions: `syncSubscriptionInputSchema` (one whole provider snapshot, so a webhook is one event), `activateSubscriptionInputSchema`, `pauseSubscriptionInputSchema`, `resumeSubscriptionInputSchema`, `reactivateSubscriptionInputSchema`, `changeSubscriptionPlanInputSchema`, `setSubscriptionCancelAtPeriodEndInputSchema`, `markSubscriptionPastDueInputSchema`.
- Refunds: `processRefundInputSchema`, `completeRefundInputSchema`, `failRefundInputSchema`.
- Reducer helpers from `core/journal/support`: `toIso` (a time as ISO text for event data), `toInstant` and `toNullableInstant` (the `Instant` a reducer builds from it), `sameJson` (deep JSON equality, key order ignored, so you can skip a write that changes nothing), `storedReal` (the number a `real` column gives back; a reducer must return this value or the journal rejects the write with `VALUE_MISMATCH`), `writtenRow` (the row a command returned, or the failure it returned, with the storage-only `version` removed).

## Refunds

- `createRefundService`: the refund service. It requests, approves and rejects refunds, and reads metrics and searches. A refund after 90 days or over the refundable amount returns a failure and writes nothing.
- `refundAutoApproveLimitsSchema`: parses the per-currency amounts (currency code to amount text) under which a refund is approved without a person. A currency missing from it waits for a person. A bad code or amount throws when the service is built.
- `DEFAULT_REFUND_AUTO_APPROVE_LIMITS`: about ten dollars where set. Other currencies wait for a person.
- `createRefundWorkflow`: the durable workflow that sends an approved refund to Stripe and records the outcome. It retries while the refund is pending, from one minute doubling to six hours, about eight days in all.
- `refundRunId`: the id of a refund's workflow run. The approval starts the run and the Stripe webhook signals it.
- `createRefundEffects`: the after-commit effects of refunds. Today it sends the approval-request notification through a `NotificationService` that you supply.
- `pendingRefundIndexName`: the name of the unique index that allows one pending refund per payment. Use it to recognise `DuplicatePendingRefund` in your own error handling.

## Subscriptions, retries and proration (core services)

- `createSubscriptionManager`: create, update, pause, resume, reactivate and cancel subscriptions against the provider, preview a change, sync with the provider, handle trials ending and past-due subscriptions, and check access.
- `createPaymentRetryService`: schedules and runs retries of failed payments by named strategies, and reports retry analytics. You can add or change strategies.
- `createDunningService` (core): rule-based handling of failed payments. A rule has a trigger (`payment_failed`, `invoice_payment_failed` or `subscription_past_due`), a delay in days and an action (email, retry, pause, cancel or webhook). Do not mix it up with the campaign-based dunning in `@arki/payments/dunning`.
- `ProrationService` and `createProrationService`: previews the charge or credit of a plan change.
- `PaymentMonitoringService` and `createPaymentMonitoringService`: you record payment attempts, webhook runs, subscription events and refunds. It detects anomalies, reports system health and sends alerts.

## Webhooks and provider helpers

- `WebhookHandler` and `createWebhookHandler`: receives a provider webhook, checks it, claims it once, and processes it. It emits events and holds a processing lease for crashed attempts.
- `WebhookSecurityService` and `createWebhookSecurityService`: verifies signature, timestamp window, replay and source address. The older `core/security/webhook-security` path re-exports the same implementation.
- `claimWebhookEvent`: inserts the event, or returns the existing row. Only the caller whose insert won gets `created: true`, so exactly one delivery processes a new event.
- `reclaimWebhookEvent`: takes over an unprocessed event for one more attempt after a failure or a crash. Only one caller wins, because `attempts` is the token.
- `WebhookAnalyticsService` and `createWebhookAnalyticsService`: counts, success rates and alerts over webhook events.
- `mapStripeEventType`: our internal event name for a Stripe event type, or `null` when we do not model it.
- `parseStripeSubscription`, `parseStripePaymentIntent`, `parseStripeCharge`, `parseStripeRefund`, `parseStripeDispute`: read a Stripe webhook object into the fields we use, checked by a schema.
- `mapStripeError`: a Stripe SDK error as a `PaymentProviderError`, to throw. Other errors pass through.
- `cardDeclinedOf`: a Stripe card error as the returned failure `CardDeclined`, or `undefined` for any other error.
- `idempotencyConflictOf`: a Stripe idempotency error as the returned failure `IdempotencyConflict`, or `undefined`.

## Presets (Stripe and RevenueCat)

- `createSubscriptionBilling`: the whole web Stripe flow behind three methods: checkout, webhook projection and entitlement. Start here for a normal subscription app.
- `projectStripeSubscription`: writes a Stripe subscription object to the `subscriptions` table through the journal. Repeated or out-of-order webhooks converge to one row. A refused write is returned, and the webhook route must reject it.
- `projectRevenueCatEvent`: the same for a validated RevenueCat event. Returns `{ handled: false }` for events that are not a subscription change.
- `revenueCatWebhookSchema`: the schema of the RevenueCat webhook body.
- `verifyRevenueCatAuth`: checks the webhook's authorization header. Returns false on any mismatch or when no secret is set.
- `getEntitlement`: reads a user's current entitlement from our `subscriptions` table. It answers "is Pro?" whether the purchase came from the web or the native app.

## Dunning campaigns (`@arki/payments/dunning`)

- `DunningCampaignService` and `createDunningCampaignService`: campaign CRUD, templates and execution.
- `CustomerSegmentationService` and `createCustomerSegmentationService`: segments, customer classification and risk scoring.
- `DunningIntegrationService` and `createDunningIntegrationService`: connects campaigns, segments and communications into one flow.
- `CommunicationOrchestrationService` and `createCommunicationOrchestrationService`: sends messages through the channels you configure. Apps pass the channel config in, so the package never reads `env`.
- Channel providers: `EmailProvider` (Resend), `SMSProvider` (Twilio), `InAppProvider` (database storage), `WebhookProvider` (external endpoints).
- `readCustomerRiskProfile`: gives a `customer_risk_profiles` row the types its columns claim. Postgres returns the jsonb dates as ISO text, so every read passes through here.
- `valueList`: builds `(a, b, c)` with one bound parameter per value, for `column IN ${valueList(...)}`. An empty list matches nothing.
- Campaign and segment procedure inputs: `createDunningCampaignInputSchema`, `updateDunningCampaignInputSchema`, `getCampaignInputSchema`, `updateCampaignWrapperInputSchema`, `deleteCampaignInputSchema`, `updateCampaignStatusInputSchema`, `executeCampaignInputSchema`, `bulkExecuteCampaignInputSchema`, `campaignAnalyticsInputSchema`, `getCampaignAnalyticsInputSchema`, `createDunningTemplateInputSchema`, `updateDunningTemplateInputSchema`, `createCustomerSegmentInputSchema`, `updateCustomerSegmentInputSchema`, `getSegmentInputSchema`, `updateSegmentWrapperInputSchema`, `deleteSegmentInputSchema`, `getSegmentCustomersInputSchema`, `updateSegmentCustomerCountInputSchema`.
- Risk profile inputs: `customerRiskProfileInputSchema`, `getRiskProfileByCustomerInputSchema`, `updateRiskProfileForCustomerInputSchema`, `getRiskProfilesByCategoryInputSchema`.
- Execution and communication inputs: `updateExecutionStatusInputSchema`, `bulkUpdateExecutionsInputSchema`, `processScheduledExecutionsInputSchema`, `retryFailedExecutionsInputSchema`, `getExecutionMetricsInputSchema`, `updateCommunicationStatusInputSchema`, `getCommunicationInputSchema`, `processPendingCommunicationsInputSchema`, `retryFailedCommunicationsInputSchema`, `communicationWebhookSchema` (a delivery callback from a channel), `getDashboardMetricsInputSchema`.
- List queries and responses: `listDunningCampaignsQuerySchema`, `listCustomerSegmentsQuerySchema`, `listExecutionsQuerySchema`, `listCommunicationsQuerySchema`, `dunningCampaignResponseSchema`, `customerSegmentResponseSchema`.

## Notifications

- `createNotificationService`: builds an email, Slack or multi-channel notification service from a config.
- `EmailNotificationService`, `SlackNotificationService`, `MultiChannelNotificationService`: the three implementations. The multi-channel one sends through several channels at once.

## Tax (`@arki/payments/tax`)

- `createTaxService` and `TaxService`: calculates tax for a sale, keeps customers' exemptions and records the result with an audit trail.
- `createTaxReportingService` and `TaxReportingService`: compliance reports, customer summaries and data export.
- `jurisdictionOwnsLine`: true when a Stripe tax line is the tax of one of our jurisdictions (same country, level and state). A jurisdiction that cannot be placed matches nothing, so tax is charged rather than wrongly waived.
- `checkTaxIdFormat`: checks a tax id against the format of its type and country. Returns `valid`, `invalid` or `unknown`.
- Calculation and result schemas: `taxCalculationInputSchema`, `calculateSubscriptionTaxInputSchema`, `taxRateSchema`, `taxCalculationResultSchema`, `taxIdValidationSchema`.
- JSON converters: `taxCalculationResultJson`, `customerTaxSummaryJson`, `taxComplianceReportJson` turn a result holding `Money` into the JSON that the matching schema (`taxCalculationResultSchema`, `customerTaxSummarySchema`, `taxComplianceReportSchema`) describes.
- Configuration inputs: `createTaxConfigSchema`, `updateTaxConfigSchema`, `updateConfigurationInputSchema`, `setDefaultConfigurationInputSchema`.
- Jurisdiction inputs: `createJurisdictionSchema`, `getJurisdictionsByCountryInputSchema`, `getJurisdictionHierarchyInputSchema`.
- Exemption inputs: `createExemptionSchema`, `getCustomerExemptionsInputSchema`, `getExpiringExemptionsInputSchema`, `approveExemptionInputSchema`, `revokeExemptionInputSchema`.
- Reporting inputs: `getCustomerTaxSummaryInputSchema`, `getCustomerAnnualSummaryInputSchema`, `generateComplianceReportInputSchema`, `exportTaxDataInputSchema`.
