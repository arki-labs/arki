# @arki/date for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. Five value types: `PlainDate` (a day), `PlainDateTime` (a wall clock), `ZonedDateTime` (an exact moment in a zone), `Instant` (an exact moment) and `Duration`.
2. Pure functions, one subpath per module. `date(...)` from `/fluent` wraps a `ZonedDateTime` for chains.
3. A `Date` is an instant that pretends to be a calendar date. Convert at the edge with `fromDate`, `toDate`, `fromPickerDate` and `toPickerDate`.
4. Time comes from a `Clock` you pass. The zone comes from an argument.
5. Invalid input throws. `tryParse*` returns `undefined`.

## Task map

### Count business days with holidays

1. Build a calendar once: `businessCalendar({ holidays: [...] })`.
2. Call `addBusinessDays(plainDate(...), n, calendar)`.
3. Read the order day in the shop's zone first (`zoned`, then `toPlainDate`).

The tested version is `examples/delivery-estimate.ts` in the repository.

```ts run
import { addBusinessDays, businessCalendar, plainDate } from '@arki/date';

const calendar = businessCalendar({ holidays: ['2026-12-01', '2026-12-25'] });
const due = addBusinessDays(plainDate('2026-11-27'), 3, calendar);
if (String(due) !== '2026-12-03') throw new Error(String(due));
```

### Add a month without surprises

1. Use `add(value, { months: 1 })`. It clamps: Jan 31 plus one month is Feb 28.
2. Pass `{ overflow: 'reject' }` when a clamp would be a bug.

```ts run
import { add, plainDate } from '@arki/date';

if (String(add(plainDate('2026-01-31'), { months: 1 })) !== '2026-02-28') throw new Error('clamp');
```

### Show a moment in the user's zone

1. Make an `Instant` from the stored value.
2. Call `inZone(value, user.timeZone)` or `zoned(value, user.timeZone)`.
3. Format with `format(value, 'yyyy-MM-dd HH:mm')` or `formatIntl(value, { dateStyle: 'long', locale })`.

### Test code that depends on time

1. Take a `clock` option or parameter. Pass `SystemClock` in production.
2. In the test, pass a `MockClock` from `@arki/clock` and call `advance`.
3. Do not look for a global `setTestNow`. There is none.

### Parse user text

1. Use `tryParseDate(text, 'yyyy-MM-dd')`. It returns `undefined` for bad input.
2. For ISO text in many shapes, use `parseISO`. Zone-less text is read in local time.

### Send values over the wire

1. oRPC and SuperJSON: register the codecs from `@arki/date/orpc` on both ends.
2. TanStack Start: register `temporalSerializationAdapters` from `@arki/date/tanstack` once.
3. Validation: use the schemas in `@arki/date/zod`.

## Rules that bite

- `new Date('2026-05-20')` is May 19 in the Americas. Keep `Date` at the edges.
- `zoned('2026-05-20T09:30')` throws. Pass a zone.
- `diff(from, to)` is `to - from`. Whole units truncate toward zero.
- `diff` counts calendar units. `diffElapsed` counts exact time.
- Weeks start on Monday and week 1 holds January 4, unless you pass `{ week: SUNDAY_WEEK }`.
- Intervals are half-open. `each` throws past `maxItems`.
- Never let the server's zone leak into output. Pass the user's zone and locale.
- The optional subpaths are not in the root: import `@arki/date/zod`, `/react`, `/orpc`, `/tanstack`.

## Errors

| Code         | Meaning                                                                | What to do                                               |
| ------------ | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| none         | The package defines no error codes.                                    | Catch the built-in error types below.                    |
| `RangeError` | A value is out of range, or a zone is unknown, or `reject` was chosen. | Fix the input, or use a `tryParse*` function.            |
| `TypeError`  | Two values of different kinds were mixed.                              | Convert one with `toPlainDate`, `toInstant` or `inZone`. |

## Verify

```sh
bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
