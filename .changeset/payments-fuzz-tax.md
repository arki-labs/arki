---
"@arki/payments": minor
---

Tax refuses hostile input. Enum values outside their list, lone-surrogate text for Stripe and more than 1,000 batch items return `schema.invalid_input` instead of a raw Postgres error, a Stripe `invalid_request` or a stack overflow. Breaking: `exportTaxData` returns `schema.invalid_input` for a bad `format` where it threw `ARKI_FAILURE_E004`, and the tax calculation methods and `createTaxTransaction` can return `SchemaFailure`. See `docs/upgrades/0.5.0-to-0.6.0.md`.
