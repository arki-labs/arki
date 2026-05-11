# @arki/payments

Payment processing library for `@arki/*` apps.

> **Status:** in extraction from `apps/kapodopera/backend/src/features/_shared/payments/`. Phase 0 scaffold only — content moves arrive in subsequent phases.

## Scope

Provider abstraction, domain types and primitives, table factories, repositories, services, event-sourcing domain pieces, and a notifications adapter. Routers stay in each consuming app so apps own their oRPC context and authz policy.

## Subpath exports

| Subpath                   | Contents                                                                     |
| ------------------------- | ---------------------------------------------------------------------------- |
| `@arki/payments`          | Provider abstraction (`BasePaymentProvider`, `StripeProvider`), shared types |
| `@arki/payments/core`     | Plans, customers, subscriptions, payments, webhook events                    |
| `@arki/payments/dunning`  | Dunning campaigns and retry services                                         |
| `@arki/payments/tax`      | Stripe Tax integration                                                       |
| `@arki/payments/refunds`  | Refund request and approval workflow                                         |
| `@arki/payments/repositories` | Aggregate repository factory                                             |

## Consuming app integration

Every consuming app must:

1. Call the table factories with its own `pgSchema` and `userForeignKeys` (see [core/tables.ts](src/core/tables.ts) once Phase 2 lands).
2. Register the resulting Drizzle relations in its `relations.ts`.
3. Build its own oRPC router using the package's services and the app's `protectedProcedure` / `publicProcedure`.
4. Inject env-driven config (`STRIPE_SECRET_KEY`, notification settings) at app boot, not per-request.
