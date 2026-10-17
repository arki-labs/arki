# @arki/date

Date and time math on [Temporal](https://tc39.es/proposal-temporal/) values with a small, explicit API. Calendar dates, instants, zoned date-times, durations, interval algebra, business days, formatting and relative text. Values are immutable, one arithmetic policy applies everywhere, and there is no hidden "now" and no hidden zone.

## Install

```sh
bun add @arki/date
# or
npm install @arki/date
```

## Quick start

Tell a customer when their order arrives: count business days in the shop's zone, skip public holidays, and move late orders to the next day.

```ts run
import { addBusinessDays, businessCalendar, format, nextBusinessDay, plainDate, toPlainDate, zoned } from '@arki/date';

const romania = businessCalendar({ holidays: ['2026-12-01', '2026-12-25'] });

// Friday 27 Nov, 12:00 in Bucharest. After a 15:00 cut-off the order ships the next business day.
const placed = zoned('2026-11-27T10:00:00Z', 'Europe/Bucharest');
const day = toPlainDate(placed);
const shipsOn = placed.hour >= 15 ? nextBusinessDay(day, romania) : day;
const arrives = addBusinessDays(shipsOn, 3, romania); // Mon is day 1, Tue 1 Dec is a holiday

if (String(arrives) !== '2026-12-03') throw new Error(String(arrives));
if (format(arrives, 'EEEE, MMMM do') !== 'Thursday, December 3rd') throw new Error('format');
if (String(plainDate('2026-01-31')) !== '2026-01-31') throw new Error('plainDate');
```

The tested version is `examples/delivery-estimate.ts`. Its tests pin the holiday, the cut-off to the second and the shop-zone day.

```ts from="examples/delivery-estimate.ts#delivery-estimate"
const romania = businessCalendar({ holidays: ['2026-12-01', '2026-12-25'] });
const cutOffHour = 15;

/**
 * The day an order arrives: `days` business days after it ships.
 * An order placed at or after 15:00 in the shop's zone ships on the next business day.
 */
export function estimateDelivery(orderedAt: string, shopZone: string, days: number): PlainDate {
  const placed = zoned(orderedAt, shopZone);
  const day = toPlainDate(placed);
  const shipsOn = placed.hour >= cutOffHour ? nextBusinessDay(day, romania) : day;
  return addBusinessDays(shipsOn, days, romania);
}

/** The same day as text for an order confirmation, for example "Thursday, December 3rd". */
export function describeDelivery(orderedAt: string, shopZone: string, days: number): string {
  return format(estimateDelivery(orderedAt, shopZone, days), 'EEEE, MMMM do');
}
```

## When not to use this

- You need recurrence rules (RRULE), natural-language parsing, a holiday database or non-ISO calendars. They are non-goals.
- You need a mutable API, macros or plugins.
- You need a monotonic clock for measuring elapsed time. Use `performance.now()`.
- You only format a date once in a browser and bundle size is tight. `Intl.DateTimeFormat` alone is smaller. This package pulls in `temporal-polyfill` (about 19 kB gzipped) where the runtime has no native `Temporal`.
- You need a different model of "now" per call without passing it in. This package never reads the clock behind your back. Pass a `Clock` from `@arki/clock`.

## Runtime support

Runs on Node 22+, Bun, Deno, browsers and edge runtimes: ECMAScript and `Intl` only. The `temporal-polyfill` ponyfill hands back the runtime's native `Temporal` where one exists (Node 26, Chrome 144, Firefox 139) and costs about 19 kB gzipped where it does not.

`bun run test` runs the suite on Node. `bun run test:bun` runs it under Bun, and the React hooks run in happy-dom. `bun run build && bun run smoke` runs one check per module under `node`, `bun` and `deno`. The token formatter and `parseISO` are differential-tested against date-fns for every pattern used in the monorepo. `bun run test:runtimes` writes the table below. The Hermes leg needs `HERMES_BIN` and prints `INCOMPLETE` when it is missing.

<!-- runtimes:start -->
| Runtime | Result | Version tested | Date (UTC) |
| --- | --- | --- | --- |
| node | pass | v26.11.1 | 2026-10-17 |
| bun | pass | 1.4.2 | 2026-10-17 |
| deno | pass | 2.9.7 | 2026-10-17 |
| browser | pass | Chromium 156.0.8078.4 | 2026-10-17 |
| hermes | not run | - | 2026-10-17 |
<!-- runtimes:end -->

## Public imports

Every module is also a subpath: `@arki/date/math`, `@arki/date/interval`, and so on. The root `@arki/date` re-exports the core modules. The optional subpaths (`zod`, `react`, `orpc`, `tanstack`) are not re-exported from the root.

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

## Failure behaviour

Invalid input throws at construction. Nothing returns a result object, and the package defines no error codes.

- A bad value (month 13, `2026-02-30`, an unknown time zone) throws `RangeError`.
- Mixed kinds (a `PlainDate` compared with an `Instant`) throw `TypeError`.
- An unknown format token throws. A time token on a `PlainDate`, or a zone token on a value without a zone, throws.
- A zone-less string passed to `zoned` throws and tells you to pass a zone. A zone is never guessed.
- `tryParse`, `tryParseDate`, `tryParseDateTime` and `tryParseZoned` return `undefined` instead of throwing. Use them for user input.
- `{ overflow: 'reject' }` and `{ disambiguation: 'reject' }` turn a clamp or a DST choice into a `RangeError`.

```ts run
import { plainDate, tryParseDate } from '@arki/date';

if (tryParseDate('nope', 'yyyy-MM-dd') !== undefined) throw new Error('expected undefined');
try {
  plainDate('2026-02-30');
  throw new Error('expected a RangeError');
} catch (error) {
  if (!(error instanceof RangeError)) throw error;
}
```

## Limits

- Overflow clamps. `add(plainDate('2026-01-31'), { months: 1 })` is `2026-02-28`. Subtraction is therefore not always the inverse of addition. Pass `{ overflow: 'reject' }` to throw instead.
- Iteration is bounded. `each`, `range` and `splitByUnit` throw when they would pass `maxItems` (10 000) items. They never truncate silently.
- A DST gap or fold resolves with the `compatible` rule: a skipped 02:30 becomes 03:30, and a repeated 02:30 takes the first. Pass `{ disambiguation }` to choose.
- Adding one day across a DST change moves 23 or 25 elapsed hours. Adding 24 hours is always 24. Use `diffElapsed` for exact time.
- `P1D - PT1H` throws, because a day is not always 24 hours. Give `normalizeDuration` a zoned `relativeTo`.
- The default locale is `en-US`, so a server and a client agree. Pass your app's locale.
- `systemTimeZone()` reads the runtime zone. Never let a server's zone leak into output: pass the user's zone.
- `parseISO` is a legacy door with date-fns semantics: zone-less text is read in local time.

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
import {
  addBusinessDays,
  age,
  businessCalendar,
  each,
  endOf,
  formatRange,
  inZone,
  interval,
  isPast,
  plainDate,
  relativeToNow,
  startOf,
  today,
  zoned,
  type Interval,
  type PlainDate,
  type ZonedDateTime,
} from '@arki/date';

import type { Clock } from '@arki/clock';

declare const clock: Clock;
declare const order: { dueAt: string };
declare const user: { birthDate: string };
declare const month: PlainDate;
declare const stay: Interval<PlainDate>;
declare const launch: ZonedDateTime;

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

## Guides

### Durations

A `Duration` keeps calendar fields (years…days) and exact fields (hours…ns) apart because a day is not always 24 hours and a month is never 30 days. `addDuration`/`subDuration` combine like with like (`P1Y − P2M = P10M`, `PT2H − PT30M = PT1H30M`) and refuse to mix groups of opposite sign (`P1D − PT1H` throws — give it a zoned `relativeTo` through `normalizeDuration`). `humanizeDuration` uses `Intl.NumberFormat` unit style and `Intl.ListFormat` — no `Intl.DurationFormat`, which Node 22 lacks.

### Intervals

```ts
import { intervalLength, splitByUnit, subtract, type Instant, type Interval, type ZonedDateTime } from '@arki/date';

declare const availability: Interval<Instant>;
declare const booking: Interval<Instant>;
declare const shift: Interval<ZonedDateTime>;

const free = subtract(availability, booking); // 0, 1 or 2 pieces
const byDay = [...splitByUnit(shift, 'day')]; // aligned pieces; partial first/last kept
intervalLength(shift, 'hour', { fractional: true });
```

Iteration (`each`, `range`, `splitByUnit`) is lazy and bounded: more than `maxItems` (10 000) throws rather than truncating.

### Testing time

```ts run
import { MockClock } from '@arki/clock';
import { createDateContext } from '@arki/date/fluent';

const clock = new MockClock(new Date('2026-10-09T09:00:00Z'));
const dates = createDateContext({ clock, timeZone: 'Europe/Bucharest', locale: 'ro-RO' });
const deadline = dates.now().add({ hours: 2 });
if (!deadline.isFuture()) throw new Error('two hours from now is in the future');
clock.advance(3 * 60 * 60 * 1000);
if (!deadline.isPast()) throw new Error('three hours later it is past');
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
import { parseDate, parseDateTime, parseZoned, tryParseDate } from '@arki/date';

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
import type { Instant } from '@arki/date';

declare const user: { timeZone: string };
declare const post: { publishedAt: Instant };

const now = useNow({ every: 1000 }); // Instant, re-read every second
const today = useToday({ timeZone: user.timeZone }); // PlainDate, re-renders only when the date changes
const label = useRelativeTime(post.publishedAt, { numeric: 'auto' }); // "yesterday", refreshed each minute
```

Every hook takes `clock` so tests can drive it with a `MockClock`. The first render reads the clock synchronously, so server and client agree. `react` is an optional peer dependency.

### Sending values over oRPC and SuperJSON (`@arki/date/orpc`)

oRPC and SuperJSON keep `Date` but not Temporal values: without help an `Instant` arrives as a string typed as `Instant`, or as `{}`. Register the codecs on both ends:

```ts
import { RPCLink } from '@orpc/client/fetch';
import SuperJSON from 'superjson';

import { registerTemporalTypes, temporalJsonSerializers } from '@arki/date/orpc';

const link = new RPCLink({ url: 'https://api.example.com/rpc', customJsonSerializers: temporalJsonSerializers }); // web and native clients
registerTemporalTypes(SuperJSON); // where the TanStack Query client dehydrates with SuperJSON
```

The server side uses the same list:

```ts skip="needs @orpc/server and an app router, which this package does not depend on"
import { RPCHandler } from '@orpc/server/fetch';

import { temporalJsonSerializers } from '@arki/date/orpc';

new RPCHandler(appRouter, { customJsonSerializers: temporalJsonSerializers });
```

Values travel as ISO text and are checked on arrival. The codecs use oRPC custom type ids 100–104 (`TEMPORAL_RPC_TYPES`).

### Loaders and server functions (`@arki/date/tanstack`)

TanStack Start sends loader data, server-function results and the SSR payload through seroval, which keeps `Date` but throws on a Temporal value. Register the adapters once in `src/start.ts`:

```ts skip="needs @tanstack/react-start, which this package does not depend on"
import { createStart } from '@tanstack/react-start';

import { temporalSerializationAdapters } from '@arki/date/tanstack';

export const startInstance = createStart(() => ({
  serializationAdapters: temporalSerializationAdapters,
}));
```

Values travel as ISO / RFC 9557 text, so a `ZonedDateTime` keeps its zone and an `Instant` its nanoseconds.

### Pickers and `Date`

`fromDate(d)` keeps the **instant**. `fromPickerDate(d, { basis: 'local' })` keeps the **calendar fields** the picker showed (`new Date(2026, 0, 31)` → `2026-01-31`). They are different on purpose; `toPickerDate` round-trips and throws for a day the zone skipped.


## Documentation

- [Agent guide](./docs/agent-guide.md): tasks, rules that bite, errors.
- [llms.txt](./llms.txt): the index an agent reads first.
- [Changelog](./CHANGELOG.md).

## Support

Report a bug or ask a question at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues). Include the input, the zone and the result you expected.

<!-- bench:start -->
## Benchmarks

> **Not publishable.** Do not quote these numbers:
>
> - The machine was busy: 1-minute load 3.9 at the start and 11.2 at the end, above half of its 12 cores. Other programs competed for the CPU, so timings are noisier. Close them and run again.
> - "arki" in "parse-iso" varies 127.7% across blocks (limit 5%). Close other programs or run again.
> - "dateFns" in "parse-iso" varies 83.6% across blocks (limit 5%). Close other programs or run again.
> - "dayjs" in "parse-iso" varies 49.9% across blocks (limit 5%). Close other programs or run again.
> - "luxon" in "parse-iso" varies 62.3% across blocks (limit 5%). Close other programs or run again.
> - "native" in "parse-iso" varies 39.7% across blocks (limit 5%). Close other programs or run again.
> - "arki" in "add-month" varies 26.8% across blocks (limit 5%). Close other programs or run again.
> - "dateFns" in "add-month" varies 52.7% across blocks (limit 5%). Close other programs or run again.
> - "dayjs" in "add-month" varies 32.0% across blocks (limit 5%). Close other programs or run again.
> - "luxon" in "add-month" varies 28.0% across blocks (limit 5%). Close other programs or run again.
> - "native" in "add-month" varies 27.3% across blocks (limit 5%). Close other programs or run again.
> - "arki" in "start-of-month" varies 67.8% across blocks (limit 5%). Close other programs or run again.
> - "dateFns" in "start-of-month" varies 22.8% across blocks (limit 5%). Close other programs or run again.
> - "dayjs" in "start-of-month" varies 20.9% across blocks (limit 5%). Close other programs or run again.
> - "luxon" in "start-of-month" varies 19.4% across blocks (limit 5%). Close other programs or run again.
> - "native" in "start-of-month" varies 20.1% across blocks (limit 5%). Close other programs or run again.
> - "arki" in "format" varies 15.0% across blocks (limit 5%). Close other programs or run again.
> - "arkiZoned" in "format" varies 10.9% across blocks (limit 5%). Close other programs or run again.
> - "dateFns" in "format" varies 27.1% across blocks (limit 5%). Close other programs or run again.
> - "dayjs" in "format" varies 16.1% across blocks (limit 5%). Close other programs or run again.
> - "luxon" in "format" varies 14.3% across blocks (limit 5%). Close other programs or run again.
> - "arki" in "diff-days" varies 11.5% across blocks (limit 5%). Close other programs or run again.
> - "dateFns" in "diff-days" varies 9.0% across blocks (limit 5%). Close other programs or run again.
> - "dayjs" in "diff-days" varies 14.9% across blocks (limit 5%). Close other programs or run again.
> - "luxon" in "diff-days" varies 16.5% across blocks (limit 5%). Close other programs or run again.
> - "arki" in "zone-hour" varies 14.2% across blocks (limit 5%). Close other programs or run again.
> - "arkiInstant" in "zone-hour" varies 9.8% across blocks (limit 5%). Close other programs or run again.
> - "dayjs" in "zone-hour" varies 12.2% across blocks (limit 5%). Close other programs or run again.
> - "luxon" in "zone-hour" varies 24.0% across blocks (limit 5%). Close other programs or run again.
> - "native" in "zone-hour" varies 12.7% across blocks (limit 5%). Close other programs or run again.
> - "zonedFromDate" in "only-arki" varies 74.8% across blocks (limit 5%). Close other programs or run again.
> - "instantFromDate" in "only-arki" varies 33.7% across blocks (limit 5%). Close other programs or run again.
> - "plainDate" in "only-arki" varies 15.1% across blocks (limit 5%). Close other programs or run again.
> - "addMonthPlain" in "only-arki" varies 19.3% across blocks (limit 5%). Close other programs or run again.
> - "startOfMonthPlain" in "only-arki" varies 183.8% across blocks (limit 5%). Close other programs or run again.
> - "addDayZoned" in "only-arki" varies 219.0% across blocks (limit 5%). Close other programs or run again.
> - "startOfHour" in "only-arki" varies 200.7% across blocks (limit 5%). Close other programs or run again.
> - "endOfMonth" in "only-arki" varies 180.4% across blocks (limit 5%). Close other programs or run again.
> - "isSameDay" in "only-arki" varies 202.4% across blocks (limit 5%). Close other programs or run again.
> - "formatZoned" in "only-arki" varies 98.7% across blocks (limit 5%). Close other programs or run again.
> - "formatWords" in "only-arki" varies 10.4% across blocks (limit 5%). Close other programs or run again.
> - "formatPreset" in "only-arki" varies 27.9% across blocks (limit 5%). Close other programs or run again.
> - "formatIntl" in "only-arki" varies 146.2% across blocks (limit 5%). Close other programs or run again.
> - "relative" in "only-arki" varies 78.1% across blocks (limit 5%). Close other programs or run again.
> - "relativeToNow" in "only-arki" varies 99.2% across blocks (limit 5%). Close other programs or run again.
> - "isToday" in "only-arki" varies 143.0% across blocks (limit 5%). Close other programs or run again.
> - "isoWeek" in "only-arki" varies 372.9% across blocks (limit 5%). Close other programs or run again.
> - "addBusinessDays" in "only-arki" varies 113.1% across blocks (limit 5%). Close other programs or run again.
> - "eachMonth" in "only-arki" varies 38.3% across blocks (limit 5%). Close other programs or run again.
> - "splitDays" in "only-arki" varies 37.5% across blocks (limit 5%). Close other programs or run again.
> - "fluent" in "only-arki" varies 100.9% across blocks (limit 5%). Close other programs or run again.
> - "humanize" in "only-arki" varies 61.6% across blocks (limit 5%). Close other programs or run again.
> - "toDate" in "only-arki" varies 118.9% across blocks (limit 5%). Close other programs or run again.
> - "systemTimeZone" in "only-arki" varies 196.8% across blocks (limit 5%). Close other programs or run again.

Speed of `@arki/date` against the three date libraries people most often pick in JavaScript: date-fns, Day.js and Luxon, with native `Date` and `Intl` where they do the same job. Each table only ranks libraries that returned the same result on every checked input.

Measured on Node 26.11.0 (Darwin 27.0.0 arm64, Apple M2 Max (12 cores)) · @arki/bench 0.0.2 (mitata 1.0.34) · publish · 5 processes × 10 blocks, seed 1592639052 · commit 3ca82e6736 · 2026-10-16.

Versions: @arki/bench 0.0.2 · @arki/date 0.2.0 · date-fns 4.4.0 · dayjs 1.11.23 · luxon 3.7.2 · mitata 1.0.34.

### Parse ISO 8601 text to an instant

Every ranked row returns the epoch milliseconds of ISO 8601 text; text with an offset is exact, text without one is local wall time (a skipped time moves forward, a repeated time takes the earlier offset); checked on 8 inputs. Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | Time / op | 95% interval | vs @arki/date parseISO |
| --- | --- | --: | --- | --- |
| **@arki/date parseISO** | 0.2.0 | 233 ns | 206–307 ns | baseline · ⚠ unstable |
| date-fns parseISO | 4.4.0 | 1.34 µs | 1.11–1.93 µs | 5.7× slower [4.1–8.6] · ⚠ unstable |
| Day.js dayjs(text) | 1.11.23 | 1 µs | 880 ns–1.33 µs | 4.3× slower [3.2–6.0] · ⚠ unstable |
| Luxon DateTime.fromISO | 3.7.2 | 2.06 µs | 1.67–2.86 µs | different contract: resolves the repeated autumn hour by the current season, not always to the earlier occurrence · ⚠ unstable |
| native Date.parse | — | 175 ns | 159–217 ns | different contract: reads a date without a time as UTC midnight, not local · ⚠ unstable |

### Add one month to a local date-time

Every ranked row returns the same wall-clock time one month later in America/New_York, the day clamped to the month end (Jan 31 → Feb 28), as epoch milliseconds; checked on 7 inputs. Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | Time / op | 95% interval | vs @arki/date add(zoned, { months: 1 }) |
| --- | --- | --: | --- | --- |
| **@arki/date add(zoned, { months: 1 })** | 0.2.0 | 656 ns | 614–764 ns | baseline · ⚠ unstable |
| date-fns addMonths | 4.4.0 | 466 ns | 432–538 ns | 1.4× faster [1.2–1.7] · ⚠ unstable |
| Day.js add(1, "month") | 1.11.23 | 3.52 µs | 3.12–4.41 µs | 5.4× slower [4.4–7.0] · ⚠ unstable |
| Luxon plus({ months: 1 }) | 3.7.2 | 10.9 µs | 9.51–13.5 µs | 17× slower [13–21] · ⚠ unstable |
| native Date setMonth(+1) | — | 254 ns | 238–295 ns | different contract: rolls over the month end (Jan 31 → Mar 3) · ⚠ unstable |

### Start of the month of a local date-time

Every ranked row returns local midnight on the first day of the month in America/New_York, with that day’s own UTC offset, as epoch milliseconds; checked on 5 inputs.

| Library | Version | Time / op | 95% interval | vs @arki/date startOf(zoned, "month") |
| --- | --- | --: | --- | --- |
| **@arki/date startOf(zoned, "month")** | 0.2.0 | 862 ns | 787–981 ns | baseline · ⚠ unstable |
| date-fns startOfMonth | 4.4.0 | 372 ns | 348–409 ns | 2.3× faster [2.0–2.7] · ⚠ unstable |
| Day.js startOf("month") | 1.11.23 | 422 ns | 396–466 ns | 2.0× faster [1.8–2.4] · ⚠ unstable |
| Luxon startOf("month") | 3.7.2 | 8.77 µs | 7.9–10 µs | 10× slower [9–12] · ⚠ unstable |
| native new Date(year, month, 1) | — | 211 ns | 199–238 ns | 4.1× faster [3.5–4.8] · ⚠ unstable |

### Format a Date as `yyyy-MM-dd HH:mm`

Every ranked row returns the text `yyyy-MM-dd HH:mm` of a `Date` in America/New_York (24-hour clock); checked on 6 inputs.

| Library | Version | Time / op | 95% interval | vs @arki/date format(Date, pattern) |
| --- | --- | --: | --- | --- |
| **@arki/date format(Date, pattern)** | 0.2.0 | 307 ns | 288–335 ns | baseline · ⚠ unstable |
| @arki/date format(zoned, pattern), zoned value prepared (variant) | — | 410 ns | 391–441 ns | 1.3× slower [1.2–1.5] · ⚠ unstable |
| date-fns format | 4.4.0 | 1.46 µs | 1.34–1.64 µs | 4.8× slower [4.2–5.4] · ⚠ unstable |
| Day.js dayjs(date).format | 1.11.23 | 1.65 µs | 1.53–1.83 µs | 5.4× slower [4.8–6.1] · ⚠ unstable |
| Luxon fromJSDate(date).toFormat | 3.7.2 | 1.43 µs | 1.34–1.58 µs | 4.7× slower [4.2–5.3] · ⚠ unstable |

### Difference in calendar days

Every ranked row returns whole calendar days from the first date to the second (negative when it is earlier), for dates without a time; checked on 6 inputs.

| Library | Version | Time / op | 95% interval | vs @arki/date diff(plainDate, plainDate, "day") |
| --- | --- | --: | --- | --- |
| **@arki/date diff(plainDate, plainDate, "day")** | 0.2.0 | 63.3 ns | 60.8–68 ns | baseline · ⚠ unstable |
| date-fns differenceInCalendarDays | 4.4.0 | 1.33 µs | 1.28–1.42 µs | 21× slower [19–23] · ⚠ unstable |
| Day.js diff(…, "day") | 1.11.23 | 417 ns | 400–449 ns | 6.6× slower [6.1–7.2] · ⚠ unstable |
| Luxon diff(…, "days").days | 3.7.2 | 12.9 µs | 11.8–14.6 µs | 204× slower [181–234] · ⚠ unstable |

### Convert a Date to a time zone and read the hour

Every ranked row returns the hour (0–23) that a `Date` shows in a given IANA zone; checked on 6 inputs.

| Library | Version | Time / op | 95% interval | vs @arki/date inZone(date, zone).hour |
| --- | --- | --: | --- | --- |
| **@arki/date inZone(date, zone).hour** | 0.2.0 | 583 ns | 555–621 ns | baseline · ⚠ unstable |
| @arki/date inZone(instant, zone).hour, instant prepared (variant) | — | 553 ns | 528–583 ns | inconclusive [0.88–1.02×] · ⚠ unstable |
| Day.js dayjs(date).tz(zone).hour() (utc + timezone plugins) | 1.11.23 | 41.1 µs | 38.1–44.8 µs | 70× slower [64–78] · ⚠ unstable |
| Luxon fromJSDate(date, { zone }).hour | 3.7.2 | 5.07 µs | 4.73–5.45 µs | 8.7× slower [7.9–9.5] · ⚠ unstable |
| native Intl.DateTimeFormat (formatter cached per zone) | — | 530 ns | 504–563 ns | inconclusive [0.84–0.99×] · ⚠ unstable |

date-fns has no row: time zones need `@date-fns/tz`, which is not installed.

### Other @arki/date operations (no direct competitor)

Each row measures different work; rows are not ranked.

| Case | Version | Time / op | 95% interval |
| --- | --- | --: | --- |
| zoned(Date, zone) | — | 576 ns | 543–637 ns |
| instant(Date) | — | 102 ns | 96–113 ns |
| plainDate(string) | — | 166 ns | 160–174 ns |
| add(plainDate, { months: 1 }) | — | 258 ns | 245–278 ns |
| startOf(plainDate, "month") | — | 151 ns | 143–169 ns |
| add(zoned, { days: 1 }) | — | 701 ns | 593–927 ns |
| startOf(zoned, "hour") | — | 382 ns | 354–434 ns |
| endOf(plainDate, "month") | — | 167 ns | 152–192 ns |
| isSameDay(zoned, zoned) | — | 491 ns | 462–556 ns |
| format(zoned, "yyyy-MM-dd") | — | 336 ns | 311–378 ns |
| format(Date, "MMM d, yyyy") | — | 303 ns | 291–321 ns |
| format(zoned, "PPPP") | — | 521 ns | 494–569 ns |
| formatIntl(zoned, medium) | — | 1.26 µs | 1.04–1.59 µs |
| relative(instant, ref) | — | 540 ns | 501–612 ns |
| relativeToNow(instant) | — | 3.42 µs | 2.81–4.42 µs |
| isToday(plainDate) | — | 318 ns | 293–356 ns |
| isoWeek(plainDate) | — | 140 ns | 127–171 ns |
| addBusinessDays(plainDate, 10) | — | 511 ns | 463–609 ns |
| each month ×12 | — | 15.3 µs | 13.1–19.1 µs |
| splitByUnit day ×31 | — | 48.6 µs | 43.3–57.4 µs |
| date(Date).add.startOf.format | — | 3.77 µs | 2.98–5.1 µs |
| humanizeDuration(P1DT2H) | — | 3.07 µs | 2.77–3.52 µs |
| toDate(zoned) | — | 56.3 ns | 52.8–61.8 ns |
| systemTimeZone() | — | 39.8 ns | 37.2–43.7 ns |

Different operations: compare each row with its own history, not with the others.

**Notes**

- All rows run with the machine zone set to America/New_York, so the inputs cross real DST changes (a skipped hour in March, a repeated hour in November) under a negative UTC offset. date-fns, Day.js and native `Date` always work in that machine zone; @arki/date and Luxon take the zone as data.
- @arki/date is built on Temporal values: immutable, nanosecond precision, IANA zones. date-fns and Day.js work on `Date` (millisecond precision, local time). Luxon is immutable and zone-aware. The @arki/date numbers include input validation and building a Temporal object.
- All four libraries clamp month ends (Jan 31 + 1 month = Feb 28). Native `Date.setMonth` rolls over (Jan 31 + 1 month = Mar 3), so it is shown as a different contract.
- The calendar-day group uses dates without a time of day. On such dates Day.js `diff(…, "day")` agrees with the others, but it counts whole 24-hour spans: 23:00 to 01:00 the next day is 0 for Day.js and 1 calendar day for date-fns, Luxon (after `startOf("day")`) and @arki/date.
- Time-zone conversion has no date-fns row: date-fns needs the extra `@date-fns/tz` package, which is not installed here. Day.js needs its `utc` and `timezone` plugins, which are loaded.
- Day.js and Luxon cannot format or convert a `Date` directly, so their timed work includes wrapping the `Date` (`dayjs(date)`, `DateTime.fromJSDate(date)`). @arki/date and date-fns accept a `Date` as is.

Run `bun run bench` in `packages/date` (set `ARKI_BENCH_NODE` to a Node 26 binary).

<!-- bench:meta {"schema":1,"suite":"@arki/date","specHash":"51605787dba240ab","profile":"publish","date":"2026-10-16T08:01:26.045Z","harness":"0.0.2"} -->
<!-- bench:end -->

### Why zoned `add` and `startOf` trail date-fns

These functions return a `Temporal.ZonedDateTime`. On Node 26 the native Temporal constructor alone takes about 500 ns for a named zone, which is more than date-fns needs for the whole operation on a `Date`. The date math in `@arki/date` takes about 150–200 ns. The constructor sets the floor, so faster math cannot close the gap. Work on a `PlainDate` (no zone) when you need speed.

Runtimes without native Temporal (Node 22, some browsers) use `temporal-polyfill`. There the same constructor takes about 3 µs, so every operation that builds a Temporal value is several times slower than on Node 26. Parsing, formatting and differences mostly avoid building Temporal values and stay fast on both.

## License

MIT — see [LICENSE](./LICENSE).
