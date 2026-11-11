---
"@arki/payments": minor
---

Core data refuses hostile input. `PaymentRepository` lookups by a status, tier, provider or event type outside its enum answer empty or null (no raw 22021 or 22P02), `claimWebhookEvent` returns `schema.invalid_input` for a provider or event type outside its enum, and `findUnprocessedWebhookEvents` takes a `belowAttempts` past the 32-bit range (no raw 22003). Breaking: the money builders (`fromMinorColumn`, `fromStoredNumber`, `planPrice`, `paymentAmount`) throw an invariant failure instead of `NumericRangeError`, `NumberFormatError` or `UnknownCurrencyError`; `lockReferences` breaks an invariant above 1,000 references. See `docs/upgrades/0.5.0-to-0.6.0.md`.
