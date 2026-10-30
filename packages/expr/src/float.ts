/**
 * `@arki/expr/float`: the float domain (RFC §8, §10). Values are `number`s.
 * `compile` resolves every name once, then turns each node into a closure
 * specialised by operator and arity — no `eval`, no `new Function`.
 *
 * Two closure trees: the checked tree serves `f(scope)` and `f.at(x)` and
 * throws `@arki/math`'s typed errors instead of returning `NaN` or
 * ±Infinity; the unchecked IEEE tree serves `f.sample`, where `NaN` marks a
 * gap, and is built on its first call. A constant subtree is folded only
 * when the checked tree evaluates it to a finite number, which both trees
 * would return at every call anyway.
 */
import { attempt } from '@arki/failure';
import { DivisionByZeroError, InvalidArgumentError, NumericRangeError } from '@arki/math/errors';

import type { Equation, Expr, Node, Warning } from './ast.js';
import type { Part, Reading } from './bind.js';
import type { Angle, Binary, Builtin, Impl, Unary } from './float-builtins.js';
import type { ConstantNameOf, FunctionNameOf, Language, ScientificConstant, ScientificFunction } from './language.js';
import type { CompileLimits, Limits } from './limits.js';
import type { Syntax } from './syntax.js';
import { Binder } from './bind.js';
import { evaluationFailure, ExprLimitError, ParseError } from './errors.js';
import { builtins, FLOAT_CONSTANTS, powChecked } from './float-builtins.js';
import { isLanguage, scientific } from './language.js';
import { resolveCompileLimits } from './limits.js';
import { parseText } from './parser.js';

export type { Angle } from './float-builtins.js';
export type { Reading } from './bind.js';

/** A host function in this domain: numbers in, a number out. It never sees the AST or the scope. */
export type FloatFunction = (...args: number[]) => number;

/** Values for the declared variables. Extra keys are ignored. */
export type Scope<V extends string = string> = Readonly<Record<V, number>>;

/** The part of `AbortSignal` that `sample` reads. */
export type AbortSignalLike = { readonly aborted: boolean; readonly reason?: unknown };

export type SampleOptions = {
  /** Checked every 1 024 points; an aborted signal throws its `reason`. */
  readonly signal?: AbortSignalLike;
};

export type CompiledFunction<V extends string = string> = {
  /** Evaluates at `scope`. Throws a typed error instead of returning `NaN` or ±Infinity. */
  (scope?: Scope<V>): number;
  /** The single-variable fast path: no scope object. Throws unless exactly one variable is declared. */
  at(x: number): number;
  /**
   * Evaluates at every `xs[i]` into `out[i]` and returns `out`. A point
   * with no finite value is `NaN` — a gap in a plot (C-22). This is the
   * only call in the package that returns `NaN`.
   */
  sample(xs: Float64Array, out: Float64Array, options?: SampleOptions): Float64Array;
  /** The declared variables, in slot order. */
  readonly variables: readonly V[];
  /** Each multi-letter name read as a product of letters (`xy` → `x·y`). */
  readonly readings: readonly Reading[];
  /** The parse warnings plus `split-after-division` for `a/bc` read as `a/(b·c)`. */
  readonly warnings: readonly Warning[];
};

/** The three sides of a compiled equation; all share the same slots. */
export type CompiledEquation<V extends string = string> = {
  readonly left: CompiledFunction<V>;
  readonly right: CompiledFunction<V>;
  /** `left - right`, for root finding and back-substitution. */
  readonly difference: CompiledFunction<V>;
};

type Scientific = Language<ScientificFunction, ScientificConstant>;
type HostFunctionName<L> = Exclude<FunctionNameOf<L>, ScientificFunction>;
type HostConstantName<L> = Exclude<ConstantNameOf<L>, ScientificConstant>;

/**
 * Implementations for the host names of `L`: required by the types when the
 * language declares a function or constant that `scientific` does not have.
 */
export type HostImplementations<L> = ([HostFunctionName<L>] extends [never]
  ? { readonly functions?: Readonly<Record<string, FloatFunction>> }
  : { readonly functions: Readonly<Record<HostFunctionName<L>, FloatFunction>> }) &
  ([HostConstantName<L>] extends [never]
    ? { readonly constants?: Readonly<Record<string, number>> }
    : { readonly constants: Readonly<Record<HostConstantName<L>, number>> });

type CommonOptions<L> = {
  /** The language the expression was parsed with. Default `scientific`. */
  readonly language?: L;
  /** Unit for trigonometry: forward-trig arguments and inverse-trig results. Default `'rad'`. */
  readonly angle?: Angle;
};

export type CompileOptions<L extends Language = Scientific, V extends string = string> = CommonOptions<L> & {
  /** The variables, in slot order. Any other name must be a constant or split into declared letters. */
  readonly variables?: readonly V[];
  readonly limits?: CompileLimits;
} & HostImplementations<L>;

export type EvaluateOptions<L extends Language = Scientific> = CommonOptions<L> & {
  readonly syntax?: Syntax;
  /** Parse budgets plus the compile budgets. */
  readonly limits?: Limits & CompileLimits;
} & HostImplementations<L>;

type InternalOptions = {
  readonly language?: Language;
  readonly angle?: Angle;
  readonly limits?: CompileLimits;
  readonly functions?: Readonly<Record<string, FloatFunction>>;
  readonly constants?: Readonly<Record<string, number>>;
};

type Closure = (values: Float64Array) => number;

type BinaryOp = '+' | '-' | '*' | '/' | '^';

/** The resolved tree: names are slots or numbers, groups and unary `+` are gone. */
type Ir =
  | { readonly k: 'num'; readonly value: number }
  | { readonly k: 'var'; readonly slot: number }
  | { readonly k: 'prod'; readonly factors: readonly Ir[] }
  | { readonly k: 'neg'; readonly arg: Ir }
  | { readonly k: 'bin'; readonly op: BinaryOp; readonly left: Ir; readonly right: Ir }
  | { readonly k: 'unary'; readonly impl: Impl<Unary>; readonly arg: Ir }
  | { readonly k: 'binary'; readonly impl: Impl<Binary>; readonly left: Ir; readonly right: Ir }
  | { readonly k: 'host'; readonly name: string; readonly fn: FloatFunction; readonly args: readonly Ir[] };

const NO_VALUES = new Float64Array(0);

function overflow(op: string): NumericRangeError {
  return new NumericRangeError(`The result of ${op} is too large for a number`);
}

function hostResult(name: string, result: unknown): number {
  if (typeof result === 'number') {
    if (result - result === 0) return result;
    if (!Number.isNaN(result)) throw new NumericRangeError(`${name}(…) returned ${result}`);
  }
  throw new InvalidArgumentError(`${name}(…) returned ${typeof result === 'number' ? 'NaN' : 'a non-number'}`);
}

function checkedBinary(op: BinaryOp, left: Closure, right: Closure, rightIr: Ir): Closure {
  switch (op) {
    case '+': {
      return v => {
        const r = left(v) + right(v);
        if (r - r === 0) return r;
        throw overflow('+');
      };
    }
    case '-': {
      return v => {
        const r = left(v) - right(v);
        if (r - r === 0) return r;
        throw overflow('-');
      };
    }
    case '*': {
      return v => {
        const r = left(v) * right(v);
        if (r - r === 0) return r;
        throw overflow('*');
      };
    }
    case '/': {
      return v => {
        const n = left(v);
        const d = right(v);
        if (d === 0) throw new DivisionByZeroError(`Division by zero: ${n} / 0`);
        const r = n / d;
        if (r - r === 0) return r;
        throw overflow('/');
      };
    }
    case '^': {
      if (rightIr.k === 'num') {
        const exponent = rightIr.value;
        return v => powChecked(left(v), exponent);
      }
      return v => powChecked(left(v), right(v));
    }
  }
}

function uncheckedBinary(op: BinaryOp, left: Closure, right: Closure, rightIr: Ir): Closure {
  switch (op) {
    case '+': {
      return v => left(v) + right(v);
    }
    case '-': {
      return v => left(v) - right(v);
    }
    case '*': {
      return v => left(v) * right(v);
    }
    case '/': {
      return v => left(v) / right(v);
    }
    case '^': {
      if (rightIr.k === 'num') {
        const exponent = rightIr.value;
        return v => left(v) ** exponent;
      }
      return v => left(v) ** right(v);
    }
  }
}

function hostClosure(name: string, fn: FloatFunction, args: readonly Closure[], checked: boolean): Closure {
  const [a, b] = args;
  if (checked) {
    if (args.length === 0) return () => hostResult(name, fn());
    if (args.length === 1 && a !== undefined) return v => hostResult(name, fn(a(v)));
    if (args.length === 2 && a !== undefined && b !== undefined) return v => hostResult(name, fn(a(v), b(v)));
    return v => hostResult(name, fn(...args.map(arg => arg(v))));
  }
  if (args.length === 0) return () => fn();
  if (args.length === 1 && a !== undefined) return v => fn(a(v));
  if (args.length === 2 && a !== undefined && b !== undefined) return v => fn(a(v), b(v));
  return v => fn(...args.map(arg => arg(v)));
}

/** Builds a closure tree. Recursion follows the IR, whose depth is bounded by the `depth` budget. */
function closure(ir: Ir, checked: boolean): Closure {
  switch (ir.k) {
    case 'num': {
      const { value } = ir;
      return () => value;
    }
    case 'var': {
      const { slot } = ir;
      return v => v[slot] ?? Number.NaN;
    }
    case 'neg': {
      const arg = closure(ir.arg, checked);
      return v => -arg(v);
    }
    case 'prod': {
      const factors = ir.factors.map(factor => closure(factor, checked));
      return v => {
        let product = 1;
        for (const factor of factors) product *= factor(v);
        if (!checked || product - product === 0) return product;
        throw overflow('*');
      };
    }
    case 'bin': {
      const left = closure(ir.left, checked);
      const right = closure(ir.right, checked);
      return checked ? checkedBinary(ir.op, left, right, ir.right) : uncheckedBinary(ir.op, left, right, ir.right);
    }
    case 'unary': {
      const arg = closure(ir.arg, checked);
      const f = checked ? ir.impl.checked : ir.impl.raw;
      return v => f(arg(v));
    }
    case 'binary': {
      const left = closure(ir.left, checked);
      const right = closure(ir.right, checked);
      const f = checked ? ir.impl.checked : ir.impl.raw;
      return v => f(left(v), right(v));
    }
    case 'host': {
      return hostClosure(
        ir.name,
        ir.fn,
        ir.args.map(arg => closure(arg, checked)),
        checked,
      );
    }
  }
}

function isNum(ir: Ir): boolean {
  return ir.k === 'num';
}

/** Replaces a pure node whose operands are numbers by its value, when the checked tree gives a finite one. */
function fold(ir: Ir): Ir {
  const constant =
    ir.k === 'neg' || ir.k === 'unary'
      ? isNum(ir.arg)
      : ir.k === 'bin' || ir.k === 'binary'
        ? isNum(ir.left) && isNum(ir.right)
        : ir.k === 'prod' && ir.factors.every(factor => isNum(factor));
  if (!constant) return ir;
  try {
    return { k: 'num', value: closure(ir, true)(NO_VALUES) };
  } catch {
    return ir; // the error belongs to the call, not to compile
  }
}

function own<T>(table: Readonly<Record<string, T>> | undefined, name: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, name) ? table[name] : undefined;
}

function checkTable(table: unknown, what: 'functions' | 'constants'): void {
  if (table === undefined) return;
  if (typeof table !== 'object' || table === null) throw new InvalidArgumentError(`options.${what} must be an object`);
  for (const name of Object.keys(table)) {
    const value: unknown = Reflect.get(table, name);
    if (what === 'functions' ? typeof value !== 'function' : typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidArgumentError(
        `options.${what}.${name} must be ${what === 'functions' ? 'a function' : 'a finite number'}`,
      );
    }
  }
}

class IrBuilder {
  /** Steps one evaluation costs: one per node plus each host function's extra cost. */
  cost = 0;
  /** Whether any host function is called: only a host function can call back into a compiled function. */
  hosts = false;
  private readonly binder: Binder;
  private readonly table: ReadonlyMap<string, Builtin>;
  private readonly language: Language;
  private readonly functions: Readonly<Record<string, FloatFunction>> | undefined;
  private readonly constants: Readonly<Record<string, number>> | undefined;
  private readonly maxDepth: number;

  constructor(
    binder: Binder,
    table: ReadonlyMap<string, Builtin>,
    language: Language,
    options: InternalOptions,
    maxDepth: number,
  ) {
    this.binder = binder;
    this.table = table;
    this.language = language;
    this.functions = options.functions;
    this.constants = options.constants;
    this.maxDepth = maxDepth;
  }

  build(node: Node, depth: number): Ir {
    if (depth > this.maxDepth) throw new ExprLimitError('depth', this.maxDepth, depth);
    this.cost++;
    const next = depth + 1;
    switch (node.kind) {
      case 'number': {
        const value = Number(node.raw);
        if (Number.isNaN(value)) {
          throw new ParseError(`"${node.raw}" is not a number`, {
            code: 'bad-number',
            span: node.span,
            found: node.raw,
          });
        }
        if (!Number.isFinite(value)) throw new NumericRangeError(`The literal ${node.raw} is too large for a number`);
        return { k: 'num', value };
      }
      case 'name': {
        const resolution = this.binder.resolve(node);
        if (resolution.kind !== 'split') return this.part(resolution, node);
        const factors = resolution.parts.map(part => this.part(part, node));
        return fold({ k: 'prod', factors });
      }
      case 'group': {
        return this.build(node.inner, next);
      }
      case 'unary': {
        const arg = this.build(node.arg, next);
        return node.op === '+' ? arg : fold({ k: 'neg', arg });
      }
      case 'factorial': {
        const impl = this.table.get('factorial')?.unary;
        if (impl === undefined) throw new InvalidArgumentError('factorial is missing from the float built-ins');
        return fold({ k: 'unary', impl, arg: this.build(node.arg, next) });
      }
      case 'binary': {
        if (node.op === '/') this.binder.checkDivision(node);
        const left = this.build(node.left, next);
        const right = this.build(node.right, next);
        return fold({ k: 'bin', op: node.op, left, right });
      }
      case 'call': {
        return this.call(node.fn, node.args, node, next);
      }
    }
  }

  private part(part: Part, node: Node): Ir {
    return part.kind === 'variable' ? { k: 'var', slot: part.slot } : this.constant(part.name, node);
  }

  private constant(name: string, node: Node): Ir {
    const builtin = FLOAT_CONSTANTS.get(name);
    if (builtin !== undefined) return { k: 'num', value: builtin };
    const host = own(this.constants, name);
    if (host !== undefined) return { k: 'num', value: host };
    if (scientific.constantSpec(name) !== undefined) {
      throw new ParseError(`"${name}" is not a real number: the float domain has no "${name}"`, {
        code: 'not-in-domain',
        span: node.span,
        found: name,
      });
    }
    throw new InvalidArgumentError(`Constant "${name}" has no value: pass it in options.constants`);
  }

  private call(name: string, args: readonly Node[], node: Node, depth: number): Ir {
    const span = { start: node.span.start, end: Math.min(node.span.end, node.span.start + name.length) };
    const builtin = this.table.get(name);
    const [first, second] = args;
    if (builtin !== undefined) {
      if (args.length === 1 && first !== undefined && builtin.unary !== undefined) {
        return fold({ k: 'unary', impl: builtin.unary, arg: this.build(first, depth) });
      }
      if (args.length === 2 && first !== undefined && second !== undefined && builtin.binary !== undefined) {
        const left = this.build(first, depth);
        const right = this.build(second, depth);
        if (name === 'pow') return fold({ k: 'bin', op: '^', left, right });
        // log(x, 10) and log(x, 2) use the exact-at-powers log10/log2: log(1000, 10) is 3, not 2.9999999999999996.
        const base = name === 'log' && right.k === 'num' ? right.value : undefined;
        const impl = base === 10 || base === 2 ? this.table.get(base === 10 ? 'log10' : 'log2')?.unary : undefined;
        if (impl !== undefined) return fold({ k: 'unary', impl, arg: left });
        return fold({ k: 'binary', impl: builtin.binary, left, right });
      }
      throw new ParseError(`${name} does not take ${args.length} argument${args.length === 1 ? '' : 's'}`, {
        code: 'arity',
        span,
        found: name,
      });
    }
    const fn = own(this.functions, name);
    const spec = this.language.functionSpec(name);
    if (fn === undefined) {
      if (spec !== undefined) {
        throw new InvalidArgumentError(`Function "${name}" has no implementation: pass it in options.functions`);
      }
      throw new ParseError(`"${name}" is not a function`, { code: 'not-a-function', span, found: name });
    }
    if (spec !== undefined && (args.length < spec.arity[0] || args.length > spec.arity[1])) {
      throw new ParseError(`${name} does not take ${args.length} arguments`, { code: 'arity', span, found: name });
    }
    this.cost += (spec?.cost ?? 1) - 1;
    this.hosts = true;
    return { k: 'host', name, fn, args: args.map(arg => this.build(arg, depth)) };
  }
}

type Core = {
  readonly roots: readonly { readonly ir: Ir; readonly cost: number }[];
  readonly readings: readonly Reading[];
  readonly warnings: readonly Warning[];
  readonly steps: number;
  readonly reentrant: boolean;
};

function core(
  roots: readonly Node[],
  source: string,
  parsed: readonly Warning[],
  variables: readonly string[],
  options: InternalOptions,
): Core {
  const language = options.language ?? scientific;
  if (!isLanguage(language)) throw new InvalidArgumentError('options.language must be a language from defineLanguage');
  const angle: unknown = options.angle ?? 'rad';
  if (angle !== 'rad' && angle !== 'deg') throw new InvalidArgumentError(`options.angle must be 'rad' or 'deg'`);
  checkTable(options.functions, 'functions');
  checkTable(options.constants, 'constants');
  const limits = resolveCompileLimits(options.limits);
  const table = builtins(angle);
  const { functions, constants } = options;
  const binder = new Binder({
    variables,
    isConstant: name =>
      FLOAT_CONSTANTS.has(name) || language.constantSpec(name) !== undefined || own(constants, name) !== undefined,
    isFunction: name =>
      table.has(name) || language.functionSpec(name) !== undefined || own(functions, name) !== undefined,
    isOutsideDomain: name =>
      !FLOAT_CONSTANTS.has(name) && own(constants, name) === undefined && scientific.constantSpec(name) !== undefined,
    roots,
    source,
  });
  const builder = new IrBuilder(binder, table, language, options, limits.depth);
  const built = roots.map(root => {
    const before = builder.cost;
    const ir = builder.build(root, 1);
    const cost = builder.cost - before;
    if (cost > limits.steps) throw new ExprLimitError('steps', limits.steps, cost);
    return { ir, cost };
  });
  return {
    roots: built,
    readings: Object.freeze([...binder.readings]),
    warnings: Object.freeze([...parsed, ...binder.warnings]),
    steps: limits.steps,
    reentrant: builder.hosts,
  };
}

function scopeValue(scope: unknown, name: string): number {
  const value: unknown =
    typeof scope === 'object' && scope !== null && Object.hasOwn(scope, name) ? Reflect.get(scope, name) : undefined;
  if (typeof value === 'number' && value - value === 0) return value;
  throw new InvalidArgumentError(
    value === undefined
      ? `Missing value for variable "${name}"`
      : `Variable "${name}" must be a finite number, got ${typeof value === 'number' ? value : typeof value}`,
  );
}

function aborted(signal: AbortSignalLike): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('sample() was aborted');
}

function assemble<V extends string>(variables: readonly V[], ir: Ir, cost: number, shared: Core): CompiledFunction<V> {
  const checked = closure(ir, true);
  let unchecked: Closure | undefined;
  const count = variables.length;
  const names: readonly string[] = Object.freeze([...variables]);
  // One buffer per compiled function: no allocation per call. A host
  // function that calls back into this function gets a fresh buffer.
  const buffer = new Float64Array(count);
  let busy = false;
  const run = (values: Float64Array): number => {
    if (!shared.reentrant || values !== buffer) return checked(values);
    busy = true;
    try {
      return checked(values);
    } finally {
      busy = false;
    }
  };
  const slots = (): Float64Array => (busy ? new Float64Array(count) : buffer);
  const single = (): void => {
    if (count !== 1) {
      throw new InvalidArgumentError(`This needs exactly one declared variable; the function has ${count}`);
    }
  };

  const call = (scope?: Scope<V>): number => {
    const values = slots();
    for (let slot = 0; slot < count; slot++) values[slot] = scopeValue(scope, names[slot] ?? '');
    return run(values);
  };
  const at = (x: number): number => {
    single();
    if (x - x !== 0) throw new InvalidArgumentError(`at() needs a finite number, got ${x}`);
    const values = slots();
    values[0] = x;
    return run(values);
  };
  const sample = (xs: Float64Array, out: Float64Array, options?: SampleOptions): Float64Array => {
    single();
    if (!(xs instanceof Float64Array) || !(out instanceof Float64Array)) {
      throw new InvalidArgumentError('sample() takes two Float64Arrays');
    }
    const points = xs.length;
    if (out.length !== points) {
      throw new InvalidArgumentError(`sample(): out has length ${out.length}, xs has ${points}`);
    }
    if (cost * points > shared.steps) throw new ExprLimitError('steps', shared.steps, cost * points);
    unchecked ??= closure(ir, false);
    const f = unchecked;
    const signal = options?.signal;
    const values = new Float64Array(1);
    for (let index = 0; index < points; index++) {
      if ((index & 1023) === 0 && signal?.aborted === true) throw aborted(signal);
      values[0] = xs[index] ?? Number.NaN;
      const y = f(values);
      out[index] = y - y === 0 ? y : Number.NaN;
    }
    return out;
  };

  const compiled = Object.assign(call, {
    at,
    sample,
    variables: Object.freeze([...variables]),
    readings: shared.readings,
    warnings: shared.warnings,
  });
  Object.freeze(compiled);
  return compiled;
}

function rootOf(core: Core, index: number): { readonly ir: Ir; readonly cost: number } {
  const root = core.roots[index];
  if (root === undefined) throw new InvalidArgumentError('compile produced no tree');
  return root;
}

/**
 * Compiles an expression to a function of its declared variables. Throws
 * `ParseError` (`unknown-name`, `name-conflict`, `not-in-domain`, `arity`)
 * and `ExprLimitError` here, before any point is evaluated.
 *
 * ```ts
 * const f = compile(parse('2x^2 + sin(x)'), { variables: ['x'] });
 * f({ x: 1.5 }); f.at(1.5); f.sample(xs, out);
 * ```
 */
export function compile<const V extends string = never, L extends Language = Scientific>(
  expr: Expr,
  options?: CompileOptions<L, V>,
): CompiledFunction<V> {
  const variables: readonly V[] = [...(options?.variables ?? [])];
  const built = core([expr.root], expr.source, expr.warnings, variables, options ?? {});
  const root = rootOf(built, 0);
  return assemble(variables, root.ir, root.cost, built);
}

/** Compiles both sides of `lhs = rhs` and their difference, on one set of slots (C-14, C-17). */
export function compileEquation<const V extends string = never, L extends Language = Scientific>(
  equation: Equation,
  options?: CompileOptions<L, V>,
): CompiledEquation<V> {
  const variables: readonly V[] = [...(options?.variables ?? [])];
  const built = core([equation.left, equation.right], equation.source, equation.warnings, variables, options ?? {});
  const left = rootOf(built, 0);
  const right = rootOf(built, 1);
  const cost = left.cost + right.cost + 1;
  if (cost > built.steps) throw new ExprLimitError('steps', built.steps, cost);
  const difference = fold({ k: 'bin', op: '-', left: left.ir, right: right.ir });
  return Object.freeze({
    left: assemble(variables, left.ir, left.cost, built),
    right: assemble(variables, right.ir, right.cost, built),
    difference: assemble(variables, difference, cost, built),
  });
}

/** Parses, compiles and evaluates an expression with no variables: the keypad's one-shot call (C-15). Reads outside text, so it returns the value or a failure from `EVALUATE_FAILURES` (`expr.invalid_text`, `expr.over_budget`, `expr.no_value`, each with the thrown error as `cause`) and never throws for bad text. */
export function evaluate<L extends Language = Scientific>(text: string, options?: EvaluateOptions<L>) {
  const settings: EvaluateOptions<L> | undefined = options;
  return attempt(() => {
    const expr = parseText(text, { language: settings?.language, syntax: settings?.syntax, limits: settings?.limits });
    const built = core([expr.root], expr.source, expr.warnings, [], settings ?? {});
    const root = rootOf(built, 0);
    return closure(root.ir, true)(NO_VALUES);
  }, evaluationFailure);
}
