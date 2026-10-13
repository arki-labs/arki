---
'@arki/testing': minor
---

`assertTimestamps` and `assertUpdatedAfterCreated` accept `Date`, Temporal `Instant` and `ZonedDateTime` timestamps, and compare them by exact epoch nanoseconds. `assertTimestamps` now narrows to `Timestamps` (`{ createdAt: Timestamp; updatedAt: Timestamp }`, where `Timestamp = Date | Instant | ZonedDateTime`) instead of `{ createdAt: Date; updatedAt: Date }`. Both functions are also exported on their own, with the `Timestamp` and `Timestamps` types. An invalid `Date` is now rejected. `@arki/testing` depends on `@arki/date`.
