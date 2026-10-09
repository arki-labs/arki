// Micro-benchmarks for the hot paths. Run after `bun run build`:
//   node scripts/bench.mjs   |   bun scripts/bench.mjs
// Each case reports the median of five 100 ms samples, in ns/op, with the
// result kept in a sink so engines cannot elide the work. Numbers track
// regressions between commits on one machine; they are not cross-machine.

import * as m from '../dist/index.js';
import { ro } from '../dist/words/ro.js';

const a = m.decimal('1234.5678');
const b = m.decimal('98.76');
const big = m.decimal('123456789012345678901234567890.123456789');
const items = Array.from({ length: 1000 }, (_, i) => m.decimal(`${i}.12`));
const huge = 10n ** 1000n;
const cancel = m.ratio(huge + 1n, huge + 3n);
const cancelInverse = cancel.inverse();
const r1 = m.ratio(355, 113);
const r2 = m.ratio(22, 7);
const t10 = m.studentT(10);
const nct = m.noncentralT(10, 1);
const fmt = m.createFormatter({ locale: 'de-DE', currency: 'EUR' });
const rng = m.createRandom(42);
const floats = Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 1000);

const cases = [
  ['decimal/parse-string', () => m.decimal('1234.5678')],
  ['decimal/from-number', () => m.decimal(0.1)],
  ['decimal/mixed-scale-add', () => a.plus(b)],
  ['decimal/times', () => a.times(b)],
  ['decimal/divide-scale10-halfEven', () => a.dividedBy(b, { scale: 10, rounding: 'halfEven' })],
  ['decimal/divide-exact-1-8', () => m.decimal(1).dividedBy(8)],
  ['decimal/compareTo', () => a.compareTo(b)],
  ['decimal/toString-30-digits', () => big.toString()],
  ['decimal/round-2', () => a.round(2)],
  ['decimal/sum-1000', () => m.Decimal.sum(items)],
  ['rational/plus', () => r1.plus(r2)],
  ['rational/cancellation', () => cancel.times(cancelInverse)],
  ['rational/toDecimal-scale10', () => r1.toDecimal({ scale: 10, rounding: 'halfEven' })],
  ['rational/toNumber', () => r1.toNumber()],
  ['number/round-1.005-2', () => m.round(1.005, 2)],
  ['number/roundTo-127.3-5', () => m.roundTo(127.3, 5)],
  ['stats/sum-1000', () => m.sum(floats)],
  ['stats/percentile-1000', () => m.percentile(floats, 90)],
  ['format/currency-de', () => m.formatCurrency(1234.5, 'EUR', { locale: 'de-DE' })],
  ['format/bound-decimal', () => fmt.formatCurrency(a)],
  ['parse/de-DE', () => m.parseNumber('1.234,56', { locale: 'de-DE' })],
  ['normal/quantile', () => m.normal().inv(0.975)],
  ['student-t/quantile', () => t10.inv(0.975)],
  ['student-t/cdf', () => t10.cdf(2)],
  ['noncentral-t/cdf', () => nct.cdf(2)],
  ['noncentral-t/quantile', () => nct.inv(0.8)],
  ['decimal-math/sqrt-50', () => m.sqrt(2, { scale: 50 })],
  ['words/english', () => m.spellNumber(1_234_567)],
  ['words/romanian', () => m.spellNumber(1_234_567, { locale: ro })],
  ['random/die', () => rng.int(1, 6)],
];

let sink;
const results = cases.map(([name, fn]) => {
  for (let i = 0; i < 200; i++) sink = fn();
  const samples = Array.from({ length: 5 }, () => {
    let count = 0;
    const start = performance.now();
    do {
      for (let i = 0; i < 16; i++) sink = fn();
      count += 16;
    } while (performance.now() - start < 100);
    return ((performance.now() - start) * 1e6) / count;
  }).sort((x, y) => x - y);
  return { name, nsPerOp: Math.round(samples[2]), check: String(sink).length };
});

const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
console.log(`@arki/math bench — ${runtime}`);
console.table(results);
