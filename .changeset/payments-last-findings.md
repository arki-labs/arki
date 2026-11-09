---
"@arki/payments": minor
---

The risk profile writes refuse what Postgres refuses: `CustomerRiskProfileRepository.create`, `update` and `upsert` return `schema.invalid_input` for U+0000 or a bigint in the profile's JSON instead of a raw 22P05 or `TypeError`, and nothing is written. Breaking: their results, `updateCustomerRiskProfile` and the integration event handlers gain `SchemaFailure`. `lockReferences` returns the reference's `missing()` for a value holding U+0000 (no row can hold it) instead of a raw 22021. See `docs/upgrades/0.5.0-to-0.6.0.md`.
