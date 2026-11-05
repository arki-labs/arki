---
"@arki/admin": patch
"@arki/ai": patch
"@arki/async": patch
"@arki/db": patch
"@arki/dot": patch
"@arki/env": patch
"@arki/fs": patch
"@arki/http": patch
"@arki/journal": patch
"@arki/kv": patch
"@arki/lock": patch
"@arki/payments": patch
"@arki/queue": patch
"@arki/resilience": patch
"@arki/schedule": patch
---

Span status now follows one rule. A returned failure always sets `failure.code`. It sets the span status to error only when `isFault(failure)` is true (status 500 or higher). An expected outcome (a 4xx, such as a missing record, a held lock or a declined card) leaves the status unset, so alerts on span errors fire only for faults. Thrown errors still set the error status. `@arki/env` and `@arki/schedule` now set `failure.code`, which they did not before. `@arki/payments` used to leave the status unset for every returned failure; a 5xx now sets error. `@arki/async`: `Cancelled` (499) no longer marks the span as an error.
