/**
 * Shared types, errors and budgets (RFC §10–§12). Internal module: the public
 * names are re-exported by `index.ts` and the verb entries.
 */
import type { Expr, Language, Span } from '@arki/expr';
import type { AbortSignalLike } from '@arki/expr/float';
import { InvalidArgumentError, MathError, ResourceLimitError } from '@arki/math/errors';

export type { AbortSignalLike } from '@arki/expr/float';

/** An expr AST, or a string parsed with expr's canonical `scientific` syntax. */
export type CasInput = Expr | string;

export type Relation = 'nonzero' | 'positive' | 'nonnegative';

/** A restriction the result relies on (RFC §6). `subject` is canonical, e.g. `x - 1`. */
export type Condition = {
  readonly subject: Expr;
  readonly relation: Relation;
  readonly reason: 'domain' | 'differentiable' | 'assumed';
};

/** Budgets (RFC §12). Each is a positive integer. */
export type CasLimits = {
  /** Nodes of the input tree, and of each output tree before printing. Default 5 000. */
  readonly nodes: number;
  /** Nesting depth of the input tree. Default 256. */
  readonly depth: number;
  /** Terms an expansion may produce, estimated before it runs. Default 10 000. */
  readonly terms: number;
  /** Degree in any one generator, checked before powers and products. Default 1 000. */
  readonly degree: number;
  /** Degree of the inputs of a polynomial gcd. Default 64. */
  readonly gcdDegree: number;
  /** Digits of any coefficient, estimated before multiplying; also the precision cap of π/e sign decisions. Default 1 000. */
  readonly digits: number;
  /** Arithmetic steps per call. Default 100 000. */
  readonly fuel: number;
};

export type CasOptions = {
  /** Functions and constants of the input. Default `scientific`. */
  readonly language?: Language;
  readonly limits?: Partial<CasLimits>;
  /** Checked every 1 024 fuel units; the call throws `signal.reason` once it is aborted. */
  readonly signal?: AbortSignalLike;
  /** `'fraction'` (default) prints `x/50`; `'decimal'` prints a terminating rational as a decimal (`0.02*x`). */
  readonly numbers?: 'fraction' | 'decimal';
};

export type CasResult = { readonly result: Expr; readonly conditions: readonly Condition[] };

/** Why a cas verb rejected its input. Apps translate messages by this code. */
export type CasErrorCode = 'unsupported-function' | 'not-differentiable' | 'not-in-domain' | 'bad-variable' | 'not-rational';

const REMEDIATION: Readonly<Record<CasErrorCode, string>> = {
  'unsupported-function': 'Remove the function at `span` or compute this case numerically.',
  'not-differentiable': 'Differentiate where the input is differentiable.',
  'not-in-domain': 'Remove the value at `span`; v1 works over the reals.',
  'bad-variable': 'Pass a name that is not a constant or function of the language.',
  'not-rational': 'Pass an input built from + - * / and integer powers only.',
};

/** The input is outside what a cas verb handles. Values never cause this; budgets throw `CasLimitError`. */
export class CasError extends MathError {
  readonly code: CasErrorCode;
  readonly remediation: string;
  /** Where in the input's `source` the problem is, when it has a place. */
  readonly span: Span | undefined;

  constructor(message: string, code: CasErrorCode, span?: Span) {
    super(message);
    this.code = code;
    this.remediation = REMEDIATION[code];
    this.span = span === undefined ? undefined : { start: span.start, end: span.end };
  }
}

export type CasBudget = keyof CasLimits;

/** An input went over one of its budgets. Thrown before the expensive work wherever a bound can be computed. */
export class CasLimitError extends ResourceLimitError {
  readonly budget: CasBudget;
  readonly limit: number;
  readonly actual: number;

  constructor(budget: CasBudget, limit: number, actual: number) {
    super(`cas ${budget} budget exceeded: ${actual} > ${limit}`);
    this.budget = budget;
    this.limit = limit;
    this.actual = actual;
  }
}

export const DEFAULT_LIMITS: CasLimits = Object.freeze({
  nodes: 5000,
  depth: 256,
  terms: 10_000,
  degree: 1000,
  gcdDegree: 64,
  digits: 1000,
  fuel: 100_000,
});

const BUDGETS: readonly CasBudget[] = ['nodes', 'depth', 'terms', 'degree', 'gcdDegree', 'digits', 'fuel'];

const SIGNAL_INTERVAL = 1024;

/** Per-call budgets and the abort signal. Created once per verb call, never shared. */
export class Budget {
  readonly limits: CasLimits;
  private readonly signal: AbortSignalLike | undefined;
  private used = 0;

  constructor(options: CasOptions) {
    this.limits = resolveLimits(options.limits);
    this.signal = options.signal;
    this.checkSignal();
  }

  /** Throws when `actual` is over the `budget`. */
  check(budget: CasBudget, actual: number): void {
    const limit = this.limits[budget];
    if (actual > limit) throw new CasLimitError(budget, limit, actual);
  }

  /** Counts `units` of arithmetic; checks the signal every 1 024 units. */
  spend(units: number): void {
    const before = Math.floor(this.used / SIGNAL_INTERVAL);
    this.used += units;
    if (this.used > this.limits.fuel) throw new CasLimitError('fuel', this.limits.fuel, this.used);
    if (Math.floor(this.used / SIGNAL_INTERVAL) !== before) this.checkSignal();
  }

  private checkSignal(): void {
    if (this.signal?.aborted === true) throw this.signal.reason;
  }
}

function resolveLimits(limits: Partial<CasLimits> | undefined): CasLimits {
  if (limits === undefined) return DEFAULT_LIMITS;
  const resolved: Record<CasBudget, number> = { ...DEFAULT_LIMITS };
  for (const key of BUDGETS) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new InvalidArgumentError(`limits.${key} must be a positive integer, got ${String(value)}`);
    }
    resolved[key] = value;
  }
  return resolved;
}
