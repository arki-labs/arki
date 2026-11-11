# @arki/payments

Payments for ARKI apps: a Stripe provider, plans, customers, subscriptions, payments, refunds, dunning and tax. It ships Drizzle table factories, repositories, services and [`@arki/journal`](https://www.npmjs.com/package/@arki/journal) commands. Routers stay in each consuming app, so the app owns its RPC context and its authorization policy.

## Install

```sh
bun add @arki/payments
```

## Quick start

Build the provider once at app boot, with the keys from your env. Then branch on what a call returns. A refused card is a returned value, not a throw.

```ts skip="needs Stripe keys and a customer with a saved card"
import { orThrow } from '@arki/failure';
import { StripeProvider } from '@arki/payments';

// `create` returns `payments.configuration_invalid` for a bad setting (`maxNetworkRetries`); at boot, stop on it
const provider = orThrow(
  StripeProvider.create({
    apiKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    environment: 'sandbox',
  }),
);
```

The branch itself runs without Stripe. A provider call that charges a card returns this value when the bank says no:

```ts run expect
import { isFailure } from '@arki/failure';
import { CardDeclined } from '@arki/payments/core/providers/provider-error';

const result = CardDeclined({ providerCode: 'expired_card' });

if (isFailure(result) && CardDeclined.is(result)) {
  console.log(result.status, result.message);
}
```

```text
402 The card was declined (expired_card)
```

## When not to use this

- You need a payment provider other than Stripe or RevenueCat. `BasePaymentProvider` is the extension point, but only these two have presets.
- You want ready-made routers. Routers stay in each app.
- You need a client-side checkout widget. This package runs on the server.
- You cannot run Postgres. The tables, repositories and journal commands are Drizzle on Postgres.

## Runtime support

Server only: Node, Bun and Deno. The package needs Postgres through Drizzle, the Stripe SDK and `@arki/journal`. It is not meant for browsers or React Native.

<!-- runtimes:start -->

| Runtime | Result | Version tested | Date (UTC) |
| ------- | ------ | -------------- | ---------- |
| node    | pass   | v22.13.1       | 2026-11-05 |
| bun     | pass   | 1.4.2          | 2026-11-05 |
| deno    | pass   | 2.9.8          | 2026-11-05 |
| browser | n/a    | -              | 2026-11-05 |
| hermes  | n/a    | -              | 2026-11-05 |

<!-- runtimes:end -->

## Public imports

| Subpath                       | Contents                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `@arki/payments`              | Provider abstraction (`BasePaymentProvider`, `StripeProvider`), shared types |
| `@arki/payments/core`         | Plans, customers, subscriptions, payments, webhook events, `UserId`          |
| `@arki/payments/presets`      | Ready-made subscription and RevenueCat flows                                 |
| `@arki/payments/env`          | Typed environment schema for the Stripe keys and notification settings       |
| `@arki/payments/dunning`      | Dunning campaigns and retry services                                         |
| `@arki/payments/tax`          | Stripe Tax integration                                                       |
| `@arki/payments/refunds`      | Refund request and approval workflow                                         |
| `@arki/payments/repositories` | Aggregate repository factory                                                 |

Deeper paths such as `@arki/payments/core/tables` resolve to the compiled file of the same name.

## User ids

Every owner column is a `UserId`, the string type `` `usr_${string}` `` exported from `@arki/payments/core`, with `userIdSchema` to validate one and `userIdFactory` to build foreign-key columns. It has the same shape as the user id of `@arki/auth`, so an app built on that package passes its ids through unchanged. An app with its own user table needs ids of that shape.

## Failure behaviour

ID generators return their successful ID or the canonical `IdGenerationFailure` from `@arki/contracts` (`ID_GENERATION_FAILURES`). ID schemas and aliases describe successful strings only. Journal commands, provider creates, checkout setup and webhook claiming return these failures before their writes or provider effects. Check `isFailure` before reading the success. The Stripe and RevenueCat subscription presets return the exact journal write failure, including ID failures, instead of acknowledging the delivery. Webhook routes must reject a returned failure so the provider can retry. Drizzle scalar defaults still throw at the callback boundary; direct repository inserts that rely on those defaults need an owned transaction to recover the failure.

Answers a correct caller must handle are returned as [`@arki/failure`](https://www.npmjs.com/package/@arki/failure) values, never thrown. Check them with `isFailure`, `Definition.is` or `match`. Bugs, bad input and provider faults (`rate_limited`, `unavailable`, `authentication`, `not_configured`) are still thrown, as `PaymentProviderError` or `RefundError`.

Amounts that come from outside are read with `@arki/money`, which returns a `MoneyFailure` (`money.unknown_currency`, `money.provider_amount`, `money.out_of_range`, `money.invalid_shape`, ...) for a bad one. Payments passes it on and never turns it into a throw or a wrong amount:

- Stripe answers (`getPlan`, `updatePlan`, `listPlans`, `previewSubscriptionChange`, `getPayment`, `createPayment`, `confirmPayment`, `cancelPayment`, `calculateTax`, `createTaxTransaction`) and `TaxService.calculateTax`, `calculateSubscriptionTax`, `calculateOneTimeTax`, `createTaxTransaction` return it.
- `WebhookHandler.processWebhook` returns it for a `payment.refunded` charge with a bad amount. The event stays unprocessed with its error recorded, and no refund is written. Reject the delivery, as for any returned failure.
- Stored JSON is outside data too: `TaxReportingService.getCustomerTaxSummary` (a payment's recorded `taxAmount`), the segment calls (`getCustomersInSegment`, `getCustomersMatchingCriteria`, `updateSegmentCustomerCount`, `getCustomerSegments`, `updateCustomerRiskProfile`, `createSegment`, `updateSegment`) and `DunningIntegrationService.handlePaymentFailure` / `handleSubscriptionStatusChange` / `handleTrialEnding` (a campaign's or segment's stored spend range).
- Journal folds read events the journal wrote itself, and a fold cannot return a failure, so a refused amount there is a corrupt log and throws.

| Failure                  | Code                                | Status | Returned by                                                                                                                                                                                      |
| ------------------------ | ----------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CardDeclined`           | `payments.card_declined`            | 402    | Provider calls that charge or check a card. Data: `providerCode`, `declineCode`.                                                                                                                 |
| `IdempotencyConflict`    | `payments.idempotency_conflict`     | 409    | Provider calls that take an `idempotencyKey`.                                                                                                                                                    |
| `ReferenceNotFound`      | `payments.reference_not_found`      | 404    | Provider calls given an id with no row, or a row with no provider id. Core journal commands and repository writes given a user, customer, plan or subscription id with no row (`kind` names it). |
| `PlanAlreadyExists`      | `payments.plan_already_exists`      | 409    | `PaymentRepository.createPlan`: a plan has this id.                                                                                                                                              |
| `CustomerInUse`          | `payments.customer_in_use`          | 409    | `PaymentRepository.deleteCustomer`: a refund still points at one of its payments.                                                                                                                |
| `WebhookEventExists`     | `payments.webhook_event_exists`     | 409    | `createWebhookEvent`, `updateWebhookEvent`: another event holds the provider event id.                                                                                                           |
| `TransactionNotFound`    | `payments.transaction_not_found`    | 404    | `RefundService.requestRefund`: the payment does not exist.                                                                                                                                       |
| `RefundWindowExceeded`   | `payments.refund_window_exceeded`   | 422    | `requestRefund`: the payment is older than the refund window.                                                                                                                                    |
| `DuplicatePendingRefund` | `payments.duplicate_pending_refund` | 409    | `requestRefund`: the payment already has a pending refund.                                                                                                                                       |
| `RefundAmountExceeded`   | `payments.refund_amount_exceeded`   | 422    | `requestRefund`: more than the payment can still refund.                                                                                                                                         |
| `RefundNotFound`         | `payments.refund_not_found`         | 404    | `approveRefund`, `rejectRefund`.                                                                                                                                                                 |
| `RefundInvalidState`     | `payments.refund_invalid_state`     | 409    | `approveRefund`, `rejectRefund`: the refund is no longer pending.                                                                                                                                |

Import the provider failures from `@arki/payments/core/providers/provider-error` and the refund failures from `@arki/payments/refunds`. When the provider returns a failure while a refund is paid back, the refund still ends `failed`, as when the provider throws.

The journal commands (`createCoreJournal(...).commands`, `createRefundsJournal(...).commands`) and the `writes(run)` functions return the journal's own failures when a rule says no, and write nothing: `CommandNotFound` (`journal.not_found`, 404), `CommandConflict` (`journal.conflict`, 409) and `CommandInvalid` (`journal.invalid`, 400), from `@arki/journal`. Their `detail` is the message. Schema validation also returns the canonical `@arki/failure` values `InvalidInput`, `AsyncSchema` and `ValidatorDefect`, without writing. `SubscriptionManager`, `DunningService.handlePaymentFailure` and `handleSubscriptionRecovery`, and `RefundService` return them on. The webhook handler throws them with `orThrow`, so a refused write fails the event and the provider's resend tries it again.

Managed journal transactions also return the canonical transaction failures from `@arki/db/errors`. `RefundService.requestRefund` maps only `TransactionRejected` with SQLSTATE `23505` and the pending-refund index in its private cause to `DuplicatePendingRefund`; it preserves the transaction failure as the cause. Other transaction failures pass through unchanged. `TransactionCommitUncertain` means the write may be durable: reconcile the stored refund before retrying or contacting the provider.

The core never answers a value the caller sent with a raw Postgres error. The journal command schemas, the contracts in `core/contracts`, the insert schemas of `createCoreDerivedSchemas` and the `PaymentRepository` writes refuse what a column refuses as `schema.invalid_input`: U+0000 in text or JSON, text past its `varchar` length, a fraction or a value past 2^31 - 1 in an integer, an amount past 2^53 - 1 minor units, a currency outside ISO 4217, and a time outside the years 1 to 9999. A webhook body that holds U+0000, or an event id past 255 characters, is `payments.webhook_payload_invalid`. The repository reads that take a time or a count state that range as a precondition and throw (`invariant`) outside it; a lookup by a provider id no column can hold finds nothing.

Handle each failure by what it says about your data:

- `CardDeclined`: ask for another card. `IdempotencyConflict`: use a new key.
- `ReferenceNotFound`, `TransactionNotFound`, `RefundNotFound`: the id is wrong. Check it. Nothing was written.
- `RefundWindowExceeded`, `RefundAmountExceeded`, `DuplicatePendingRefund`, `RefundInvalidState`: the refund rules said no. Nothing was written. Show the user why.
- A thrown `PaymentProviderError` has a `retryable` flag. Retry only when it is `true`.

## Consuming app integration

Every consuming app must:

1. Call the table factories with its own `pgSchema` and a reference to its user id column (see `createCoreTables` in `@arki/payments/core/tables`).
2. Register the resulting Drizzle relations in its `relations.ts`.
3. Build its own RPC router from the package's services and the app's protected and public procedures.
4. Inject env-driven config (`STRIPE_SECRET_KEY`, notification settings) at app boot, not per request.

## Observability

Spans (OpenTelemetry API only; nothing is exported until the app configures an SDK):

| Span                                                                  | When                                                           | Attributes                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| `payments.stripe.<resource>.<method>`                                 | each Stripe request (`payments.stripe.payment_intents.create`) | `payments.provider`, `failure.code` on a returned failure   |
| `payments.webhook.process`                                            | each provider webhook the handler processes                    | `payments.provider`, `failure.code`                         |
| `payments.webhook.event`                                              | each webhook event it applies                                  | `payments.provider`, `payments.event_type`, `failure.code`  |
| `payments.notification`                                               | each email or Slack notification                               | `payments.channel`, `payments.notification`, `failure.code` |
| `payments.notification.send`, `payments.notification.delivery_status` | each dunning message and delivery check                        | `channel`, `provider`, `failure.code`                       |
| `payments.alert`                                                      | each payment-monitor alert                                     | `payments.alert`, `payments.severity`, `failure.code`       |

A returned failure sets `failure.code`. It sets the span status to error only when it is a fault (`isFault`: status 500 or higher, such as a provider outage); a 4xx such as a declined card leaves the status unset. A throw sets the status to error and records the exception. Amounts, card data, customer ids, payloads and secrets are never attributes.

Metrics: `payments.operations` (counter; `operation`, `outcome` = `success`, `failure` or `error`).

Not instrumented: repositories and journal commands (the app's database driver and `@arki/journal` span them); `DunningService.processDunningEvents` (a batch the app runs under `schedule.run` or `queue.execute`); money, tax and proration math (pure computation).

## Limits

- A refund is refused after the refund window. The default is 90 days (`refundWindowMs`). A payment 91 days old returns `RefundWindowExceeded`; one 89 days old does not.
- A refund and what the payment already gives back cannot add up to more than was paid. The extra returns `RefundAmountExceeded`.
- A payment has at most one pending refund. A second request returns `DuplicatePendingRefund`.
- A refund under the auto-approve limit is approved without a person. The default is 10.00 in USD and EUR, 1500 in JPY (`autoApproveLimits`).
- A refund in another currency than the payment returns `RefundCurrencyMismatch` (`payments.refund_currency_mismatch`, 422). Nothing is written.
- Amounts are decimal text in the payment's currency, such as `'12.50'`.
- A repeated `idempotencyKey` with different parameters returns `IdempotencyConflict`.
- Provider faults are thrown, not returned: `rate_limited` and `unavailable` can pass on retry; `authentication`, `invalid_request` and `not_configured` cannot.
- Tables, repositories and journal commands need Postgres through Drizzle. There is no other store.
- The dunning contracts refuse what Postgres refuses, as `schema.invalid_input`: text holding U+0000 (also inside stored JSON), text longer than its `varchar` column, `stepNumber`, `updateFrequency` or `paymentFailureCount` above 2^31 - 1, a subscription status or plan tier the enum has not, and a time outside the years 1 to 9999. A day, month or hour span (`cooldownPeriod`, `delayHours` and their sum over a campaign's steps, the trigger and segment day and month counts) is at most 100 years (`MAX_DUNNING_DAYS`, `MAX_DUNNING_HOURS`).
- The dunning repositories check what they write the same way and return `schema.invalid_input` instead of a raw database error: campaigns and segments against their contracts, the actor id (`createdBy`, `updatedBy`, a `usr_` id), execution and communication text, JSON and times, the JSON of a step, a campaign and a risk profile (`create`, `update`, `upsert`: U+0000, a lone surrogate or a bigint anywhere in it), and a segment's customer count. An id holding U+0000 is unknown: a read answers not found and a write names the missing row, without a query. A spend range finer than its currency's minor unit, or past 2^53 - 1 minor units, returns `money.rounding_necessary` or `money.out_of_range`. A second `CustomerRiskProfileRepository.create` for a customer returns `CustomerRiskProfileExists` (`payments.customer_risk_profile_exists`, 409).
- A scheduled dunning message that does not go out fails its execution and is listed in the tick report: a provider that cannot be reached or a 5xx refusal is retried (30, 60, then 120 minutes); a timeout (the message may have gone out), a 4xx refusal, an invalid recipient or a channel with no provider is not. Only a sent message counts in `communicationsSent`.
- Which dunning job sends what: `processScheduledExecutions` sends each due step; `retryFailedExecutions` sends again the steps that failed with a `nextRetryAt` (executions own the resend); `processPendingCommunications` sends communication rows still `pending`; `retryFailedCommunications` sends again only the latest failed communication of an execution no retry will run (refused with a 4xx, timed out, retries used up), so one message is never resent by two jobs.
- The dunning event handlers never acknowledge a campaign run that threw: the error is thrown, so the webhook caller retries the event. A customer, payment or subscription the event names with no row returns `ReferenceNotFound`.
- `handleCommunicationWebhook` parses its payload with `communicationWebhookSchema` and returns `DunningCommunicationNotFound` (`payments.dunning_communication_not_found`, 404) for a provider message id no communication has.
- A dunning write that names a row that does not exist returns that row's not-found failure, never a foreign-key error: `DunningCampaignNotFound`, `DunningTemplateNotFound`, `DunningExecutionNotFound`, or `ReferenceNotFound` for a customer, subscription or payment. A campaign or step that sent a communication cannot be deleted: `DunningTemplateInUse`.
- A customer has one risk profile (a unique index on `customer_id`). `upsert` replaces it in one statement.
- A refund notification that did not go out (mail transport failure, Slack non-2xx, network error or timeout) returns `NotificationFailed` (`payments.notification_failed`, 502); a refund that is not a stored row is a caller bug and rejects with the `@arki/money` error. A dunning communication provider that cannot be reached at all throws `PaymentProviderError` with code `unavailable`; a provider setting `fetch` would refuse (an API key no header can carry, an API URL with credentials) throws `payments.configuration_invalid` when the provider is built.
- The tax contracts and every tax repository write refuse what Postgres refuses, as `schema.invalid_input`: text holding U+0000 (also inside stored JSON), text longer than its `varchar` column, a bigint in JSON, a time outside the years 1 to 9999, a tax record with a negative amount or a rate of 10000 or more. A tax read given U+0000 finds nothing. A new row with an `id` another row has returns `TaxRowExists` (`payments.tax_row_exists`, 409).
- `TaxService.createTaxTransaction` checks the records it will write before Stripe is asked, so Stripe never records a transaction the records cannot hold. A line item in another currency than the sale returns `TaxLineCurrencyMismatch` (`payments.tax_line_currency_mismatch`, 422), from `calculateTax` too.
- A tax jurisdiction that a child jurisdiction or an exemption names cannot be deleted: `deleteJurisdiction` returns `TaxJurisdictionInUse` (`payments.tax_jurisdiction_in_use`, 409).
- The compliance report and the export return `StoredTaxInvalid` for a tax record in another currency than its payment, never a wrong total.
- The refund commands refuse text holding U+0000 (`customerNote`, `internalNotes`, `metadata`, `notes`, `rejectionReason`, `providerResponse`, `errorMessage`) as `schema.invalid_input`, and return `CommandNotFound` for a `requestedBy`, `approvedBy` or `rejectedBy` with no user.
- A refund mail that does not go out is never dropped: the approval and rejection effects return the failure. `payments.notification_failed` is retried with backoff (8 tries, 1 s up to 5 minutes); any other failure makes the job dead at once, with it as `lastError`. The `payments.refund` workflow output carries `notificationFailure`.
- The compliance report's `averageTaxRate` is the mean of tax / (amount - tax) over the taxed payments; a payment whose tax equals its amount has no taxable base and is left out.

## Documentation

- [Agent guide](docs/agent-guide.md): tasks and rules for agents.
- [API reference](docs/api-reference.md): every export grouped by purpose, with when to import it.
- [llms.txt](llms.txt): the import map.

## Support

Report bugs at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).

## License

MIT. See [LICENSE](./LICENSE).
