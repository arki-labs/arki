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

## Consuming app integration

Every consuming app must:

1. Call the table factories with its own `pgSchema` and a reference to its user id column (see `createCoreTables` in `@arki/payments/core/tables`).
2. Register the resulting Drizzle relations in its `relations.ts`.
3. Build its own RPC router from the package's services and the app's protected and public procedures.
4. Inject env-driven config (`STRIPE_SECRET_KEY`, notification settings) at app boot, not per request.

## License

MIT — see [LICENSE](./LICENSE).
