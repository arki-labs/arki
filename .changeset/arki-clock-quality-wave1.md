---
'@arki/clock': minor
---

Breaking: `MockClock.advance` now throws `ClockError` with code `ARKI_CLOCK_E001` instead of `RangeError`. Adds a cross-runtime smoke test, `test:runtimes`, and the shared library lint preset.
