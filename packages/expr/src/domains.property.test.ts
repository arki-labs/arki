/**
 * Decimal against Rational (RFC §19, "domain equivalence"). Trees of
 * `+ - * / ^int` over small literals, some of them decimal fractions, are
 * evaluated by both exact domains. Why: Decimal claims "exact unless it
 * says otherwise", and Rational is the exact reference; a step that rounds
 * without clearing `exact`, or an operator that disagrees, breaks every
 * calculator that shows `=` instead of `≈`. Float against Rational lives in
 * `float.property.test.ts`, whose oracle is checked against this Rational
 * domain there.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Decimal } from '@arki/math/decimal';
import type { Rational } from '@arki/math/rational';
import { DivisionByZeroError, RoundingNecessaryError } from '@arki/math/errors';

import type { Expr, Node } from './ast.js';
import { compile as compileDecimal } from './decimal.js';
import { compile as compileRational } from './rational.js';

const SPAN = { start: 0, end: 0 } as const;

const literal = (raw: string): Node => ({ kind: 'number', raw, span: SPAN });

const trees = fc.letrec<{ node: Node }>(tie => ({
  node: fc.oneof(
    { maxDepth: 4, depthIdentifier: 'tree' },
    fc.constantFrom('0', '1', '2', '3', '5', '7', '9', '0.1', '0.25', '0.3', '1.2', '2.5').map(raw => literal(raw)),
    fc
      .record({ op: fc.constantFrom('+', '-', '*', '/'), left: tie('node'), right: tie('node') })
      .map(({ op, left, right }): Node => ({ kind: 'binary', op, left, right, implicit: false, span: SPAN })),
    fc.record({ base: tie('node'), exponent: fc.integer({ min: -3, max: 3 }) }).map(({ base, exponent }): Node => ({
      kind: 'binary',
      op: '^',
      left: { kind: 'group', inner: base, span: SPAN },
      right:
        exponent < 0
          ? { kind: 'unary', op: '-', arg: literal(String(-exponent)), span: SPAN }
          : literal(String(exponent)),
      implicit: false,
      span: SPAN,
    })),
  ),
})).node;

const expr = (root: Node): Expr => ({ version: 1, source: '', root, warnings: [] });

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

function outcome<T>(run: () => T): Outcome<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
}

const rational = (root: Node): Outcome<Rational> => outcome(() => compileRational(expr(root))());

function classOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? value.constructor : undefined;
}

describe('Decimal against Rational', () => {
  it('whenever detailed().exact is true, Decimal equals Rational exactly', () => {
    let exact = 0;
    let runs = 0;
    fc.assert(
      fc.property(trees, root => {
        runs++;
        const reference = rational(root);
        const actual = outcome(() => compileDecimal(expr(root), { scale: 12, rounding: 'halfEven' }).detailed());
        if (actual.ok && actual.value.exact) {
          exact++;
          expect(reference.ok).toBe(true);
          if (reference.ok) expect(actual.value.value.toRational().eq(reference.value)).toBe(true);
        }
        // Errors agree: Decimal can only miss Rational's division by zero after a step that rounded.
        if (!reference.ok && reference.error instanceof DivisionByZeroError) {
          const agrees = actual.ok ? !actual.value.exact : actual.error instanceof DivisionByZeroError;
          expect(agrees).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
    // Not vacuous: most of these trees are exact in Decimal (terminating quotients included).
    expect(exact / runs).toBeGreaterThan(0.3);
  });

  it('under the default rounding, Decimal equals Rational, throws the same error, or throws RoundingNecessaryError', () => {
    fc.assert(
      fc.property(trees, root => {
        const reference = rational(root);
        const actual: Outcome<Decimal> = outcome(() => compileDecimal(expr(root))());
        if (actual.ok) {
          expect(reference.ok && actual.value.toRational().eq(reference.value)).toBe(true);
          return;
        }
        if (actual.error instanceof RoundingNecessaryError) return;
        expect(reference.ok).toBe(false);
        if (!reference.ok) expect(classOf(actual.error)).toBe(classOf(reference.error));
      }),
      { numRuns: 2000 },
    );
  });
});
