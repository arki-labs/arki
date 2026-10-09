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

| Subpath    | Contents                                                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types`    | the value-type aliases, `Point`/`Civil`/`Timeline` unions, unit and option types, `ISO_WEEK` `SUNDAY_WEEK`, `isPlainDate`… guards, `kindOf`                                                                                                                 |
| `core`     | `plainDate` `plainDateTime` `zoned` `instant` `fromUnix` `fromMillis` `toUnix` `toMillis` `toInstant` `toPlainDate` `toISO` `tryParse`                                                                                                                      |
| `interop`  | `fromDate` `toDate` `fromPickerDate` `toPickerDate` `systemTimeZone`                                                                                                                                                                                        |
| `math`     | `add` `sub` `set` `parts` `startOf` `endOf` `nextBoundary` `floor` `ceil` `round` `diff` `until` `diffElapsed` `elapsedNanoseconds`                                                                                                                         |
| `calendar` | `dayOfWeek` `dayOfYear` `daysInMonth` `daysInYear` `isLeapYear` `isWeekend` `isWeekday` `isoWeek` `weekOf` `weeksInYear` `quarter` `calendarDaysBetween` `age`                                                                                              |
| `compare`  | `equals` `sameInstant` `compareAsc` `compareDesc` `isBefore` `isAfter` `isSameOrBefore` `isSameOrAfter` `isSame` `isSameDay/Week/Month/Quarter/Year` `isBetween` `min` `max` `clamp`                                                                        |
| `zone`     | `inZone` (same instant) `reinterpretZone` (same wall clock) `atTime` `toUTC` `offset` `offsetMinutes` `isValidTimeZone`                                                                                                                                     |
| `duration` | `duration` `years…milliseconds` `addDuration` `subDuration` `multiplyDuration` `negateDuration` `absDuration` `normalizeDuration` `totalDuration` `toUnits` `compareDurations` `isZeroDuration` `isNegativeDuration` `formatDurationISO` `humanizeDuration` |
| `interval` | `interval` `contains` `overlaps` `abuts` `intersection` `union` `gap` `subtract` `symmetricDifference` `mergeIntervals` `gapsBetween` `intervalLength` `splitByUnit` `each` `range` `toISOInterval`                                                         |
| `business` | `businessCalendar` `isBusinessDay` `addBusinessDays` `subBusinessDays` `nextBusinessDay` `previousBusinessDay` `businessDaysBetween` `businessDaysIn`                                                                                                       |
| `format`   | `format` (date-fns-compatible tokens) `formatIntl` (`Intl.DateTimeFormat`) `formatISO` `toHumanReadableDate`                                                                                                                                                |
| `relative` | `relative` `relativeToNow` `relativeUnit` — "3 days ago" via `Intl.RelativeTimeFormat`                                                                                                                                                                      |
| `clock`    | `now` `nowIn` `today` `isToday` `isTomorrow` `isYesterday` `isThisWeek` `isThisMonth` `isThisYear` `isPast` `isFuture`                                                                                                                                      |
| `fluent`   | `date` `DateValue` `createDateContext`                                                                                                                                                                                                                      |
| `parseISO` | `parseISO(text): Date` — legacy, date-fns semantics (zone-less text is local time)                                                                                                                                                                          |

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

### Pickers and `Date`

`fromDate(d)` keeps the **instant**. `fromPickerDate(d, { basis: 'local' })` keeps the **calendar fields** the picker showed (`new Date(2026, 0, 31)` → `2026-01-31`). They are different on purpose; `toPickerDate` round-trips and throws for a day the zone skipped.

## Non-goals

Recurrence rules (RRULE), natural-language parsing, a holiday database, non-ISO calendars, a mutable API, macros or plugins, a monotonic clock.

## Verification

`bun run test` (vitest, Node), `bun run test:bun` (same suite under Bun), `bun run build && bun run smoke` (one check per module under `node`, `bun` and `deno`). The token formatter and `parseISO` are differential-tested against date-fns for every pattern used in the monorepo.

## License

MIT — see [LICENSE](./LICENSE).
