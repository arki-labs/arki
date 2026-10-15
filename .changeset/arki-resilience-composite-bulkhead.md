---
'@arki/resilience': minor
---

`createResiliencePolicy` takes an optional `bulkhead` (`{ maxConcurrent, maxQueue }`). It wraps retry, circuit breaker and timeout, so one logical call holds one slot for all its attempts. Without it the composite keeps unlimited concurrency, as before. The README used to say the composite always included a bulkhead; it never did.
