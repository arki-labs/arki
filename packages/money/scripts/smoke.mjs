// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser target.
// One call per feature, plus one past 2^53; the unit tests cover the details.

import { MoneyBag } from '../dist/bag.js';
import { toRational } from '../dist/exact.js';
import { createConverter, ratesFrom } from '../dist/exchange.js';
import { formatMoney } from '../dist/format.js';
import { Currency, factor, Money, money, sum } from '../dist/index.js';
import { parseMoney } from '../dist/parse.js';
import { RationalMoney } from '../dist/rational.js';
import { toStripeAmount } from '../dist/stripe.js';

const plain = text => text.replaceAll(/[\u00A0\u202F]/g, ' ');
const vat = factor('0.19');
const converter = createConverter(ratesFrom({ base: 'EUR', rates: { USD: '1.0832', GBP: '0.8571' } }), {
  inverse: true,
  via: 'EUR',
});

const checks = [
  ['parse and print', money('19.99', 'EUR').toString(), '19.99 EUR'],
  ['exact add', money('0.10', 'EUR').plus(money('0.20', 'EUR')).toString(), '0.30 EUR'],
  ['times with rounding', money('9.99', 'EUR').times(vat, 'halfEven').toString(), '1.90 EUR'],
  ['allocate', money(100, 'EUR').allocate([1, 1, 1]).map(String).join(','), '33.34 EUR,33.33 EUR,33.33 EUR'],
  ['ISO scale', `${money(1, 'KWD')}`, '1.000 KWD'],
  [
    'unknown code rejected',
    (() => {
      try {
        Currency.of('ZZZ');
        return 'accepted';
      } catch (e) {
        return e.name;
      }
    })(),
    'UnknownCurrencyError',
  ],
  [
    'past 2^53',
    sum([Money.fromMinor(2n ** 60n, 'USD'), money('0.01', 'USD')])
      .toMinorBigInt()
      .toString(),
    String(2n ** 60n + 1n),
  ],
  ['JSON', JSON.stringify(money('1.5', 'EUR')), '{"amount":"1.50","currency":"EUR"}'],
  ['rational bridge', toRational(money('19.90', 'EUR')).toString(), '199/10'],
  ['parse de-DE', parseMoney('1.234,56 €', 'EUR', { locale: 'de-DE' }).toString(), '1234.56 EUR'],
  [
    'parse strict',
    (() => {
      try {
        parseMoney('1,23,4', 'USD');
        return 'accepted';
      } catch (e) {
        return e.name;
      }
    })(),
    'NumberFormatError',
  ],
  [
    'convert via base',
    converter.convert(money('1234.56', 'USD'), 'GBP', { rounding: 'halfEven' }).toString(),
    '976.87 GBP',
  ],
  ['rational thirds', RationalMoney.of(100, 'EUR').dividedBy(3).times(3).toMoney().toString(), '100.00 EUR'],
  [
    'bag rounds once',
    MoneyBag.of(money('1.07', 'USD'), money('1.06', 'GBP'))
      .convert(converter, 'EUR', { rounding: 'halfEven' })
      .toString(),
    '2.22 EUR',
  ],
  ['stripe ISK', toStripeAmount(money(5, 'ISK')), 500],
  ['format de-DE', plain(formatMoney(money('1234.5', 'EUR'), { locale: 'de-DE' })), '1.234,50 €'],
];

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual === expected) continue;
  failed++;
  console.log(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const runtime =
  typeof Deno !== 'undefined'
    ? 'deno'
    : typeof Bun !== 'undefined'
      ? 'bun'
      : typeof window !== 'undefined'
        ? 'browser'
        : 'node';
if (failed > 0) {
  console.log(`${runtime}: ${failed} smoke checks FAILED`);
  throw new Error('smoke failed');
}
console.log(`${runtime}: ${checks.length} smoke checks passed`);
