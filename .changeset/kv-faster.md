---
'@arki/kv': patch
---

`getRateLimiter(id, options)` finds its cached limiter faster. Limiters are now kept per id, and options that hold only plain values are compared field by field instead of being turned into JSON on every call. Which limiter you get back is unchanged: the same id and options that serialise to the same JSON still share one limiter.
