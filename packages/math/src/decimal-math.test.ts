import { Decimal as DecimalJs } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { cbrt, E, exp, ln, log, log2, log10, nthRoot, PI, pow, sqrt } from './decimal-math.js';
import { DivisionByZeroError, InvalidArgumentError, ResourceLimitError, RoundingNecessaryError } from './errors.js';

describe('known constants to 50 fraction digits', () => {
  // These are the correctly rounded (half-even) 50-digit values, so a result
  // that is merely "close" fails on the last digit.
  const s50 = { scale: 50 };

  it('roots', () => {
    expect(sqrt(2, s50).toString()).toBe('1.41421356237309504880168872420969807856967187537695');
    expect(cbrt(2, s50).toString()).toBe('1.25992104989487316476721060727822835057025146470151');
  });

  it('π and e', () => {
    expect(PI(50).toString()).toBe('3.14159265358979323846264338327950288419716939937511');
    expect(E(50).toString()).toBe('2.71828182845904523536028747135266249775724709369996');
    expect(exp(1, s50).toString()).toBe(E(50).toString());
  });

  it('logarithms', () => {
    expect(ln(2, s50).toString()).toBe('0.69314718055994530941723212145817656807550013436026');
    expect(ln(10, s50).toString()).toBe('2.30258509299404568401799145468436420760110148862877');
    expect(log10(2, s50).toString()).toBe('0.30102999566398119521373889472449302676818988146211');
  });
});

describe('exact results', () => {
  it('roots of perfect powers are exact, at half (or 1/n) the scale', () => {
    expect(sqrt(16).toString()).toBe('4');
    expect(sqrt('2.25').toString()).toBe('1.5');
    expect(sqrt('0.0001').toString()).toBe('0.01');
    // 1.00 has scale 2, so its exact root has scale 1: coefficient 100 → 10.
    expect(sqrt('1.00').toString()).toBe('1.0');
    // Odd scale pads one zero first: 0.250 = 0.2500 → 0.50.
    expect(sqrt('0.250').toString()).toBe('0.50');
    expect(cbrt('-27').toString()).toBe('-3');
    expect(cbrt('0.008').toString()).toBe('0.2');
    expect(nthRoot('1024', 10).toString()).toBe('2');
    expect(sqrt(0).toString()).toBe('0');
  });

  it('roots that do not terminate throw without options', () => {
    expect(() => sqrt(2)).toThrow(RoundingNecessaryError);
    expect(() => sqrt('0.4')).toThrow(RoundingNecessaryError);
    expect(() => cbrt(9)).toThrow(RoundingNecessaryError);
  });

  it('pow', () => {
    expect(pow(2, 10).toString()).toBe('1024');
    expect(pow('1.5', 2).toString()).toBe('2.25');
    expect(pow(4, '0.5', { scale: 10 }).toString()).toBe('2.0000000000');
    expect(pow('2.25', '1.5', { scale: 3, rounding: 'unnecessary' }).toString()).toBe('3.375');
    expect(pow(4, '-0.5', { scale: 2 }).toString()).toBe('0.50');
    expect(pow(2, '0.5', { scale: 20 }).toString()).toBe(sqrt(2, { scale: 20 }).toString());
    expect(pow(0, 0).toString()).toBe('1');
    expect(pow(0, 2.5, { scale: 5 }).toString()).toBe('0.00000');
    expect(pow(3, -1, { scale: 3 }).toString()).toBe('0.333');
  });

  it('exp, ln and log at their exact points', () => {
    expect(exp(0, { scale: 10 }).toString()).toBe('1.0000000000');
    expect(ln(1, { scale: 10 }).toString()).toBe('0.0000000000');
    expect(log(8, 2, { scale: 10 }).toString()).toBe('3.0000000000');
    expect(log(8, 4, { scale: 1, rounding: 'unnecessary' }).toString()).toBe('1.5');
    expect(log('0.125', 2, { scale: 0, rounding: 'unnecessary' }).toString()).toBe('-3');
    expect(log10(1000, { scale: 5 }).toString()).toBe('3.00000');
    expect(log10('0.001', { scale: 2 }).toString()).toBe('-3.00');
    expect(log2(1024, { scale: 5 }).toString()).toBe('10.00000');
  });

  it('an exact result that sits on a tie rounds by the mode, not by approximation noise', () => {
    // log_4(8) = 1.5 exactly: half-even goes to 2, half-down to 1.
    expect(log(8, 4, { scale: 0 }).toString()).toBe('2');
    expect(log(8, 4, { scale: 0, rounding: 'halfDown' }).toString()).toBe('1');
    // 2.25^0.5 = 1.5 exactly.
    expect(pow('2.25', '0.5', { scale: 0, rounding: 'halfDown' }).toString()).toBe('1');
  });
});

describe('rounding modes', () => {
  it('roots', () => {
    expect(sqrt(2, { scale: 3, rounding: 'floor' }).toString()).toBe('1.414');
    expect(sqrt(2, { scale: 3, rounding: 'ceiling' }).toString()).toBe('1.415');
    expect(sqrt(2, { scale: 3 }).toString()).toBe('1.414');
    expect(cbrt(-2, { scale: 3, rounding: 'floor' }).toString()).toBe('-1.260');
    expect(cbrt(-2, { scale: 3, rounding: 'ceiling' }).toString()).toBe('-1.259');
    expect(sqrt(4, { scale: 2, rounding: 'unnecessary' }).toString()).toBe('2.00');
  });

  it('exp', () => {
    expect(exp(1, { scale: 2, rounding: 'up' }).toString()).toBe('2.72');
    expect(exp(1, { scale: 2, rounding: 'down' }).toString()).toBe('2.71');
    expect(exp(-1, { scale: 2, rounding: 'floor' }).toString()).toBe('0.36');
    expect(exp(-1, { scale: 2, rounding: 'ceiling' }).toString()).toBe('0.37');
  });

  it('very negative exponents round to zero or one unit', () => {
    expect(exp(-1000, { scale: 10 }).toString()).toBe('0.0000000000');
    expect(exp(-1000, { scale: 10, rounding: 'up' }).toString()).toBe('0.0000000001');
    expect(() => exp(-1000, { scale: 10, rounding: 'unnecessary' })).toThrow(RoundingNecessaryError);
  });

  it("'unnecessary' throws on an inexact result", () => {
    expect(() => sqrt(2, { scale: 10, rounding: 'unnecessary' })).toThrow(RoundingNecessaryError);
    expect(() => exp(1, { scale: 10, rounding: 'unnecessary' })).toThrow(RoundingNecessaryError);
    expect(() => ln(2, { scale: 10, rounding: 'unnecessary' })).toThrow(RoundingNecessaryError);
    expect(() => log(3, 2, { scale: 10, rounding: 'unnecessary' })).toThrow(RoundingNecessaryError);
    expect(() => log(8, 4, { scale: 0, rounding: 'unnecessary' })).toThrow(RoundingNecessaryError);
    expect(() => pow(2, '0.5', { scale: 10, rounding: 'unnecessary' })).toThrow(RoundingNecessaryError);
  });
});

describe('differential vs decimal.js', () => {
  // 80 significant digits is correctly rounded far past 25 fraction digits
  // for every magnitude used here (results stay below 1e19).
  DecimalJs.set({ precision: 80, toExpNeg: -1000, toExpPos: 1000 });
  const fixed = (value: DecimalJs): string => value.toFixed(25, DecimalJs.ROUND_HALF_EVEN);
  const s25 = { scale: 25 };

  let state = 987_654_321;
  const next = (bound: number): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % bound;
  };
  const digits = (count: number): string => {
    let out = '';
    for (let i = 0; i < count; i++) out += String(next(10));
    return out;
  };
  /** Positive, from about 1e-6 to 1e6, with up to 10 fraction digits. */
  const positive = (): string => {
    const length = 1 + next(16);
    const coefficient = String(1 + next(9)) + digits(length - 1);
    const minScale = Math.max(0, length - 6);
    const scale = minScale + next(Math.min(10, length + 5) - minScale + 1);
    if (scale === 0) return coefficient;
    const padded = coefficient.padStart(scale + 1, '0');
    return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
  };
  /** |x| ≤ 30 with up to 10 fraction digits. */
  const smallSigned = (): string => `${next(2) === 0 ? '-' : ''}${next(30)}.${digits(next(11))}`.replace(/\.$/, '');
  /** Non-integer in (−3, 3). */
  const fractionalExponent = (): string => `${next(2) === 0 ? '-' : ''}${next(3)}.${digits(next(10))}${1 + next(9)}`;

  const cases = Array.from({ length: 150 }, () => ({
    x: positive(),
    t: smallSigned(),
    y: fractionalExponent(),
  }));

  it('sqrt and cbrt', () => {
    for (const { x } of cases) {
      expect(sqrt(x, s25).toString(), `sqrt(${x})`).toBe(fixed(new DecimalJs(x).sqrt()));
      expect(cbrt(x, s25).toString(), `cbrt(${x})`).toBe(fixed(new DecimalJs(x).cbrt()));
      expect(cbrt(`-${x}`, s25).toString(), `cbrt(-${x})`).toBe(fixed(new DecimalJs(x).neg().cbrt()));
    }
  });

  it('exp', () => {
    for (const { t } of cases) {
      expect(exp(t, s25).toString(), `exp(${t})`).toBe(fixed(new DecimalJs(t).exp()));
    }
  });

  it('ln and log10', () => {
    for (const { x } of cases) {
      expect(ln(x, s25).toString(), `ln(${x})`).toBe(fixed(new DecimalJs(x).ln()));
      expect(log10(x, s25).toString(), `log10(${x})`).toBe(fixed(new DecimalJs(x).log(10)));
    }
  });

  it('pow with a non-integer exponent', () => {
    for (const { x, y } of cases) {
      expect(pow(x, y, s25).toString(), `pow(${x}, ${y})`).toBe(fixed(new DecimalJs(x).pow(y)));
    }
  });
});

describe('errors', () => {
  it('rejects arguments outside the domain', () => {
    expect(() => sqrt(-4)).toThrow(InvalidArgumentError);
    expect(() => sqrt(-4, { scale: 2 })).toThrow(InvalidArgumentError);
    expect(() => nthRoot(-16, 4)).toThrow(InvalidArgumentError);
    expect(() => ln(0, { scale: 5 })).toThrow(InvalidArgumentError);
    expect(() => ln(-1, { scale: 5 })).toThrow(InvalidArgumentError);
    expect(() => log(8, 1, { scale: 5 })).toThrow(InvalidArgumentError);
    expect(() => log(8, 0, { scale: 5 })).toThrow(InvalidArgumentError);
    expect(() => log10(-1, { scale: 5 })).toThrow(InvalidArgumentError);
    expect(() => nthRoot(8, 1.5)).toThrow(InvalidArgumentError);
    expect(() => nthRoot(8, 0)).toThrow(InvalidArgumentError);
    expect(() => pow(-8, '0.5', { scale: 5 })).toThrow(InvalidArgumentError);
    expect(() => pow(0, '-0.5', { scale: 5 })).toThrow(DivisionByZeroError);
  });

  it('requires options where no exact result exists', () => {
    // The types require options; an untyped (JS) caller can still omit them.
    expect(() => {
      Reflect.apply(exp, undefined, [1]);
    }).toThrow(InvalidArgumentError);
    expect(() => {
      Reflect.apply(ln, undefined, [2]);
    }).toThrow(InvalidArgumentError);
    expect(() => pow(2, '0.5')).toThrow(InvalidArgumentError);
    expect(() => sqrt(2, { scale: -1 })).toThrow(InvalidArgumentError);
  });

  it('refuses results beyond the digit limit', () => {
    expect(() => exp(100_000, { scale: 10 })).toThrow(ResourceLimitError);
    expect(() => pow(10, '20000.5', { scale: 2 })).toThrow(ResourceLimitError);
  });
});

describe('performance', () => {
  it('PI(1000) is fast', { timeout: 5000 }, () => {
    const start = Date.now();
    const pi = PI(1000);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(pi.toString().startsWith('3.14159265358979323846')).toBe(true);
    expect(pi.scale).toBe(1000);
  });

  it('sqrt(2) to 1000 digits is fast and squares back to 2', { timeout: 5000 }, () => {
    const start = Date.now();
    const root = sqrt(2, { scale: 1000 });
    expect(Date.now() - start).toBeLessThan(2000);
    // floor(√2) squared is just below 2, the next unit up is just above.
    const floor = sqrt(2, { scale: 1000, rounding: 'floor' });
    expect(floor.times(floor).lt(2)).toBe(true);
    const ceiling = floor.plus(`0.${'0'.repeat(999)}1`);
    expect(ceiling.times(ceiling).gt(2)).toBe(true);
    expect([floor.toString(), ceiling.toString()]).toContain(root.toString());
  });
});

describe('trailing zeros do not inflate the work', () => {
  it('log of an exactly-representable result with a 5000-zero input', () => {
    const padded = `2.${'0'.repeat(5000)}`;
    expect(log(padded, 16, { scale: 2, rounding: 'ceiling' }).toString()).toBe('0.25');
    expect(ln(`1.5${'0'.repeat(5000)}`, { scale: 5 }).toString()).toBe(ln('1.5', { scale: 5 }).toString());
    expect(exp(`1${'0'.repeat(5000)}e-5000`, { scale: 5 }).toString()).toBe(exp(1, { scale: 5 }).toString());
    expect(pow(`2.${'0'.repeat(5000)}`, '0.5', { scale: 5 }).toString()).toBe(pow(2, '0.5', { scale: 5 }).toString());
    expect(sqrt(`2.${'0'.repeat(5000)}`, { scale: 5 }).toString()).toBe('1.41421');
  });
});
