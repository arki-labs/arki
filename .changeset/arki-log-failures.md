---
'@arki/log': minor
---

A failure value from `@arki/failure` can be logged as a field: `log.warn('lookup failed', { failure })`. Every formatter and the OpenTelemetry sink print its `code`, `message`, `status`, `data` and `remediation`, plus `causes`: the cause chain, nearest first, through nested failures and thrown errors. The list stops at a cycle (`[Circular]`) or after 64 links (`[MaxDepth]`), the same limit as `findCause`. `redact()` paths reach into a failure's data and causes. `@arki/log` still has no dependencies: it knows a failure by its `'~failure'` brand. New exports: `serializeFailure` and the `FailureLike` type, which is now part of `Value`.
