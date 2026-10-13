// Speed of @arki/money against the money libraries most projects use.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Every `compare` group states a contract and is checked before timing: each
// ranked library must return the same minor units (or text) for every input,
// including the boundary inputs listed. Libraries that keep a different
// promise are marked `differs` and shown without a ratio.

// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- loads the local module declaration for an untyped competitor
/// <reference path="./dinero.d.ts" />

import Big from 'big.js';
import currency from 'currency.js';
import Dinero from 'dinero.js';

import { compare, defineSuite, scenario } from '@arki/bench';
import { factor, Money, money, sum } from '@arki/money';
import { createConverter, ratesFrom } from '@arki/money/exchange';
import { formatMoney } from '@arki/money/format';
import { createMoneyParser } from '@arki/money/parse';
import { toStripeAmount } from '@arki/money/stripe';

const minor = (value: Money<'EUR'>): string => String(value.toMinorUnits());
const minorList = (values: readonly Money<'EUR'>[]): string => values.map(value => minor(value)).join(',');

/** Half-even rounding of cents × 1.0825, in exact integer arithmetic: the oracle. */
function vatHalfEven(cents: number): string {
  const exact = BigInt(cents) * 10_825n;
  const quotient = exact / 10_000n;
  const remainder = exact % 10_000n;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  const away = twice > 10_000n || (twice === 10_000n && quotient % 2n !== 0n);
  return String(away ? quotient + (exact < 0n ? -1n : 1n) : quotient);
}

/** Split into three equal parts; leftover cents go to the earliest parts. */
function splitThree(cents: number): string {
  const base = Math.floor(cents / 3);
  const left = cents - base * 3;
  return [0, 1, 2].map(index => base + (index < left ? 1 : 0)).join(',');
}

type Pair = { left: number; right: number };

export default defineSuite({
  id: '@arki/money',
  intro:
    'Speed of `@arki/money` against dinero.js v1 and currency.js, the money libraries most projects use, with big.js as a plain decimal reference. Each table only ranks libraries that returned the same result on every checked input.',
  notes: [
    '`@arki/money` keeps a currency on every value, refuses to mix currencies, and switches to bigint minor units above 2^53, so it does checks the others skip.',
    'currency.js stores a float and rounds results half-up to 2 decimals; dinero.js v1 stores safe-integer cents; big.js is a decimal with no currency.',
    'For negative amounts, dinero.js gives leftover cents to the last parts; `@arki/money` and currency.js give them to the first. The allocation contract covers non-negative amounts only.',
  ],
  groups: [
    compare<Pair>({
      id: 'add',
      title: 'Add two amounts',
      contract: { id: 'money-add/v1', description: 'the sum in minor units, for safe-integer cents' },
      inputs: [
        { left: 123_456, right: 9876 },
        { left: -500, right: 250 },
        { left: 0, right: 0 },
        { left: 1, right: 2_147_483_647 },
      ],
      expected: ({ left, right }) => String(left + right),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/money',
          package: '@arki/money',
          setup: ({ left, right }) => ({ a: Money.fromMinor(left, 'EUR'), b: Money.fromMinor(right, 'EUR') }),
          run: ({ a, b }) => a.plus(b),
          normalize: minor,
        }),
        dinero: c({
          label: 'dinero.js v1',
          package: 'dinero.js',
          setup: ({ left, right }) => ({
            a: Dinero({ amount: left, currency: 'EUR' }),
            b: Dinero({ amount: right, currency: 'EUR' }),
          }),
          run: ({ a, b }) => a.add(b),
          normalize: result => String(result.getAmount()),
        }),
        currency: c({
          label: 'currency.js',
          package: 'currency.js',
          setup: ({ left, right }) => ({
            a: currency(left, { fromCents: true }),
            b: currency(right, { fromCents: true }),
          }),
          run: ({ a, b }) => a.add(b),
          normalize: result => String(result.intValue),
        }),
        big: c({
          label: 'big.js',
          package: 'big.js',
          setup: ({ left, right }) => ({ a: new Big(left), b: new Big(right) }),
          run: ({ a, b }) => a.plus(b),
          normalize: result => result.toFixed(0),
        }),
      }),
    }),
    compare<number>({
      id: 'multiply-half-even',
      title: 'Multiply by 1.0825 and round half-even',
      contract: {
        id: 'money-vat-half-even/v1',
        description: 'cents × 1.0825 rounded half-even to whole cents (200 → 216, 600 → 650)',
      },
      // 200 and 600 land exactly on half a cent: they separate half-even from half-up.
      inputs: [123_456, 200, 600, -200, 0],
      expected: vatHalfEven,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/money (prepared factor)',
          package: '@arki/money',
          setup: cents => ({ a: Money.fromMinor(cents, 'EUR'), vat: factor('1.0825') }),
          run: ({ a, vat }) => a.times(vat, 'halfEven'),
          normalize: minor,
        }),
        arkiString: c({
          label: '@arki/money (string factor)',
          variant: true,
          setup: cents => Money.fromMinor(cents, 'EUR'),
          run: a => a.times('1.0825', 'halfEven'),
          normalize: minor,
        }),
        dinero: c({
          label: 'dinero.js v1',
          package: 'dinero.js',
          setup: cents => Dinero({ amount: cents, currency: 'EUR' }),
          run: a => a.multiply(1.0825, 'HALF_EVEN'),
          normalize: result => String(result.getAmount()),
        }),
        big: c({
          label: 'big.js',
          package: 'big.js',
          setup: cents => new Big(cents),
          run: a => a.times('1.0825').round(0, Big.roundHalfEven),
          normalize: result => result.toFixed(0),
        }),
        currency: c({
          label: 'currency.js',
          package: 'currency.js',
          differs: 'rounds half-up only (200 → 217)',
          setup: cents => currency(cents, { fromCents: true }),
          run: a => a.multiply(1.0825),
          normalize: result => String(result.intValue),
        }),
      }),
    }),
    compare<number>({
      id: 'allocate',
      title: 'Split an amount into three equal parts',
      contract: {
        id: 'money-split-3/v1',
        description: 'three parts in minor units that add up to the amount, leftover cents to the first parts',
      },
      inputs: [10_000, 123_456, 1, 2, 0],
      expected: splitThree,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/money allocate([1, 1, 1])',
          package: '@arki/money',
          setup: cents => Money.fromMinor(cents, 'EUR'),
          run: a => a.allocate([1, 1, 1]),
          normalize: minorList,
        }),
        arkiSplit: c({
          label: '@arki/money split(3)',
          variant: true,
          setup: cents => Money.fromMinor(cents, 'EUR'),
          run: a => a.split(3),
          normalize: minorList,
        }),
        dinero: c({
          label: 'dinero.js v1 allocate([1, 1, 1])',
          package: 'dinero.js',
          setup: cents => Dinero({ amount: cents, currency: 'EUR' }),
          run: a => a.allocate([1, 1, 1]),
          normalize: parts => parts.map(part => part.getAmount()).join(','),
        }),
        currency: c({
          label: 'currency.js distribute(3)',
          package: 'currency.js',
          setup: cents => currency(cents, { fromCents: true }),
          run: a => a.distribute(3),
          normalize: parts => parts.map(part => part.intValue).join(','),
        }),
      }),
    }),
    compare<Pair>({
      id: 'compare',
      title: 'Compare two amounts',
      contract: { id: 'money-compare/v1', description: '-1, 0 or 1 for less, equal or greater' },
      inputs: [
        { left: 123_456, right: 9876 },
        { left: 9876, right: 123_456 },
        { left: 500, right: 500 },
        { left: -1, right: 0 },
      ],
      expected: ({ left, right }) => Math.sign(left - right),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/money compareTo',
          package: '@arki/money',
          setup: ({ left, right }) => ({ a: Money.fromMinor(left, 'EUR'), b: Money.fromMinor(right, 'EUR') }),
          run: ({ a, b }) => a.compareTo(b),
        }),
        dinero: c({
          label: 'dinero.js v1 lessThan / equalsTo',
          package: 'dinero.js',
          setup: ({ left, right }) => ({
            a: Dinero({ amount: left, currency: 'EUR' }),
            b: Dinero({ amount: right, currency: 'EUR' }),
          }),
          run: ({ a, b }) => (a.lessThan(b) ? -1 : a.equalsTo(b) ? 0 : 1),
        }),
        big: c({
          label: 'big.js cmp',
          package: 'big.js',
          setup: ({ left, right }) => ({ a: new Big(left), b: new Big(right) }),
          run: ({ a, b }) => a.cmp(b),
        }),
      }),
    }),
    compare<string>({
      id: 'parse-decimal',
      title: 'Read a decimal string',
      contract: {
        id: 'money-from-decimal-string/v1',
        description: 'the amount in minor units for a plain decimal string',
      },
      inputs: ['1234.56', '0.01', '-98.76', '1000000.00', '0'],
      expected: text => String(Math.round(Number(text) * 100)),
      baseline: 'arki',
      note: 'dinero.js v1 only accepts minor units, so it has no row here.',
      cases: c => ({
        arki: c({
          label: '@arki/money money()',
          package: '@arki/money',
          run: (text: string) => money(text, 'EUR'),
          normalize: minor,
        }),
        currency: c({
          label: 'currency.js',
          package: 'currency.js',
          run: (text: string) => currency(text),
          normalize: result => String(result.intValue),
        }),
        big: c({
          label: 'big.js',
          package: 'big.js',
          run: (text: string) => new Big(text),
          normalize: result => result.times(100).toFixed(0),
        }),
      }),
    }),
    compare<number>({
      id: 'format',
      title: 'Format as en-US euros',
      contract: { id: 'money-format-en-us-eur/v1', description: 'text like €1,234.56' },
      inputs: [123_456, 5, 0, 100_000_000],
      expected: cents =>
        `€${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/money formatMoney',
          package: '@arki/money',
          setup: cents => Money.fromMinor(cents, 'EUR'),
          run: a => formatMoney(a),
        }),
        dinero: c({
          label: 'dinero.js v1 toFormat',
          package: 'dinero.js',
          setup: cents => Dinero({ amount: cents, currency: 'EUR' }),
          run: a => a.toFormat('$0,0.00'),
        }),
        currency: c({
          label: 'currency.js format (symbol €)',
          package: 'currency.js',
          setup: cents => currency(cents, { fromCents: true, symbol: '€' }),
          run: a => a.format(),
        }),
      }),
    }),
    scenario({
      kind: 'scenario',
      id: 'only-arki',
      title: 'Operations without a direct competitor',
      note: 'Different operations: compare each row with its own history, not with the others.',
      cases: {
        bigAdd: {
          label: 'add above 2^53 (bigint)',
          setup: () => ({ a: Money.fromMinor(2n ** 60n, 'EUR'), b: Money.fromMinor(123_456, 'EUR') }),
          run: ({ a, b }: { a: Money<'EUR'>; b: Money<'EUR'> }) => a.plus(b),
        },
        sum: {
          label: 'sum of 1,000 amounts',
          setup: () => Array.from({ length: 1000 }, (_, index) => Money.fromMinor(index * 7 + 1, 'EUR')),
          run: (prices: Money<'EUR'>[]) => sum(prices),
        },
        convert: {
          label: 'convert EUR → USD, round once',
          setup: () => ({
            converter: createConverter(ratesFrom({ base: 'EUR', rates: { USD: '1.0832', GBP: '0.8571' } }), {
              inverse: true,
              via: 'EUR',
            }),
            amount: money('1234.56', 'EUR'),
          }),
          run: ({ converter, amount }: { converter: ReturnType<typeof createConverter>; amount: Money<'EUR'> }) =>
            converter.convert(amount, 'USD', { rounding: 'halfEven' }),
        },
        parseDe: {
          label: 'parse "1.234,56 €" (de-DE, bound parser)',
          setup: () => createMoneyParser('EUR', { locale: 'de-DE' }),
          run: (parser: ReturnType<typeof createMoneyParser>) => parser.parse('1.234,56 €'),
        },
        stripe: {
          label: 'toStripeAmount',
          setup: () => money('1234.56', 'EUR'),
          run: (amount: Money<'EUR'>) => toStripeAmount(amount),
        },
      },
    }),
  ],
});
