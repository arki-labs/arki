/**
 * The differentiator (RFC §9.1) and the loop over orders that `derivative`
 * and `derivation` share (§9.2).
 *
 * It works rule by rule on the expr tree, so a derivation can show each
 * rule. Every subtree gets a structural id (hash-consing), and a derivative
 * is memoized per id, so each distinct subterm is derived once and the cost
 * is linear in the DAG, not in the unfolded tree. The raw derivative has
 * `fold` applied only; each order is then normalized by the rule table.
 * Steps are recorded only when the caller passes a list to record into:
 * `derivative` never does, so a rule costs one check.
 *
 * Internal module.
 */
import type { BinaryNode, CallNode, Expr, Node } from '@arki/expr';
import type { Rational } from '@arki/math/rational';
import { InvalidArgumentError } from '@arki/math/errors';
import { ratio } from '@arki/math/rational';

import type { Domain } from './conditions.js';
import type { RatFun } from './context.js';
import type { CasInput, CasOptions, Condition } from './core.js';
import type { Normal } from './normal.js';
import { inputDomain, lostConditions } from './conditions.js';
import { Context } from './context.js';
import { CasError } from './core.js';
import { binary, decimalText, exprOf, minus, numberNode } from './emit.js';
import { normalize, Readable } from './normal.js';
import { constantValue, normalized, squareFreePart } from './poly.js';
import { inputExpr, read } from './read.js';
import { holds, SignOracle } from './sign.js';

/** The differentiation rules of RFC §9.3. */
export type DerivativeRule =
  | 'constant'
  | 'variable'
  | 'sum'
  | 'constant-multiple'
  | 'product'
  | 'quotient'
  | 'power'
  | 'exponential'
  | 'general-power'
  | 'logarithm'
  | 'function'
  | 'root'
  | 'absolute-value'
  | 'chain';

/**
 * One rule application as the differentiator records it. Steps hold trees,
 * not printed text, so a derivation can check its budgets before printing.
 */
export type RawStep = {
  readonly rule: DerivativeRule | 'repeat';
  /** The function a `function`, `logarithm`, `root`, `exponential` or `absolute-value` step differentiates. */
  readonly fn: string | undefined;
  readonly key: string;
  readonly params: Readonly<Record<string, Node | string>>;
  readonly before: Node;
  after: Node;
  readonly children: RawStep[];
  /** For `repeat`: the step that derived this subterm first. */
  readonly of: RawStep | undefined;
  /** For `absolute-value`: the rule holds where this is non-zero. */
  readonly nonzero: Node | undefined;
};

type Params = Readonly<Record<string, Node | string>>;

/** What to do with one node: its rule, and a body that derives the children (into `kids` when recording). */
type Plan = {
  readonly rule: DerivativeRule;
  readonly fn?: string;
  readonly key: string;
  readonly params: Params;
  readonly nonzero?: Node;
  readonly body: (kids: RawStep[] | undefined) => Node;
};

const AT = { start: 0, end: 0 };
const ZERO = numberNode('0');
const ONE = numberNode('1');
const TWO = numberNode('2');

/** Their derivative is 0 almost everywhere; 0 would hide the jumps (RFC §9.1). */
const NOT_DIFFERENTIABLE: ReadonlySet<string> = new Set(['floor', 'ceil', 'round', 'fix', 'sign', 'mod', 'max', 'min']);

function call(fn: string, ...args: Node[]): Node {
  return { kind: 'call', fn, args, notation: 'call', span: AT };
}

/** Groups and unary `+` are transparent. */
function strip(node: Node): Node {
  let n = node;
  while (n.kind === 'group' || (n.kind === 'unary' && n.op === '+')) n = n.kind === 'group' ? n.inner : n.arg;
  return n;
}

/** The exact value of a literal tree: a number, a negated literal or a quotient of literals. */
function literal(node: Node): Rational | undefined {
  const n = strip(node);
  if (n.kind === 'number') return ratio(n.raw);
  if (n.kind === 'unary') return literal(n.arg)?.negated();
  if (n.kind !== 'binary' || n.op !== '/') return undefined;
  const [a, b] = [literal(n.left), literal(n.right)];
  return a === undefined || b === undefined || b.isZero() ? undefined : a.dividedBy(b);
}

/**
 * Builds trees with `fold` (RFC §7): literal arithmetic, `0*u`, `u + 0`,
 * `1*u`, `u^1`, `u/1`. Nothing else is rewritten, so a step shows the
 * textbook form of its rule.
 */
class Fold {
  private readonly decimal: boolean;

  constructor(ctx: Context) {
    this.decimal = ctx.numbers === 'decimal';
  }

  value(q: Rational): Node {
    if (q.isNegative()) return minus(this.value(q.negated()));
    if (q.isInteger()) return numberNode(q.numerator.toString());
    const decimal = this.decimal ? decimalText(q) : undefined;
    if (decimal !== undefined) return numberNode(decimal);
    return binary('/', numberNode(q.numerator.toString()), numberNode(q.denominator.toString()));
  }

  negate(a: Node): Node {
    const n = strip(a);
    const la = literal(n);
    if (la !== undefined) return this.value(la.negated());
    return n.kind === 'unary' ? n.arg : minus(a);
  }

  plus(a: Node, b: Node): Node {
    const [la, lb] = [literal(a), literal(b)];
    if (la !== undefined && lb !== undefined) return this.value(la.plus(lb));
    if (la?.isZero() === true) return b;
    if (lb?.isZero() === true) return a;
    const nb = strip(b);
    if (lb?.isNegative() === true) return binary('-', a, this.value(lb.negated()));
    return nb.kind === 'unary' ? binary('-', a, nb.arg) : binary('+', a, b);
  }

  minus(a: Node, b: Node): Node {
    const [la, lb] = [literal(a), literal(b)];
    if (la !== undefined && lb !== undefined) return this.value(la.minus(lb));
    if (lb?.isZero() === true) return a;
    if (la?.isZero() === true) return this.negate(b);
    const nb = strip(b);
    if (lb?.isNegative() === true) return binary('+', a, this.value(lb.negated()));
    return nb.kind === 'unary' ? binary('+', a, nb.arg) : binary('-', a, b);
  }

  times(a: Node, b: Node): Node {
    const [la, lb] = [literal(a), literal(b)];
    if (la !== undefined && lb !== undefined) return this.value(la.times(lb));
    if (la?.isZero() === true || lb?.isZero() === true) return ZERO;
    if (la?.eq(1) === true) return b;
    if (lb?.eq(1) === true) return a;
    if (la?.eq(-1) === true) return this.negate(b);
    if (lb?.eq(-1) === true) return this.negate(a);
    const [na, nb] = [strip(a), strip(b)];
    if (na.kind === 'unary') return this.negate(this.times(na.arg, b));
    if (nb.kind === 'unary') return this.negate(this.times(a, nb.arg));
    // A literal factor goes first: `2 * x`, not `x * 2`.
    return lb === undefined ? binary('*', a, b) : binary('*', b, a);
  }

  over(a: Node, b: Node): Node {
    const [la, lb] = [literal(a), literal(b)];
    if (la !== undefined && lb !== undefined && !lb.isZero()) return this.value(la.dividedBy(lb));
    if (lb?.eq(1) === true) return a;
    if (la?.isZero() === true && lb?.isZero() !== true) return ZERO;
    return binary('/', a, b);
  }

  pow(a: Node, b: Node): Node {
    const lb = literal(b);
    if (lb?.isZero() === true) return ONE;
    if (lb?.eq(1) === true) return a;
    return binary('^', a, b);
  }
}

/**
 * Derivatives of one order with respect to one variable. One instance per
 * order: ids and the memo belong to the tree being differentiated.
 */
export class Differentiator {
  /** The `u` of every `abs(u)` differentiated: its derivative holds where `u ≠ 0`. */
  readonly nonzero: Node[] = [];
  private readonly fold: Fold;
  private readonly variable: string;
  /** False after the first order: those trees are cas output, so a span would not point into the caller's text. */
  private readonly spans: boolean;
  private readonly ids = new Map<string, number>();
  private readonly idOf = new Map<Node, number>();
  private readonly varying: boolean[] = [];
  private readonly memo = new Map<number, { readonly after: Node; readonly step: RawStep | undefined }>();

  constructor(ctx: Context, variable: string, spans: boolean) {
    this.fold = new Fold(ctx);
    this.variable = variable;
    this.spans = spans;
  }

  /** Distinct subterms seen so far: the size of the DAG. */
  get size(): number {
    return this.ids.size;
  }

  /** The structural id of a subtree; groups and unary `+` share their operand's id. Recursion is bounded by the depth budget. */
  id(node: Node): number {
    const known = this.idOf.get(node);
    if (known !== undefined) return known;
    const [key, varies] = this.shape(node);
    // A group or unary `+` is its operand: `shape` returns the operand's id.
    const id = typeof key === 'number' ? key : this.intern(key, varies);
    this.idOf.set(node, id);
    return id;
  }

  private intern(key: string, varies: boolean): number {
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const id = this.ids.size;
    this.ids.set(key, id);
    this.varying[id] = varies;
    return id;
  }

  private shape(node: Node): readonly [string | number, boolean] {
    switch (node.kind) {
      case 'number': {
        return [`#${node.raw}`, false];
      }
      case 'name': {
        return [`$${node.name}`, node.name === this.variable];
      }
      case 'group': {
        return [this.id(node.inner), this.varies(node.inner)];
      }
      case 'unary': {
        const arg = this.id(node.arg);
        return node.op === '+' ? [arg, this.varies(node.arg)] : [`-(${arg})`, this.varies(node.arg)];
      }
      case 'factorial': {
        return [`!(${this.id(node.arg)})`, this.varies(node.arg)];
      }
      case 'binary': {
        const key = `${node.op}(${this.id(node.left)},${this.id(node.right)})`;
        return [key, this.varies(node.left) || this.varies(node.right)];
      }
      case 'call': {
        const key = `${node.fn}(${node.args.map(arg => this.id(arg)).join(',')})`;
        return [key, node.args.some(arg => this.varies(arg))];
      }
    }
  }

  /** True when the subtree contains the variable. */
  varies(node: Node): boolean {
    return this.varying[this.id(node)] === true;
  }

  /** The raw derivative of `node`; each rule application goes into `into` when the caller records steps. */
  derive(node: Node, into: RawStep[] | undefined): Node {
    const n = strip(node);
    if (!this.varies(n)) return this.leaf(into, 'constant', 'derivative.constant', { c: n }, n, ZERO);
    if (n.kind === 'name') return this.leaf(into, 'variable', 'derivative.variable', { x: n.name }, n, ONE);
    const id = this.id(n);
    const known = this.memo.get(id);
    if (known !== undefined) {
      into?.push({
        ...EMPTY_STEP,
        rule: 'repeat',
        key: 'derivative.repeat',
        before: n,
        after: known.after,
        of: known.step,
      });
      return known.after;
    }
    const plan = this.plan(n);
    const step: RawStep | undefined =
      into === undefined
        ? undefined
        : {
            ...EMPTY_STEP,
            rule: plan.rule,
            fn: plan.fn,
            key: plan.key,
            params: plan.params,
            before: n,
            after: n,
            children: [],
            nonzero: plan.nonzero,
          };
    if (step !== undefined) into?.push(step);
    const after = plan.body(step?.children);
    if (step !== undefined) step.after = after;
    this.memo.set(id, { after, step });
    return after;
  }

  private leaf(
    into: RawStep[] | undefined,
    rule: DerivativeRule,
    key: string,
    params: Params,
    before: Node,
    after: Node,
  ): Node {
    into?.push({ ...EMPTY_STEP, rule, key, params, before, after });
    return after;
  }

  private plan(node: Node): Plan {
    switch (node.kind) {
      case 'unary': {
        return this.scaled(minus(ONE), node.arg);
      }
      case 'binary': {
        return this.binary(node);
      }
      case 'call': {
        return this.call(node);
      }
      case 'factorial': {
        throw this.unsupported('factorial', node);
      }
      case 'number':
      case 'name':
      case 'group': {
        throw new Error('cas invariant: leaves and groups are handled before a rule is chosen');
      }
    }
  }

  private binary(node: BinaryNode): Plan {
    const [f, g] = [node.left, node.right];
    const fold = this.fold;
    switch (node.op) {
      case '+':
      case '-': {
        return this.sum(node);
      }
      case '*': {
        if (!this.varies(f)) return this.scaled(f, g);
        if (!this.varies(g)) return this.scaled(g, f);
        return {
          rule: 'product',
          key: 'derivative.product',
          params: { f, g },
          body: kids => {
            const [df, dg] = [this.derive(f, kids), this.derive(g, kids)];
            return fold.plus(fold.times(df, g), fold.times(f, dg));
          },
        };
      }
      case '/': {
        if (!this.varies(g)) {
          return {
            rule: 'constant-multiple',
            key: 'derivative.constant-divisor',
            params: { c: g, f },
            body: kids => fold.over(this.derive(f, kids), g),
          };
        }
        return {
          rule: 'quotient',
          key: 'derivative.quotient',
          params: { f, g },
          body: kids => {
            const [df, dg] = [this.derive(f, kids), this.derive(g, kids)];
            return fold.over(fold.minus(fold.times(df, g), fold.times(f, dg)), fold.pow(g, TWO));
          },
        };
      }
      case '^': {
        return this.power(node, f, g);
      }
    }
  }

  /** `(f ± g ± …)' = f' ± g' ± …`: one step for the whole chain of `+` and `-`. */
  private sum(node: BinaryNode): Plan {
    const terms: { readonly node: Node; readonly negative: boolean }[] = [];
    let rest: Node = node;
    for (let n = strip(rest); n.kind === 'binary' && (n.op === '+' || n.op === '-'); n = strip(rest)) {
      terms.push({ node: n.right, negative: n.op === '-' });
      rest = n.left;
    }
    terms.push({ node: rest, negative: false });
    terms.reverse();
    return {
      rule: 'sum',
      key: 'derivative.sum',
      params: {},
      body: kids => {
        let out = ZERO;
        for (const term of terms) {
          const d = this.derive(term.node, kids);
          out = term.negative ? this.fold.minus(out, d) : this.fold.plus(out, d);
        }
        return out;
      },
    };
  }

  /** `(c·f)' = c·f'` for a factor `c` without the variable. */
  private scaled(c: Node, f: Node): Plan {
    return {
      rule: 'constant-multiple',
      key: 'derivative.constant-multiple',
      params: { c, f },
      body: kids => this.fold.times(c, this.derive(f, kids)),
    };
  }

  private power(node: Node, base: Node, exponent: Node): Plan {
    const fold = this.fold;
    if (!this.varies(exponent)) {
      const outer = fold.times(exponent, fold.pow(base, fold.minus(exponent, ONE)));
      return this.outer(node, base, { rule: 'power', key: 'derivative.power', params: { n: exponent } }, outer);
    }
    if (!this.varies(base)) {
      const b = strip(base);
      if (b.kind === 'name' && b.name === 'e') {
        return this.outer(
          node,
          exponent,
          { rule: 'exponential', fn: 'exp', key: 'derivative.exponential.e', params: {} },
          node,
        );
      }
      const outer = fold.times(node, call('ln', base));
      return this.outer(
        node,
        exponent,
        { rule: 'exponential', key: 'derivative.exponential', params: { a: base } },
        outer,
      );
    }
    return {
      rule: 'general-power',
      key: 'derivative.general-power',
      params: { f: base, g: exponent },
      body: kids => {
        const [df, dg] = [this.derive(base, kids), this.derive(exponent, kids)];
        return fold.times(node, fold.plus(fold.times(dg, call('ln', base)), fold.over(fold.times(exponent, df), base)));
      },
    };
  }

  /**
   * A rule for the outer function at `u`. When `u` is not the variable
   * itself, the chain rule is its own step, with the outer rule and `u'` as
   * children: `sin(x^2)` is `chain` over `function` and `power`.
   */
  private outer(node: Node, u: Node, rule: Omit<Plan, 'body'>, outer: Node): Plan {
    if (rule.nonzero !== undefined) this.nonzero.push(rule.nonzero);
    const inner = strip(u);
    if (inner.kind === 'name' && inner.name === this.variable) return { ...rule, body: () => outer };
    return {
      rule: 'chain',
      key: 'derivative.chain',
      params: { u: inner },
      body: kids => {
        kids?.push({ ...EMPTY_STEP, ...rule, before: node, after: outer });
        return this.fold.times(outer, this.derive(inner, kids));
      },
    };
  }

  private call(node: CallNode): Plan {
    const fn = node.fn;
    const fold = this.fold;
    const [u, v] = node.args;
    if (NOT_DIFFERENTIABLE.has(fn)) {
      throw new CasError(
        `${fn} has jumps, so it has no derivative there; elsewhere its derivative is 0`,
        'not-differentiable',
        this.spans ? node.span : undefined,
      );
    }
    if (u === undefined) throw this.unsupported(fn, node);
    if (fn === 'pow' && v !== undefined) return this.power(node, u, v);
    // log(u, b) with a varying base is ln(u)/ln(b).
    if (fn === 'log' && v !== undefined && this.varies(v)) {
      const left = call('ln', u);
      return this.binary({ kind: 'binary', op: '/', left, right: call('ln', v), implicit: false, span: node.span });
    }
    if (v !== undefined && (this.varies(v) || (fn !== 'log' && fn !== 'nthRoot'))) throw this.unsupported(fn, node);
    const at = (rule: DerivativeRule, key: string, outer: Node, params: Params = {}, nonzero?: Node): Plan =>
      this.outer(node, u, { rule, fn, key, params, ...(nonzero === undefined ? {} : { nonzero }) }, outer);
    switch (fn) {
      case 'exp': {
        return at('exponential', 'derivative.exponential.e', node);
      }
      case 'ln':
      case 'log': {
        if (v === undefined) return at('logarithm', 'derivative.logarithm', fold.over(ONE, u));
        return at('logarithm', 'derivative.logarithm.base', fold.over(ONE, fold.times(u, call('ln', v))), { b: v });
      }
      case 'log10':
      case 'log2': {
        const b = numberNode(fn === 'log10' ? '10' : '2');
        return at('logarithm', 'derivative.logarithm.base', fold.over(ONE, fold.times(u, call('ln', b))), { b });
      }
      case 'sqrt':
      case 'nthRoot': {
        if (v === undefined) return at('root', 'derivative.root.sqrt', fold.over(ONE, fold.times(TWO, node)));
        const outer = fold.over(ONE, fold.times(v, fold.pow(node, fold.minus(v, ONE))));
        return at('root', 'derivative.root.nth', outer, { n: v });
      }
      case 'cbrt': {
        return at('root', 'derivative.root.cbrt', fold.over(ONE, fold.times(numberNode('3'), fold.pow(node, TWO))));
      }
      case 'abs': {
        return at('absolute-value', 'derivative.absolute-value', call('sign', u), {}, u);
      }
    }
    const derivative = FUNCTIONS[fn];
    if (derivative === undefined) throw this.unsupported(fn, node);
    return at('function', `derivative.function.${fn}`, derivative(u, fold));
  }

  private unsupported(fn: string, node: Node): CasError {
    return new CasError(`cas has no derivative for ${fn}`, 'unsupported-function', this.spans ? node.span : undefined);
  }
}

const EMPTY_STEP: RawStep = {
  rule: 'constant',
  fn: undefined,
  key: '',
  params: {},
  before: ZERO,
  after: ZERO,
  children: [],
  of: undefined,
  nonzero: undefined,
};

type Outer = (u: Node, f: Fold) => Node;

const square = (u: Node, f: Fold): Node => f.pow(u, TWO);
const reciprocal = (d: Node, f: Fold): Node => f.over(ONE, d);
/** 1/(|u|·√(u² − 1)) for asec and acsc. */
const arcsecant = (u: Node, f: Fold): Node =>
  reciprocal(f.times(call('abs', u), call('sqrt', f.minus(square(u, f), ONE))), f);

/** f'(u) for the functions of the `function` rule; the chain rule multiplies by u'. */
export const FUNCTIONS: Readonly<Record<string, Outer>> = {
  sin: u => call('cos', u),
  cos: (u, f) => f.negate(call('sin', u)),
  tan: (u, f) => square(call('sec', u), f),
  sec: (u, f) => f.times(call('sec', u), call('tan', u)),
  csc: (u, f) => f.negate(f.times(call('csc', u), call('cot', u))),
  cot: (u, f) => f.negate(square(call('csc', u), f)),
  asin: (u, f) => reciprocal(call('sqrt', f.minus(ONE, square(u, f))), f),
  acos: (u, f) => f.negate(reciprocal(call('sqrt', f.minus(ONE, square(u, f))), f)),
  atan: (u, f) => reciprocal(f.plus(ONE, square(u, f)), f),
  asec: arcsecant,
  acsc: (u, f) => f.negate(arcsecant(u, f)),
  acot: (u, f) => f.negate(reciprocal(f.plus(ONE, square(u, f)), f)),
  sinh: u => call('cosh', u),
  cosh: u => call('sinh', u),
  tanh: (u, f) => square(call('sech', u), f),
  sech: (u, f) => f.negate(f.times(call('sech', u), call('tanh', u))),
  csch: (u, f) => f.negate(f.times(call('csch', u), call('coth', u))),
  coth: (u, f) => f.negate(square(call('csch', u), f)),
  asinh: (u, f) => reciprocal(call('sqrt', f.plus(square(u, f), ONE)), f),
  acosh: (u, f) => reciprocal(call('sqrt', f.minus(square(u, f), ONE)), f),
  atanh: (u, f) => reciprocal(f.minus(ONE, square(u, f)), f),
  asech: (u, f) => f.negate(reciprocal(f.times(u, call('sqrt', f.minus(ONE, square(u, f)))), f)),
  acsch: (u, f) => f.negate(reciprocal(f.times(call('abs', u), call('sqrt', f.plus(ONE, square(u, f)))), f)),
  acoth: (u, f) => reciprocal(f.minus(ONE, square(u, f)), f),
};

/** One order of a run: what was differentiated, the raw derivative, its steps and its normal form. */
export type Order = {
  /** The tree this order differentiates: the input, then each previous order's result. */
  readonly input: Node;
  readonly raw: Node;
  readonly rawValue: RatFun;
  /** The differentiation tree, when steps were recorded: one root step. */
  readonly steps: readonly RawStep[] | undefined;
  /** The domain of the input and of every raw derivative up to this order. */
  readonly domain: Domain;
  /** The phases reading the raw derivative performed. */
  readonly notes: ReadonlySet<string>;
  /** The normalized derivative; `undefined` for a last order left raw (`simplify: false`). */
  readonly normal: Normal | undefined;
};

export type Run = {
  readonly ctx: Context;
  readonly orders: readonly Order[];
  readonly result: Expr;
  readonly conditions: readonly Condition[];
};

/** A derivation's step budget for one order: one rule step plus one possible `chain` step per DAG node, and 16 simplify steps. */
export function stepBound(dagNodes: number): number {
  return 2 * dagNodes + 16;
}

function merge(a: Domain, b: Domain): Domain {
  return { nonzero: [...a.nonzero, ...b.nonzero], signed: [...a.signed, ...b.signed] };
}

/** Unfolded size of a tree that may share subtrees, without unfolding it. */
export function treeSize(node: Node, memo: Map<Node, number>): number {
  const known = memo.get(node);
  if (known !== undefined) return known;
  let size = 1;
  switch (node.kind) {
    case 'group': {
      size += treeSize(node.inner, memo);
      break;
    }
    case 'unary':
    case 'factorial': {
      size += treeSize(node.arg, memo);
      break;
    }
    case 'binary': {
      size += treeSize(node.left, memo) + treeSize(node.right, memo);
      break;
    }
    case 'call': {
      for (const arg of node.args) size += treeSize(arg, memo);
      break;
    }
    case 'number':
    case 'name': {
      break;
    }
  }
  memo.set(node, size);
  return size;
}

/**
 * Differentiates `order` times, normalizing between orders. The conditions
 * cover the input's domain (a derivative exists only where the function is
 * defined), every raw derivative's domain, and `u ≠ 0` for each `abs(u)`
 * (reason `differentiable`). `record` keeps the steps for a derivation, with
 * the `steps` budget checked before each order.
 */
export function differentiateOrders(
  input: CasInput,
  variable: string,
  options: CasOptions & { readonly order?: number; readonly simplify?: boolean },
  record: boolean,
): Run {
  const ctx = new Context(options);
  ctx.checkVariable(variable);
  const order: number = options.order ?? 1;
  if (!Number.isSafeInteger(order) || order < 1) {
    throw new InvalidArgumentError(`order must be a positive integer, got ${String(order)}`);
  }
  ctx.budget.check('order', order);
  ctx.cache = new Map();
  const expr = inputExpr(input, ctx);
  read(expr.root, ctx);
  let domain = inputDomain(ctx);
  const orders: Order[] = [];
  const differentiable: Condition[] = [];
  let current = expr.root;
  let steps = 0;
  let result = expr;
  for (let k = 1; k <= order; k++) {
    const differentiator = new Differentiator(ctx, variable, k === 1);
    differentiator.id(current);
    if (record) {
      steps += stepBound(differentiator.size);
      ctx.budget.check('steps', steps);
    }
    const tree: RawStep[] | undefined = record ? [] : undefined;
    const raw = differentiator.derive(current, tree);
    const notes = new Set<string>();
    const [kernels, divisors] = [ctx.generators.length, ctx.divisors.length];
    ctx.notes = notes;
    const rawValue = read(raw, ctx);
    ctx.notes = undefined;
    domain = merge(domain, inputDomain(ctx, ctx.generators.length, ctx.divisors.length, kernels, divisors));
    differentiable.push(...nonzeroConditions(ctx, differentiator.nonzero));
    const last = k === order;
    const fixed = domain;
    const normal = last && options.simplify === false ? undefined : normalize(ctx, rawValue, () => fixed, notes);
    orders.push({ input: current, raw, rawValue, steps: tree, domain, notes, normal });
    if (normal === undefined) {
      ctx.budget.check('nodes', treeSize(raw, new Map()));
      result = exprOf(raw, ctx);
    } else {
      result = normal.result;
      current = normal.result.root;
    }
  }
  const final = orders.at(-1);
  if (final === undefined) throw new Error('cas invariant: at least one order was differentiated');
  const conditions = final.normal?.conditions ?? lostConditions(ctx, domain, final.rawValue, new Readable(ctx));
  const listed = new Set(conditions.map(c => `${c.relation}:${c.subject.source}`));
  const extra = differentiable.filter(c => {
    const key = `${c.relation}:${c.subject.source}`;
    if (listed.has(key)) return false;
    listed.add(key);
    return true;
  });
  return { ctx, orders, result, conditions: [...conditions, ...extra] };
}

/** `u ≠ 0` for each `abs(u)`, unless the sign oracle proves it from the expression alone. */
export function nonzeroConditions(ctx: Context, subjects: readonly Node[]): Condition[] {
  const oracle = new SignOracle(ctx, new Map());
  const out: Condition[] = [];
  for (const u of subjects) {
    const value = read(u, ctx);
    if (constantValue(value.num) !== undefined || holds(oracle.value(value).signs, 'nonzero')) continue;
    const part = squareFreePart(normalized(value.num), ctx.budget);
    out.push({ subject: exprOf(new Readable(ctx).polyNode(part), ctx), relation: 'nonzero', reason: 'differentiable' });
  }
  return out;
}
