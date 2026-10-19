# @arki/payments for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. A **provider** (`BasePaymentProvider`, with `StripeProvider`) talks to the payment service. It takes keys and an `environment`.
2. **Tables and repositories** come from factories. The app passes its `pgSchema` and its user id column.
3. **Services** hold the rules: `RefundService`, `SubscriptionManager`, `DunningService`. They return failures for expected refusals.
4. **Journal commands** write through `@arki/journal` and return its failures when a rule says no. Schema failures (`InvalidInput`, `AsyncSchema`, `ValidatorDefect` from `@arki/failure`) also return without writing.
5. **Routers** are not here. The app builds them from the services.
6. An expected answer is a returned `payments.*` failure. A bug, bad input or provider fault throws.

## Task map

### Charge or check a card

1. Build `StripeProvider` once at boot.
2. Call the provider method. Pass an `idempotencyKey`.
3. Check the result with `isFailure`.

```ts
import { isFailure } from '@arki/failure';
import { CardDeclined } from '@arki/payments/core/providers/provider-error';

const result = CardDeclined({ providerCode: 'card_declined' });
export const ask = isFailure(result) && CardDeclined.is(result) ? 'ask for another card' : 'continue';
```

### Request and decide a refund

1. Build `RefundService` with a `systemUserId`.
2. Call `requestRefund`. Branch on the returned failure.
3. Call `approveRefund` or `rejectRefund` for a pending refund.

A refund under the auto-approve limit is approved at once.

### Wire the package into an app

1. Call `createCoreTables` and the other table factories with the app's `pgSchema`.
2. Register the Drizzle relations in the app's `relations.ts`.
3. Build the RPC router from the services.
4. Inject the Stripe keys at boot.

## Rules that bite

- A refund after the window (90 days by default) returns `RefundWindowExceeded`.
- A refund in another currency throws. It is bad input.
- `rate_limited` and `unavailable` provider faults can pass on retry. `authentication` cannot.
- The webhook handler throws a refused write on purpose. The provider's resend retries it.
- A journal command's `detail` is the message. Show it to the user.

## Errors

| Code                                | Status | Meaning                                | What to do                            |
| ----------------------------------- | ------ | -------------------------------------- | ------------------------------------- |
| `payments.card_declined`            | 402    | The card was refused                   | Ask for another card                  |
| `payments.idempotency_conflict`     | 409    | The key was used with other parameters | Use a new key                         |
| `payments.reference_not_found`      | 404    | An id has no row or no provider id     | Check the id                          |
| `payments.transaction_not_found`    | 404    | The payment does not exist             | Check the id                          |
| `payments.refund_window_exceeded`   | 422    | The payment is past the refund window  | Refund outside this workflow          |
| `payments.duplicate_pending_refund` | 409    | A refund already waits                 | Decide the pending one first          |
| `payments.refund_amount_exceeded`   | 422    | More than can be refunded              | Ask for at most the refundable amount |
| `payments.refund_not_found`         | 404    | No refund has this id                  | Check the id                          |
| `payments.refund_invalid_state`     | 409    | The refund is no longer pending        | Read the refund again                 |

A thrown `PaymentProviderError` carries `code`, `providerCode` and `retryable`.

## Verify

```sh
bun run test
bun run test:docs
```
