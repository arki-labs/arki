// Speed of @arki/date against date-fns, Day.js and Luxon.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Every `compare` group states a contract and is checked before timing: each
// ranked library must return the same value for every input, including month
// ends, leap days, DST gaps and overlaps, and a negative UTC offset. Libraries
// that keep a different promise are marked `differs` and shown without a ratio.

import {
  addMonths,
  format as dfFormat,
  parseISO as dfParseISO,
  differenceInCalendarDays,
  startOfMonth,
} from 'date-fns';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { DateTime } from 'luxon';

import { compare, defineSuite, scenario } from '@arki/bench';
import * as d from '@arki/date';

// date-fns, Day.js and native `Date` work in the machine's local zone. Pin it, so
// every library sees the same zone and the DST inputs below hit real transitions
// (America/New_York: UTC-5, UTC-4 from 2026-03-08 to 2026-11-01).
const ZONE = 'America/New_York';
// eslint-disable-next-line turbo/no-undeclared-env-vars -- the suite pins its own process's zone; not a build input
process.env.TZ = ZONE;

dayjs.extend(utc);
dayjs.extend(timezone);

const DAY = 86_400_000;

const hourFormatters = new Map<string, Intl.DateTimeFormat>();
function hourFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = hourFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' });
    hourFormatters.set(zone, formatter);
  }
  return formatter;
}

/** `yyyy-MM-dd HH:mm` of an instant in ZONE, through Intl: the format oracle. */
const oracleParts = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
function wallText(ms: number): string {
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    oracleParts.formatToParts(ms).find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/** Whole days between two YYYY-MM-DD dates, by UTC arithmetic: the calendar-day oracle. */
function utcDay(text: string): number {
  const [year = 0, month = 1, day = 1] = text.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY;
}

type Parse = { text: string; ms: number };
type DayPair = { from: string; to: string };
type ZoneRead = { ms: number; zone: string };

export default defineSuite({
  id: '@arki/date',
  intro:
    'Speed of `@arki/date` against the three date libraries people most often pick in JavaScript: date-fns, Day.js and Luxon, with native `Date` and `Intl` where they do the same job. Each table only ranks libraries that returned the same result on every checked input.',
  notes: [
    'All rows run with the machine zone set to America/New_York, so the inputs cross real DST changes (a skipped hour in March, a repeated hour in November) under a negative UTC offset. date-fns, Day.js and native `Date` always work in that machine zone; @arki/date and Luxon take the zone as data.',
    '@arki/date is built on Temporal values: immutable, nanosecond precision, IANA zones. date-fns and Day.js work on `Date` (millisecond precision, local time). Luxon is immutable and zone-aware. The @arki/date numbers include input validation and building a Temporal object.',
    'All four libraries clamp month ends (Jan 31 + 1 month = Feb 28). Native `Date.setMonth` rolls over (Jan 31 + 1 month = Mar 3), so it is shown as a different contract.',
    'The calendar-day group uses dates without a time of day. On such dates Day.js `diff(…, "day")` agrees with the others, but it counts whole 24-hour spans: 23:00 to 01:00 the next day is 0 for Day.js and 1 calendar day for date-fns, Luxon (after `startOf("day")`) and @arki/date.',
    'Time-zone conversion has no date-fns row: date-fns needs the extra `@date-fns/tz` package, which is not installed here. Day.js needs its `utc` and `timezone` plugins, which are loaded.',
    'Day.js and Luxon cannot format or convert a `Date` directly, so their timed work includes wrapping the `Date` (`dayjs(date)`, `DateTime.fromJSDate(date)`). @arki/date and date-fns accept a `Date` as is.',
  ],
  groups: [
    compare<Parse>({
      id: 'parse-iso',
      title: 'Parse ISO 8601 text to an instant',
      contract: {
        id: 'date-parse-iso-instant/v1',
        description:
          'the epoch milliseconds of ISO 8601 text; text with an offset is exact, text without one is local wall time (a skipped time moves forward, a repeated time takes the earlier offset)',
      },
      inputs: [
        { text: '2026-10-09T12:37:48.123Z', ms: Date.UTC(2026, 9, 9, 12, 37, 48, 123) },
        { text: '2024-02-29T23:59:59.999+02:00', ms: Date.UTC(2024, 1, 29, 21, 59, 59, 999) },
        { text: '1969-12-31T23:59:59.999Z', ms: -1 },
        { text: '2026-06-15T12:00:00+05:45', ms: Date.UTC(2026, 5, 15, 6, 15) },
        { text: '2026-11-01T01:30:00-05:00', ms: Date.UTC(2026, 10, 1, 6, 30) },
        // No offset: local New York time. 02:30 on 2026-03-08 does not exist (→ 03:30 EDT); 01:30 on 2026-11-01 happens twice.
        { text: '2026-03-08T02:30:00', ms: Date.UTC(2026, 2, 8, 7, 30) },
        { text: '2026-11-01T01:30:00', ms: Date.UTC(2026, 10, 1, 5, 30) },
        // Date only: local midnight for every library except native Date.parse.
        { text: '2026-10-09', ms: Date.UTC(2026, 9, 9, 4) },
      ],
      expected: ({ ms }) => ms,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/date parseISO',
          package: '@arki/date',
          setup: ({ text }) => text,
          run: text => d.parseISO(text),
          normalize: value => value.epochMilliseconds,
        }),
        dateFns: c({
          label: 'date-fns parseISO',
          package: 'date-fns',
          setup: ({ text }) => text,
          run: text => dfParseISO(text),
          normalize: value => value.getTime(),
        }),
        dayjs: c({
          label: 'Day.js dayjs(text)',
          package: 'dayjs',
          setup: ({ text }) => text,
          run: text => dayjs(text),
          normalize: value => value.valueOf(),
        }),
        luxon: c({
          label: 'Luxon DateTime.fromISO',
          package: 'luxon',
          differs: 'resolves the repeated autumn hour by the current season, not always to the earlier occurrence',
          setup: ({ text }) => text,
          run: text => DateTime.fromISO(text),
          normalize: value => value.toMillis(),
        }),
        native: c({
          label: 'native Date.parse',
          differs: 'reads a date without a time as UTC midnight, not local',
          setup: ({ text }) => text,
          run: text => Date.parse(text),
        }),
      }),
    }),
    compare<string>({
      id: 'add-month',
      title: 'Add one month to a local date-time',
      contract: {
        id: 'date-add-month-zoned/v1',
        description:
          'the same wall-clock time one month later in America/New_York, the day clamped to the month end (Jan 31 → Feb 28), as epoch milliseconds',
      },
      inputs: [
        '2026-01-31T12:00',
        '2024-01-31T09:15',
        '2026-03-31T00:00',
        '2026-12-31T23:59',
        '2026-02-28T12:00', // lands after the March DST change: 24 × 28 − 1 elapsed hours
        '2026-02-08T02:30', // lands in the skipped hour on 2026-03-08 → 03:30 EDT
        '2026-10-01T01:30', // lands in the repeated hour on 2026-11-01 → the earlier 01:30 (EDT)
      ],
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/date add(zoned, { months: 1 })',
          package: '@arki/date',
          setup: text => d.zoned(text, ZONE),
          run: value => d.add(value, { months: 1 }),
          normalize: value => value.epochMilliseconds,
        }),
        dateFns: c({
          label: 'date-fns addMonths',
          package: 'date-fns',
          setup: text => new Date(text),
          run: value => addMonths(value, 1),
          normalize: value => value.getTime(),
        }),
        dayjs: c({
          label: 'Day.js add(1, "month")',
          package: 'dayjs',
          setup: text => dayjs(text),
          run: value => value.add(1, 'month'),
          normalize: value => value.valueOf(),
        }),
        luxon: c({
          label: 'Luxon plus({ months: 1 })',
          package: 'luxon',
          setup: text => DateTime.fromISO(text, { zone: ZONE }),
          run: value => value.plus({ months: 1 }),
          normalize: value => value.toMillis(),
        }),
        native: c({
          label: 'native Date setMonth(+1)',
          differs: 'rolls over the month end (Jan 31 → Mar 3)',
          setup: text => new Date(text),
          run: value => {
            const next = new Date(value);
            next.setMonth(next.getMonth() + 1);
            return next;
          },
          normalize: value => value.getTime(),
        }),
      }),
    }),
    compare<string>({
      id: 'start-of-month',
      title: 'Start of the month of a local date-time',
      contract: {
        id: 'date-start-of-month-zoned/v1',
        description:
          'local midnight on the first day of the month in America/New_York, with that day’s own UTC offset, as epoch milliseconds',
      },
      inputs: [
        '2026-03-15T12:00', // DST started on the 8th: the result is EST (UTC-5), the input EDT
        '2026-11-15T08:00', // DST ended on the 1st: the result is EDT (UTC-4), the input EST
        '2024-02-29T23:59',
        '2026-01-01T00:00',
        '2026-12-31T23:59:59.999',
      ],
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/date startOf(zoned, "month")',
          package: '@arki/date',
          setup: text => d.zoned(text, ZONE),
          run: value => d.startOf(value, 'month'),
          normalize: value => value.epochMilliseconds,
        }),
        dateFns: c({
          label: 'date-fns startOfMonth',
          package: 'date-fns',
          setup: text => new Date(text),
          run: value => startOfMonth(value),
          normalize: value => value.getTime(),
        }),
        dayjs: c({
          label: 'Day.js startOf("month")',
          package: 'dayjs',
          setup: text => dayjs(text),
          run: value => value.startOf('month'),
          normalize: value => value.valueOf(),
        }),
        luxon: c({
          label: 'Luxon startOf("month")',
          package: 'luxon',
          setup: text => DateTime.fromISO(text, { zone: ZONE }),
          run: value => value.startOf('month'),
          normalize: value => value.toMillis(),
        }),
        native: c({
          label: 'native new Date(year, month, 1)',
          setup: text => new Date(text),
          run: value => new Date(value.getFullYear(), value.getMonth(), 1),
          normalize: value => value.getTime(),
        }),
      }),
    }),
    compare<number>({
      id: 'format',
      title: 'Format a Date as `yyyy-MM-dd HH:mm`',
      contract: {
        id: 'date-format-local-pattern/v1',
        description: 'the text `yyyy-MM-dd HH:mm` of a `Date` in America/New_York (24-hour clock)',
      },
      inputs: [
        Date.UTC(2026, 9, 9, 12, 37, 48, 123),
        Date.UTC(2026, 2, 8, 7, 30), // 03:30 EDT, just after the skipped hour
        Date.UTC(2026, 10, 1, 5, 30), // 01:30 EDT, first pass
        Date.UTC(2026, 10, 1, 6, 30), // 01:30 EST, second pass
        Date.UTC(1969, 11, 31, 23, 59, 59, 999), // before the epoch: 1969-12-31 18:59
        Date.UTC(2024, 1, 29, 4, 59), // leap day in UTC, Feb 28 in New York
      ],
      expected: wallText,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/date format(Date, pattern)',
          package: '@arki/date',
          setup: ms => new Date(ms),
          run: value => d.format(value, 'yyyy-MM-dd HH:mm'),
        }),
        arkiZoned: c({
          label: '@arki/date format(zoned, pattern), zoned value prepared',
          variant: true,
          setup: ms => d.zoned(new Date(ms), ZONE),
          run: value => d.format(value, 'yyyy-MM-dd HH:mm'),
        }),
        dateFns: c({
          label: 'date-fns format',
          package: 'date-fns',
          setup: ms => new Date(ms),
          run: value => dfFormat(value, 'yyyy-MM-dd HH:mm'),
        }),
        dayjs: c({
          label: 'Day.js dayjs(date).format',
          package: 'dayjs',
          setup: ms => new Date(ms),
          run: value => dayjs(value).format('YYYY-MM-DD HH:mm'),
        }),
        luxon: c({
          label: 'Luxon fromJSDate(date).toFormat',
          package: 'luxon',
          setup: ms => new Date(ms),
          run: value => DateTime.fromJSDate(value).toFormat('yyyy-MM-dd HH:mm'),
        }),
      }),
    }),
    compare<DayPair>({
      id: 'diff-days',
      title: 'Difference in calendar days',
      contract: {
        id: 'date-diff-calendar-days/v1',
        description:
          'whole calendar days from the first date to the second (negative when it is earlier), for dates without a time',
      },
      inputs: [
        { from: '2026-01-31', to: '2026-12-31' },
        { from: '2026-03-01', to: '2026-03-15' }, // spans the March DST change (one 23-hour day)
        { from: '2026-11-15', to: '2026-10-25' }, // backwards across the November DST change
        { from: '2024-02-28', to: '2024-03-01' }, // leap year: 2
        { from: '2023-02-28', to: '2023-03-01' }, // common year: 1
        { from: '2026-05-20', to: '2026-05-20' },
      ],
      expected: ({ from, to }) => utcDay(to) - utcDay(from),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/date diff(plainDate, plainDate, "day")',
          package: '@arki/date',
          setup: ({ from, to }) => ({ a: d.plainDate(from), b: d.plainDate(to) }),
          run: ({ a, b }) => d.diff(a, b, 'day'),
        }),
        dateFns: c({
          label: 'date-fns differenceInCalendarDays',
          package: 'date-fns',
          setup: ({ from, to }) => ({ a: dfParseISO(from), b: dfParseISO(to) }),
          run: ({ a, b }) => differenceInCalendarDays(b, a),
        }),
        dayjs: c({
          label: 'Day.js diff(…, "day")',
          package: 'dayjs',
          setup: ({ from, to }) => ({ a: dayjs(from), b: dayjs(to) }),
          run: ({ a, b }) => b.diff(a, 'day'),
        }),
        luxon: c({
          label: 'Luxon diff(…, "days").days',
          package: 'luxon',
          setup: ({ from, to }) => ({
            a: DateTime.fromISO(from, { zone: ZONE }),
            b: DateTime.fromISO(to, { zone: ZONE }),
          }),
          run: ({ a, b }) => b.diff(a, 'days').days,
        }),
      }),
    }),
    compare<ZoneRead>({
      id: 'zone-hour',
      title: 'Convert a Date to a time zone and read the hour',
      contract: {
        id: 'date-zone-hour/v1',
        description: 'the hour (0–23) that a `Date` shows in a given IANA zone',
      },
      inputs: [
        { ms: Date.UTC(2026, 9, 9, 12, 37), zone: 'Europe/Bucharest' },
        { ms: Date.UTC(2026, 2, 8, 6, 59), zone: 'America/New_York' }, // 01:59 EST
        { ms: Date.UTC(2026, 2, 8, 7, 0), zone: 'America/New_York' }, // 03:00 EDT: 02:xx is skipped
        { ms: Date.UTC(2026, 10, 1, 6, 30), zone: 'America/New_York' }, // 01:30 EST, second pass
        { ms: Date.UTC(2026, 0, 15, 20, 0), zone: 'Asia/Kolkata' }, // +05:30 → 01:30 next day
        { ms: Date.UTC(2026, 5, 1, 2, 0), zone: 'America/St_Johns' }, // -02:30 → 23:30 the day before
      ],
      expected: ({ ms, zone }) =>
        [
          { ms: Date.UTC(2026, 9, 9, 12, 37), zone: 'Europe/Bucharest', hour: 15 },
          { ms: Date.UTC(2026, 2, 8, 6, 59), zone: 'America/New_York', hour: 1 },
          { ms: Date.UTC(2026, 2, 8, 7, 0), zone: 'America/New_York', hour: 3 },
          { ms: Date.UTC(2026, 10, 1, 6, 30), zone: 'America/New_York', hour: 1 },
          { ms: Date.UTC(2026, 0, 15, 20, 0), zone: 'Asia/Kolkata', hour: 1 },
          { ms: Date.UTC(2026, 5, 1, 2, 0), zone: 'America/St_Johns', hour: 23 },
        ].find(row => row.ms === ms && row.zone === zone)?.hour,
      baseline: 'arki',
      note: 'date-fns has no row: time zones need `@date-fns/tz`, which is not installed.',
      cases: c => ({
        arki: c({
          label: '@arki/date inZone(date, zone).hour',
          package: '@arki/date',
          setup: ({ ms, zone }) => ({ date: new Date(ms), zone }),
          run: ({ date, zone }) => d.inZone(date, zone).hour,
        }),
        arkiInstant: c({
          label: '@arki/date inZone(instant, zone).hour, instant prepared',
          variant: true,
          setup: ({ ms, zone }) => ({ value: d.instant(new Date(ms)), zone }),
          run: ({ value, zone }) => d.inZone(value, zone).hour,
        }),
        dayjs: c({
          label: 'Day.js dayjs(date).tz(zone).hour() (utc + timezone plugins)',
          package: 'dayjs',
          setup: ({ ms, zone }) => ({ date: new Date(ms), zone }),
          run: ({ date, zone }) => dayjs(date).tz(zone).hour(),
        }),
        luxon: c({
          label: 'Luxon fromJSDate(date, { zone }).hour',
          package: 'luxon',
          setup: ({ ms, zone }) => ({ date: new Date(ms), zone }),
          run: ({ date, zone }) => DateTime.fromJSDate(date, { zone }).hour,
        }),
        native: c({
          label: 'native Intl.DateTimeFormat (formatter cached per zone)',
          setup: ({ ms, zone }) => ({ date: new Date(ms), zone }),
          // The zone lookup is part of the work, as it is for the libraries (which cache formatters the same way).
          run: ({ date, zone }) => hourFormatter(zone).format(date),
          normalize: text => Number(text),
        }),
      }),
    }),
    scenario({
      kind: 'scenario',
      id: 'only-arki',
      title: 'Other @arki/date operations (no direct competitor)',
      note: 'Different operations: compare each row with its own history, not with the others.',
      cases: c => {
        const date = new Date(Date.UTC(2026, 9, 9, 12, 37, 48, 123));
        const at = (): d.ZonedDateTime => d.zoned(date, ZONE);
        const jan31 = (): d.PlainDate => d.plainDate('2026-01-31');
        return {
          zonedFromDate: c({ label: 'zoned(Date, zone)', setup: () => date, run: value => d.zoned(value, ZONE) }),
          instantFromDate: c({ label: 'instant(Date)', setup: () => date, run: value => d.instant(value) }),
          plainDate: c({ label: 'plainDate(string)', setup: () => '2026-01-31', run: text => d.plainDate(text) }),
          addMonthPlain: c({
            label: 'add(plainDate, { months: 1 })',
            setup: jan31,
            run: value => d.add(value, { months: 1 }),
          }),
          startOfMonthPlain: c({
            label: 'startOf(plainDate, "month")',
            setup: jan31,
            run: value => d.startOf(value, 'month'),
          }),
          addDayZoned: c({ label: 'add(zoned, { days: 1 })', setup: at, run: value => d.add(value, { days: 1 }) }),
          startOfHour: c({ label: 'startOf(zoned, "hour")', setup: at, run: value => d.startOf(value, 'hour') }),
          endOfMonth: c({ label: 'endOf(plainDate, "month")', setup: jan31, run: value => d.endOf(value, 'month') }),
          isSameDay: c({ label: 'isSameDay(zoned, zoned)', setup: at, run: value => d.isSameDay(value, value) }),
          formatZoned: c({
            label: 'format(zoned, "yyyy-MM-dd")',
            setup: at,
            run: value => d.format(value, 'yyyy-MM-dd'),
          }),
          formatWords: c({
            label: 'format(Date, "MMM d, yyyy")',
            setup: () => date,
            run: value => d.format(value, 'MMM d, yyyy'),
          }),
          formatPreset: c({ label: 'format(zoned, "PPPP")', setup: at, run: value => d.format(value, 'PPPP') }),
          formatIntl: c({
            label: 'formatIntl(zoned, medium)',
            setup: at,
            run: value => d.formatIntl(value, { dateStyle: 'medium' }),
          }),
          relative: c({
            label: 'relative(instant, ref)',
            setup: () => ({ value: d.instant(date), ref: d.instant('2026-10-09T15:00:00Z') }),
            run: ({ value, ref }) => d.relative(value, ref),
          }),
          relativeToNow: c({
            label: 'relativeToNow(instant)',
            setup: () => d.instant(date),
            run: value => d.relativeToNow(value),
          }),
          isToday: c({ label: 'isToday(plainDate)', setup: jan31, run: value => d.isToday(value) }),
          isoWeek: c({ label: 'isoWeek(plainDate)', setup: jan31, run: value => d.isoWeek(value) }),
          addBusinessDays: c({
            label: 'addBusinessDays(plainDate, 10)',
            setup: jan31,
            run: value => d.addBusinessDays(value, 10),
          }),
          eachMonth: c({
            label: 'each month ×12',
            setup: () => d.interval(jan31(), d.plainDate('2027-01-31')),
            run: range => [...d.each(range, { months: 1 })],
          }),
          splitDays: c({
            label: 'splitByUnit day ×31',
            setup: () => d.interval(jan31(), d.plainDate('2026-03-03')),
            run: range => [...d.splitByUnit(range, 'day')],
          }),
          fluent: c({
            label: 'date(Date).add.startOf.format',
            setup: () => date,
            run: value => d.date(value, { timeZone: ZONE }).add({ months: 1 }).startOf('day').format('yyyy-MM-dd'),
          }),
          humanize: c({
            label: 'humanizeDuration(P1DT2H)',
            setup: () => d.duration('P1DT2H'),
            run: value => d.humanizeDuration(value),
          }),
          toDate: c({ label: 'toDate(zoned)', setup: at, run: value => d.toDate(value) }),
          systemTimeZone: c({ label: 'systemTimeZone()', run: () => d.systemTimeZone() }),
        };
      },
    }),
  ],
});
