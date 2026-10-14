/**
 * Float against exact arithmetic (RFC §19, "domain equivalence"). Trees of
 * `+ - * / ^int` over the literals 0..9 are evaluated by `compile` and by
 * `@arki/math` Rational. Float must stay within a first-order running error
 * bound of the exact value, or throw the same error class. Why: the float
 * domain promises honest IEEE results with typed errors, so any wider gap
 * means an operator, a fold or an error mapping is wrong.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Rational } from '@arki/math/rational';
import { DivisionByZeroError } from '@arki/math/errors';
import { ratio } from '@arki/math/rational';

import type { BinaryNode, Node } from './ast.js';
import { compile } from './float.js';
import { compile as compileRational } from './rational.js';

const SPAN = { start: 0, end: 0 } as const;
/** Twice the unit roundoff: a generous per-operation relative error for `+ - * /`. */
const U = 2 ** -52;

const literal = (value: number): Node => ({ kind: 'number', raw: String(value), span: SPAN });

const trees = fc.letrec<{ node: Node }>(tie => ({
  node: fc.oneof(
    { maxDepth: 4, depthIdentifier: 'tree' },
    fc.integer({ min: 0, max: 9 }).map(value => literal(value)),
    fc
      .record({ op: fc.constantFrom('+', '-', '*', '/'), left: tie('node'), right: tie('node') })
      .map(({ op, left, right }): Node => ({ kind: 'binary', op, left, right, implicit: false, span: SPAN })),
    fc.record({ base: tie('node'), exponent: fc.integer({ min: -3, max: 3 }) }).map(({ base, exponent }): Node => ({
      kind: 'binary',
      op: '^',
      left: { kind: 'group', inner: base, span: SPAN },
      right: exponent < 0 ? { kind: 'unary', op: '-', arg: literal(-exponent), span: SPAN } : literal(exponent),
      implicit: false,
      span: SPAN,
    })),
  ),
})).node;

/** The exact value and a bound on the absolute error of the float result, or the error both must throw. */
type Outcome =
  | { readonly kind: 'value'; readonly exact: Rational; readonly error: number }
  | { readonly kind: 'throws'; readonly error: unknown }
  | { readonly kind: 'unbounded' };

function magnitude(value: Rational): number {
  return Math.abs(value.toNumber());
}

function exponentOf(node: Node): number {
  if (node.kind === 'number') return Number(node.raw);
  if (node.kind === 'unary' && node.arg.kind === 'number') return -Number(node.arg.raw);
  throw new Error('generated exponents are literals');
}

function combine(node: BinaryNode, a: Rational, ea: number, b: Rational, eb: number): Outcome {
  const [ma, mb] = [magnitude(a), magnitude(b)];
  switch (node.op) {
    case '+':
    case '-': {
      const exact = node.op === '+' ? a.plus(b) : a.minus(b);
      return { kind: 'value', exact, error: ea + eb + U * magnitude(exact) };
    }
    case '*': {
      const exact = a.times(b);
      return { kind: 'value', exact, error: ma * eb + mb * ea + ea * eb + U * magnitude(exact) };
    }
    case '/': {
      // A divisor within its own error of zero has no useful bound; an exact zero must throw in both.
      if (eb > 0 && mb <= 2 * eb) return { kind: 'unbounded' };
      const exact = a.dividedBy(b);
      return { kind: 'value', exact, error: (ea + magnitude(exact) * eb) / (mb - eb) + U * magnitude(exact) };
    }
    case '^': {
      const n = exponentOf(node.right);
      if (n === 0) return { kind: 'value', exact: ratio(1), error: 0 };
      if (a.isZero() && ea > 0) {
        return n < 0 ? { kind: 'unbounded' } : { kind: 'value', exact: ratio(0), error: ea ** n };
      }
      if (a.isZero()) return { kind: 'value', exact: a.pow(n), error: 0 };
      const relative = Math.abs(n) * (ea / ma);
      if (relative > 0.25) return { kind: 'unbounded' };
      const exact = a.pow(n);
      // First order: |n| times the base's relative error, plus a few ulps for Math.pow itself.
      return { kind: 'value', exact, error: magnitude(exact) * (relative / (1 - relative) + 4 * U) };
    }
  }
}

function exact(node: Node): Outcome {
  switch (node.kind) {
    case 'number': {
      return { kind: 'value', exact: ratio(node.raw), error: 0 };
    }
    case 'group': {
      return exact(node.inner);
    }
    case 'binary': {
      const left = exact(node.left);
      if (left.kind !== 'value') return left;
      const right: Outcome = node.op === '^' ? { kind: 'value', exact: ratio(0), error: 0 } : exact(node.right);
      if (right.kind !== 'value') return right;
      try {
        return combine(node, left.exact, left.error, right.exact, right.error);
      } catch (error) {
        return { kind: 'throws', error };
      }
    }
    default: {
      throw new Error(`not generated: ${node.kind}`);
    }
  }
}

function float(root: Node): { readonly value: number } | { readonly error: unknown } {
  try {
    return { value: compile({ version: 1, source: '', root, warnings: [] })() };
  } catch (error) {
    return { error };
  }
}

function classOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? value.constructor : undefined;
}

const zero = (op: '/' | '^', right: Node): Node => ({
  kind: 'binary',
  op,
  left: literal(op === '/' ? 1 : 0),
  right,
  implicit: false,
  span: SPAN,
});

describe('float against Rational', () => {
  it('stays within the running error bound of the exact value, or both throw the same error class', () => {
    fc.assert(
      fc.property(trees, root => {
        const expected = exact(root);
        fc.pre(expected.kind !== 'unbounded');
        const actual = float(root);
        if (expected.kind === 'throws') {
          expect('error' in actual).toBe(true);
          expect(classOf('error' in actual ? actual.error : undefined)).toBe(classOf(expected.error));
          return;
        }
        expect('value' in actual).toBe(true);
        if (!('value' in actual)) return;
        const truth = expected.exact.toNumber();
        // Twice the bound, plus the rounding of the exact value to a double.
        expect(Math.abs(actual.value - truth)).toBeLessThanOrEqual(2 * expected.error + U * Math.abs(truth));
      }),
      { numRuns: 2000 },
    );
  });

  it('the oracle is the rational domain: same value, or the same error class (so float is bounded against it)', () => {
    // Why: RFC §19 states float's bound against the Rational domain; this pins the oracle above to it.
    fc.assert(
      fc.property(trees, root => {
        const expected = exact(root);
        fc.pre(expected.kind !== 'unbounded');
        let domain: { readonly value: Rational } | { readonly error: unknown };
        try {
          domain = { value: compileRational({ version: 1, source: '', root, warnings: [] })() };
        } catch (error) {
          domain = { error };
        }
        if (expected.kind === 'throws') {
          expect(classOf('error' in domain ? domain.error : undefined)).toBe(classOf(expected.error));
          return;
        }
        expect('value' in domain && domain.value.eq(expected.exact)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('Rational and float agree on division by zero, including 0^-n', () => {
    for (const [root, rational] of [
      [zero('/', literal(0)), () => ratio(1).dividedBy(ratio(0))],
      [zero('^', { kind: 'unary', op: '-', arg: literal(2), span: SPAN }), () => ratio(0).pow(-2)],
    ] as const) {
      const actual = float(root);
      const expected = exact(root);
      expect(expected.kind).toBe('throws');
      expect(() => rational()).toThrow(DivisionByZeroError);
      expect('error' in actual && actual.error).toBeInstanceOf(DivisionByZeroError);
    }
  });
});
