# @arki/payments

Payments for ARKI apps: a Stripe provider, plans, customers, subscriptions, payments, refunds, dunning and tax. It ships Drizzle table factories, repositories, services and [`@arki/journal`](https://www.npmjs.com/package/@arki/journal) commands. Routers stay in each consuming app, so the app owns its RPC context and its authorization policy.

## Installation

```sh
npm install @arki/payments
# or
bun add @arki/payments
```

## Subpath exports

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

Every owner column is a `UserId`, the string type `` `usr_${string}` `` exported from `@arki/payments/core`, with `userIdSchema` to validate one and `userIdFactory` to build foreign-key columns. It has the same shape as the user id of `@arki/auth`, so an app built on that package passes its ids through unchanged. An app with its own user table only needs ids of that shape.

## Expected failures

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

## Consuming app integration

Every consuming app must:

1. Call the table factories with its own `pgSchema` and a reference to its user id column (see `createCoreTables` in `@arki/payments/core/tables`).
2. Register the resulting Drizzle relations in its `relations.ts`.
3. Build its own RPC router from the package's services and the app's protected and public procedures.
4. Inject env-driven config (`STRIPE_SECRET_KEY`, notification settings) at app boot, not per request.

## License

MIT — see [LICENSE](./LICENSE).
