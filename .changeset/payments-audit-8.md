---
'@arki/payments': minor
---

Dunning analytics never add past what their columns hold, and the JSON depth check measures what `JSON.stringify` writes.

- Breaking: the campaign analytics upsert checks each sum in the statement itself. A counter that would pass 2^31 - 1 returns `payments.counter_exhausted` (`CounterExhausted`, whose `counter` may now be `paymentsRecovered`, `executions`, `customersReached` or `communicationsSent`), and recovered revenue that would pass 2^53 - 1 minor units returns `money.out_of_range`. Nothing is written then. `processScheduledExecutions` and `retryFailedExecutions` list either one as a `refused` entry; the execution stays complete and the stop check still runs.
- Breaking: `DunningCampaignRepository.getAnalyticsSince` and `getAnalyticsSummary`, `DunningCampaignService.getCampaignAnalytics` and `getDashboardStats` return `money.out_of_range` when revenue of one currency sums past 2^53 - 1 minor units over many rows, where they threw an invariant failure. `findTopPerformer` no longer casts its sum to `int`, so a count past 2^31 - 1 reads.
- Breaking: `pgJsonSchema`, `pgJsonRecordSchema` and `exceedsJsonDepth` follow `toJSON(key)` as `JSON.stringify` does. A `toJSON` that returns more than `MAX_JSON_DEPTH` (100) levels returns `schema.invalid_input`; a throwing `toJSON` keeps `schema.async_required`.

no demo impact: the demos do not read dunning analytics or store values with a custom `toJSON`.
