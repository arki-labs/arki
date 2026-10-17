---
'@arki/resilience': minor
---

New `onThrow` option on `createResiliencePolicy`, `createRetryPolicy` and `withRetry`. It maps a thrown error that outlasts the retries, or one that is never retried, to a value, usually a failure from `@arki/failure`. The call then resolves to `T | Mapped`, typed from the mapper, so a loop has one error path instead of a failure check plus a try/catch. It wraps everything, so an open circuit, a timeout and a full bulkhead reach it too. A cancel by the caller's signal is never mapped. The mapper may rethrow what it does not recognise, so unknown errors stay bugs. Without `onThrow`, nothing changes. `RetryPolicy` and `ResiliencePolicy` now take the mapped type as `RetryPolicy<F>` and `ResiliencePolicy<F>` (default `never`), and the mapper's type is exported as `OnThrow<Mapped>`.
