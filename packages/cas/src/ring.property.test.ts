/**
 * Ring laws and value preservation, as fast-check properties over ℚ[π, e]
 * (RFC §13).
 *
 * - The laws are checked symbolically: `expand(lhs - rhs)` must be exactly
 *   `0`, a zero test in free generators.
 * - Values are checked exactly in `@arki/expr/rational`: π and e are renamed
 *   to variables and bound to random rationals with x and y. A polynomial
 *   identity in free generators holds for every substitution, so the input and
 *   the result must agree exactly wherever the input is defined.
 * - Every result round-trips: its source is canonical text that prints back
 *   to itself.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Expr, Node } from '@arki/expr';
import type { Rational } from '@arki/math/rational';
import { parse, print } from '@arki/expr';
import { compile } from '@arki/expr/rational';
import { orThrow } from '@arki/failure';
import { DivisionByZeroError } from '@arki/math/errors';

import { expand, polynomialIn, rationalize } from './polynomial.js';

const leaf = fc.oneof(
  fc.constantFrom('x', 'y', 'pi', 'e'),
  fc.integer({ min: -9, max: 9 }).map(String),
  fc.tuple(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 2, max: 7 })).map(([n, d]) => `${n}/${d}`),
);

/** Polynomial expressions: + - * and small integer powers. */
const polynomials = fc.letrec<{ node: string }>(tie => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.tuple(tie('node'), fc.constantFrom('+', '-', '*'), tie('node')).map(([a, op, b]) => `(${a}) ${op} (${b})`),
    fc.tuple(tie('node'), fc.integer({ min: 0, max: 3 })).map(([a, n]) => `(${a})^${n}`),
  ),
})).node;

/** Rational-function expressions: polynomials plus division. */
const quotients = fc.letrec<{ node: string }>(tie => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.tuple(tie('node'), fc.constantFrom('+', '-', '*', '/'), tie('node')).map(([a, op, b]) => `(${a}) ${op} (${b})`),
    fc.tuple(tie('node'), fc.integer({ min: -2, max: 2 })).map(([a, n]) => `(${a})^(${n})`),
  ),
})).node;

const point = fc.record({
  x: fc.integer({ min: -20, max: 20 }),
  y: fc.integer({ min: -20, max: 20 }),
  P: fc.integer({ min: -20, max: 20 }),
  E: fc.integer({ min: 1, max: 20 }),
  d: fc.integer({ min: 1, max: 7 }),
});

/** pi → P and e → E, so the rational domain can bind them. */
function renamed(node: Node): Node {
  switch (node.kind) {
    case 'name': {
      return node.name === 'pi' ? { ...node, name: 'P' } : node.name === 'e' ? { ...node, name: 'E' } : node;
    }
    case 'number': {
      return node;
    }
    case 'unary':
    case 'factorial': {
      return { ...node, arg: renamed(node.arg) };
    }
    case 'group': {
      return { ...node, inner: renamed(node.inner) };
    }
    case 'binary': {
      return { ...node, left: renamed(node.left), right: renamed(node.right) };
    }
    case 'call': {
      return { ...node, args: node.args.map(arg => renamed(arg)) };
    }
  }
}

function valueAt(expr: Expr, p: { x: number; y: number; P: number; E: number; d: number }): Rational | 'undefined' {
  const f = compile({ ...expr, root: renamed(expr.root) }, { variables: ['x', 'y', 'P', 'E'] });
  const scope = { x: `${p.x}/${p.d}`, y: `${p.y}/${p.d + 1}`, P: `${p.P}/${p.d + 2}`, E: `${p.E}/${p.d + 3}` };
  try {
    return f(scope);
  } catch (error) {
    if (error instanceof DivisionByZeroError) return 'undefined';
    throw error;
  }
}

const zero = (text: string): string => expand(text).result.source;

describe('ring laws in ℚ[π, e][x, y]', () => {
  const runs = { numRuns: 200 };

  it('commutativity of + and *', () => {
    fc.assert(
      fc.property(polynomials, polynomials, (a, b) => {
        expect(zero(`((${a}) + (${b})) - ((${b}) + (${a}))`)).toBe('0');
        expect(zero(`((${a}) * (${b})) - ((${b}) * (${a}))`)).toBe('0');
      }),
      runs,
    );
  });

  it('associativity of + and *', () => {
    fc.assert(
      fc.property(polynomials, polynomials, polynomials, (a, b, c) => {
        expect(zero(`(((${a}) + (${b})) + (${c})) - ((${a}) + ((${b}) + (${c})))`)).toBe('0');
        expect(zero(`(((${a}) * (${b})) * (${c})) - ((${a}) * ((${b}) * (${c})))`)).toBe('0');
      }),
      runs,
    );
  });

  it('distributivity, identities and inverses', () => {
    fc.assert(
      fc.property(polynomials, polynomials, polynomials, (a, b, c) => {
        expect(zero(`(${a}) * ((${b}) + (${c})) - ((${a}) * (${b}) + (${a}) * (${c}))`)).toBe('0');
        expect(zero(`((${a}) + 0) * 1 - (${a})`)).toBe('0');
        expect(zero(`(${a}) - (${a})`)).toBe('0');
      }),
      runs,
    );
  });
});

describe('values are preserved exactly (π and e substituted by rationals)', () => {
  it('expand of a polynomial equals its input at every rational point', () => {
    fc.assert(
      fc.property(polynomials, point, (text, p) => {
        const input = orThrow(parse(text));
        const { result } = expand(input);
        const before = valueAt(input, p);
        const after = valueAt(result, p);
        expect(before === 'undefined' ? before : before.toString()).toBe(
          after === 'undefined' ? after : after.toString(),
        );
      }),
      { numRuns: 300 },
    );
  });

  it('rationalize: where the input is defined, the result is defined and equal; conditions only name divisors', () => {
    fc.assert(
      fc.property(quotients, point, (text, p) => {
        const input = orThrow(parse(text));
        let form: ReturnType<typeof rationalize>;
        try {
          form = rationalize(input);
        } catch (error) {
          if (error instanceof DivisionByZeroError) return; // the input divides by an identically zero value
          throw error;
        }
        const before = valueAt(input, p);
        if (before === 'undefined') return;
        const numerator = valueAt(form.numerator, p);
        const denominator = valueAt(form.denominator, p);
        expect(numerator).not.toBe('undefined');
        expect(denominator).not.toBe('undefined');
        if (numerator === 'undefined' || denominator === 'undefined') return;
        expect(denominator.isZero()).toBe(false);
        expect(numerator.dividedBy(denominator).toString()).toBe(before.toString());
        // A listed condition is a lost divisor: where the input is defined, it holds.
        for (const condition of form.conditions) {
          const v = valueAt(condition.subject, p);
          expect(v !== 'undefined' && !v.isZero()).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('round trip: AST → polynomial → AST is canonical and stable', () => {
    fc.assert(
      fc.property(polynomials, text => {
        const { result } = expand(text);
        expect(print(orThrow(parse(result.source)))).toBe(result.source);
        expect(expand(result).result.source).toBe(result.source);
        const form = polynomialIn(result, 'x');
        if (form.kind !== 'polynomial') return;
        for (const c of form.coefficients) expect(print(orThrow(parse(c.value.source)))).toBe(c.value.source);
      }),
      { numRuns: 200 },
    );
  });
});
