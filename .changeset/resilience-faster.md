---
'@arki/resilience': patch
---

`withResilience()`, `withRetry()`, `withTimeout()` and `withCircuitBreaker()` now return the policy's own promise instead of wrapping it in a second one, so every call skips an extra promise and its microtask hops. A policy that throws instead of rejecting still gives a rejected promise.
