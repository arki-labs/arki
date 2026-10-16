---
'@arki/clock': minor
---

`Clock` now has timers, so code that waits can run instantly in tests. Every clock has `setTimer(callback, ms)`, which returns a cancel function, and `sleep(ms, signal?)`, which an `AbortSignal` can cut short. `MockClock.advance(ms)` now fires every timer that comes due, in time order, including timers set by timers that fire during the step. The new `MockClock.advanceAsync(ms)` also lets promise callbacks run between timers, so a retry loop with real-size delays finishes in a millisecond. New error codes: `ARKI_CLOCK_E002` for a bad delay and `ARKI_CLOCK_E003` for an aborted sleep. New constant `MAX_TIMER_MS`.

Breaking: a hand-written `Clock` object now needs `setTimer` and `sleep` as well as `now`.
