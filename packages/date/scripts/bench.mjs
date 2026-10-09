// Micro-benchmark of the hot paths against the built `dist/` (run `bun run build` first).
// Prints the best of five rounds per operation in microseconds; compare before/after a change.
import * as d from '../dist/index.js';

const N = 5000;
const bench = (name, fn) => {
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    for (let i = 0; i < 300; i++) fn();
    const t = performance.now();
    for (let i = 0; i < N; i++) fn();
    best = Math.min(best, ((performance.now() - t) * 1000) / N);
  }
  console.log(`${name.padEnd(34)} ${best.toFixed(2)} µs/op`);
};
const date = new Date('2026-10-09T12:37:48.123Z');
const z = d.zoned(date, 'Europe/Bucharest');
const pd = d.plainDate('2026-01-31');
const i = d.instant(date);
const ref = d.instant('2026-10-09T15:00:00Z');
bench('zoned(Date, tz)', () => d.zoned(date, 'Europe/Bucharest'));
bench('instant(Date)', () => d.instant(date));
bench('plainDate(string)', () => d.plainDate('2026-01-31'));
bench('add(pd, {months:1})', () => d.add(pd, { months: 1 }));
bench('add(z, {days:1})', () => d.add(z, { days: 1 }));
bench('startOf(z, month)', () => d.startOf(z, 'month'));
bench('startOf(z, hour)', () => d.startOf(z, 'hour'));
bench('endOf(pd, month)', () => d.endOf(pd, 'month'));
bench('diff(pd, pd2, day)', () => d.diff(pd, d.plainDate('2026-12-31'), 'day'));
bench('isSameDay(z, z)', () => d.isSameDay(z, z));
bench('format(z, yyyy-MM-dd)', () => d.format(z, 'yyyy-MM-dd'));
bench('format(Date, MMM d, yyyy)', () => d.format(date, 'MMM d, yyyy'));
bench('format(z, PPPP)', () => d.format(z, 'PPPP'));
bench('formatIntl(z, medium)', () => d.formatIntl(z, { dateStyle: 'medium' }));
bench('relative(i, ref)', () => d.relative(i, ref));
bench('relativeToNow(i)', () => d.relativeToNow(i));
bench('isToday(pd)', () => d.isToday(pd));
bench('isoWeek(pd)', () => d.isoWeek(pd));
bench('addBusinessDays(pd, 10)', () => d.addBusinessDays(pd, 10));
bench('each month x12', () => [...d.each(d.interval(pd, d.plainDate('2027-01-31')), { months: 1 })]);
bench('splitByUnit day x31', () => [...d.splitByUnit(d.interval(pd, d.plainDate('2026-03-03')), 'day')]);
bench('date(Date).add.startOf.format', () =>
  d.date(date, { timeZone: 'Europe/Bucharest' }).add({ months: 1 }).startOf('day').format('yyyy-MM-dd'),
);
bench('humanizeDuration(P1DT2H)', () => d.humanizeDuration(d.duration('P1DT2H')));
bench('toDate(z)', () => d.toDate(z));
bench('systemTimeZone()', () => d.systemTimeZone());
