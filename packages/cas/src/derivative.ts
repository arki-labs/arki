/**
 * `@arki/cas/derivative` (RFC §9): symbolic derivatives of any order, with
 * conditions. Only the result is built here; the rule-by-rule derivation tree
 * is `@arki/cas/derivation`, and none of its code is imported by this entry.
 */
import type { CasInput, CasOptions, CasResult } from './core.js';
import { differentiateOrders } from './differentiate.js';

export type DerivativeOptions = CasOptions & {
  /** How many times to differentiate. Default 1; at most the `order` budget (default 10). */
  readonly order?: number;
  /** False returns the last order's raw derivative (`fold` applied only) instead of the readable normal form. Default true. */
  readonly simplify?: boolean;
};

/**
 * The derivative of `input` with respect to `variable`; every other name is a
 * constant (a partial derivative). Higher orders are normalized between
 * orders. `conditions` lists where the result holds: the input's restrictions
 * the result no longer shows (`ln(x)` → `1/x` needs `x > 0`, reason `domain`)
 * and the points where a rule needs more (`abs(x)` → `sign(x)` needs `x ≠ 0`,
 * reason `differentiable`).
 *
 * ```ts
 * derivative('x^3 - 2*x^2 + x', 'x').result.source; // '3 * x^2 - 4 * x + 1'
 * derivative('sin(x^2)', 'x').result.source; // '2 * x * cos(x^2)'
 * derivative('ln(x)', 'x'); // '1 / x', conditions: [x > 0]
 * derivative('x^5', 'x', { order: 5 }).result.source; // '120'
 * ```
 *
 * Throws `CasError` `not-differentiable` for `floor ceil round fix sign mod`
 * of the variable, `unsupported-function` for `factorial`, `gamma` and host
 * functions, and `bad-variable` when `variable` is a constant or function.
 */
export function derivative(input: CasInput, variable: string, options: DerivativeOptions = {}): CasResult {
  const { result, conditions } = differentiateOrders(input, variable, options, false);
  return { result, conditions };
}

export type { CasInput, CasOptions, CasResult, Condition } from './core.js';
