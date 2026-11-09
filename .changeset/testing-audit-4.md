---
"@arki/testing": patch
---

`logState`, a debug context's `state` and the `assertDeepPartialMatch` mismatch message never throw on the value they show: a bigint prints as `12n` and a circular value as its tag. A bigint column turned the path-naming assertion into a bare `TypeError`, and `logState` failed the test only when `DEBUG_TESTS` was on.
