---
"@arki/payments": minor
---

Dunning and tax refusals that stored data causes are returned, and failed dunning executions are really retried. Breaking in 0.x.

- `DunningCampaignService.deleteCampaign` returns `DunningTemplateInUse` (`payments.dunning_template_in_use`, 409) for a campaign whose step already sent a communication, instead of throwing the database's foreign-key error. Nothing is deleted; archive the campaign instead. It returns `undefined` when it deletes.
- `TaxExemptionRepository.updateExemption` returns `InvalidInput` (`schema.invalid_input`) when the row the update leaves would name no customer, product code or jurisdiction, or would end before it starts, instead of throwing the table's CHECK error. `createExemption` returns the same failure for an end before the start. New `exemptionPeriodSchema` in `@arki/payments/tax/contracts` holds the date rule.
- `retryFailedExecutions` now retries: an execution that throws (in `processScheduledExecutions` or in a retry) is `failed` with a `nextRetryAt` of 30, 60, then 120 minutes, each retry counts once in `retryCount`, and after 3 retries it stays failed with no `nextRetryAt`. `DunningExecutionRepository.incrementRetryCount` is replaced by `startRetry(id)` and `recordFailure(id, errorMessage, nextRetryAt)`.
- The README and agent guide now say a refund in another currency returns `RefundCurrencyMismatch`; they said it throws.

Migration: branch on the result of `deleteCampaign` and `updateExemption` with `isFailure`. Callers of `incrementRetryCount` call `startRetry` and `recordFailure`. See `docs/upgrades/0.5.0-to-0.6.0.md`.

no demo impact: the package has no demo.
