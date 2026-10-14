---
'@arki/resilience': minor
---

Remove `withCircuitBreaker`. It built a new circuit breaker on every call, so it never remembered a failure and never opened. Build one policy with `createCircuitBreakerPolicy()` and pass it to `withResilience()` on each call.
