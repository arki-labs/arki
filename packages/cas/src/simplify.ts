/**
 * `@arki/cas/simplify` (RFC §7): the rational-function normal form plus the
 * kernel rules of the rule table, applied bottom-up to a fixed point, printed
 * in the readable normal form (RFC §5.4). The rules live in `normal.ts`,
 * shared with the derivative verbs.
 */
import type { CasInput, CasOptions } from './core.js';
import type { SimplifyResult } from './normal.js';
import { inputDomain } from './conditions.js';
import { Context } from './context.js';
import { normalize } from './normal.js';
import { inputExpr, read } from './read.js';

export type { SimplifyResult, SimplifyRule } from './normal.js';

/**
 * Simplifies by the rule table of RFC §7 and prints the readable normal
 * form. `conditions` lists every restriction of the input the result no
 * longer shows (reason `domain`) and every caller assumption a rewrite relied
 * on (reason `assumed`). `applied` lists the rule ids that changed something.
 *
 * ```ts
 * simplify('x/x').result.source; // '1', conditions: [x ≠ 0]
 * simplify('sqrt(x^2)').result.source; // 'abs(x)'
 * simplify('sqrt(x^2)', { assume: { x: 'nonnegative' } }); // 'x', conditions: [x ≥ 0 (assumed)]
 * simplify('exp(ln(x))'); // 'x', conditions: [x > 0]
 * simplify('ln(exp(x))'); // 'x', no conditions: it holds for every real x
 * ```
 */
export function simplify(input: CasInput, options: CasOptions = {}): SimplifyResult {
  const ctx = new Context(options);
  const notes = new Set<string>();
  ctx.notes = notes;
  const value = read(inputExpr(input, ctx).root, ctx);
  const [kernels, divisors] = [ctx.generators.length, ctx.divisors.length];
  const { result, conditions, applied } = normalize(ctx, value, () => inputDomain(ctx, kernels, divisors), notes);
  return { result, conditions, applied };
}

export type { Assumption, Assumptions, CasInput, CasOptions, CasResult, Condition } from './core.js';
