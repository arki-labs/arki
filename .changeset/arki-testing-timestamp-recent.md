---
'@arki/testing': minor
---

`assertTimestampRecent` now accepts a `Date`, an `Instant` or a `ZonedDateTime`, like `assertTimestamps`, and narrows to `Timestamp`. `generateDate({ between })` takes the same three kinds for its bounds. `timestamps.ts` also exports `isTimestamp`, `describeKind`, `epochNanoseconds` and `epochMilliseconds`.
