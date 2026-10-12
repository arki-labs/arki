// Cross-runtime smoke test: run with `node`, `bun` and `deno run --allow-read`.
// Imports the built `dist/` (run `bun run build` first) and exercises one
// operation per module so a runtime gap (missing Intl API, `node:` import,
// `process` access…) fails loudly on every engine, not just on Node.
import * as date from '../dist/index.js';

const runtime = globalThis.Deno
  ? `deno ${globalThis.Deno.version.deno}`
  : globalThis.Bun
    ? `bun ${globalThis.Bun.version}`
    : `node ${globalThis.process?.version ?? '?'}`;
const checks = [];
const check = (name, actual, expected) => checks.push({ name, ok: actual === expected, actual, expected });

const d = date.plainDate('2026-01-31');
check('add constrain', date.add(d, { months: 1 }).toString(), '2026-02-28');
check('startOf week', date.startOf(date.plainDate('2026-10-09'), 'week').toString(), '2026-10-05');
check('diff', date.diff(date.plainDate('2026-01-01'), date.plainDate('2026-12-31'), 'day'), 364);
check(
  'zoned DST',
  date.add(date.zoned({ year: 2026, month: 3, day: 28, hour: 12 }, 'Europe/Bucharest'), { days: 1 }).toString(),
  '2026-03-29T12:00:00+03:00[Europe/Bucharest]',
);
check('isoWeek', date.isoWeek(date.plainDate('2027-01-01')).week, 53);
check('format tokens', date.format(d, 'LLL dd, y'), 'Jan 31, 2026');
check('parseDate', date.parseDate('May 20, 2026', 'MMMM d, yyyy').toString(), '2026-05-20');
check('parseISO', date.parseISO('2026-W41-5T10:30Z').toString(), '2026-10-09T10:30:00Z');
check('easter', date.easter(2026, 'orthodox').toString(), '2026-04-12');
check('nthWeekdayOfMonth', date.nthWeekdayOfMonth(2026, 5, -1, 5).toString(), '2026-05-29');
check('weekRulesFor', typeof date.weekRulesFor('en-US').startsOn, 'number');
check('formatRange', date.formatRange(d, date.plainDate('2026-02-02'), { dateStyle: 'medium' }).length > 10, true);
check('now options', typeof date.now({ clock: { now: () => new Date(0) } }).epochMilliseconds, 'number');
check('format intl', date.formatIntl(d, { dateStyle: 'medium', locale: 'en-US' }), 'Jan 31, 2026');
check(
  'relative',
  date.relative(date.instant('2026-01-01T00:00:00Z'), date.instant('2026-01-03T00:00:00Z'), { locale: 'en-US' }),
  '2 days ago',
);
check('humanize duration', typeof date.humanizeDuration(date.duration('P1DT2H'), { locale: 'en-US' }), 'string');
check(
  'interval',
  date.overlaps(
    date.interval(d, date.plainDate('2026-02-10')),
    date.interval(date.plainDate('2026-02-09'), date.plainDate('2026-03-01')),
  ),
  true,
);
check('business', date.addBusinessDays(date.plainDate('2026-10-09'), 1).toString(), '2026-10-12');
check(
  'fluent',
  date.date('2026-01-31T10:00:00Z', { timeZone: 'Europe/Bucharest' }).add({ months: 1 }).startOf('day').toString(),
  '2026-02-28T00:00:00+02:00[Europe/Bucharest]',
);
check('clock', typeof date.now().epochMilliseconds, 'number');
check('no node globals leaked', typeof date.systemTimeZone(), 'string');

const failed = checks.filter(c => !c.ok);
for (const c of failed) console.error(`✗ ${c.name}: expected ${String(c.expected)}, got ${String(c.actual)}`);
console.log(`${runtime}: ${checks.length - failed.length}/${checks.length} smoke checks passed`);
if (failed.length > 0) throw new Error(`${failed.length} smoke check(s) failed on ${runtime}`);
