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
import type { Expr, Node } from '@arki/expr';
import { children, parse, print } from '@arki/expr';
import { Rational } from '@arki/math/rational';

import type { Context, RatFun } from './context.js';
import type { Monomial, Poly } from './poly.js';
import { coefficientsIn, compareMonomials, EMPTY, constantValue, fromCoefficientsIn, ONE, scale } from './poly.js';

const AT = { start: 0, end: 0 };

function numberNode(raw: string): Node {
  return { kind: 'number', raw, span: AT };
}

function nameNode(name: string): Node {
  return { kind: 'name', name, span: AT };
}

function binary(op: '+' | '-' | '*' | '/' | '^', left: Node, right: Node): Node {
  return { kind: 'binary', op, left, right, implicit: false, span: AT };
}

function minus(arg: Node): Node {
  return { kind: 'unary', op: '-', arg, span: AT };
}

/** A term or group of a sum; `node(true)` builds it with its minus sign inside. */
type Part = { readonly negative: boolean; readonly node: (negative: boolean) => Node };

function product(factors: readonly Node[]): Node {
  let node = factors[0] ?? numberNode('1');
  for (let i = 1; i < factors.length; i++) node = binary('*', node, factors[i] ?? numberNode('1'));
  return node;
}

/** The decimal text of a non-negative rational if it terminates (`1/50` → `0.02`), else `undefined`. */
function decimalText(c: Rational): string | undefined {
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
  /** Generator ids in product order, and in sum-ordering priority. */
  private readonly factorOrder: number[];
  private readonly sumOrder: number[];

  constructor(ctx: Context, main?: number) {
    this.ctx = ctx;
    const gens = ctx.generators.map((gen, id) => ({ gen, id }));
    const firstName = gens.find(({ gen }) => gen.kind === 'name')?.id;
    const mainId = main ?? firstName;
    const rank = (g: { gen: (typeof gens)[number]['gen']; id: number }): number =>
      g.id === mainId ? 2 : { pi: 0, e: 1, name: 3, kernel: 4, atom: 5 }[g.gen.kind];
    const keyOf = (g: (typeof gens)[number]): string =>
      g.gen.kind === 'kernel' ? g.gen.key : g.gen.kind === 'atom' ? g.gen.name : '';
    const sorted = gens.sort((a, b) => rank(a) - rank(b) || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : a.id - b.id));
    this.factorOrder = sorted.map(g => g.id);
    // π and e rank last for sums, so `2*pi*x + 3*x + pi + 1`.
    this.sumOrder = [...this.factorOrder.filter(id => !isTranscendental(ctx, id)), ...this.factorOrder.filter(id => isTranscendental(ctx, id))];
  }

  private compareTerms(a: Monomial, b: Monomial): number {
    for (const g of this.sumOrder) {
      const d = (b[g] ?? 0) - (a[g] ?? 0);
      if (d !== 0) return d;
    }
    return compareMonomials(b, a);
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
    const factors: Node[] = [];
    for (const g of this.factorOrder) {
      const e = m[g] ?? 0;
      if (e === 0) continue;
      const base = this.generatorNode(g);
      factors.push(e === 1 ? base : binary('^', base, numberNode(String(e))));
    }
    const [first, ...rest] = factors;
    if (first === undefined) return this.rationalNode(c, negative);
    const signed = (node: Node): Node => (negative ? minus(node) : node);
    if (c.eq(ONE)) return product([signed(first), ...rest]);
    const decimal = c.isInteger() ? c.numerator.toString() : this.ctx.numbers === 'decimal' ? decimalText(c) : undefined;
    if (decimal !== undefined) return product([signed(numberNode(decimal)), ...factors]);
    const top = c.numerator === 1n ? product([signed(first), ...rest]) : product([signed(numberNode(c.numerator.toString())), ...factors]);
    return binary('/', top, numberNode(c.denominator.toString()));
  }

  /** Parts joined as a sum: the first one signed in place, the rest by `+` and `-`. */
  private join(parts: readonly Part[]): Node {
    let node: Node | undefined;
    for (const part of parts) {
      node = node === undefined ? part.node(part.negative) : binary(part.negative ? '-' : '+', node, part.node(false));
    }
    return node ?? numberNode('0');
  }

  private parts(p: Poly): Part[] {
    return [...p.values()]
      .sort((a, b) => this.compareTerms(a.m, b.m))
      .map(term => ({ negative: term.c.isNegative(), node: (negative: boolean) => this.termNode(term.c.abs(), term.m, negative) }));
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

  quotient(top: Node, bottom: Node): Node {
    return binary('/', top, bottom);
  }

  /** Always one fraction, constant denominators included: `(sqrt(5) + 1) / 2`. */
  fractionNode(r: RatFun): Node {
    const [num, den] = this.fractionParts(r);
    return constantValue(den)?.eq(1) === true ? this.polyNode(num) : binary('/', this.polyNode(num), this.polyNode(den));
  }

  /** A value as one fraction with integer coefficients on both sides, or a sum when the denominator is 1. */
  node(r: RatFun): Node {
    if (constantValue(r.den) !== undefined) return this.polyNode(r.num);
    const [num, den] = this.fractionParts(r);
    return binary('/', this.polyNode(num), this.polyNode(den));
  }

  /** A polynomial grouped by powers of generator `x`: `(2*pi + 3)*x + y`. */
  collectedNode(p: Poly, x: number): Node {
    const parts: Part[] = [];
    const coefficients = coefficientsIn(p, x);
    for (let i = coefficients.length - 1; i >= 0; i--) {
      const c = coefficients[i];
      if (c === undefined || c.size === 0) continue;
      const power = i === 0 ? undefined : i === 1 ? this.generatorNode(x) : binary('^', this.generatorNode(x), numberNode(String(i)));
      if (c.size === 1 || power === undefined) {
        parts.push(...this.parts(power === undefined ? c : fromCoefficientsIn([...Array.from({ length: i }, () => EMPTY), c], x)));
      } else {
        parts.push({ negative: false, node: () => binary('*', this.polyNode(c), power) });
      }
    }
    return this.join(parts);
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
        if (gen.fn === '!') return { kind: 'factorial', arg: args[0] ?? numberNode('0'), span: AT };
        return { kind: 'call', fn: gen.fn, args, notation: 'call', span: AT };
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
  return parse(text, {
    language: ctx.language,
    limits: { length: size, tokens: size, depth: 2 * depth + 2, nodes: 2 * nodes + 2 },
  });
}
