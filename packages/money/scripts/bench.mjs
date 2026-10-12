// Micro-benchmarks against the common JS money libraries. Run after a build:
//   bun run bench   |   node scripts/bench.mjs   |   bun scripts/bench.mjs
// Each case reports the median of five 100 ms samples in ns/op, with results
// kept in a sink so engines cannot drop the work. Numbers compare libraries on
// one machine; they are not cross-machine.
//
// Contracts differ, so read rows with care: currency.js stores a float and
// rounds every result to 2 decimals; dinero.js v1 stores safe-integer cents
// and rounds multiplication by default; big.js is a decimal, not money.

import Big from 'big.js';
import currency from 'currency.js';
import Dinero from 'dinero.js';

import { formatMoney } from '../dist/format.js';
import * as m from '../dist/index.js';

const a = m.money('1234.56', 'EUR');
const b = m.money('98.76', 'EUR');
const vat = m.factor('1.0825');
const huge = m.Money.fromMinor(2n ** 60n, 'EUR');
const prices = Array.from({ length: 1000 }, (_, i) => m.Money.fromMinor(i * 7 + 1, 'EUR'));

const da = Dinero({ amount: 123_456, currency: 'EUR' });
const db = Dinero({ amount: 9876, currency: 'EUR' });
const ca = currency('1234.56');
const cb = currency('98.76');
const ba = new Big('1234.56');
const bb = new Big('98.76');

const groups = [
  [
    'add',
    [
      ['@arki/money', () => a.plus(b)],
      ['@arki/money (bigint, > 2^53)', () => huge.plus(a)],
      ['dinero.js v1', () => da.add(db)],
      ['currency.js', () => ca.add(cb)],
      ['big.js', () => ba.plus(bb)],
    ],
  ],
  [
    'multiply by 1.0825 and round half-even',
    [
      ['@arki/money (prepared factor)', () => a.times(vat, 'halfEven')],
      ['@arki/money (string factor)', () => a.times('1.0825', 'halfEven')],
      ['dinero.js v1', () => da.multiply(1.0825, 'HALF_EVEN')],
      ['currency.js (half-up only)', () => ca.multiply(1.0825)],
      ['big.js', () => ba.times('1.0825').round(2, Big.roundHalfEven)],
    ],
  ],
  [
    'allocate 100 into [1, 1, 1]',
    [
      ['@arki/money', () => a.allocate([1, 1, 1])],
      ['@arki/money split(3)', () => a.split(3)],
      ['dinero.js v1', () => da.allocate([1, 1, 1])],
      ['currency.js distribute(3)', () => ca.distribute(3)],
    ],
  ],
  [
    'compare',
    [
      ['@arki/money', () => a.compareTo(b)],
      ['dinero.js v1 (lessThan)', () => da.lessThan(db)],
      ['big.js', () => ba.cmp(bb)],
    ],
  ],
  [
    'construct from a string',
    [
      ['@arki/money', () => m.money('1234.56', 'EUR')],
      ['@arki/money fromMinor', () => m.Money.fromMinor(123_456, 'EUR')],
      ['dinero.js v1 (minor units only)', () => Dinero({ amount: 123_456, currency: 'EUR' })],
      ['currency.js', () => currency('1234.56')],
    ],
  ],
  [
    'sum of 1000',
    [
      ['@arki/money sum()', () => m.sum(prices)],
      ['@arki/money reduce(plus)', () => prices.reduce((acc, p) => acc.plus(p))],
    ],
  ],
  [
    'format en-US',
    [
      ['@arki/money', () => formatMoney(a)],
      ['dinero.js v1', () => da.toFormat('$0,0.00')],
      ['currency.js', () => ca.format()],
    ],
  ],
];

let sink = 0;
function measure(fn) {
  for (let i = 0; i < 20_000; i++) sink ^= fn() === undefined ? 1 : 0;
  const samples = [];
  for (let s = 0; s < 5; s++) {
    let ops = 0;
    const start = performance.now();
    let now = start;
    while (now - start < 100) {
      for (let i = 0; i < 1000; i++) sink ^= fn() === undefined ? 1 : 0;
      ops += 1000;
      now = performance.now();
    }
    samples.push(((now - start) * 1e6) / ops);
  }
  return samples.toSorted((x, y) => x - y)[2];
}

const runtime =
  typeof Deno !== 'undefined' ? 'deno' : typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
console.log(`# @arki/money benchmark — ${runtime} — ns/op, lower is better\n`);
for (const [group, cases] of groups) {
  console.log(group);
  for (const [name, fn] of cases) {
    console.log(`  ${name.padEnd(38)} ${measure(fn).toFixed(1).padStart(9)}`);
  }
}
if (sink === -1) console.log(sink);
