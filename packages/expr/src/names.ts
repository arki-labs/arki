/**
 * Free-name analysis (C-23): which names an expression uses, sorted and
 * de-duplicated. Replaces hand-kept "known function" filters at call sites.
 */
import type { Equation, Expr } from './ast.js';
import type { Language } from './language.js';
import { walk } from './ast.js';
import { scientific } from './language.js';

export type Names = {
  /** Names that are not constants of the language: what `compile` must be told about. */
  readonly variables: string[];
  /** Constants of the language that appear (`pi`, `e`, …). */
  readonly constants: string[];
  /** Functions called, including `abs` for `|x|` and `sqrt` for `√x`. */
  readonly functions: string[];
};

function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort();
}

/**
 * The names `expr` uses. Identifiers are reported as typed: `xy` is one
 * variable here even if `compile` later reads it as `x·y`.
 */
export function names(expr: Expr | Equation, options: { readonly language?: Language } = {}): Names {
  const language = options.language ?? scientific;
  const variables = new Set<string>();
  const constants = new Set<string>();
  const functions = new Set<string>();
  const roots = 'root' in expr ? [expr.root] : [expr.left, expr.right];
  for (const root of roots) {
    walk(root, node => {
      if (node.kind === 'call') functions.add(node.fn);
      else if (node.kind === 'name') {
        (language.constantSpec(node.name) === undefined ? variables : constants).add(node.name);
      }
    });
  }
  return { variables: sorted(variables), constants: sorted(constants), functions: sorted(functions) };
}
