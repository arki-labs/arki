# @arki/payments

Payments for ARKI apps: a Stripe provider, plans, customers, subscriptions, payments, refunds, dunning and tax. It ships Drizzle table factories, repositories, services and [`@arki/journal`](https://www.npmjs.com/package/@arki/journal) commands. Routers stay in each consuming app, so the app owns its RPC context and its authorization policy.

## Install

```sh
bun add @arki/payments
```

## Quick start

Build the provider once at app boot, with the keys from your env. Then branch on what a call returns. A refused card is a returned value, not a throw.

```ts skip="needs Stripe keys and a customer with a saved card"
import { StripeProvider } from '@arki/payments';

const provider = new StripeProvider({
  apiKey: process.env.STRIPE_SECRET_KEY ?? '',
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  environment: 'sandbox',
});
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

Server only: Node and Bun. The package needs Postgres through Drizzle, the Stripe SDK and `@arki/journal`. It is not meant for browsers, Deno or React Native.

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

| Failure                  | Code                                | Status | Returned by                                                                      |
| ------------------------ | ----------------------------------- | ------ | -------------------------------------------------------------------------------- |
| `CardDeclined`           | `payments.card_declined`            | 402    | Provider calls that charge or check a card. Data: `providerCode`, `declineCode`. |
| `IdempotencyConflict`    | `payments.idempotency_conflict`     | 409    | Provider calls that take an `idempotencyKey`.                                    |
| `ReferenceNotFound`      | `payments.reference_not_found`      | 404    | Provider calls given an id with no row, or a row with no provider id.            |
| `TransactionNotFound`    | `payments.transaction_not_found`    | 404    | `RefundService.requestRefund`: the payment does not exist.                       |
| `RefundWindowExceeded`   | `payments.refund_window_exceeded`   | 422    | `requestRefund`: the payment is older than the refund window.                    |
| `DuplicatePendingRefund` | `payments.duplicate_pending_refund` | 409    | `requestRefund`: the payment already has a pending refund.                       |
| `RefundAmountExceeded`   | `payments.refund_amount_exceeded`   | 422    | `requestRefund`: more than the payment can still refund.                         |
| `RefundNotFound`         | `payments.refund_not_found`         | 404    | `approveRefund`, `rejectRefund`.                                                 |
| `RefundInvalidState`     | `payments.refund_invalid_state`     | 409    | `approveRefund`, `rejectRefund`: the refund is no longer pending.                |

Import the provider failures from `@arki/payments/core/providers/provider-error` and the refund failures from `@arki/payments/refunds`. When the provider returns a failure while a refund is paid back, the refund still ends `failed`, as when the provider throws.

The journal commands (`createCoreJournal(...).commands`, `createRefundsJournal(...).commands`) and the `writes(run)` functions return the journal's own failures when a rule says no, and write nothing: `CommandNotFound` (`journal.not_found`, 404), `CommandConflict` (`journal.conflict`, 409) and `CommandInvalid` (`journal.invalid`, 400), from `@arki/journal`. Their `detail` is the message. Schema validation also returns the canonical `@arki/failure` values `InvalidInput`, `AsyncSchema` and `ValidatorDefect`, without writing. `SubscriptionManager`, `DunningService.handlePaymentFailure` and `handleSubscriptionRecovery`, and `RefundService` return them on. The webhook handler throws them with `orThrow`, so a refused write fails the event and the provider's resend tries it again.

Managed journal transactions also return the canonical transaction failures from `@arki/db/errors`. `RefundService.requestRefund` maps only `TransactionRejected` with SQLSTATE `23505` and the pending-refund index in its private cause to `DuplicatePendingRefund`; it preserves the transaction failure as the cause. Other transaction failures pass through unchanged. `TransactionCommitUncertain` means the write may be durable: reconcile the stored refund before retrying or contacting the provider.

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

## Limits

- A refund is refused after the refund window. The default is 90 days (`refundWindowMs`). A payment 91 days old returns `RefundWindowExceeded`; one 89 days old does not.
- A refund and what the payment already gives back cannot add up to more than was paid. The extra returns `RefundAmountExceeded`.
- A payment has at most one pending refund. A second request returns `DuplicatePendingRefund`.
- A refund under the auto-approve limit is approved without a person. The default is 10.00 in USD and EUR, 1500 in JPY (`autoApproveLimits`).
- A refund in another currency than the payment is bad input. It throws, it does not return a failure.
- Amounts are decimal text in the payment's currency, such as `'12.50'`.
- A repeated `idempotencyKey` with different parameters returns `IdempotencyConflict`.
- Provider faults are thrown, not returned: `rate_limited` and `unavailable` can pass on retry; `authentication`, `invalid_request` and `not_configured` cannot.
- Tables, repositories and journal commands need Postgres through Drizzle. There is no other store.

## Documentation

- [Agent guide](docs/agent-guide.md): tasks and rules for agents.
- [API reference](docs/api-reference.md): every export grouped by purpose, with when to import it.
- [llms.txt](llms.txt): the import map.

## Support

Report bugs at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).

## License

MIT. See [LICENSE](./LICENSE).
