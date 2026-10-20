AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/payments

## Laws

1. An answer a correct caller must handle is a returned `@arki/failure` value with a `payments.*` code. Never throw it. Bugs, bad input and provider faults throw.
2. Define each failure once, with JSDoc `@fix` and `@verify`. Provider failures live in `src/core/providers/provider-error.ts`. Refund failures live in `src/refunds/failures.ts`.
3. Routers stay in the consuming app. This package ships tables, repositories, services and journal commands only.
4. Tables come from factories that take the app's `pgSchema` and its user id column. Do not create a table at import.
5. Every owner column is a `UserId` (`usr_...`), shaped like the `@arki/auth` user id.
6. Amounts are decimal text in the payment's currency. Never compare money as a float. Use `@arki/money` rules.
7. A refused write writes nothing. A refund check runs before any provider request.
8. Stripe calls that charge take an `idempotencyKey`. A repeated key with different parameters returns `IdempotencyConflict`.
9. Owned webhook services return canonical refused writes. The native HTTP adapter rejects that outcome before acknowledgement, so the provider's resend tries the event again.
10. Env-driven config (`STRIPE_SECRET_KEY`, notification settings) is injected at app boot, never read per request.
11. Never log card data, keys or webhook secrets.

## Changing this package

- Provider calls: `src/core/providers`. Keep `BasePaymentProvider` the contract and `StripeProvider` one implementation.
- Refund rules: `src/refunds/service.ts`. A new refusal is a new failure in `src/refunds/failures.ts` plus a row in the README Failure behaviour table and a line in Limits.
- A new subpath needs a `package.json` export. The `llms.txt` Import paths list is grouped by hand because there are more than 70 entries. Keep it equal to the exports.
- Keep `README.md`, `llms.txt` and `docs/agent-guide.md` in step.

## Verify

```sh
bun run test
bun run typecheck
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
