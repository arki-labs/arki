---
'@arki/payments': minor
---

Dates are `@arki/date` Temporal values, from the database to the service API.

Breaking:

- Every timestamp column (core, dunning, tax, refunds tables) is `instant()` from `@arki/db/temporal`. The SQL type does not change (`timestamp with time zone`), only the TypeScript type: rows hold `Instant`, not `Date`.
- Contracts and Zod schemas that described dates use `instantSchema()`: subscription command inputs (`currentPeriodStart`, `currentPeriodEnd`, `trialStart`, `trialEnd`, `canceledAt`), `Subscription` derived schemas, tax report periods, dunning segment filters, and the analytics `startDate` and `endDate` filters (they were ISO strings).
- Service, repository and preset inputs and outputs that carry dates take and return `Instant`: `PaymentRepository` ranges, `SubscriptionManager`, `DunningService`, `ProrationService`, `PaymentRetryService`, `WebhookAnalyticsService`, refund and tax services, the dunning campaign, communication and segmentation services, `getEntitlement` (`renews`, `trialEnd`), and the RevenueCat and subscription presets.
- `core/journal/support.ts` helpers are `toIso`, `toInstant` and `toNullableInstant`. Journal event data is still ISO text.
- Stripe and RevenueCat payloads are converted at the provider boundary (`fromUnix`, `fromMillis`).
- New dependency: `@arki/date`.
