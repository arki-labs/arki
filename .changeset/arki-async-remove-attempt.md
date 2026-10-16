---
'@arki/async': minor
---

`@arki/async` no longer has its own `attempt`, `Outcome` and `unwrap` helpers. They were internal and never exported from the package entry, so no import breaks. `all`, `mapConcurrent`, `race`, `timeout` and `scoped` behave as before. To turn a throw into a value, use `attempt` from `@arki/failure`.
