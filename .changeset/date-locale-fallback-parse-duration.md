---
'@arki/date': minor
---

A malformed locale tag (an `Accept-Language` header, a cookie) no longer throws. `format`, `formatIntl`, `formatRange`, `parseDate`, `parseDateTime`, `parseZoned`, `relative`, `humanizeDuration`, `formatDurationIntl`, `weekRulesFor` and the `date` context fall back to `en-US` and log the swap at DEBUG (`arki:date:locale`). New `parseDuration(text)` returns an `InvalidDateText` failure (`operation` `'parseDuration'`, `reason` `'invalid_duration'`) for text that is not an ISO 8601 duration; both names were added to the failure's lists. A hand-built `BusinessCalendar` with all seven weekend days now throws `RangeError` in the business-day walks instead of looping forever. The zod issue messages copy a bounded part of the input. The oRPC and SuperJSON codecs document that their `deserialize` hooks have no failure channel. `@arki/log` is a new dependency.
