// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser target.
// It exercises one call per module; the unit tests cover the details.

import {
  convert,
  createRandom,
  decimal,
  formatCurrency,
  formatFileSize,
  formatNumber,
  formatPercent,
  gcd,
  isPrime,
  mean,
  normal,
  num,
  parseNumber,
  payment,
  ratio,
  round,
  spellNumber,
  spellOrdinal,
  sqrt,
  stddev,
} from '../dist/index.js';
import { ro } from '../dist/words/ro.js';

const exactStrings =
  new Intl.NumberFormat('en-US', { useGrouping: false }).format('9007199254740993') === '9007199254740993';
const hasFormatToParts = typeof Intl.NumberFormat.prototype.formatToParts === 'function';
const errorName = fn => {
  try {
    fn();
    return 'accepted';
  } catch (error) {
    return error.name;
  }
};

const checks = [
  ['decimal exact', decimal('0.1').plus('0.2').toString(), '0.3'],
  ['decimal division', decimal(1).dividedBy(3, { scale: 4, rounding: 'halfEven' }).toString(), '0.3333'],
  ['rational', ratio(1, 3).plus(ratio(1, 6)).toString(), '1/2'],
  ['round what you typed', round(1.005, 2), 1.01],
  ['gcd', gcd(12, 18), 6],
  ['mean', mean([1, 2, 3, 4]), 2.5],
  ['stddev', round(stddev([2, 4, 4, 4, 5, 5, 7, 9], { ddof: 0 }), 6), 2],
  // Hermes (React Native) formats number strings through a double: up to 15
  // shown digits still come out exact, more must fail with the typed error.
  [
    'format currency (exact Decimal input)',
    formatCurrency(decimal('1234.5'), 'EUR', { locale: 'de-DE' }),
    '1.234,50\u00A0€',
  ],
  exactStrings
    ? ['format past 2^53', formatNumber('9007199254740993', { useGrouping: false }), '9007199254740993']
    : [
        'format past 2^53 needs exact strings',
        errorName(() => formatNumber('9007199254740993')),
        'UnsupportedFeatureError',
      ],
  ['format percent', formatPercent(0.125), '12.5%'],
  ['format file size', formatFileSize(1536), '1.5 kB'],
  hasFormatToParts
    ? ['parse de-DE', parseNumber('1.234,56', { locale: 'de-DE' }), 1234.56]
    : [
        'parse needs formatToParts',
        errorName(() => parseNumber('1,5', { locale: 'de-DE' })),
        'UnsupportedFeatureError',
      ],
  ['parse with explicit symbols', parseNumber('1.234,56', { symbols: { decimal: ',', group: '.' } }), 1234.56],
  ['seeded random', createRandom(42).int(1, 6), createRandom(42).int(1, 6)],
  ['fluent', num(127.3).clamp(0, 100).roundTo(5).value(), 100],
  ['distributions', round(normal().quantile(0.975), 6), 1.959964],
  ['decimal-math', sqrt(2, { scale: 10 }).toString(), '1.4142135624'],
  ['words', spellOrdinal(21), 'twenty-first'],
  ['words locale subpath', spellNumber(21_000, { locale: ro }), 'douăzeci și una de mii'],
  ['units', convert(100, 'C', 'F'), 212],
  ['finance', payment(200_000, 0.005, 360, { scale: 2, rounding: 'halfEven' }).toString(), '1199.10'],
  ['integer', isPrime(9_007_199_254_740_881), true],
];

const runtime =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
