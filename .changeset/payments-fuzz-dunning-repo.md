---
'@arki/payments': minor
---

Dunning repositories refuse hostile caller values as `schema.invalid_input` instead of raw Postgres errors: unknown `sortBy`, enum values (type, status, channel, risk category), over-long reference ids and more than 1,000 trigger segment ids. `sumMinorByCurrency` returns a `SchemaFailure` for a row it cannot read as money. The list reads and `findByType`, `findActiveForTrigger`, `findByRiskCategory` now include `SchemaFailure` in their result.
