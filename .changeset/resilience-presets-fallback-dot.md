---
'@arki/resilience': minor
---

New: `withFallback(policy, fallback)` gives a policy a last answer, typed `T | F`, and never hides a cancel. `definePresets({ name: options })` builds named composed policies, each with its own breaker. `createResiliencePolicy` now returns `components` (the retry, breaker, timeout and optional bulkhead it runs), and `Policy` gains a fallback type `F` (`never` for plain policies). `attachPolicyLogger` accepts any policy and returns a function that ends its subscriptions. New entry `@arki/resilience/dot`: the `resilience(presets)` plugin publishes `services.resilience` (`for`, `run`) and logs preset events at `debug` under `arki:resilience`. `@arki/dot` is an optional peer; `@arki/log` is a new dependency. The package moves to the `kernel` layer.
