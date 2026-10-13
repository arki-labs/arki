---
'@arki/date': minor
---

Much faster hot paths. Results are unchanged: every fast path is checked against Temporal on thousands of generated values, and it hands any case it does not cover (other calendars, `reject` on an ambiguous time, rare zone histories) back to Temporal.

- `parseISO` reads common ISO 8601 text with integer math (about 10× faster).
- `format` reads fields once with integer math and caches localized names (about 5× faster).
- `startOf`/`endOf` on plain dates and zoned values, `diff` in days, `isSame*`, `isToday` and friends, and `weekOf` work on day counts instead of Temporal objects.
- Time-zone offsets come from a per-day cache instead of a new `ZonedDateTime` per question.
