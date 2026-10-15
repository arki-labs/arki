/**
 * `simplify` properties (RFC §13), with fast-check.
 *
 * The contract (RFC §6) in testable form, at random points:
 * 1. Where the input is defined, every returned condition holds. So a
 *    condition never excludes a point the input covers: conditions are
 *    necessary, never invented.
 * 2. Where the input is defined, the result is defined and equal: exactly in
 *    `@arki/expr/rational` for algebraic inputs (π and e substituted by random
 *    rationals, valid because ℚ[π, e] identities hold in free generators),
 *    within 1e-9 in floating point for kernel rules (exp, ln, sin, cos).
 * 3. `simplify` is idempotent, and every result round-trips through print and
 *    parse.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Expr, Node } from '@arki/expr';
import type { Rational } from '@arki/math/rational';
import { children, parse, print } from '@arki/expr';
import { compile as compileFloat } from '@arki/expr/float';
import { compile } from '@arki/expr/rational';
import { DivisionByZeroError, InvalidArgumentError, MathError, RoundingNecessaryError } from '@arki/math/errors';

import type { Condition } from './index.js';
import { simplify } from './simplify.js';

type Outcome = Rational | 'undefined' | 'inexact';

const smallRational = fc
  .tuple(fc.integer({ min: -9, max: 9 }), fc.integer({ min: 1, max: 4 }))
  .map(([n, d]) => (d === 1 ? String(n) : `${n}/${d}`));

/** Rational functions over ℚ[π, e] in x and y. */
const algebraic = fc.letrec<{ node: string }>(tie => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constantFrom('x', 'y', 'pi', 'e'),
    smallRational,
    fc.tuple(tie('node'), fc.constantFrom('+', '-', '*', '/'), tie('node')).map(([a, op, b]) => `(${a}) ${op} (${b})`),
    fc.tuple(tie('node'), fc.integer({ min: -2, max: 3 })).map(([a, n]) => `(${a})^(${n})`),
  ),
})).node;

/** Algebraic kernels that the rational domain evaluates exactly: abs, sqrt of squares, abs(u)/u. No π or e: abs rules use their true signs. */
const kernels = fc.letrec<{ node: string }>(tie => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constantFrom('x', 'y'),
    smallRational,
    fc.tuple(tie('node'), fc.constantFrom('+', '-', '*', '/'), tie('node')).map(([a, op, b]) => `(${a}) ${op} (${b})`),
    fc.tuple(tie('node'), fc.integer({ min: -2, max: 3 })).map(([a, n]) => `(${a})^(${n})`),
    tie('node').map(a => `abs(${a})`),
    tie('node').map(a => `sqrt((${a})^2)`),
    tie('node').map(a => `abs(${a})/(${a})`),
    tie('node').map(a => `0*sqrt(${a})`),
  ),
})).node;

/** Transcendental kernels, checked in floating point. */
const transcendental = fc.letrec<{ node: string }>(tie => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constantFrom('x', 'y'),
    fc.integer({ min: -3, max: 3 }).map(String),
    fc.tuple(tie('node'), fc.constantFrom('+', '-', '*', '/'), tie('node')).map(([a, op, b]) => `(${a}) ${op} (${b})`),
    fc.tuple(fc.constantFrom('exp', 'ln', 'sin', 'cos', 'sqrt', 'abs'), tie('node')).map(([f, a]) => `${f}(${a})`),
    tie('node').map(a => `exp(ln(${a}))`),
    tie('node').map(a => `ln(exp(${a}))`),
    tie('node').map(a => `sqrt(${a})^2`),
    fc.tuple(tie('node'), tie('node')).map(([a, b]) => `exp(${a})*exp(${b})`),
    tie('node').map(a => `sin(-(${a})) + cos(-(${a}))`),
  ),
})).node;

const point = fc.record({
  x: fc.integer({ min: -12, max: 12 }),
  y: fc.integer({ min: -12, max: 12 }),
  P: fc.integer({ min: -12, max: 12 }),
  E: fc.integer({ min: 1, max: 12 }),
  d: fc.integer({ min: 1, max: 4 }),
});
type Point = typeof point extends fc.Arbitrary<infer P> ? P : never;

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

function exactAt(expr: Expr, p: Point): Outcome {
  const f = compile({ ...expr, root: renamed(expr.root) }, { variables: ['x', 'y', 'P', 'E'] });
  try {
    return f({ x: `${p.x}/${p.d}`, y: `${p.y}/${p.d + 1}`, P: `${p.P}/${p.d + 2}`, E: `${p.E}/${p.d + 3}` });
  } catch (error) {
    if (error instanceof RoundingNecessaryError) return 'inexact';
    if (error instanceof DivisionByZeroError || error instanceof InvalidArgumentError) return 'undefined';
    throw error;
  }
}

function holdsExactly(c: Condition, p: Point): boolean {
  const v = exactAt(c.subject, p);
  if (v === 'inexact') return true;
  if (v === 'undefined') return false;
  return c.relation === 'nonzero' ? !v.isZero() : c.relation === 'positive' ? v.isPositive() : !v.isNegative();
}

/** The largest magnitude of any subexpression at (x, y), or `undefined` where one is undefined. */
function largestPart(expr: Expr, x: number, y: number): number | undefined {
  let most = 0;
  const stack: Node[] = [expr.root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const value = floatAt(parse(print(node)), x, y);
    if (value === undefined) return undefined;
    most = Math.max(most, Math.abs(value));
    stack.push(...children(node));
  }
  return most;
}

function floatAt(expr: Expr, x: number, y: number): number | undefined {
  try {
    const value = compileFloat(expr, { variables: ['x', 'y'] })({ x, y });
    return Number.isFinite(value) ? value : undefined;
  } catch (error) {
    if (error instanceof MathError) return undefined;
    throw error;
  }
}

/** Simplify, or `undefined` when the input divides by something identically zero (it is defined nowhere). */
function attempt(text: string): ReturnType<typeof simplify> | undefined {
  try {
    return simplify(text);
  } catch (error) {
    if (error instanceof DivisionByZeroError) return undefined;
    throw error;
  }
}

describe('simplify preserves values exactly where the input is defined', () => {
  it.each([
    ['rational functions over ℚ[π, e]', algebraic],
    ['abs, sqrt of squares and abs(u)/u', kernels],
  ])('%s', (_, inputs) => {
    fc.assert(
      fc.property(inputs, point, (text, p) => {
        const input = parse(text);
        const before = exactAt(input, p);
        if (before === 'undefined' || before === 'inexact') return;
        const r = attempt(text);
        expect(r).toBeDefined();
        if (r === undefined) return;
        // Necessity: the input is defined here, so no condition may exclude this point.
        for (const c of r.conditions) expect(holdsExactly(c, p)).toBe(true);
        const after = exactAt(r.result, p);
        expect(after === 'undefined' || after === 'inexact' ? after : after.toString()).toBe(before.toString());
      }),
      { numRuns: 400 },
    );
  });
});

describe('kernel rules preserve values in floating point', () => {
  it('exp, ln, sin, cos, sqrt and abs: within 1e-9 where the input is defined', () => {
    // Small points: nested exp grows fast, and sin of a huge argument amplifies rounding beyond any fixed tolerance.
    const xs = fc
      .tuple(fc.integer({ min: -8, max: 8 }), fc.integer({ min: -8, max: 8 }))
      .map(([a, b]) => [a / 8, b / 8] as const);
    fc.assert(
      fc.property(transcendental, xs, (text, [x, y]) => {
        const input = parse(text);
        const before = floatAt(input, x, y);
        // Rounding grows with the magnitude of intermediate values (sin of a huge exp): compare only where they stay small.
        const largest = largestPart(input, x, y);
        if (before === undefined || largest === undefined || largest > 1e3) return;
        const r = attempt(text);
        if (r === undefined) return;
        for (const c of r.conditions) {
          const v = floatAt(c.subject, x, y);
          expect(v).toBeDefined();
          if (v === undefined) return;
          // Conditions are necessary: the input is defined here, so none is clearly broken. Float cannot see
          // the boundary itself (sqrt(y)^2 - y rounds to 1e-16 > 0), so a tolerance stands in for it.
          if (c.relation !== 'nonzero') expect(v).toBeGreaterThan(-1e-9);
        }
        const after = floatAt(r.result, x, y);
        expect(after).toBeDefined();
        if (after === undefined) return;
        expect(Math.abs(after - before)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(before)));
      }),
      { numRuns: 400 },
    );
  });
});

describe('conditions are necessary: breaking one makes the input undefined, while the result is not', () => {
  it.each([
    ['x/x', 0],
    ['(x^2 - 1)/(x - 1)', 1],
    ['sqrt(x)^2', -1],
    ['exp(ln(x))', 0],
    ['exp(ln(x))', -2],
    ['0*ln(x)', -1],
    ['abs(x)/x', 0],
    ['0*sqrt(x)', -1],
    ['0*ln(x - 1)', 1],
  ])('%s at x = %d', (text, x) => {
    const r = simplify(text);
    expect(r.conditions.length).toBeGreaterThan(0);
    expect(floatAt(parse(text), x, 0)).toBeUndefined();
    expect(floatAt(r.result, x, 0)).toBeDefined();
    const broken = r.conditions.some(c => {
      const v = floatAt(c.subject, x, 0);
      return (
        v === undefined || (c.relation === 'nonzero' ? Math.abs(v) < 1e-12 : c.relation === 'positive' ? v <= 0 : v < 0)
      );
    });
    expect(broken).toBe(true);
  });
});

describe('idempotence and round trip', () => {
  it.each([
    ['rational functions', algebraic],
    ['algebraic kernels', kernels],
    ['transcendental kernels', transcendental],
  ])('%s: simplify(simplify(e)) == simplify(e), and the result prints back to itself', (_, inputs) => {
    fc.assert(
      fc.property(inputs, text => {
        const r = attempt(text);
        if (r === undefined) return;
        expect(print(parse(r.result.source))).toBe(r.result.source);
        expect(simplify(r.result).result.source).toBe(r.result.source);
      }),
      { numRuns: 300 },
    );
  });
});
