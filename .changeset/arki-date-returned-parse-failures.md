---
'@arki/date': minor
---

Parsers return, builders throw. `parseISO`, `parseDate`, `parseDateTime`, `parseZoned` and `fromPickerDate` return the value or an `@arki/failure` value instead of throwing on bad outside input: `InvalidDateText` (`date.invalid_text`, 400, `data.reason` from `DATE_TEXT_REASONS` and a copy of the text cut to 64 characters), `InvalidNativeDate` (`date.invalid_native_date`, 400) and `UnknownTimeZone` (`date.unknown_time_zone`, 400). Breaking: `tryParse`, `tryParseDate`, `tryParseDateTime`, `tryParseZoned`, `ParseKinds` and `ParseResult` are removed; check results with `isFailure(result)` or `InvalidDateText.is(result)`. Builders (`plainDate`, `plainDateTime`, `instant`, `zoned`, `inZone`) still throw on the caller's own values. `fromUnix` now throws its own `RangeError` past ±8.64e12 seconds instead of a bare `BigInt` error. `@arki/failure` is now a runtime dependency. See `docs/upgrades/0.3.0-to-0.4.0.md`.
