/**
 * Output (RFC §5.4): a value becomes a canonical tree, is printed with expr's
 * `print` and parsed again, so a result is an ordinary `Expr` whose source is
 * canonical text and `parse(print(r))` holds by construction.
 *
 * Sums: descending degree in the main variable, then other names, kernels and
 * atoms, then π and e, the rational constant last. Products: the coefficient,
 * then π, e, the main variable, other names, kernels, atoms. A quotient is one
 * fraction with integer coefficients on both sides. Negative terms print as
 * subtraction.
 *
 * Internal module.
 */
import type { Expr, Node, Span } from '@arki/expr';
import { children, parse, print } from '@arki/expr';
import { Rational } from '@arki/math/rational';

import type { Context, RatFun } from './context.js';
import type { Monomial, Poly, Term } from './poly.js';
import { treeOrThrow } from './core.js';
import { compareMonomials, constantValue, ONE, scale } from './poly.js';

/** The span of a node cas built: it points nowhere in the input. */
export const NOWHERE: Span = { start: 0, end: 0 };

export function numberNode(raw: string): Node {
  return { kind: 'number', raw, span: NOWHERE };
}

function nameNode(name: string): Node {
  return { kind: 'name', name, span: NOWHERE };
}

export function binary(op: '+' | '-' | '*' | '/' | '^', left: Node, right: Node): Node {
  return { kind: 'binary', op, left, right, implicit: false, span: NOWHERE };
}

export function minus(arg: Node): Node {
  return { kind: 'unary', op: '-', arg, span: NOWHERE };
}

/** A term or group of a sum; `node(true)` builds it with its minus sign inside. */
export type Part = { readonly negative: boolean; readonly node: (negative: boolean) => Node };

export function product(factors: readonly Node[]): Node {
  let node = factors[0] ?? numberNode('1');
  for (let i = 1; i < factors.length; i++) node = binary('*', node, factors[i] ?? numberNode('1'));
  return node;
}

/** The decimal text of a non-negative rational if it terminates (`1/50` → `0.02`), else `undefined`. */
export function decimalText(c: Rational): string | undefined {
  let d = c.denominator;
  let twos = 0;
  let fives = 0;
  for (; d % 2n === 0n; d /= 2n) twos++;
  for (; d % 5n === 0n; d /= 5n) fives++;
  if (d !== 1n) return undefined;
  const places = Math.max(twos, fives);
  const digits = ((c.numerator * 10n ** BigInt(places)) / c.denominator).toString().padStart(places + 1, '0');
  return places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

export class Emitter {
  private readonly ctx: Context;
  private readonly main: number | undefined;
  private readonly byName: boolean;
  private orderedFor = -1;
  private productOrder: number[] = [];
  private additionOrder: number[] = [];

  /**
   * `main` leads sums and products. Without `byName`, the main variable is
   * the first name in source order and names keep source order. With
   * `byName`, names are ordered by name and the main variable is the first
   * of them, so the output does not depend on how the input was written
   * (`simplify`, kernel keys).
   */
  constructor(ctx: Context, main?: number, byName = false) {
    this.ctx = ctx;
    this.main = main;
    this.byName = byName;
  }

  /** Generator ids in product order, recomputed when the call has interned new generators since. */
  private get factorOrder(): readonly number[] {
    this.order();
    return this.productOrder;
  }

  /** Generator ids in sum-ordering priority: π and e rank last, so `2*pi*x + 3*x + pi + 1`. */
  private get sumOrder(): readonly number[] {
    this.order();
    return this.additionOrder;
  }

  private order(): void {
    const ctx = this.ctx;
    if (this.orderedFor === ctx.generators.length) return;
    this.orderedFor = ctx.generators.length;
    const gens = ctx.generators.map((gen, id) => ({ gen, id }));
    const keyOf = (g: (typeof gens)[number]): string =>
      g.gen.kind === 'kernel'
        ? g.gen.key
        : g.gen.kind === 'atom' || (this.byName && g.gen.kind === 'name')
          ? g.gen.name
          : '';
    const names = gens.filter(({ gen }) => gen.kind === 'name');
    const mainId =
      this.main ??
      (this.byName
        ? names.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))[0]?.id
        : names[0]?.id);
    const rank = (g: { gen: (typeof gens)[number]['gen']; id: number }): number =>
      g.id === mainId ? 2 : { pi: 0, e: 1, name: 3, kernel: 4, atom: 5 }[g.gen.kind];
    const sorted = gens.sort(
      (a, b) => rank(a) - rank(b) || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : a.id - b.id),
    );
    this.productOrder = sorted.map(g => g.id);
    this.additionOrder = [
      ...this.productOrder.filter(id => !isTranscendental(ctx, id)),
      ...this.productOrder.filter(id => isTranscendental(ctx, id)),
    ];
  }

  private compareTerms(a: Monomial, b: Monomial): number {
    for (const g of this.sumOrder) {
      const d = (b[g] ?? 0) - (a[g] ?? 0);
      if (d !== 0) return d;
    }
    return compareMonomials(b, a);
  }

  /** The term that prints first in a sum: canonical, unlike the internal leading term, which depends on generator ids. */
  firstTerm(p: Poly): Term | undefined {
    let first: Term | undefined;
    for (const term of p.values()) if (first === undefined || this.compareTerms(term.m, first.m) < 0) first = term;
    return first;
  }

  /** A literal or a fraction of two; `negative` puts the minus on the numerator, as the parser reads `-1 / 4`. */
  private rationalNode(c: Rational, negative: boolean): Node {
    const signed = (node: Node): Node => (negative ? minus(node) : node);
    if (c.isInteger()) return signed(numberNode(c.numerator.toString()));
    const decimal = this.ctx.numbers === 'decimal' ? decimalText(c) : undefined;
    if (decimal !== undefined) return signed(numberNode(decimal));
    return binary('/', signed(numberNode(c.numerator.toString())), numberNode(c.denominator.toString()));
  }

  /** The term c·m for c > 0; `negative` puts the minus on its first factor, as the parser reads `-2 * x`. */
  private termNode(c: Rational, m: Monomial, negative: boolean): Node {
    const factors = this.monomialFactors(m);
    const [first, ...rest] = factors;
    if (first === undefined) return this.rationalNode(c, negative);
    const signed = (node: Node): Node => (negative ? minus(node) : node);
    if (c.eq(ONE)) return product([signed(first), ...rest]);
    const decimal = c.isInteger()
      ? c.numerator.toString()
      : this.ctx.numbers === 'decimal'
        ? decimalText(c)
        : undefined;
    if (decimal !== undefined) return product([signed(numberNode(decimal)), ...factors]);
    const top =
      c.numerator === 1n
        ? product([signed(first), ...rest])
        : product([signed(numberNode(c.numerator.toString())), ...factors]);
    return binary('/', top, numberNode(c.denominator.toString()));
  }

  /** The factors `g^e` of a monomial, in product order. */
  monomialFactors(m: Monomial): Node[] {
    const factors: Node[] = [];
    for (const g of this.factorOrder) {
      const e = m[g] ?? 0;
      if (e === 0) continue;
      const base = this.generatorNode(g);
      factors.push(e === 1 ? base : binary('^', base, numberNode(String(e))));
    }
    return factors;
  }

  /** Parts joined as a sum: the first one signed in place, the rest by `+` and `-`. */
  join(parts: readonly Part[]): Node {
    let node: Node | undefined;
    for (const part of parts) {
      node = node === undefined ? part.node(part.negative) : binary(part.negative ? '-' : '+', node, part.node(false));
    }
    return node ?? numberNode('0');
  }

  /** The terms of a sum in canonical order. */
  parts(p: Poly): Part[] {
    return [...p.values()]
      .sort((a, b) => this.compareTerms(a.m, b.m))
      .map(term => ({
        negative: term.c.isNegative(),
        node: (negative: boolean) => this.termNode(term.c.abs(), term.m, negative),
      }));
  }

  /** A polynomial as a sum in canonical order. */
  polyNode(p: Poly): Node {
    return this.join(this.parts(p));
  }

  /** Numerator and denominator scaled to integer coefficients. */
  fractionParts(r: RatFun): readonly [Poly, Poly] {
    let lcm = 1n;
    for (const term of r.num.values()) {
      const d = term.c.denominator;
      let a = lcm;
      let b = d;
      while (b !== 0n) [a, b] = [b, a % b];
      lcm = (lcm / a) * d;
    }
    const factor = Rational.fromParts(lcm, 1n);
    return [scale(r.num, factor), scale(r.den, factor)];
  }

  /** A value as one fraction with integer coefficients on both sides, or a sum when the denominator is 1. */
  node(r: RatFun): Node {
    if (constantValue(r.den) !== undefined) return this.polyNode(r.num);
    const [num, den] = this.fractionParts(r);
    return binary('/', this.polyNode(num), this.polyNode(den));
  }

  generatorNode(g: number): Node {
    const gen = this.ctx.generators[g];
    switch (gen?.kind) {
      case 'pi': {
        return nameNode('pi');
      }
      case 'e': {
        return nameNode('e');
      }
      case 'name':
      case 'atom': {
        return nameNode(gen.name);
      }
      case 'kernel': {
        const args = gen.args.map(arg => this.node(arg));
        if (gen.fn === '^') return binary('^', args[0] ?? numberNode('0'), args[1] ?? numberNode('1'));
        if (gen.fn === '!') return { kind: 'factorial', arg: args[0] ?? numberNode('0'), span: NOWHERE };
        return { kind: 'call', fn: gen.fn, args, notation: 'call', span: NOWHERE };
      }
      case undefined: {
        return numberNode('0');
      }
    }
  }
}

function isTranscendental(ctx: Context, id: number): boolean {
  const kind = ctx.generators[id]?.kind;
  return kind === 'pi' || kind === 'e';
}

/** Node count and depth (a leaf is 1), without recursion. */
function measure(root: Node): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  const stack: [Node, number][] = [[root, 1]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [node, d] = item;
    nodes++;
    depth = Math.max(depth, d);
    for (const child of children(node)) stack.push([child, d + 1]);
  }
  return { nodes, depth };
}

/** Canonical text of a tree. Checks the `nodes` budget first. */
export function textOf(node: Node, ctx: Context): string {
  const { nodes, depth } = measure(node);
  ctx.budget.check('nodes', nodes);
  return print(node, { limits: { depth: depth + 1 } });
}

/** The tree as a canonical `Expr`: printed, then parsed again. */
export function exprOf(node: Node, ctx: Context): Expr {
  const { nodes, depth } = measure(node);
  ctx.budget.check('nodes', nodes);
  const text = print(node, { limits: { depth: depth + 1 } });
  const size = text.length + 1;
  return treeOrThrow(
    parse(text, {
      language: ctx.language,
      limits: { length: size, tokens: size, depth: 2 * depth + 2, nodes: 2 * nodes + 2 },
    }),
  );
}
