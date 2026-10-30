import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Node } from './ast.js';
import type { PrintOptions } from './print.js';
import type { Syntax } from './syntax.js';
import { ExprLimitError } from './errors.js';
import { parseText } from './parser.js';
import { print } from './print.js';
import { canonical, decimalComma } from './syntax.js';

const SPAN = { start: 0, end: 0 };
const VARIABLES = ['x', 'y', 't', 'theta', 'a1', '_k', 'α', 'Ω', 'e2', 'E', 'xy'];
const CONSTANTS = ['pi', 'e', 'i'];
const NUMBERS = ['0', '2', '10', '0.5', '.5', '1e-7', '2e+1', '3E5', '0.50', '123.456'];
const CALLS: readonly [string, number, number][] = [
  ['sin', 1, 1],
  ['log', 1, 2],
  ['nthRoot', 1, 2],
  ['pow', 2, 2],
  ['abs', 1, 1],
  ['sqrt', 1, 1],
];

/** Grammar levels, as in the printer: sum, product, unary, power, postfix, primary. */
const [SUM, PRODUCT, UNARY, POWER, POSTFIX, PRIMARY] = [1, 2, 3, 4, 5, 6];

/** A small seeded PRNG (mulberry32), so each fast-check seed is one reproducible tree. */
function random(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return n => {
    state = (state + 1_831_565_813) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % 2 ** 32) % n;
  };
}

/**
 * Generates trees of the shape `parse` produces: every child sits at a level
 * its parent allows (groups are explicit nodes), and an implicit product's
 * right side starts with a name, `(`, `√` or — outside bars — `|`.
 */
function generate(seed: number, size: number): Node {
  const int = random(seed);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(items.length)];
    if (item === undefined) throw new Error('empty choice');
    return item;
  };
  const leaf = (): Node =>
    int(2) === 0
      ? { kind: 'number', raw: pick(NUMBERS), span: SPAN }
      : { kind: 'name', name: pick([...VARIABLES, ...CONSTANTS]), span: SPAN };

  const primary = (depth: number, inBar: boolean, allowNumber: boolean, allowBars: boolean): Node => {
    const choice = depth <= 0 ? 0 : int(6);
    if (choice === 0) {
      return allowNumber ? leaf() : { kind: 'name', name: pick([...VARIABLES, ...CONSTANTS]), span: SPAN };
    }
    if (choice === 1) return { kind: 'group', inner: node(SUM, depth - 1, false), span: SPAN };
    if (choice === 2 && allowBars) {
      return { kind: 'call', fn: 'abs', args: [node(SUM, depth - 1, true)], notation: 'bars', span: SPAN };
    }
    if (choice === 3) {
      return { kind: 'call', fn: 'sqrt', args: [node(PRIMARY, depth - 1, inBar)], notation: 'radical', span: SPAN };
    }
    const [fn, min, max] = pick(CALLS);
    const count = min + int(max - min + 1);
    const args = Array.from({ length: count }, () => node(SUM, depth - 1, false));
    return { kind: 'call', fn, args, notation: 'call', span: SPAN };
  };

  /** The right side of an implicit product: power level, not starting with a number (or a bar inside bars). */
  const implicitRight = (depth: number, inBar: boolean): Node => {
    let lead = primary(depth - 1, inBar, false, !inBar);
    if (int(4) === 0) lead = { kind: 'factorial', arg: lead, span: SPAN };
    if (int(3) === 0) {
      return { kind: 'binary', op: '^', left: lead, right: node(UNARY, depth - 1, inBar), implicit: false, span: SPAN };
    }
    return lead;
  };

  const node = (minLevel: number, depth: number, inBar: boolean): Node => {
    if (depth <= 0) return leaf();
    const forms = [SUM, PRODUCT, PRODUCT, UNARY, POWER, POSTFIX, PRIMARY, PRIMARY].filter(level => level >= minLevel);
    const next = depth - 1;
    switch (pick(forms)) {
      case SUM: {
        return {
          kind: 'binary',
          op: pick(['+', '-']),
          left: node(SUM, next, inBar),
          right: node(PRODUCT, next, inBar),
          implicit: false,
          span: SPAN,
        };
      }
      case PRODUCT: {
        const left = node(PRODUCT, next, inBar);
        if (int(2) === 0)
          return { kind: 'binary', op: '*', left, right: implicitRight(next, inBar), implicit: true, span: SPAN };
        return {
          kind: 'binary',
          op: pick(['*', '/']),
          left,
          right: node(UNARY, next, inBar),
          implicit: false,
          span: SPAN,
        };
      }
      case UNARY: {
        return { kind: 'unary', op: pick(['-', '+']), arg: node(UNARY, next, inBar), span: SPAN };
      }
      case POWER: {
        return {
          kind: 'binary',
          op: '^',
          left: node(POSTFIX, next, inBar),
          right: node(UNARY, next, inBar),
          implicit: false,
          span: SPAN,
        };
      }
      case POSTFIX: {
        return { kind: 'factorial', arg: node(POSTFIX, next, inBar), span: SPAN };
      }
      default: {
        return primary(next, inBar, true, true);
      }
    }
  };
  return node(SUM, size, false);
}

/**
 * The tree without spans. For canonical text, also without the presentation
 * the storage form drops on purpose: implicit products print as `*`, `√x` as `sqrt(x)`.
 */
function shape(node: Node, storage: boolean): unknown {
  switch (node.kind) {
    case 'number': {
      return { kind: node.kind, raw: node.raw };
    }
    case 'name': {
      return { kind: node.kind, name: node.name };
    }
    case 'unary': {
      return { kind: node.kind, op: node.op, arg: shape(node.arg, storage) };
    }
    case 'factorial': {
      return { kind: node.kind, arg: shape(node.arg, storage) };
    }
    case 'group': {
      return { kind: node.kind, inner: shape(node.inner, storage) };
    }
    case 'binary': {
      const implicit = storage ? false : node.implicit;
      return {
        kind: node.kind,
        op: node.op,
        implicit,
        left: shape(node.left, storage),
        right: shape(node.right, storage),
      };
    }
    case 'call': {
      const notation = storage && node.notation === 'radical' ? 'call' : node.notation;
      return { kind: node.kind, fn: node.fn, notation, args: node.args.map(arg => shape(arg, storage)) };
    }
  }
}

const runs = 400;
const tree = fc.record({ seed: fc.integer(), size: fc.integer({ min: 0, max: 6 }) });

function roundTrip(node: Node, options: PrintOptions, syntax: Syntax): Node {
  return parseText(print(node, options), { syntax, variables: VARIABLES }).root;
}

describe('print', () => {
  it('canonical style: ASCII, explicit *, spaces around binary operators', () => {
    expect(print(parseText('2x^2+sin(x)'))).toBe('2 * x^2 + sin(x)');
    expect(print(parseText('√(x) × π − 1 ÷ 2'))).toBe('sqrt((x)) * pi - 1 / 2');
    expect(print(parseText('log(x,2)'))).toBe('log(x, 2)');
  });

  it('display style: juxtaposition, ·, −, √ and π, as typed', () => {
    const display = { style: 'display' } as const;
    expect(print(parseText('2x^2 + 3*y - √x + 2pi'), display)).toBe('2x^2 + 3 · y − √x + 2π');
    expect(print(parseText('x y'), display)).toBe('x y');
    // `2e2` would read back as the literal 200, so the product keeps a space.
    expect(print(parseText('2 e2'), display)).toBe('2 e2');
  });

  it('decimal-comma syntax prints 0,5 and separates arguments with ;', () => {
    const typed = parseText('log(0,50; 2)', { syntax: decimalComma });
    expect(typed.root).toMatchObject({ args: [{ raw: '0.50' }, { raw: '2' }] });
    expect(print(typed)).toBe('log(0.50, 2)');
    expect(print(typed, { syntax: decimalComma })).toBe('log(0,50; 2)');
  });

  it('adds parentheses only where a hand-built tree needs them to keep its meaning', () => {
    const sum: Node = {
      kind: 'binary',
      op: '+',
      left: { kind: 'name', name: 'a', span: SPAN },
      right: { kind: 'name', name: 'b', span: SPAN },
      implicit: false,
      span: SPAN,
    };
    const product: Node = {
      kind: 'binary',
      op: '*',
      left: sum,
      right: { kind: 'name', name: 'c', span: SPAN },
      implicit: false,
      span: SPAN,
    };
    expect(print(product)).toBe('(a + b) * c');
    expect(print({ kind: 'unary', op: '-', arg: sum, span: SPAN })).toBe('-(a + b)');
  });

  it('bounds its recursion on hand-built trees by the depth budget', () => {
    let deep: Node = { kind: 'name', name: 'x', span: SPAN };
    for (let index = 0; index < 100_000; index++) deep = { kind: 'group', inner: deep, span: SPAN };
    expect(() => print(deep)).toThrow(ExprLimitError);
  });
});

describe('round trip properties', () => {
  it('parseText(print(ast)) equals ast apart from spans, in display style', () => {
    fc.assert(
      fc.property(tree, ({ seed, size }) => {
        const ast = generate(seed, size);
        expect(shape(roundTrip(ast, { style: 'display' }, canonical), false)).toEqual(shape(ast, false));
      }),
      { numRuns: runs },
    );
  });

  it('parseText(print(ast)) equals ast apart from spans and storage presentation, in canonical style', () => {
    fc.assert(
      fc.property(tree, ({ seed, size }) => {
        const ast = generate(seed, size);
        expect(shape(roundTrip(ast, {}, canonical), true)).toEqual(shape(ast, true));
      }),
      { numRuns: runs },
    );
  });

  it('the same holds through decimal-comma syntax', () => {
    fc.assert(
      fc.property(tree, ({ seed, size }) => {
        const ast = generate(seed, size);
        expect(shape(roundTrip(ast, { syntax: decimalComma }, decimalComma), true)).toEqual(shape(ast, true));
        const display = roundTrip(ast, { syntax: decimalComma, style: 'display' }, decimalComma);
        expect(shape(display, false)).toEqual(shape(ast, false));
      }),
      { numRuns: runs },
    );
  });

  it('print(parseText(s)) is idempotent', () => {
    fc.assert(
      fc.property(tree, fc.boolean(), ({ seed, size }, display) => {
        const text = print(generate(seed, size), display ? { style: 'display' } : {});
        const once = print(parseText(text, { variables: VARIABLES }));
        expect(print(parseText(once, { variables: VARIABLES }))).toBe(once);
      }),
      { numRuns: runs },
    );
  });
});
