# @arki/date

Date and time math for ARKI, built on [Temporal](https://tc39.es/proposal-temporal/) semantics with a small, explicit API. Calendar dates, instants, zoned date-times, durations, interval algebra, business days, formatting and relative text — immutable values, one arithmetic policy, no hidden "now", no hidden zone.

Runs unchanged on **Node 22+, Bun, Deno, browsers and edge runtimes**: ECMAScript + `Intl` only. The `temporal-polyfill` ponyfill hands back the runtime's native `Temporal` where one exists (Node 26, Chrome 144, Firefox 139) and costs about 19 kB gzipped where it does not.

## Installation

```sh
bun add @arki/date
# npm install @arki/date · pnpm add @arki/date
```

## The five value types

| Type            | What it is                            | Use it for                                               |
| --------------- | ------------------------------------- | -------------------------------------------------------- |
| `PlainDate`     | a calendar day, no time, no zone      | birthdays, due dates, holidays, date keys                |
| `PlainDateTime` | a wall-clock date + time, no zone     | "the meeting is at 09:00 local" before the zone is known |
| `ZonedDateTime` | an exact moment shown in an IANA zone | scheduling, display, everything users see                |
| `Instant`       | an exact moment, zone-less            | timestamps, logs, `timestamptz` columns                  |
| `Duration`      | a signed amount of time               | "3 h 20 min", billing periods                            |

They are Temporal's own types; `@arki/date` adds no parallel classes. The only shape it adds is `Interval<T> = { start, end }` (end exclusive).

A `Date` is an instant that _pretends_ to be a calendar date. That is the root of most date bugs (`new Date('2026-05-20')` renders as May 19 in the Americas). Keep `Date` at the edges — DB drivers, pickers, third-party APIs — and convert once with `fromDate` / `toDate` / `fromPickerDate` / `toPickerDate`.

## Quick tour

```ts
import {
  add,
  date,
  diff,
  each,
  format,
  instant,
  interval,
  isWeekend,
  nextBusinessDay,
  overlaps,
  plainDate,
  relative,
  startOf,
  zoned,
} from '@arki/date';

const due = add(plainDate('2026-01-31'), { months: 1 }); // 2026-02-28 (clamped, never March 3)
const monthStart = startOf(zoned(new Date(), 'Europe/Bucharest'), 'month');
diff(plainDate('2026-01-01'), plainDate('2026-12-31'), 'day'); // 364  (to − from)
isWeekend(due) ? nextBusinessDay(due) : due;

format(zoned('2026-10-09T15:37:48+03:00[Europe/Bucharest]'), 'EEEE, MMMM do, yyyy HH:mm');
// "Friday, October 9th, 2026 15:37"
relative(instant('2026-10-09T09:00:00Z'), instant('2026-10-09T12:00:00Z')); // "3 hours ago"

const booking = interval(plainDate('2026-02-09'), plainDate('2026-03-01'));
overlaps(interval(plainDate('2026-01-31'), plainDate('2026-02-10')), booking); // true
[...each(interval(plainDate('2026-01-31'), plainDate('2026-05-01')), { months: 1 })].map(String);
// ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"] — anchored, not drifting

date('2026-01-31T10:00:00Z', { timeZone: 'Europe/Bucharest' })
  .add({ months: 1 })
  .set({ hour: 9, minute: 0 })
  .startOf('minute')
  .format('yyyy-MM-dd HH:mm'); // "2026-02-28 09:00"
```

Two ways to use it: **pure functions** (tree-shakeable, one subpath per module) and the **fluent `date()` wrapper** over `ZonedDateTime` for chains. The fluent form imports everything it delegates to; browser code that needs two operations should import those two.

## Which constructor, and where the zone comes from

| You have                                  | Call                                            | Result                                       |
| ----------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| `'2026-05-20'`                            | `plainDate(text)`                               | `PlainDate` — no time, no zone               |
| `'2026-05-20T09:30'`                      | `plainDateTime(text)`                           | `PlainDateTime` — wall clock, no zone        |
| `'2026-05-20T09:30'` + a zone             | `zoned(text, 'Europe/Bucharest')`               | that wall clock in that zone                 |
| `'…T06:30:00Z'` or `'…+03:00'`            | `instant(text)`                                 | `Instant` — exact time, no zone              |
| `'…T06:30:00Z'` + a zone                  | `zoned(text, 'Europe/Bucharest')`               | that exact time shown in that zone           |
| `'…+03:00[Europe/Bucharest]'`             | `zoned(text)`                                   | `ZonedDateTime` (zone from the annotation)   |
| a `Date`                                  | `instant(d)` / `zoned(d, zone)` / `fromDate(d)` | exact time; `zoned` adds the zone to show it |
| a `Date` from a picker                    | `fromPickerDate(d, { basis: 'local' })`         | the calendar fields the picker showed        |
| `{ year, month, day, hour }` parts + zone | `zoned(parts, zone, { disambiguation? })`       | DST gaps/folds resolved by `'compatible'`    |

A zone-less string is never guessed into a zone: `zoned('2026-05-20T09:30')` throws and tells you to pass one. `format`/`formatIntl` on an `Instant` or `Date` use `options.timeZone ?? systemTimeZone()`; on a `ZonedDateTime` they use its own zone.

**Server rendering:** never let the server's zone leak into output. Resolve the user's zone and locale once per request and pass them everywhere, or bind them: `const dates = createDateContext({ timeZone: user.timeZone, locale: user.locale })`. `systemTimeZone()` is for client-side code that wants the browser's zone.

## Common tasks

```ts
// Deadline in business days, skipping Romanian public holidays
const calendar = businessCalendar({ holidays: ['2026-12-01', '2026-12-25'] });
addBusinessDays(plainDate('2026-11-27'), 3, calendar); // 2026-12-03

// Is it overdue? (clock-driven, test with MockClock)
isPast(zoned(order.dueAt, 'Europe/Bucharest'), { clock });

// Age today
age(plainDate(user.birthDate), today({ clock, timeZone: 'Europe/Bucharest' }));

// A month grid (Monday-first weeks)
[...each(interval(startOf(month, 'week'), endOf(month, 'week')), { days: 1 })];

// "May 20 – 24, 2026"
formatRange(stay.start, stay.end, { dateStyle: 'medium' });

// "09:00 in Tokyo" as seen from Bucharest
inZone(zoned('2026-05-20T09:00', 'Asia/Tokyo'), 'Europe/Bucharest'); // 03:00+03:00

// Countdown text: "in 3 days" / "tomorrow"
relativeToNow(launch, { numeric: 'auto', clock });
```

## Policies (the whole package follows the same rules)

- **Overflow clamps.** `add`, `sub` and `set` constrain out-of-range fields (`Jan 31 + 1 month = Feb 28`). Pass `{ overflow: 'reject' }` to throw instead. Subtraction is therefore not always the inverse of addition.
- **Calendar vs elapsed.** On a `ZonedDateTime`, days/weeks/months/years move the wall clock, hours and below move the instant. Adding one day across a DST change is 23 or 25 elapsed hours; adding 24 hours is always 24. `diffElapsed` counts exact time (a day is 24 h there); `diff` counts calendar units.
- **`diff(from, to)` is `to − from`.** Positive means forward. Whole units truncate toward zero; `{ fractional: true }` gives the exact total anchored at `from`.
- **DST gaps and folds** resolve with Temporal's `compatible` rule (a skipped 02:30 becomes 03:30; a repeated 02:30 takes the first). Every constructor and `set` accepts `{ disambiguation: 'earlier' | 'later' | 'reject' }`.
- **Weeks are ISO by default** (Monday start, week 1 contains January 4). Pass `{ week: SUNDAY_WEEK }` or your own `WeekRules`.
- **No hidden now, no hidden zone.** Time comes from an `@arki/clock` `Clock` passed in (or `SystemClock`). Functions that need a zone take it explicitly; `today()`/`nowIn()` default to the runtime zone and say so — pass it when rendering on both server and client.
- **Default locale is `en-US`** so server and client agree. Pass your app's locale.
- **Half-open intervals.** `[start, end)` everywhere; touching intervals do not overlap; `union` returns sorted disjoint pieces and never bridges a gap.
- **Fail loud.** Invalid input throws `RangeError` at construction; mixed kinds throw `TypeError`; unknown format tokens throw. `tryParse` is the non-throwing door for user input.

## Modules

Every module is also a subpath: `@arki/date/math`, `@arki/date/interval`, …

| Subpath     | Contents                                                                                                                                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types`     | the value-type aliases, `Point`/`Civil`/`Timeline` unions, unit and option types, `ISO_WEEK` `SUNDAY_WEEK`, `isPlainDate`… guards, `kindOf`                                                                                                                                      |
| `core`      | `plainDate` `plainDateTime` `zoned` `instant` `fromUnix` `fromMillis` `toUnix` `toMillis` `toInstant` `toPlainDate` `toISO` `tryParse` `parseISO` `tryParse`                                                                                                                     |
| `interop`   | `fromDate` `toDate` `fromPickerDate` `toPickerDate` `systemTimeZone`                                                                                                                                                                                                             |
| `math`      | `add` `sub` `set` `parts` `startOf` `endOf` `nextBoundary` `floor` `ceil` `round` `diff` `until` `diffElapsed` `elapsedNanoseconds`                                                                                                                                              |
| `calendar`  | `dayOfWeek` `dayOfYear` `daysInMonth` `daysInYear` `isLeapYear` `isWeekend` `isWeekday` `isoWeek` `weekOf` `weeksInYear` `quarter` `calendarDaysBetween` `age` `nthWeekdayOfMonth` `lastWeekdayOfMonth` `easter` `weekRulesFor`                                                  |
| `compare`   | `equals` `sameInstant` `compareAsc` `compareDesc` `isBefore` `isAfter` `isSameOrBefore` `isSameOrAfter` `isSame` `isSameDay/Week/Month/Quarter/Year` `isBetween` `min` `max` `clamp`                                                                                             |
| `zone`      | `inZone` (same instant) `reinterpretZone` (same wall clock) `atTime` `toUTC` `offset` `offsetMinutes` `isValidTimeZone`                                                                                                                                                          |
| `duration`  | `duration` `years…milliseconds` `addDuration` `subDuration` `multiplyDuration` `negateDuration` `absDuration` `normalizeDuration` `totalDuration` `toUnits` `compareDurations` `isZeroDuration` `isNegativeDuration` `formatDurationISO` `humanizeDuration` `formatDurationIntl` |
| `interval`  | `interval` `contains` `overlaps` `abuts` `intersection` `union` `gap` `subtract` `symmetricDifference` `mergeIntervals` `gapsBetween` `intervalLength` `splitByUnit` `each` `range` `toISOInterval`                                                                              |
| `business`  | `businessCalendar` `isBusinessDay` `addBusinessDays` `subBusinessDays` `nextBusinessDay` `previousBusinessDay` `businessDaysBetween` `businessDaysIn`                                                                                                                            |
| `format`    | `format` (date-fns-compatible tokens) `formatIntl` `formatRange` (`Intl.DateTimeFormat`) `formatISO` `toHumanReadableDate`                                                                                                                                                       |
| `relative`  | `relative` `relativeToNow` `relativeUnit` — "3 days ago" via `Intl.RelativeTimeFormat`                                                                                                                                                                                           |
| `clock`     | `now` `nowIn` `today` `isToday` `isTomorrow` `isYesterday` `isThisWeek` `isThisMonth` `isThisYear` `isPast` `isFuture`                                                                                                                                                           |
| `fluent`    | `date` `DateValue` `createDateContext`                                                                                                                                                                                                                                           |
| `parse`     | `parseDate` `parseDateTime` `parseZoned` `tryParseDate` `tryParseDateTime` `tryParseZoned` (inverse of `format`)                                                                                                                                                                 |
| `zod`       | optional, needs `zod`: `plainDateSchema` `plainDateTimeSchema` `instantSchema` `zonedDateTimeSchema` `durationSchema` `timeZoneSchema` `intervalSchema`                                                                                                                          |
| `react`     | optional, needs `react`: `useNow` `useToday` `useRelativeTime`                                                                                                                                                                                                                   |
| `serialize` | optional, needs `@orpc/client` and/or `superjson`: `temporalJsonSerializers` `registerTemporalTypes` `TEMPORAL_RPC_TYPES`                                                                                                                                                        |
| `tanstack`  | optional, needs `@tanstack/react-router`: `temporalSerializationAdapters` and one adapter per type                                                                                                                                                                               |
| `parseISO`  | `parseISO(text): Date` — legacy, date-fns semantics (zone-less text is local time)                                                                                                                                                                                               |

### Durations

A `Duration` keeps calendar fields (years…days) and exact fields (hours…ns) apart because a day is not always 24 hours and a month is never 30 days. `addDuration`/`subDuration` combine like with like (`P1Y − P2M = P10M`, `PT2H − PT30M = PT1H30M`) and refuse to mix groups of opposite sign (`P1D − PT1H` throws — give it a zoned `relativeTo` through `normalizeDuration`). `humanizeDuration` uses `Intl.NumberFormat` unit style and `Intl.ListFormat` — no `Intl.DurationFormat`, which Node 22 lacks.

### Intervals

```ts
const free = subtract(availability, booking); // 0, 1 or 2 pieces
const byDay = [...splitByUnit(shift, 'day')]; // aligned pieces; partial first/last kept
intervalLength(shift, 'hour', { fractional: true });
```

Iteration (`each`, `range`, `splitByUnit`) is lazy and bounded: more than `maxItems` (10 000) throws rather than truncating.

### Testing time

```ts
import { MockClock } from '@arki/clock';
import { createDateContext } from '@arki/date/fluent';

const clock = new MockClock(new Date('2026-10-09T09:00:00Z'));
const dates = createDateContext({ clock, timeZone: 'Europe/Bucharest', locale: 'ro-RO' });
const deadline = dates.now().add({ hours: 2 });
deadline.isFuture(); // true
clock.advance(3 * 60 * 60 * 1000);
deadline.isPast(); // true
```

There is no package-level `setTestNow`: a global test clock leaks across tests and requests. Pass a clock.

### Format tokens

`format(value, pattern)` takes the date-fns v4 Unicode tokens (same output, en-US):

| Field      | Tokens                                          | Field        | Tokens                                    |
| ---------- | ----------------------------------------------- | ------------ | ----------------------------------------- |
| year       | `y` `yy` `yyyy` `yo`, ISO week-year `R` `RRRR`  | hour         | `h` `hh` `H` `HH` `K` `k` (+ `o`)         |
| quarter    | `Q` `QQ` `QQQ` `QQQQ` `Qo`                      | minute / sec | `m` `mm` `s` `ss` (+ `o`)                 |
| month      | `M` `MM` `MMM` `MMMM` `Mo`, stand-alone `L…`    | fraction     | `S` `SS` `SSS` (truncated)                |
| week / day | ISO week `I` `II`, day `d` `dd` `do`, `D` `DDD` | AM/PM        | `a` `aaa` `aaaa` `b` (noon/midnight)      |
| weekday    | `E` `EEEE` `EEEEE`, ISO `i` `iiii` `io`         | zone         | `X` `XX` `XXX` `x…` `O` `OOOO` `z` `zzzz` |
| presets    | `P` `PP` `PPP` `PPPP` `p` `pp` `Pp` `PPpp`      | literal      | `'text'`, `''` for a quote                |

Any other letter throws. Time tokens on a `PlainDate`, and zone tokens on a value without a zone, throw too. For locale-native output use `formatIntl(value, { dateStyle: 'long', locale })`.

### Parsing text

`parse` is the inverse of `format` for the same tokens (no ordinals or presets): the whole text must match, names are matched case-insensitively in the pattern's locale, and impossible dates throw.

```ts
parseDate('20 May 2026', 'd MMMM yyyy'); // PlainDate 2026-05-20
parseDateTime('2026-05-20 09:30 PM', 'yyyy-MM-dd hh:mm a'); // PlainDateTime
parseZoned('20/05/2026 09:30', 'dd/MM/yyyy HH:mm', 'Europe/Bucharest'); // wall clock in that zone
parseZoned('2026-05-20T09:30+03:00', "yyyy-MM-dd'T'HH:mmxxx", 'UTC'); // exact, shown in UTC
tryParseDate('nope', 'yyyy-MM-dd'); // undefined
```

For lenient ISO text (`2026-05-20`, `2026-W41-5`, `20260520T1030`) use `parseISO`, which returns an `Instant` and reads zone-less text in `options.timeZone` (runtime zone by default).

### Validating input (`@arki/date/zod`)

Schemas take an ISO string or an already-built value and output the Temporal value, so router inputs infer `string | PlainDate` and handlers receive a `PlainDate`:

```ts
import { z } from 'zod';

import { instantSchema, intervalSchema, plainDateSchema, timeZoneSchema } from '@arki/date/zod';

const input = z.object({
  day: plainDateSchema(),
  stay: intervalSchema(plainDateSchema()),
  seenAt: instantSchema(),
  timeZone: timeZoneSchema(), // canonical IANA id
});
```

`zod` is an optional peer dependency; the subpath is not re-exported from the package root.

### React (`@arki/date/react`)

```ts
import { useNow, useRelativeTime, useToday } from '@arki/date/react';

const now = useNow({ every: 1000 }); // Instant, re-read every second
const today = useToday({ timeZone: user.timeZone }); // PlainDate, re-renders only when the date changes
const label = useRelativeTime(post.publishedAt, { numeric: 'auto' }); // "yesterday", refreshed each minute
```

Every hook takes `clock` so tests can drive it with a `MockClock`. The first render reads the clock synchronously, so server and client agree. `react` is an optional peer dependency.

### Sending values over oRPC and SuperJSON (`@arki/date/serialize`)

oRPC and SuperJSON keep `Date` but not Temporal values: without help an `Instant` arrives as a string typed as `Instant`, or as `{}`. Register the codecs on both ends:

```ts
import { registerTemporalTypes, temporalJsonSerializers } from '@arki/date/serialize';

new RPCHandler(appRouter, { customJsonSerializers: temporalJsonSerializers }); // server
new RPCLink({ url, customJsonSerializers: temporalJsonSerializers }); // web and native clients
registerTemporalTypes(SuperJSON); // where the TanStack Query client dehydrates with SuperJSON
```

Values travel as ISO text and are checked on arrival. The codecs use oRPC custom type ids 100–104 (`TEMPORAL_RPC_TYPES`).

### Loaders and server functions (`@arki/date/tanstack`)

TanStack Start sends loader data, server-function results and the SSR payload through seroval, which keeps `Date` but throws on a Temporal value. Register the adapters once in `src/start.ts`:

```ts
import { createStart } from '@tanstack/react-start';

import { temporalSerializationAdapters } from '@arki/date/tanstack';

export const startInstance = createStart(() => ({
  serializationAdapters: temporalSerializationAdapters,
}));
```

Values travel as ISO / RFC 9557 text, so a `ZonedDateTime` keeps its zone and an `Instant` its nanoseconds.

### Pickers and `Date`

`fromDate(d)` keeps the **instant**. `fromPickerDate(d, { basis: 'local' })` keeps the **calendar fields** the picker showed (`new Date(2026, 0, 31)` → `2026-01-31`). They are different on purpose; `toPickerDate` round-trips and throws for a day the zone skipped.

## Non-goals

Recurrence rules (RRULE), natural-language parsing, a holiday database, non-ISO calendars, a mutable API, macros or plugins, a monotonic clock.

## Verification

`bun run test` (vitest, Node), `bun run test:bun` (same suite under Bun; the React hooks run in happy-dom), `bun run build && bun run smoke` (one check per module under `node`, `bun` and `deno`). The token formatter and `parseISO` are differential-tested against date-fns for every pattern used in the monorepo.

<!-- bench:start -->
## Benchmarks

Compares @arki/date with the three date libraries people most often pick in JavaScript: date-fns, Day.js and Luxon. Native `Date` and `Intl` are included where they solve the same task.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Parse an ISO 8601 instant

Input: `2026-10-09T12:37:48.123Z`. @arki/date returns an `Instant`; the others return a `Date`, a Day.js, or a Luxon `DateTime`.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/date parseISO | 18.03 µs | 35.52× |
| date-fns parseISO | 2.86 µs | 5.64× |
| Day.js dayjs(string) | 594.1 ns | 1.17× |
| Luxon DateTime.fromISO | 7.80 µs | 15.36× |
| native Date.parse | 507.7 ns | fastest |

### Add one month

Calendar date 2026-01-31 plus one month (the end-of-month clamping case).

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/date add(plainDate, { months: 1 }) | 5.17 µs | 3.95× |
| date-fns addMonths | 1.31 µs | fastest |
| Day.js add(1, "month") | 9.39 µs | 7.18× |
| Luxon plus({ months: 1 }) | 6.15 µs | 4.70× |

### Start of month

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/date startOf(plainDate, "month") | 3.55 µs | 3.61× |
| date-fns startOfMonth | 983.3 ns | fastest |
| Day.js startOf("month") | 1.68 µs | 1.71× |
| Luxon startOf("month") | 1.75 µs | 1.78× |

### Format as `yyyy-MM-dd HH:mm`

All libraries format the same `Date` in the machine time zone. The pattern is parsed on every call; none of these libraries offers a precompiled formatter.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/date format(Date, pattern) | 21.56 µs | 3.58× |
| date-fns format | 7.16 µs | 1.19× |
| Day.js format | 10.00 µs | 1.66× |
| Luxon toFormat | 6.03 µs | fastest |

### Difference in calendar days

2026-01-31 to 2026-12-31 (334 days).

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/date diff(plainDate, plainDate, "day") | 1.27 µs | fastest |
| date-fns differenceInCalendarDays | 15.52 µs | 12.19× |
| Day.js diff(…, "day") | 1.84 µs | 1.45× |
| Luxon diff(…, "days") | 11.35 µs | 8.92× |

### Convert an instant to a time zone and read the hour

Europe/Bucharest. The native row uses one prepared `Intl.DateTimeFormat`, which is the fastest native route but returns a string, not a date object.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/date inZone(instant, zone).hour | 10.86 µs | 9.63× |
| Day.js tz(zone).hour() (utc + timezone plugins) | 110.09 µs | 97.68× |
| Luxon fromJSDate(date, { zone }).hour | 13.91 µs | 12.34× |
| native Intl.DateTimeFormat (prepared) | 1.13 µs | fastest |

### Other @arki/date operations (no direct competitor)

These rows are for tracking regressions in this package. They are not a comparison, so ignore the "vs fastest" column.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| zoned(Date, tz) | 17.95 µs | 188.09× |
| instant(Date) | 2.82 µs | 29.58× |
| plainDate(string) | 6.53 µs | 68.45× |
| add(zoned, { days: 1 }) | 71.97 µs | 753.96× |
| startOf(zoned, "month") | 51.91 µs | 543.82× |
| startOf(zoned, "hour") | 9.17 µs | 96.12× |
| endOf(plainDate, "month") | 25.33 µs | 265.37× |
| isSameDay(zoned, zoned) | 3.62 µs | 37.92× |
| format(zoned, "yyyy-MM-dd") | 13.71 µs | 143.60× |
| format(Date, "MMM d, yyyy") | 22.63 µs | 237.02× |
| format(zoned, "PPPP") | 14.72 µs | 154.17× |
| formatIntl(zoned, medium) | 11.63 µs | 121.83× |
| relative(instant, ref) | 3.53 µs | 36.98× |
| relativeToNow(instant) | 54.00 µs | 565.72× |
| isToday(plainDate) | 21.98 µs | 230.24× |
| isoWeek(plainDate) | 17.86 µs | 187.08× |
| addBusinessDays(plainDate, 10) | 4.55 µs | 47.65× |
| each month x12 | 73.39 µs | 768.78× |
| splitByUnit day x31 | 160.73 µs | 1683.76× |
| date(Date).add.startOf.format | 74.14 µs | 776.68× |
| humanizeDuration(P1DT2H) | 142.93 µs | 1497.28× |
| toDate(zoned) | 261.0 ns | 2.73× |
| systemTimeZone() | 95.5 ns | fastest |

Read the rows with the contracts in mind:

- @arki/date is built on Temporal values: immutable, nanosecond precision, and time zones come from the IANA database, not from the host machine. Day.js and date-fns work on `Date`, which has millisecond precision and a local-time bias. Luxon is also immutable and zone-aware.
- @arki/date rejects impossible input (such as 2026-02-31) instead of rolling it over, and it adds months by clamping to the last valid day (Jan 31 + 1 month = Feb 28). date-fns, Day.js and Luxon clamp too; native `Date` does not, so it is left out of the month group.
- Day.js `diff(…, "day")` counts whole 24-hour spans. date-fns `differenceInCalendarDays`, Luxon `diff` and @arki/date `diff` on plain dates count calendar days. The inputs here are midnight local dates, so the answers agree.
- date-fns has no time-zone conversion without the extra `@date-fns/tz` package, so it is not in the zone group. Day.js needs its `utc` and `timezone` plugins, which are loaded here.
- The @arki/date numbers include input validation and building a Temporal object, which is what you pay for correctness. The extra cases at the end have no direct competitor and exist to catch regressions.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT — see [LICENSE](./LICENSE).
