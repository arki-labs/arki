/**
 * Input (RFC §5.1): an expr AST becomes a `RatFun` over the call's
 * generators. Groups are transparent; literals are read exactly from `raw`
 * (`0.01` is 1/100); `pi` and `e` are generators; `i` is rejected (v1 is
 * real-only); anything that is not `+ - * / ^integer` becomes a kernel.
 *
 * Internal module.
 */
import type { BinaryNode, Expr, Node, Span } from '@arki/expr';
import { children, parse } from '@arki/expr';
import { isFailure } from '@arki/failure';
import { InvalidArgumentError } from '@arki/math/errors';
import { ratio } from '@arki/math/rational';

import type { Context, RatFun } from './context.js';
import type { CasInput } from './core.js';
import { rationalValue } from './context.js';
import { CasError } from './core.js';
import { Emitter, textOf } from './emit.js';
import { ParseRefused } from './failures.js';
import { constant, constantValue, generator } from './poly.js';

/** Parses a string, or checks a given AST against the `nodes` and `depth` budgets (without recursion). */
export function inputExpr(input: CasInput, ctx: Context): Expr {
  const { nodes, depth } = ctx.budget.limits;
  if (typeof input === 'string') {
    const parsed = parse(input, { language: ctx.language, limits: { nodes, depth } });
    if (isFailure(parsed)) throw new ParseRefused(parsed);
    return parsed;
  }
  // Stored ASTs come from JSON: check the version at run time, whatever the type says.
  const version: number = input.version;
  if (version !== 1) throw new InvalidArgumentError(`cas reads expr AST version 1, got ${String(version)}`);
  let count = 0;
  const stack: [Node, number][] = [[input.root, 1]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [node, d] = item;
    ctx.budget.check('nodes', ++count);
    ctx.budget.check('depth', d);
    for (const child of children(node)) stack.push([child, d + 1]);
  }
  return input;
}

/** Digits a literal's exact value needs, estimated from its text (`1e-7` → 8). */
function literalDigits(raw: string): number {
  const [mantissa = '', exponent = '0'] = raw.toLowerCase().split('e');
  const size = mantissa.replace('.', '').length + Math.abs(Number(exponent));
  return Number.isFinite(size) ? size : Number.POSITIVE_INFINITY;
}

/** Equal kernels have equal keys; names are ordered by name, so the key does not depend on how the input was written. */
function kernelKey(fn: string, args: readonly RatFun[], ctx: Context): string {
  const emitter = new Emitter(ctx, undefined, true);
  return `${fn}(${args.map(arg => textOf(emitter.node(arg), ctx)).join(', ')})`;
}

/** The kernel `fn(args)` as a value; equal kernels are one generator. */
export function kernelValue(fn: string, args: readonly RatFun[], span: Span, ctx: Context): RatFun {
  return ctx.generatorValue(ctx.kernel(fn, args, kernelKey(fn, args, ctx), span));
}

function kernel(fn: string, args: readonly RatFun[], node: Node, ctx: Context): RatFun {
  return kernelValue(fn, args, node.span, ctx);
}

function isGenerator(r: RatFun, g: number): boolean {
  if (constantValue(r.den) === undefined || r.num.size !== 1) return false;
  const [key] = generator(g).keys();
  const term = key === undefined ? undefined : r.num.get(key);
  return term !== undefined && term.c.eq(1);
}

/**
 * `base^exponent`: a polynomial power for an integer exponent, a power of
 * `sqrt(base)` for a half-integer one (`x^(1/2)` and `sqrt(x)` are one
 * kernel, so they cancel and simplify together), `exp(u)` for `e^u`, else a
 * kernel.
 */
function readPower(base: RatFun, exponent: RatFun, node: Node, ctx: Context): RatFun {
  const n = rationalValue(exponent);
  if (n?.isInteger() === true) {
    // `power` checks degree and digits from the exponent before any arithmetic.
    return ctx.power(base, Number(n.numerator));
  }
  if (isGenerator(base, ctx.e())) return kernel('exp', [exponent], node, ctx);
  if (n?.denominator === 2n) {
    const root = kernel('sqrt', [base], node, ctx);
    return n.numerator === 1n ? root : ctx.power(root, Number(n.numerator));
  }
  return kernel('^', [base, exponent], node, ctx);
}

function readBinary(node: BinaryNode, ctx: Context): RatFun {
  const left = read(node.left, ctx);
  const right = read(node.right, ctx);
  switch (node.op) {
    case '+': {
      return ctx.add(left, right);
    }
    case '-': {
      return ctx.add(left, ctx.negate(right));
    }
    case '*': {
      return ctx.multiply(left, right);
    }
    case '/': {
      return ctx.divide(left, right);
    }
    case '^': {
      return readPower(left, right, node, ctx);
    }
  }
}

/**
 * Reads a node. Recursion is bounded by the input's depth, checked by
 * `inputExpr`. With `ctx.cache` set, a shared subtree is read once.
 */
export function read(node: Node, ctx: Context): RatFun {
  const cache = ctx.cache;
  if (cache === undefined) return readNode(node, ctx);
  const known = cache.get(node);
  if (known !== undefined) return known;
  const value = readNode(node, ctx);
  cache.set(node, value);
  return value;
}

function readNode(node: Node, ctx: Context): RatFun {
  switch (node.kind) {
    case 'number': {
      ctx.budget.check('digits', literalDigits(node.raw));
      return ctx.fromPoly(constant(ratio(node.raw)));
    }
    case 'name': {
      if (ctx.language.constantSpec(node.name) === undefined) return ctx.generatorValue(ctx.name(node.name, node.span));
      if (node.name === 'pi') return ctx.generatorValue(ctx.pi());
      if (node.name === 'e') return ctx.generatorValue(ctx.e());
      if (node.name === 'i')
        throw new CasError('`i` is not a real number; cas works over the reals', 'not-in-domain', node.span);
      return ctx.generatorValue(ctx.atom(node.name, node.span));
    }
    case 'group': {
      return read(node.inner, ctx);
    }
    case 'unary': {
      const arg = read(node.arg, ctx);
      return node.op === '-' ? ctx.negate(arg) : arg;
    }
    case 'factorial': {
      return kernel('!', [read(node.arg, ctx)], node, ctx);
    }
    case 'binary': {
      return readBinary(node, ctx);
    }
    case 'call': {
      const args = node.args.map(arg => read(arg, ctx));
      const [first, second] = args;
      if (node.fn === 'pow' && first !== undefined && second !== undefined) return readPower(first, second, node, ctx);
      if (node.fn === 'exp' && first !== undefined && args.length === 1 && rationalValue(first)?.isInteger() === true) {
        return readPower(ctx.generatorValue(ctx.e()), first, node, ctx);
      }
      return kernel(node.fn, args, node, ctx);
    }
  }
}
