---
"@arki/payments": minor
---

Core services return a bad config and refuse oversized batches. `PaymentRetryService` and `DunningService` have a private constructor: build them with `static create(...)`, or with `createPaymentRetryService` / `createDunningService`; each returns the service or `payments.configuration_invalid`. `addRetryStrategy`, `updateRetryStrategy` and `DunningService.updateConfiguration` return nothing or that failure, and change nothing on failure. `previewMultiplePlanChanges` takes at most `MAX_BATCH_ITEMS` (1,000) plan ids, and the retry strategies, their lists, and the dunning `rules` and `retrySchedule` hold at most that many items. See `docs/upgrades/0.5.0-to-0.6.0.md`.
