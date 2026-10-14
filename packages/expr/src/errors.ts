/**
 * The two error classes this package adds to `@arki/math`'s family. The rule:
 * anything about the text is a `ParseError` with a span; anything about the
 * values is one of math's own errors, unchanged.
 */
import { MathError, ResourceLimitError } from '@arki/math/errors';

/** A range of the source text, as UTF-16 offsets (`start` inclusive, `end` exclusive). */
export type Span = { readonly start: number; readonly end: number };

/** Why a text, AST or language was rejected. Apps translate messages by this code. */
export type ParseErrorCode =
  | 'unexpected-token'
  | 'unexpected-end'
  | 'unbalanced-paren'
  | 'unbalanced-bar'
  | 'bad-number'
  | 'not-a-function'
  | 'unknown-name'
  | 'arity'
  | 'name-conflict'
  | 'not-in-domain';

/** The input text (or a stored AST) is not an expression this language accepts. */
export class ParseError extends MathError {
  readonly code: ParseErrorCode;
  readonly remediation = 'Fix the text at `span`; `expected` lists what fits there.';
  readonly span: Span;
  /** Same as `span.start`: where to put the caret. */
  readonly position: number;
  /** What the parser would have accepted at `span`, e.g. `['(']` or `['number', 'name']`. */
  readonly expected: readonly string[];
  /** The text found at `span`, or `'end of input'`. */
  readonly found: string;

  constructor(
    message: string,
    details: {
      readonly code: ParseErrorCode;
      readonly span: Span;
      readonly expected?: readonly string[];
      readonly found: string;
    },
  ) {
    super(message);
    this.code = details.code;
    this.span = { start: details.span.start, end: details.span.end };
    this.position = details.span.start;
    this.expected = Object.freeze([...(details.expected ?? [])]);
    this.found = details.found;
  }
}

/** The budget a limit applies to (RFC §11). Parsing checks the first four. */
export type Budget = 'length' | 'tokens' | 'depth' | 'nodes' | 'steps' | 'digits';

/** An input went over one of its budgets. Thrown before the expensive work, never after. */
export class ExprLimitError extends ResourceLimitError {
  readonly budget: Budget;
  readonly limit: number;
  /** The size seen when the budget broke; for streaming checks this is `limit + 1`. */
  readonly actual: number;

  constructor(budget: Budget, limit: number, actual: number) {
    super(`Expression ${budget} budget exceeded: ${actual} > ${limit}`);
    this.budget = budget;
    this.limit = limit;
    this.actual = actual;
  }
}
