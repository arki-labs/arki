/**
 * exactRoots is checked by substitution, never by comparing strings: each
 * root is evaluated in the formal field ℚ(√r, i) (exact rational arithmetic
 * on a + b·√r + c·i + d·√r·i) and plugged into the polynomial, which must give
 * exactly 0. For π/e coefficients, π and e are replaced by random rationals
 * first: an identity in free generators holds for every substitution.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Node } from '@arki/expr';
import { E, PI } from '@arki/math/decimal-math';
import { InvalidArgumentError } from '@arki/math/errors';
import { Rational } from '@arki/math/rational';

import { exactRoots } from './roots.js';
import { polynomialIn } from './test-support.js';

type Field = readonly [Rational, Rational, Rational, Rational]; // 1, s, i, s·i

const R = (value: number | string): Rational => Rational.from(value);
const ZERO = R(0);

function fieldMultiply(x: Field, y: Field, r: Rational): Field {
  const [a, b, c, d] = x;
  const [e, f, g, h] = y;
  // s² = r, i² = -1
  return [
    a.times(e).plus(b.times(f).times(r)).minus(c.times(g)).minus(d.times(h).times(r)),
    a.times(f).plus(b.times(e)).minus(c.times(h)).minus(d.times(g)),
    a.times(g).plus(c.times(e)).plus(b.times(h).times(r)).plus(d.times(f).times(r)),
    a.times(h).plus(d.times(e)).plus(b.times(g)).plus(c.times(f)),
  ];
}

/** Evaluates a root's tree; `sqrt(u)` must have a rational u (after substitution), which becomes s with s² = u. */
function evaluateField(node: Node, scope: Readonly<Record<string, Rational>>, radicand: { r?: Rational }): Field {
  const scalar = (q: Rational): Field => [q, ZERO, ZERO, ZERO];
  switch (node.kind) {
    case 'number': {
      return scalar(R(node.raw));
    }
    case 'name': {
      if (node.name === 'i') return [ZERO, ZERO, R(1), ZERO];
      const value = scope[node.name];
      if (value === undefined) throw new Error(`unbound ${node.name}`);
      return scalar(value);
    }
    case 'group': {
      return evaluateField(node.inner, scope, radicand);
    }
    case 'unary': {
      const v = evaluateField(node.arg, scope, radicand);
      return node.op === '-' ? [v[0].negated(), v[1].negated(), v[2].negated(), v[3].negated()] : v;
    }
    case 'call': {
      const [arg] = node.args;
      if (node.fn !== 'sqrt' || arg === undefined) throw new Error(`unexpected ${node.fn}`);
      const [u, ...rest] = evaluateField(arg, scope, radicand);
      if (rest.some(q => !q.isZero())) throw new Error('nested radical');
      if (radicand.r !== undefined && !radicand.r.eq(u)) throw new Error('two different radicands');
      radicand.r = u;
      return [ZERO, R(1), ZERO, ZERO];
    }
    case 'binary': {
      const x = evaluateField(node.left, scope, radicand);
      const y = evaluateField(node.right, scope, radicand);
      const r = radicand.r ?? R(1);
      switch (node.op) {
        case '+': {
          return [x[0].plus(y[0]), x[1].plus(y[1]), x[2].plus(y[2]), x[3].plus(y[3])];
        }
        case '-': {
          return [x[0].minus(y[0]), x[1].minus(y[1]), x[2].minus(y[2]), x[3].minus(y[3])];
        }
        case '*': {
          return fieldMultiply(x, y, r);
        }
        case '/': {
          if (y.slice(1).some(q => !q.isZero())) throw new Error('division by a non-rational');
          return [x[0].dividedBy(y[0]), x[1].dividedBy(y[0]), x[2].dividedBy(y[0]), x[3].dividedBy(y[0])];
        }
        case '^': {
          const n = Number(evaluateField(node.right, scope, radicand)[0].toString());
          let out: Field = [R(1), ZERO, ZERO, ZERO];
          for (let k = 0; k < n; k++) out = fieldMultiply(out, x, r);
          return out;
        }
      }
    }
    // eslint-disable-next-line no-fallthrough -- every binary operator returns above
    case 'factorial': {
      throw new Error('unexpected factorial');
    }
  }
}

/** Σ cₖ·rootᵏ in the field: must be exactly zero for a root. */
function residual(coefficients: readonly Rational[], root: Node, scope: Readonly<Record<string, Rational>>): Field {
  const radicand: { r?: Rational } = {};
  const value = evaluateField(root, scope, radicand);
  const r = radicand.r ?? R(1);
  let sum: Field = [ZERO, ZERO, ZERO, ZERO];
  let power: Field = [R(1), ZERO, ZERO, ZERO];
  for (const c of coefficients) {
    sum = [
      sum[0].plus(power[0].times(c)),
      sum[1].plus(power[1].times(c)),
      sum[2].plus(power[2].times(c)),
      sum[3].plus(power[3].times(c)),
    ];
    power = fieldMultiply(power, value, r);
  }
  return sum;
}

function rootsOf(text: string) {
  const form = polynomialIn(text, 'x');
  if (form.kind !== 'polynomial') throw new Error(`not a polynomial: ${text}`);
  return { form, result: exactRoots(form) };
}

describe('exactRoots over ℚ', () => {
  it.each([
    ['x^2 - 5x + 6', ['2', '3'], true],
    ['2x^2 - 7x + 3', ['1 / 2', '3'], true],
    ['x^2 - 2', ['-sqrt(2)', 'sqrt(2)'], true],
    ['x^2 - 8', ['-2 * sqrt(2)', '2 * sqrt(2)'], true],
    // 10007 is a prime above the trial-division bound; its square must still come out from under the root.
    ['x^2 - 200280098', ['-10007 * sqrt(2)', '10007 * sqrt(2)'], true],
    ['x^2 - x - 1', ['(-sqrt(5) + 1) / 2', '(sqrt(5) + 1) / 2'], true],
    ['x^2 + 4', ['-2 * i', '2 * i'], false],
    ['1000000*x^2 + 1', ['-i / 1000', 'i / 1000'], false],
    ['3x + 9', ['-3'], true],
  ])('%s → %j (real: %s)', (text, expected, real) => {
    const { result } = rootsOf(text);
    expect(result.roots.map(r => r.value.source)).toEqual(expected);
    expect(result.roots.every(r => r.real === real)).toBe(true);
    expect(result.exact).toBe(true);
  });

  it('gives a zero discriminant one root of multiplicity 2', () => {
    const { result } = rootsOf('x^2 - 6x + 9');
    expect(result.roots.map(r => [r.value.source, r.multiplicity])).toEqual([['3', 2]]);
  });

  it('splits off x^k and square-free parts of higher degree, solving the small ones exactly', () => {
    const { result } = rootsOf('(x - 1)^2 * (x^2 + 1)^3 * (x - 2) * x');
    expect(result.roots.map(r => [r.value.source, r.multiplicity, r.real])).toEqual([
      ['0', 1, true],
      ['1', 2, true],
      ['2', 1, true],
      ['-i', 3, false],
      ['i', 3, false],
    ]);
  });

  it('factors rational polynomials over ℚ first: x^4 - 5x^2 + 4 has the exact roots ±1, ±2', () => {
    const { result } = rootsOf('x^4 - 5x^2 + 4');
    expect(result.exact).toBe(true);
    expect(result.roots.map(r => r.value.source)).toEqual(['-2', '-1', '1', '2']);
  });

  it('solves the linear and quadratic factors exactly and returns irreducible factors of degree ≥ 3 as numeric', () => {
    const { result } = rootsOf('(x^3 - 2) * (x^2 - 2) * (x - 5)');
    expect(result.roots.map(r => r.value.source)).toEqual(['-sqrt(2)', 'sqrt(2)', '5']);
    expect(result.exact).toBe(false);
    expect(result.numeric).toEqual([{ coefficients: [-2, 0, 0, 1], multiplicity: 1 }]);
  });

  it('refuses the zero polynomial: every number is a root', () => {
    const form = polynomialIn('x - x', 'x');
    expect(() => form.kind === 'polynomial' && exactRoots(form)).toThrow(InvalidArgumentError);
  });

  it('property: every root of a random rational quadratic substitutes to exactly 0', () => {
    const rational = fc
      .tuple(fc.integer({ min: -30, max: 30 }), fc.integer({ min: 1, max: 6 }))
      .map(([n, d]) => `${n}/${d}`);
    fc.assert(
      fc.property(rational, rational, rational, (a, b, c) => {
        fc.pre(!R(a).isZero());
        const { form, result } = rootsOf(`(${a})*x^2 + (${b})*x + (${c})`);
        const coefficients = form.coefficients.map(k => k.rational ?? R(0));
        const count = result.roots.reduce((sum, r) => sum + r.multiplicity, 0);
        expect(count).toBe(2);
        for (const root of result.roots) {
          expect(residual(coefficients, root.value.root, {}).every(q => q.isZero())).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe('exactRoots over ℚ(π, e) (decision 6)', () => {
  it('pi*x = 1 gives x = 1/pi exactly', () => {
    expect(rootsOf('pi*x - 1').result.roots.map(r => r.value.source)).toEqual(['1 / pi']);
  });

  it('x^2 = pi^2 gives ±pi: polynomial squares come out of the root', () => {
    expect(rootsOf('x^2 - pi^2').result.roots.map(r => r.value.source)).toEqual(['-pi', 'pi']);
  });

  it('property: roots substitute to exactly 0 with π, e replaced by random rationals, and real ⇔ Δ > 0 at 200 digits', () => {
    const small = fc.integer({ min: -4, max: 4 });
    const pi200 = Rational.from(PI(200));
    const e200 = Rational.from(E(200));
    fc.assert(
      fc.property(small, small, small, small, small, small, (a1, a2, b1, b2, c1, c2) => {
        fc.pre(a1 !== 0 || a2 !== 0);
        fc.pre(b2 !== 0 || c2 !== 0 || a2 !== 0);
        const [a, b, c] = [`(${a1} + ${a2}*pi)`, `(${b1} + ${b2}*e)`, `(${c1} - ${c2}*pi*e)`];
        const { result } = rootsOf(`${a}*x^2 + ${b}*x + ${c}`);
        const value = (p: Rational, q: Rational) => ({
          a: R(a1).plus(R(a2).times(p)),
          b: R(b1).plus(R(b2).times(q)),
          c: R(c1).minus(R(c2).times(p).times(q)),
        });
        const exact = value(pi200, e200);
        const discriminant = exact.b.times(exact.b).minus(R(4).times(exact.a).times(exact.c));
        if (discriminant.isZero()) return;
        expect(result.roots.every(r => r.real === discriminant.isPositive())).toBe(true);
        for (const [p, q] of [
          [R('3/1'), R('5/2')],
          [R('-7/3'), R('11/4')],
        ] as const) {
          const k = value(p, q);
          if (k.a.isZero()) continue;
          for (const root of result.roots) {
            expect(residual([k.c, k.b, k.a], root.value.root, { pi: p, e: q }).every(x => x.isZero())).toBe(true);
          }
        }
      }),
      { numRuns: 120 },
    );
  });
});
