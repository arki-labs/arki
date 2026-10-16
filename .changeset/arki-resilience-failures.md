---
'@arki/resilience': minor
---

Retry now understands failures from `@arki/failure`. A function that returns a failure, such as "card declined", is not retried: the failure is an expected outcome, so it goes back to the caller after one try. A returned failure is retried only when the backoff's `while` predicate accepts it, for example `.while(reason => isFailure(reason) && reason.code === 'db.timeout')`. When those retries run out, the caller gets the last failure as a value instead of an error, and the result type stays the function's own. `onFailure` and `onRetry` report a returned failure as `{ value }`; `onGiveUp` fires for it only after at least one retry. Circuit breakers and bulkheads are unchanged.

Breaking: the predicate of `while` now also sees returned failures, and a backoff without `while` no longer retries them. A negative predicate such as `reason => !(reason instanceof BadInput)` says yes to failures, so name the failures you want retried instead. `Backoff.delay`'s second parameter is renamed from `error` to `reason`.
