---
'@arki/async': minor
---

`sleep`, `debounce`, `throttle` and `timeout` take an optional `clock` (an `@arki/clock` `Clock`). The default is the system clock, so nothing changes unless you pass one. With a `MockClock`, `clock.advance(ms)` drives the waits, so tests of long delays run instantly without fake timers. New type `TimeoutOptions` for `timeout`'s options. The package now depends on `@arki/clock`.
