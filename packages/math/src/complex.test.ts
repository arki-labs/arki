import { describe, expect, it } from 'vitest';

import { Complex, complex, isComplex } from './complex.js';
import { DivisionByZeroError, InvalidArgumentError, NumberFormatError, NumericRangeError } from './errors.js';

const close = (actual: Complex, expected: Complex | number, tolerance = 1e-14): void => {
  expect(actual.approxEqual(expected, tolerance), `${actual.toString()} ≉ ${String(expected)}`).toBe(true);
};

// Node's `util.inspect` and Deno's console both look these symbols up on the object.
function inspectWith(value: object, hook: symbol): unknown {
  return Reflect.apply(Reflect.get(value, hook) as () => string, value, []);
}

describe('construction and parsing', () => {
  it('builds from parts, numbers and existing values', () => {
    const z = complex(3, 4);
    expect([z.re, z.im]).toEqual([3, 4]);
    expect(complex(5).isReal()).toBe(true);
    expect(complex(z)).toBe(z);
    expect(isComplex(z)).toBe(true);
    expect(isComplex(3)).toBe(false);
  });

  it('never stores -0, so the principal branch cut is unambiguous', () => {
    const z = complex(-0, -0);
    expect(Object.is(z.re, 0) && Object.is(z.im, 0)).toBe(true);
    // With a stored -0 imaginary part, arg(-1) would be -π and ln(-1) would be -πi.
    expect(complex(-1, -0).arg()).toBe(Math.PI);
  });

  it('parses every form toString prints, with or without spaces', () => {
    const cases: [string, number, number][] = [
      ['3+4i', 3, 4],
      ['3 - 4i', 3, -4],
      ['-2i', 0, -2],
      ['5', 5, 0],
      ['i', 0, 1],
      ['-i', 0, -1],
      ['+i', 0, 1],
      ['3 + i', 3, 1],
      ['-.5e1-2.5e-3i', -5, -0.0025],
      ['  1e-7i ', 0, 1e-7],
      ['1e+21 + 1.5i', 1e21, 1.5],
    ];
    for (const [text, re, im] of cases) {
      const z = complex(text);
      expect([z.re, z.im], text).toEqual([re, im]);
    }
  });

  it('rejects junk with a typed error instead of NaN', () => {
    for (const junk of ['', 'i4', '3 + -4i', '3+4j', 'NaN', 'Infinity', '3 4i', '++3', '3+4i5', 'ii', '1,5']) {
      expect(() => complex(junk), junk).toThrow(NumberFormatError);
    }
    expect(() => complex('1e400')).toThrow(NumericRangeError);
    expect(() => complex(Number.NaN, 1)).toThrow(InvalidArgumentError);
    expect(() => complex(1, Number.POSITIVE_INFINITY)).toThrow(InvalidArgumentError);
  });

  it('round-trips through toString exactly', () => {
    const values = [
      complex(3, 4),
      complex(3, -4),
      complex(0, -2),
      complex(5),
      complex(0, 1),
      complex(0.1, 1e-7),
      complex(1e21, -1),
      complex(Math.PI, Math.E),
      Complex.ZERO,
    ];
    for (const z of values) expect(Complex.from(z.toString()).eq(z), z.toString()).toBe(true);
  });
});

describe('display and coercion', () => {
  it('prints the documented format', () => {
    expect(complex(3, 4).toString()).toBe('3 + 4i');
    expect(complex(3, -4).toString()).toBe('3 - 4i');
    expect(complex(0, -2).toString()).toBe('-2i');
    expect(complex(5).toString()).toBe('5');
    expect(complex(3, -1).toString()).toBe('3 - i');
    expect(Complex.I.toString()).toBe('i');
    expect(Complex.ZERO.toString()).toBe('0');
  });

  it('serializes as text and shows its kind in consoles', () => {
    expect(JSON.stringify({ z: complex(3, 4) })).toBe('{"z":"3 + 4i"}');
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- toPrimitive('string') is the point
    expect(`${complex(1, -1)}`).toBe('1 - i');
    expect(inspectWith(complex(3, 4), Symbol.for('nodejs.util.inspect.custom'))).toBe('Complex(3 + 4i)');
    expect(inspectWith(complex(3, 4), Symbol.for('Deno.customInspect'))).toBe('Complex(3 + 4i)');
    expect(Object.prototype.toString.call(complex(1))).toBe('[object Complex]');
  });

  it('refuses to become a float silently, like Decimal', () => {
    // A complex value has no single numeric value; `+z` dropping im would be a silent bug.
    expect(() => +complex(1, 2)).toThrow(TypeError);
    expect(() => complex(1).valueOf()).toThrow(TypeError);
  });
});

describe('arithmetic', () => {
  it('follows the field rules with exact results for exact inputs', () => {
    expect(complex(1, 2).plus(complex(3, -5)).eq(complex(4, -3))).toBe(true);
    expect(complex(1, 2).minus('1+2i').isZero()).toBe(true);
    expect(complex(3, 4).times(complex(3, -4)).eq(25)).toBe(true);
    expect(Complex.I.times(Complex.I).eq(-1)).toBe(true);
    expect(complex(1, 2).dividedBy(complex(3, 4)).eq(complex(0.44, 0.08))).toBe(true);
    expect(complex(1, 2).negated().eq(complex(-1, -2))).toBe(true);
    expect(complex(1, 2).conjugate().eq(complex(1, -2))).toBe(true);
    close(complex(2, 0).inverse(), 0.5);
  });

  it('divides without overflowing |divisor|² (Smith)', () => {
    // The textbook formula forms c² + d² = 2e600, which is Infinity.
    expect(complex(1e300, 1e300).dividedBy(complex(1e300, 1e300)).eq(1)).toBe(true);
  });

  it('divides at extreme scales when the quotient itself is representable (Baudin & Smith)', () => {
    // Smith alone overflows here: its denominator c + d·(d/c) is 2e308.
    expect(complex(1e308, 1e308).dividedBy(complex(1e308, 1e308)).eq(1)).toBe(true);
    expect(complex(1).dividedBy(1e-200).eq(1e200)).toBe(true);
    expect(complex(1e-300, 1e-300).dividedBy(complex(1e-300, 1e-300)).eq(1)).toBe(true);
    // Only a quotient outside the float range throws.
    expect(() => complex(1e308).dividedBy(1e-10)).toThrow(NumericRangeError);
  });

  it('returns the correctly rounded quotient on the Baudin & Smith 2012 hard cases', () => {
    // [a, b, c, d] as powers of two for (a + b·i) / (c + d·i), and the exact
    // quotient rounded to a float (checked with 1,200-digit decimal arithmetic).
    // Plain Smith gets six of these wrong: 0 or a lost imaginary part, an
    // overflow, or 0.5 + 0.5i instead of 0.6 + 0.2i.
    const cases: [number, number, number, number, number, number][] = [
      [0, 0, 0, 1023, 2 ** -1023, -(2 ** -1023)],
      [0, 0, -1023, -1023, 2 ** 1023, 0],
      [1023, -1023, 677, -677, 2 ** 346, -(2 ** -1008)],
      [1023, 1023, 0, 0, 2 ** 1023, 0],
      [1020, -844, 656, -780, 2 ** 364, -(2 ** -1072)],
      [-71, 1021, 1001, -323, 2 ** -1072, 2 ** 20],
      [-347, -54, -1037, -1058, 3.898_125_604_559_113_3e289, 8.174_961_907_852_354e295],
      [-1074, -1074, -1073, -1074, 0.6, 0.2],
      [1015, -989, 1023, 1023, 0.001_953_125, -0.001_953_125],
      [-622, -1071, -343, -798, 1.029_511_517_893_605_8e-84, 6.971_459_875_150_762e-220],
    ];
    for (const [a, b, c, d, re, im] of cases) {
      const quotient = complex(2 ** a, 2 ** b).dividedBy(complex(2 ** c, 2 ** d));
      expect([quotient.re, quotient.im]).toEqual([re, im]);
    }
  });

  it('throws on division by zero rather than returning NaN or Infinity', () => {
    expect(() => complex(1, 1).dividedBy(0)).toThrow(DivisionByZeroError);
    expect(() => Complex.ZERO.inverse()).toThrow(DivisionByZeroError);
  });

  it('throws NumericRangeError when a result overflows', () => {
    expect(() => complex(1e308, 0).times(10)).toThrow(NumericRangeError);
    expect(() => complex(1000).exp()).toThrow(NumericRangeError);
  });
});

describe('modulus, argument and polar form', () => {
  it('measures modulus with hypot so large parts do not overflow', () => {
    expect(complex(3, 4).abs()).toBe(5);
    expect(complex(1e200, 1e200).abs()).toBeCloseTo(Math.SQRT2 * 1e200, -186);
  });

  // Finite parts can have a modulus beyond Number.MAX_VALUE (up to √2 times it). The
  // library never answers Infinity, so abs and toPolar refuse with a typed error.
  it('throws NumericRangeError when |z| itself is beyond the float range', () => {
    expect(() => complex(1.5e308, 1.5e308).abs()).toThrow(NumericRangeError);
    expect(() => complex(-1.5e308, 1.5e308).toPolar()).toThrow(NumericRangeError);
    expect(complex(1e308, 1e308).abs()).toBe(Math.hypot(1e308, 1e308));
    expect(complex(Number.MAX_VALUE, 0).abs()).toBe(Number.MAX_VALUE);
  });

  it('keeps the argument in (-π, π]', () => {
    expect(complex(-1).arg()).toBe(Math.PI);
    expect(complex(0, -1).arg()).toBe(-Math.PI / 2);
    expect(Complex.ZERO.arg()).toBe(0);
  });

  it('round-trips through polar form', () => {
    const { r, theta } = complex(-3, 4).toPolar();
    expect(r).toBe(5);
    close(Complex.fromPolar(r, theta), complex(-3, 4));
    expect(() => Complex.fromPolar(-1, 0)).toThrow(InvalidArgumentError);
  });
});

describe('exp, ln, log', () => {
  it("satisfies Euler's identity e^(iπ) = -1", () => {
    close(complex(0, Math.PI).exp(), -1);
    expect(complex(2).exp().eq(Math.exp(2))).toBe(true);
  });

  it('takes the principal logarithm', () => {
    expect(complex(-1).ln().eq(complex(0, Math.PI))).toBe(true);
    close(Complex.I.ln(), complex(0, Math.PI / 2));
    const z = complex(-2.5, 0.75);
    close(z.ln().exp(), z);
    expect(() => Complex.ZERO.ln()).toThrow(InvalidArgumentError);
  });

  // ln|z| is about 710 even where |z| overflows, so ln and log must answer, not throw.
  it('takes the logarithm of a value whose modulus is beyond the float range', () => {
    const z = complex(1.5e308, 1.5e308);
    const ln = z.ln();
    expect(ln.re).toBeCloseTo(Math.log(1.5e308) + Math.LN2 / 2, 12);
    expect(ln.im).toBe(Math.PI / 4);
    expect(z.log(10).re).toBeCloseTo(308 + Math.log10(1.5) + Math.log10(2) / 2, 12);
  });

  it('takes logarithms in any base except 0 and 1', () => {
    close(complex(8).log(2), 3);
    close(complex(-8).log(2), complex(3, Math.PI / Math.LN2));
    expect(() => complex(8).log(1)).toThrow(InvalidArgumentError);
    expect(() => complex(8).log(0)).toThrow(InvalidArgumentError);
  });
});

describe('roots and powers', () => {
  it('takes the principal square root exactly where it can', () => {
    expect(complex(-4).sqrt().eq(complex(0, 2))).toBe(true);
    expect(complex(3, 4).sqrt().eq(complex(2, 1))).toBe(true);
    expect(complex(-3, -4).sqrt().eq(complex(1, -2))).toBe(true);
    expect(Complex.ZERO.sqrt().isZero()).toBe(true);
  });

  it('square roots square back and stay in the right half-plane', () => {
    for (const z of [complex(-1e-300, 1e-300), complex(1e300, -1e300), complex(-7, -0.001), complex(0.5, 9)]) {
      const root = z.sqrt();
      expect(root.re).toBeGreaterThanOrEqual(0);
      close(root.times(root), z, 1e-13);
    }
  });

  // sqrt computes |z| as √(re² + im²) only while re² + im² is a normal float,
  // and falls back to Math.hypot outside it: both sides of each edge must stay right.
  it('square roots stay right on both sides of the fast-modulus range', () => {
    for (const z of [
      complex(1e-144, -3e-145),
      complex(-1e-146, 1e-146),
      complex(3e-170, 1),
      complex(-1.2e154, 1e153),
      complex(1.4e154, -1e154),
    ]) {
      const root = z.sqrt();
      expect(Number.isFinite(root.re) && Number.isFinite(root.im)).toBe(true);
      close(root.times(root), z, 1e-13);
    }
    expect(complex(-1e-160).sqrt().eq(complex(0, 1e-80))).toBe(true);
  });

  // Roots shrink the modulus, so a root of a value at the top of the float range
  // fits easily: an overflow on the way there would be a spurious error.
  it('takes roots of values whose modulus is beyond the float range', () => {
    // 1e308 + 1e308i: |z| fits, but |re| + |z| inside the square root did not.
    for (const z of [complex(1e308, 1e308), complex(1.5e308, -1.5e308), complex(-1.7e308, 1e308), complex(1.7e308)]) {
      // Squared back at half size: (root / 2)² = z / 4, since root² itself may not fit.
      const half = z.sqrt().times(0.5);
      close(half.times(half), z.times(0.25), 1e-13);
      close(z.pow(0.5).times(0.5), half, 1e-13);
      const third = z.nthRoots(3)[0]!.times(0.5);
      close(third.times(third).times(third), z.times(0.125), 1e-13);
    }
  });

  it('keeps integer powers exact: (1+i)² = 2i', () => {
    expect(complex(1, 1).pow(2).eq(complex(0, 2))).toBe(true);
    expect(Complex.I.pow(4).eq(1)).toBe(true);
    expect(complex(1, 1).pow(-2).eq(complex(0, -0.5))).toBe(true);
    expect(complex(2, 3).pow(0).eq(1)).toBe(true);
  });

  it('raises to real and complex exponents on the principal branch', () => {
    expect(complex(4).pow(0.5).eq(2)).toBe(true);
    // i^i = e^(-π/2): a complex power with a real value.
    close(Complex.I.pow(Complex.I), Math.exp(-Math.PI / 2));
    // (-8)^(1/3) is the principal root 1 + √3·i, not the real root -2.
    close(complex(-8).pow(1 / 3), complex(1, Math.sqrt(3)));
  });

  it('defines 0^w as 1, 0, or an error', () => {
    expect(Complex.ZERO.pow(0).eq(1)).toBe(true);
    expect(Complex.ZERO.pow(complex(0.5, 3)).isZero()).toBe(true);
    expect(() => Complex.ZERO.pow(-1)).toThrow(DivisionByZeroError);
    expect(() => Complex.ZERO.pow(Complex.I)).toThrow(DivisionByZeroError);
  });

  it('finds all n-th roots: the cube roots of unity', () => {
    const roots = complex(1).nthRoots(3);
    expect(roots[0]!.eq(1)).toBe(true);
    close(roots[1]!, complex(-0.5, Math.sqrt(3) / 2));
    close(roots[2]!, complex(-0.5, -Math.sqrt(3) / 2));
    for (const root of roots) close(root.pow(3), 1);
  });

  it('lists roots counter-clockwise from the principal root', () => {
    const roots = complex(-16).nthRoots(4);
    close(roots[0]!, complex(-16).pow(0.25));
    const expected = [
      complex(Math.SQRT2, Math.SQRT2),
      complex(-Math.SQRT2, Math.SQRT2),
      complex(-Math.SQRT2, -Math.SQRT2),
      complex(Math.SQRT2, -Math.SQRT2),
    ];
    for (const [k, root] of roots.entries()) close(root, expected[k]!);
    expect(Complex.ZERO.nthRoots(3).every(root => root.isZero())).toBe(true);
    expect(() => complex(1).nthRoots(0)).toThrow(InvalidArgumentError);
    expect(() => complex(1).nthRoots(2.5)).toThrow(InvalidArgumentError);
  });
});

describe('trigonometric and hyperbolic functions', () => {
  const EPS = 2 ** -52;
  /** Each part within `ulps` units of its reference (relative; a zero reference must be met exactly). */
  const near = (actual: Complex, re: number, im: number, ulps = 4): void => {
    const off = (got: number, want: number) => (want === 0 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want));
    const label = `${actual.toString()} vs ${re} + ${im}i`;
    expect(off(actual.re, re), label).toBeLessThanOrEqual(ulps * EPS);
    expect(off(actual.im, im), label).toBeLessThanOrEqual(ulps * EPS);
  };
  const z = complex(1.5, 2);

  // References: mpmath 1.4.1 at 60 digits, rounded to the nearest double.
  it('matches mpmath at 1.5 + 2i', () => {
    near(z.sin(), 3.752_771_340_479_298, 0.256_553_956_090_481_8);
    near(z.cos(), 0.266_127_195_313_545_8, -3.617_775_073_940_137_5);
    near(z.tan(), 0.005_362_060_922_003_056_5, 1.036_920_282_100_185);
    near(z.sinh(), -0.886_092_909_362_531_4, 2.139_040_009_980_677);
    near(z.cosh(), -0.978_947_819_646_557_7, 1.936_148_329_510_507_3);
    near(z.tanh(), 1.064_144_399_176_537_1, -0.080_391_015_310_168_18);
    near(z.asin(), 0.606_511_518_199_754_8, 1.622_494_148_871_593_8);
    near(z.acos(), 0.964_284_808_595_141_9, -1.622_494_148_871_593_8);
    near(z.atan(), 1.311_223_269_671_635, 0.310_428_283_077_195_8);
    near(z.asinh(), 1.600_410_055_234_613_7, 0.887_765_146_183_905_1);
    near(z.acosh(), 1.622_494_148_871_593_8, 0.964_284_808_595_141_9);
    near(z.atanh(), 0.220_089_680_662_022_92, 1.245_257_966_072_656_8);
  });

  it('keeps the digits where the plain formulas cancel (mpmath references)', () => {
    // A tiny imaginary part: im = 1e-20 / √0.75. A naive ln(iz + √(1 − z²)) returns 0 here.
    near(complex(0.5, 1e-20).asin(), 0.523_598_775_598_298_9, 1.154_700_538_379_251_5e-20);
    // Next to the branch point 1: both parts ≈ 1e-5, the naive form keeps about 8 digits.
    near(complex(1, 1e-10).acos(), 9.999_999_999_916_666e-6, -1.000_000_000_008_333_4e-5);
    // Next to the pole at 1: (1 − x)² + y² underflows to 0.
    near(complex(1, 1e-200).atanh(), 230.605_082_889_684_55, 0.785_398_163_397_448_3);
    near(complex(1e-10, 1e-10).sinh(), 1e-10, 1e-10);
  });

  it('does not overflow where the result fits (mpmath references)', () => {
    near(complex(1e300, 1e300).asin(), 0.785_398_163_397_448_3, 691.815_248_669_053_6);
    // atan(2^28 i) on the cut: π/2 + i·atanh(2^-28), not π/2 + 0i.
    near(complex(0, 2 ** 28).atan(), 1.570_796_326_794_896_6, 3.725_290_298_461_914e-9);
    // atanh z = 1/z − iπ/2 below the real axis, at a size where |z|² overflows.
    near(complex(1e300, -1e300).atanh(), 5e-301, -Math.PI / 2);
    // cosh(710.6) overflows a double, but sin(π/4)·cosh(710.6) does not.
    near(complex(Math.PI / 4, 710.6).sin(), 1.439_175_797_666_210_7e308, 1.439_175_797_666_210_7e308, 8);
    near(complex(1, 30).tan(), 1.592_454_540_898_266_7e-26, 1);
    expect(complex(800, 1).tanh().re).toBe(1);
  });

  it('throws NumericRangeError only when the result overflows', () => {
    expect(() => complex(1, 800).sin()).toThrow(NumericRangeError);
    expect(() => complex(1, 711).cos()).toThrow(NumericRangeError);
    expect(() => complex(800, 1).cosh()).toThrow(NumericRangeError);
    expect(() => complex(800).sinh()).toThrow(NumericRangeError);
  });

  it('throws InvalidArgumentError at the poles, like ln(0)', () => {
    expect(() => Complex.ZERO.ln()).toThrow(InvalidArgumentError);
    expect(() => complex(1).atanh()).toThrow(InvalidArgumentError);
    expect(() => complex(-1).atanh()).toThrow(InvalidArgumentError);
    expect(() => Complex.I.atan()).toThrow(InvalidArgumentError);
    expect(() => complex(0, -1).atan()).toThrow(InvalidArgumentError);
  });

  // With no -0, a point on a cut takes the counter-clockwise limit (Kahan); mpmath and
  // Mathematica agree. C99 with +0 would give the conjugate of the first, third,
  // fifth and seventh lines below.
  it('takes counter-clockwise continuity on the branch cuts (mpmath values)', () => {
    const acosh2 = 1.316_957_896_924_816_8;
    const atanh2 = 0.549_306_144_334_054_9;
    near(complex(2).asin(), Math.PI / 2, -acosh2);
    near(complex(-2).asin(), -Math.PI / 2, acosh2);
    near(complex(2).acos(), 0, acosh2);
    near(complex(-2).acos(), Math.PI, -acosh2);
    near(complex(2).atanh(), atanh2, -Math.PI / 2);
    near(complex(-2).atanh(), -atanh2, Math.PI / 2);
    near(complex(0, -2).atan(), -Math.PI / 2, -atanh2);
    near(complex(0, 2).atan(), Math.PI / 2, atanh2);
    near(complex(0, -2).asinh(), -acosh2, -Math.PI / 2);
    near(complex(0, 2).asinh(), acosh2, Math.PI / 2);
    near(complex(-2).acosh(), acosh2, Math.PI);
    near(complex(0.5).acosh(), 0, Math.acos(0.5));
    near(complex(-0.5).acosh(), 0, Math.acos(-0.5));
  });

  it('keeps the odd functions odd on their cuts, where conjugate symmetry cannot hold', () => {
    for (const w of [complex(3), complex(-1.5), complex(0, 3), complex(0, -1.5)]) {
      expect(w.negated().asin().eq(w.asin().negated()), `asin ${w.toString()}`).toBe(true);
      if (w.im === 0) expect(w.negated().atanh().eq(w.atanh().negated())).toBe(true);
      else expect(w.negated().atan().eq(w.atan().negated())).toBe(true);
      expect(w.negated().asinh().eq(w.asinh().negated())).toBe(true);
    }
    // On the cut, conj(2) is 2, so asin(conj 2) = asin 2 ≠ conj(asin 2).
    expect(complex(2).conjugate().asin().eq(complex(2).asin().conjugate())).toBe(false);
  });

  it('agrees exactly with Math on the real axis', () => {
    const fns = ['sin', 'cos', 'tan', 'sinh', 'cosh', 'tanh', 'atan', 'asinh'] as const;
    for (const x of [0, 1e-300, 1e-8, 0.3, -0.75, 1, -2.5, 7, 100, 1e15]) {
      for (const f of fns) {
        if (!Number.isFinite(Math[f](x))) continue; // sinh/cosh of 1e15
        const w = complex(x)[f]();
        expect(w.re, `${f}(${x})`).toBe(Math[f](x));
        expect(w.im, `${f}(${x})`).toBe(0);
      }
    }
    for (const x of [-1, -0.9, -1e-9, 0, 0.5, 1]) {
      expect(complex(x).asin().eq(Math.asin(x))).toBe(true);
      expect(complex(x).acos().eq(Math.acos(x))).toBe(true);
      if (Math.abs(x) < 1) expect(complex(x).atanh().eq(Math.atanh(x))).toBe(true);
    }
    for (const x of [1, 1.5, 1e10, 1e300]) expect(complex(x).acosh().eq(Math.acosh(x))).toBe(true);
  });

  it('never returns -0', () => {
    const results = [
      complex(-2).asinh(),
      complex(2).atan(),
      complex(0, 2).sinh(),
      complex(-1).tan(),
      complex(0, -3).cosh(),
      complex(-0.5).acosh(),
      complex(2).acos(),
    ];
    for (const w of results) {
      expect(Object.is(w.re, -0) || Object.is(w.im, -0), w.toString()).toBe(false);
    }
  });
});

describe('comparison', () => {
  it('separates exact from approximate equality', () => {
    const sum = complex(0.1, 0.2).plus(complex(0.2, 0.1));
    expect(sum.eq(complex(0.3, 0.3))).toBe(false);
    expect(sum.approxEqual(complex(0.3, 0.3))).toBe(true);
    expect(complex(1e12, 0).approxEqual(complex(1e12 + 1, 0))).toBe(true); // relative for large values
    expect(complex(1e-3, 0).approxEqual(0)).toBe(false); // absolute near zero
    expect(() => sum.approxEqual(0, -1)).toThrow(InvalidArgumentError);
  });

  // An overflowing distance or modulus must not make far-apart values "equal"
  // (Infinity <= tolerance × Infinity), nor make close ones throw.
  it('compares values at the top of the float range', () => {
    const z = complex(1.5e308, 1.5e308);
    expect(z.approxEqual(complex(1.5e308, -1.5e308))).toBe(false);
    expect(z.approxEqual(complex(-1.5e308, -1.5e308))).toBe(false);
    expect(z.approxEqual(complex(1.5e308, 1.5e308 * (1 + 1e-12)))).toBe(true);
    expect(z.approxEqual(z, 0)).toBe(true);
  });
});

describe('immutability without freezing', () => {
  // Results are deliberately not frozen. `Object.freeze` on every result made an
  // inlined `times` loop 5–7× slower (Bun 25.9 → 3.7 ns, Node 40.7 → 7.3 ns,
  // measured 2026-10-14), and no peer (decimal.js, big.js, bignumber.js,
  // fraction.js, complex.js) freezes. The guarantee is that no method modifies its
  // operands; the shared constants that arithmetic returns are frozen instead.
  it('does not freeze results', () => {
    expect(Object.isFrozen(complex(1, 2))).toBe(false);
    expect(Object.isFrozen(complex(1, 2).times(complex(3, 4)))).toBe(false);
  });

  it('leaves the receiver and the operand unchanged after success and failure, frozen or not', () => {
    for (const freeze of [false, true]) {
      const a = complex(3, -4);
      const b = complex(0.5, 2);
      if (freeze) {
        Object.freeze(a);
        Object.freeze(b);
      }
      expect(a.plus(b).eq(complex(3.5, -2))).toBe(true);
      expect(a.times(b).eq(complex(9.5, 4))).toBe(true);
      expect(a.dividedBy(b).times(b).approxEqual(a)).toBe(true);
      expect(a.sqrt().eq(complex(2, -1))).toBe(true);
      expect(a.pow(b).ln().exp().approxEqual(a.pow(b))).toBe(true);
      expect(a.nthRoots(3)).toHaveLength(3);
      expect(() => a.dividedBy(0)).toThrow(DivisionByZeroError);
      expect(() => complex(0).pow(complex(-1, 1))).toThrow(DivisionByZeroError);
      expect([a.re, a.im, b.re, b.im]).toEqual([3, -4, 0.5, 2]);
    }
  });

  it('freezes ZERO, ONE and I, which arithmetic returns as results', () => {
    // pow(0) returns Complex.ONE, sqrt(0) and 0^n return Complex.ZERO, and
    // inverse() divides Complex.ONE. If a caller could write to them, later
    // inverses, roots and powers would come out wrong.
    expect([Complex.ZERO, Complex.ONE, Complex.I].every(c => Object.isFrozen(c))).toBe(true);
    const one = complex(2, 3).pow(0);
    const zero = complex(0).sqrt();
    expect(() => Object.assign(one, { re: 5 })).toThrow(TypeError);
    expect(() => Object.assign(zero, { im: 5 })).toThrow(TypeError);
    expect(complex(4).pow(-1).eq(complex(0.25))).toBe(true);
    expect(complex(4).inverse().eq(complex(0.25))).toBe(true);
    expect(complex(-4).sqrt().eq(complex(0, 2))).toBe(true);
    expect(complex(0).pow(2).isZero()).toBe(true);
    expect(complex(0).times(complex(3, 4)).isZero()).toBe(true);
    expect(complex(8).nthRoots(3)[0]?.approxEqual(complex(2))).toBe(true);
  });

  it('keeps its JSON text and plain-data shape', () => {
    const z = complex(3, -4);
    expect(complex(z.toJSON()).eq(z)).toBe(true);
    expect(Object.keys(z)).toEqual(['re', 'im']);
    expect(Object.fromEntries(Object.entries(z))).toEqual({ re: 3, im: -4 });
  });
});
