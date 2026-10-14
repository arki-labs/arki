import { Decimal as DecimalJs } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { Decimal, decimal, isDecimal } from './decimal.js';
import {
  DivisionByZeroError,
  InvalidArgumentError,
  NumberFormatError,
  NumericRangeError,
  ResourceLimitError,
  RoundingNecessaryError,
} from './errors.js';
import { ROUNDING_MODES } from './rounding.js';

// Node's `util.inspect` and Deno's console both look this symbol up on the object.
function inspectWith(value: object, hook: symbol): unknown {
  return Reflect.apply(Reflect.get(value, hook) as () => string, value, []);
}

describe('decimal() construction', () => {
  it('reads numbers through their shortest spelling', () => {
    expect(decimal(0.1).toString()).toBe('0.1');
    expect(decimal(1.005).toString()).toBe('1.005');
    expect(decimal(-0).toString()).toBe('0');
    expect(decimal(1e-7).toString()).toBe('0.0000001');
    expect(decimal(42).toString()).toBe('42');
  });
  it('prints every digit on both sides of the safe-integer range', () => {
    // toString prints coefficients up to 2^53 - 1 through Number and larger ones as bigints;
    // the text must not change at the switch (nor round, nor turn into exponent form).
    for (const text of [
      '9007199254740991',
      '-9007199254740991',
      '9007199254740992',
      '-9007199254740993',
      '900719925474099.1',
      '-0.0000009007199254740993',
      '12345678901234567890123.45',
      '0.000000000000000000001',
    ]) {
      expect(decimal(text).toString()).toBe(text);
    }
  });
  it('accepts bigint and Decimal', () => {
    expect(decimal(12n).toString()).toBe('12');
    const d = decimal('1.5');
    expect(decimal(d)).toBe(d);
    expect(Decimal.from('2').toString()).toBe('2');
  });
  it('rejects non-finite and unsafe-integer numbers', () => {
    expect(() => decimal(Number.NaN)).toThrow(NumericRangeError);
    expect(() => decimal(Number.POSITIVE_INFINITY)).toThrow(NumericRangeError);
    expect(() => decimal(2 ** 53 + 2)).toThrow(NumericRangeError);
  });
  it.each([' 1', '1 ', '1,5', '0x10', 'Infinity', 'NaN', '', '.', '+', '-', '1e', '1.2.3', '１'])(
    'rejects malformed string %j',
    text => {
      expect(() => decimal(text)).toThrow(NumberFormatError);
    },
  );
  it.each([
    ['1e3', '1000'],
    ['1E3', '1000'],
    ['-.5', '-0.5'],
    ['5.', '5'],
    ['+2', '2'],
    ['1.5e-2', '0.015'],
    ['12e-1', '1.2'],
    ['0001.50', '1.50'],
    ['-0', '0'],
  ])('parses %j as %j', (text, expected) => {
    expect(decimal(text).toString()).toBe(expected);
  });
  it('enforces resource limits', () => {
    expect(() => decimal('1'.repeat(10_001))).toThrow(ResourceLimitError);
    expect(() => decimal('1e10001')).toThrow(ResourceLimitError);
    expect(() => decimal('1e-10001')).toThrow(ResourceLimitError);
    expect(decimal('1'.repeat(10_000)).toString()).toHaveLength(10_000);
  });
  it('is not frozen and is recognized by isDecimal', () => {
    // Results are deliberately not frozen. `Object.freeze` on every result made an
    // inlined `times` loop 5–7× slower (Bun 25.9 → 3.7 ns, Node 40.7 → 7.3 ns,
    // measured 2026-10-14), and no peer (decimal.js, big.js, bignumber.js,
    // fraction.js, complex.js) freezes. The guarantee is that no method modifies its
    // operands; the shared constants that arithmetic returns are frozen instead.
    expect(Object.isFrozen(decimal(1))).toBe(false);
    expect(Object.isFrozen(decimal('1.5').times(2))).toBe(false);
    expect(isDecimal(decimal(1))).toBe(true);
    expect(isDecimal('1')).toBe(false);
    expect(isDecimal({ coefficient: 1n, scale: 0 })).toBe(false);
  });
});

describe('scale retention', () => {
  it('keeps trailing zeros through arithmetic', () => {
    expect(decimal('1.10').toString()).toBe('1.10');
    expect(decimal('1.10').times(3).toString()).toBe('3.30');
    expect(decimal('1.1').times('1.1').toString()).toBe('1.21');
    expect(decimal(1).plus('0.005').toString()).toBe('1.005');
    expect(decimal('1.10').plus('0.005').toString()).toBe('1.105');
    expect(decimal('1.10').minus('0.10').toString()).toBe('1.00');
  });
  it('builds a 0 integer part for small values', () => {
    expect(decimal('0.000001').toString()).toBe('0.000001');
    expect(decimal('-0.05').toString()).toBe('-0.05');
  });
});

describe('dividedBy', () => {
  it('is exact when the result terminates', () => {
    expect(decimal(1).dividedBy(8).toString()).toBe('0.125');
    expect(decimal('10.00').dividedBy(4).toString()).toBe('2.5');
    expect(decimal(-1).dividedBy(8).toString()).toBe('-0.125');
    expect(decimal(1).dividedBy(-8).toString()).toBe('-0.125');
  });
  it('throws when it does not terminate', () => {
    expect(() => decimal(1).dividedBy(3)).toThrow(RoundingNecessaryError);
  });
  it('rounds with scale and rounding', () => {
    expect(decimal(1).dividedBy(3, { scale: 4, rounding: 'halfEven' }).toString()).toBe('0.3333');
    expect(decimal(2).dividedBy(3, { scale: 4, rounding: 'halfUp' }).toString()).toBe('0.6667');
    expect(decimal(2).dividedBy(3, { scale: 4, rounding: 'down' }).toString()).toBe('0.6666');
  });
  it('treats scale alone as rounding "unnecessary"', () => {
    expect(() => decimal(1).dividedBy(3, { scale: 4 })).toThrow(RoundingNecessaryError);
    expect(() => decimal(1).dividedBy(8, { scale: 2 })).toThrow(RoundingNecessaryError);
    expect(decimal(1).dividedBy(4, { scale: 3 }).toString()).toBe('0.250');
    expect(decimal(1).dividedBy(8, { scale: 3 }).toString()).toBe('0.125');
  });
  it('rejects bad scales', () => {
    expect(() => decimal(1).dividedBy(4, { scale: -1 })).toThrow(InvalidArgumentError);
    expect(() => decimal(1).dividedBy(4, { scale: 1.5 })).toThrow(InvalidArgumentError);
  });
  it('throws on division by zero', () => {
    expect(() => decimal(1).dividedBy(0)).toThrow(DivisionByZeroError);
    expect(() => decimal(1).dividedBy('0.00', { scale: 2, rounding: 'halfUp' })).toThrow(DivisionByZeroError);
  });
});

describe('rounding modes', () => {
  const inputs = ['2.5', '3.5', '-2.5', '-3.5', '2.4', '2.6', '-2.6'];
  // Expected result at scale 0 for each input above, then 1.005 at scale 2.
  const table = {
    up: ['3', '4', '-3', '-4', '3', '3', '-3', '1.01'],
    down: ['2', '3', '-2', '-3', '2', '2', '-2', '1.00'],
    ceiling: ['3', '4', '-2', '-3', '3', '3', '-2', '1.01'],
    floor: ['2', '3', '-3', '-4', '2', '2', '-3', '1.00'],
    halfUp: ['3', '4', '-3', '-4', '2', '3', '-3', '1.01'],
    halfDown: ['2', '3', '-2', '-3', '2', '3', '-3', '1.00'],
    halfEven: ['2', '4', '-2', '-4', '2', '3', '-3', '1.00'],
  } as const;

  it.each(Object.entries(table))('%s', (mode, expected) => {
    if (!ROUNDING_MODES.includes(mode as (typeof ROUNDING_MODES)[number])) throw new Error('bad table');
    const rounding = ROUNDING_MODES.find(m => m === mode);
    if (rounding === undefined) throw new Error('bad table');
    for (const [i, text] of inputs.entries()) {
      expect(decimal(text).toScale(0, rounding).toString()).toBe(expected[i]);
    }
    expect(decimal('1.005').toScale(2, rounding).toString()).toBe(expected[7]);
  });

  it('unnecessary throws when digits would be lost, passes otherwise', () => {
    expect(() => decimal('2.5').toScale(0, 'unnecessary')).toThrow(RoundingNecessaryError);
    expect(() => decimal('2.5').toScale(0)).toThrow(RoundingNecessaryError);
    expect(decimal('2.50').toScale(1).toString()).toBe('2.5');
    expect(decimal('2.00').toScale(0, 'unnecessary').toString()).toBe('2');
  });
  it('never yields a negative zero string', () => {
    expect(decimal('-0.4').toScale(0, 'halfUp').toString()).toBe('0');
    expect(decimal('-0.4').toScale(0, 'ceiling').toString()).toBe('0');
  });
  it('round() defaults to halfUp', () => {
    expect(decimal('1.005').round(2).toString()).toBe('1.01');
    expect(decimal('2.5').round().toString()).toBe('3');
    expect(decimal('2.5').round(0, 'halfEven').toString()).toBe('2');
  });
  it('toFixed returns a string', () => {
    expect(decimal('3.14159').toFixed(2)).toBe('3.14');
    expect(decimal('3.145').toFixed(2)).toBe('3.15');
    expect(decimal('3.145').toFixed(2, 'halfEven')).toBe('3.14');
    expect(decimal(3).toFixed(2)).toBe('3.00');
  });
  it('trim strips zeros but never the integer part', () => {
    expect(decimal('100').trim().toString()).toBe('100');
    expect(decimal('1.500').trim().toString()).toBe('1.5');
    expect(decimal('2.00').trim().toString()).toBe('2');
    expect(decimal('0.00').trim().toString()).toBe('0');
    expect(decimal('1.5').trim().toString()).toBe('1.5');
  });
  it('toScale to a larger scale pads', () => {
    expect(decimal('1.5').toScale(4).toString()).toBe('1.5000');
    expect(decimal(7).toScale(2).toString()).toBe('7.00');
  });
  it('rejects bad scale', () => {
    expect(() => decimal(1).toScale(-1)).toThrow(InvalidArgumentError);
    expect(() => decimal(1).toScale(20_000)).toThrow(ResourceLimitError);
  });
});

describe('pow and mod', () => {
  it('raises to integer powers', () => {
    expect(decimal('1.1').pow(2).toString()).toBe('1.21');
    expect(decimal('1.5').pow(0).toString()).toBe('1');
    expect(decimal(2).pow(10).toString()).toBe('1024');
    expect(decimal(2).pow(-2).toString()).toBe('0.25');
    expect(decimal('-2').pow(3).toString()).toBe('-8');
  });
  it('throws for non-terminating negative powers and zero', () => {
    expect(() => decimal(3).pow(-1)).toThrow(RoundingNecessaryError);
    expect(() => decimal(0).pow(-1)).toThrow(DivisionByZeroError);
  });
  it('rejects non-integer exponents', () => {
    expect(() => decimal(2).pow(1.5)).toThrow(InvalidArgumentError);
    expect(() => decimal(2).pow(Number.NaN)).toThrow(InvalidArgumentError);
  });
  it('guards against huge results', () => {
    expect(() => decimal(10).pow(20_000)).toThrow(ResourceLimitError);
  });
  it('mod follows the dividend sign', () => {
    expect(decimal('-7.5').mod(2).toString()).toBe('-1.5');
    expect(decimal('7.5').mod(-2).toString()).toBe('1.5');
    expect(decimal(7).mod(2).toString()).toBe('1');
    expect(() => decimal(1).mod(0)).toThrow(DivisionByZeroError);
  });
});

describe('comparison and predicates', () => {
  it('compares numerically', () => {
    expect(decimal('1.0').eq('1.00')).toBe(true);
    expect(decimal('1.0').compareTo('1.00')).toBe(0);
    expect(decimal(1).compareTo(2)).toBe(-1);
    expect(decimal(3).compareTo('2.999')).toBe(1);
    expect(decimal(1).lt(2)).toBe(true);
    expect(decimal(2).lt(2)).toBe(false);
    expect(decimal(2).lte(2)).toBe(true);
    expect(decimal(2).gt(1)).toBe(true);
    expect(decimal(2).gt(2)).toBe(false);
    expect(decimal(2).gte(2)).toBe(true);
    expect(decimal('-1').lt('-0.5')).toBe(true);
  });
  it('sum / min / max', () => {
    expect(Decimal.sum(['0.1', '0.2', 0.3]).toString()).toBe('0.6');
    expect(Decimal.sum([]).toString()).toBe('0');
    expect(Decimal.max(1, '3.5', 2).toString()).toBe('3.5');
    expect(Decimal.min(1, '-3.5', 2).toString()).toBe('-3.5');
    expect(Decimal.min('5').toString()).toBe('5');
  });
  it('predicates', () => {
    expect(decimal('0.00').isZero()).toBe(true);
    expect(decimal('0.01').isZero()).toBe(false);
    expect(decimal('0.01').isPositive()).toBe(true);
    expect(decimal('-0.01').isNegative()).toBe(true);
    expect(decimal('2.0').isInteger()).toBe(true);
    expect(decimal('2.5').isInteger()).toBe(false);
    expect(decimal(5).isInteger()).toBe(true);
    expect(decimal('-3').sign()).toBe(-1);
    expect(decimal('0').sign()).toBe(0);
    expect(decimal('3').sign()).toBe(1);
  });
  it('abs / negated', () => {
    expect(decimal('-1.50').abs().toString()).toBe('1.50');
    expect(decimal('1.50').abs().toString()).toBe('1.50');
    expect(decimal('1.50').negated().toString()).toBe('-1.50');
    expect(decimal('0').negated().toString()).toBe('0');
  });
});

describe('conversion', () => {
  it('toNumber', () => {
    expect(decimal('0.1').toNumber()).toBe(0.1);
    expect(Object.is(decimal('0.00').toNumber(), 0)).toBe(true);
    expect(() => decimal('1e400').toNumber()).toThrow(NumericRangeError);
    expect(() => decimal('1e-400').toNumber()).toThrow(NumericRangeError);
  });
  it('toBigInt requires an integral value', () => {
    expect(decimal('2.0').toBigInt()).toBe(2n);
    expect(decimal('-2.00').toBigInt()).toBe(-2n);
    expect(decimal(5).toBigInt()).toBe(5n);
    expect(() => decimal('2.5').toBigInt()).toThrow(RoundingNecessaryError);
  });
  it('toRational', () => {
    const r = decimal('0.75').toRational();
    expect(r.numerator).toBe(3n);
    expect(r.denominator).toBe(4n);
    expect(decimal('2.50').toRational().toString()).toBe('5/2');
  });
  it('serializes as a string', () => {
    expect(decimal('1.50').toJSON()).toBe('1.50');
    expect(JSON.stringify({ a: decimal('1.5') })).toBe('{"a":"1.5"}');
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- toPrimitive('string') is the point
    expect(`${decimal('1.5')}`).toBe('1.5');
    expect(String(decimal('-1.5'))).toBe('-1.5');
    expect(Object.prototype.toString.call(decimal(1))).toBe('[object Decimal]');
  });
  it('refuses arithmetic coercion', () => {
    // @ts-expect-error a Decimal is not a number
    expect(() => decimal('1') + 1).toThrow(TypeError); // eslint-disable-line @typescript-eslint/restrict-plus-operands
    expect(() => +decimal('1')).toThrow(TypeError);
    // @ts-expect-error a Decimal is not comparable with <
    expect(() => decimal('1') < 2).toThrow(TypeError);
    expect(() => decimal('1').valueOf()).toThrow(TypeError);
  });
  // `new Decimal(...)` is rejected by the type system (private constructor); not tested at runtime.
});

describe('differential vs decimal.js', () => {
  DecimalJs.set({ precision: 200, toExpNeg: -1000, toExpPos: 1000 });

  let state = 123_456_789;
  const next = (bound: number): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % bound;
  };
  const digits = (count: number): string => {
    let out = '';
    for (let i = 0; i < count; i++) out += String(next(10));
    return out;
  };
  const randomDecimal = (): string => {
    const sign = next(2) === 0 ? '-' : '';
    const intPart = digits(1 + next(25)).replace(/^0+(?=\d)/, '');
    const fractionLength = next(13);
    return fractionLength === 0 ? `${sign}${intPart}` : `${sign}${intPart}.${digits(fractionLength)}`;
  };
  const normalize = (text: string): string => text.replace(/^-(0(?:\.0+)?)$/, '$1');

  const pairs = Array.from({ length: 300 }, () => [randomDecimal(), randomDecimal()] as const);

  it('plus / minus / times match', () => {
    for (const [a, b] of pairs) {
      const ops = [
        [decimal(a).plus(b), new DecimalJs(a).plus(b)],
        [decimal(a).minus(b), new DecimalJs(a).minus(b)],
        [decimal(a).times(b), new DecimalJs(a).times(b)],
      ] as const;
      for (const [ours, theirs] of ops) {
        expect(ours.toString(), `${a} ? ${b}`).toBe(normalize(theirs.toFixed(ours.scale)));
      }
    }
  });

  it('dividedBy matches for halfEven and halfUp', () => {
    for (const [a, b] of pairs) {
      if (new DecimalJs(b).isZero()) continue;
      const even = decimal(a).dividedBy(b, { scale: 10, rounding: 'halfEven' }).toString();
      expect(even, `${a} / ${b}`).toBe(normalize(new DecimalJs(a).div(b).toFixed(10, DecimalJs.ROUND_HALF_EVEN)));
      const up = decimal(a).dividedBy(b, { scale: 10, rounding: 'halfUp' }).toString();
      expect(up, `${a} / ${b}`).toBe(normalize(new DecimalJs(a).div(b).toFixed(10, DecimalJs.ROUND_HALF_UP)));
    }
  });
});

describe('string parsing matches the documented syntax', () => {
  // The grammar the hand-written scanner implements: [sign] digits [. digits] [e|E [sign] digits].
  const SYNTAX = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;

  /** Reference parse straight from the grammar, with BigInt on the digit text. */
  function reference(text: string): { coefficient: bigint; scale: number } | undefined {
    const match = SYNTAX.exec(text);
    const digits = (match?.[2] ?? '') + (match?.[3] ?? '');
    if (!match || digits === '') return undefined;
    const exponent = Number(match[4] ?? 0);
    let coefficient = BigInt(digits);
    if (match[1] === '-') coefficient = -coefficient;
    let scale = (match[3] ?? '').length - exponent;
    if (scale < 0) {
      coefficient *= 10n ** BigInt(-scale);
      scale = 0;
    }
    return { coefficient, scale };
  }

  const inputs = [
    '0',
    '-0',
    '+0',
    '007.50',
    '1.',
    '.5',
    '-.5',
    '+1.25',
    '123456789012345',
    '1234567890123456',
    '999999999999999.9',
    '-98765.4321',
    '0.000000000000000000001',
    '123456789012345678901234567890.123456789',
    '1e3',
    '1E3',
    '1.5e-3',
    '-2.5E+2',
    '1e0',
    '1e-0',
    '0.0e5',
    '12.34e1',
    '',
    '-',
    '+',
    '.',
    'e5',
    '.e5',
    '1e',
    '1e+',
    '1.2.3',
    '1,5',
    ' 1',
    '1 ',
    'abc',
    '0x10',
    'Infinity',
    'NaN',
    '1e5.5',
    '--1',
  ];

  it.each(inputs)('%j', text => {
    const expected = reference(text);
    if (expected === undefined) {
      expect(() => decimal(text)).toThrow(NumberFormatError);
      return;
    }
    const value = decimal(text);
    expect({ coefficient: value.coefficient, scale: value.scale }).toEqual(expected);
  });
});

describe('immutability without freezing', () => {
  it('leaves the receiver and the operand unchanged after success and failure, frozen or not', () => {
    for (const freeze of [false, true]) {
      const a = decimal('12.50');
      const b = decimal('-0.3');
      if (freeze) {
        Object.freeze(a);
        Object.freeze(b);
      }
      expect(a.plus(b).toString()).toBe('12.20');
      expect(a.minus(b).toString()).toBe('12.80');
      expect(a.times(b).toString()).toBe('-3.750');
      expect(a.dividedBy(b, { scale: 2, rounding: 'halfEven' }).toString()).toBe('-41.67');
      expect(a.mod(b).toString()).toBe('0.20');
      expect(a.pow(-2).toString()).toBe('0.0064');
      expect(() => a.dividedBy(b)).toThrow(RoundingNecessaryError);
      expect(() => a.dividedBy(0)).toThrow(DivisionByZeroError);
      expect(() => a.mod(0)).toThrow(DivisionByZeroError);
      expect([a.coefficient, a.scale, b.coefficient, b.scale]).toEqual([1250n, 2, -3n, 1]);
    }
  });

  it('freezes the shared one that pow(0) returns, so no caller can corrupt later results', () => {
    // pow(0) returns a module-wide ONE, and pow(-n) divides by that same ONE.
    // If a caller could write to it, `decimal(4).pow(-1)` would come out wrong.
    const one = decimal(2).pow(0);
    expect(Object.isFrozen(one)).toBe(true);
    expect(() => Object.assign(one, { coefficient: 7n })).toThrow(TypeError);
    expect(decimal(4).pow(-1).toString()).toBe('0.25');
    expect(decimal(9).pow(0).toString()).toBe('1');
  });

  it('keeps its JSON text, console display and plain-data shape', () => {
    const d = decimal('-1.50');
    expect(JSON.stringify({ d })).toBe('{"d":"-1.50"}');
    expect(decimal(d.toJSON()).toString()).toBe('-1.50');
    expect(inspectWith(d, Symbol.for('nodejs.util.inspect.custom'))).toBe('Decimal(-1.50)');
    expect(Object.keys(d)).toEqual(['coefficient', 'scale']);
    expect(Object.fromEntries(Object.entries(d))).toEqual({ coefficient: -150n, scale: 2 });
  });
});
