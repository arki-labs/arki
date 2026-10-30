/**
 * Recursive-descent parser for the grammar of RFC §4. Precedence, high to low:
 * literals/names/calls/groups/bars/radicals, postfix `!`, right-associative
 * `^` (whose exponent is a unary), unary `-`/`+`, `*` `/` and implicit
 * multiplication (left to right), binary `+`/`-`, and `=` in equations only.
 *
 * Every recursion passes through `enter`, so nesting is bounded by the depth
 * budget before the stack is: a 100 000-paren input throws `ExprLimitError`,
 * never `RangeError`.
 */
import { attempt } from '@arki/failure';
import { InvalidArgumentError } from '@arki/math/errors';

import type { BinaryNode, CallNode, Equation, Expr, Node, Warning } from './ast.js';
import type { Language } from './language.js';
import type { Token } from './lexer.js';
import type { Limits, ResolvedLimits } from './limits.js';
import type { Syntax } from './syntax.js';
import { ExprLimitError, ParseError, parseFailure } from './errors.js';
import { isLanguage, scientific } from './language.js';
import { tokenize } from './lexer.js';
import { resolveLimits } from './limits.js';
import { splitLetters } from './resolve.js';
import { canonical, decimalComma, defineSyntax } from './syntax.js';

export type ParseOptions = {
  /** The registered functions and constants. Default `scientific`. */
  readonly language?: Language;
  /** Decimal mark and argument separator. Default `canonical`. */
  readonly syntax?: Syntax;
  readonly limits?: Limits;
  /**
   * Names the host will declare as variables at compile. Only needed to read
   * a variable directly before `(` as a product (`x(y+1)`): without it, a name
   * that is neither a function nor a constant followed by `(` is a
   * `not-a-function` error, never a guess.
   */
  readonly variables?: readonly string[];
};

const OPERAND = ['number', 'name', '(', '|', '√', '-', '+'] as const;

type Context = 'paren' | 'bar';

function describe(token: Token, source: string): string {
  return token.kind === 'end' ? 'end of input' : source.slice(token.start, token.end);
}

class Parser {
  readonly warnings: Warning[] = [];
  private readonly source: string;
  private readonly tokens: readonly Token[];
  private readonly language: Language;
  private readonly variables: ReadonlySet<string> | undefined;
  private readonly limits: ResolvedLimits;
  private readonly contexts: Context[] = [];
  private readonly last: Token;
  private index = 0;
  private nodeCount = 0;
  private nest = 0;
  /** Depth of the node most recently returned by a parse method (a leaf is 1). */
  private depth = 0;

  constructor(
    source: string,
    tokens: readonly Token[],
    language: Language,
    variables: ReadonlySet<string> | undefined,
    limits: ResolvedLimits,
  ) {
    this.source = source;
    this.tokens = tokens;
    this.language = language;
    this.variables = variables;
    this.limits = limits;
    this.last = { kind: 'end', start: source.length, end: source.length, text: '' };
  }

  get current(): Token {
    return this.tokens[this.index] ?? this.last;
  }

  advance(): Token {
    const token = this.current;
    if (token.kind !== 'end') this.index++;
    return token;
  }

  /** Throws unless the next token is the end of input, explaining what stopped the parse. */
  expectEnd(allowEquals: boolean): void {
    const token = this.current;
    if (token.kind === 'end') return;
    if (token.kind === ')') {
      throw this.error('unbalanced-paren', token, 'This ")" has no matching "("', []);
    }
    if (token.kind === '=') {
      throw this.error(
        'unexpected-token',
        token,
        allowEquals ? 'An equation has at most one "="' : '"=" is only allowed in equations (use parseEquation)',
        ['end of input'],
      );
    }
    if (token.kind === 'sep') {
      throw this.error('unexpected-token', token, 'An argument separator is only allowed inside a function call', [
        'end of input',
      ]);
    }
    throw this.error('unexpected-token', token, `Unexpected "${describe(token, this.source)}"`, ['end of input']);
  }

  parseSum(): Node {
    let left = this.parseProduct();
    for (let token = this.current; token.kind === '+' || token.kind === '-'; token = this.current) {
      this.advance();
      const leftDepth = this.depth;
      const right = this.parseProduct();
      left = this.binary(token.kind, left, right, false, leftDepth);
    }
    return left;
  }

  private parseProduct(): Node {
    let left = this.parseUnary();
    for (;;) {
      const token = this.current;
      const leftDepth = this.depth;
      if (token.kind === '*' || token.kind === '/') {
        this.advance();
        const right = this.parseUnary();
        left = this.binary(token.kind, left, right, false, leftDepth);
      } else if (this.startsImplicitOperand(token)) {
        const right = this.parsePower();
        this.warnImplicit(left, right);
        left = this.binary('*', left, right, true, leftDepth);
      } else if (token.kind === 'number') {
        throw this.error(
          'unexpected-token',
          token,
          `A number cannot follow an operand: write "*" between them (for example 2*x, not x2 or (a)2)`,
          ['operator'],
        );
      } else {
        return left;
      }
    }
  }

  /** Juxtaposition: a name, `(`, `√`, or a `|` that cannot be closing one (RFC §4.3). */
  private startsImplicitOperand(token: Token): boolean {
    switch (token.kind) {
      case 'name':
      case '(':
      case 'radical': {
        return true;
      }
      case '|': {
        return this.contexts.at(-1) !== 'bar';
      }
      default: {
        return false;
      }
    }
  }

  private warnImplicit(left: Node, right: Node): void {
    let core = left;
    while (core.kind === 'unary') core = core.arg;
    if (core.kind !== 'binary' || core.implicit || (core.op !== '/' && core.op !== '^')) return;
    const text = (node: Node): string => this.source.slice(node.span.start, node.span.end);
    const prefix = this.source.slice(left.span.start, core.span.start);
    const [a, b, x] = [text(core.left), text(core.right), text(right)];
    const span = { start: left.span.start, end: right.span.end };
    const reading = this.source.slice(span.start, span.end);
    this.warnings.push(
      core.op === '/'
        ? {
            code: 'implicit-after-division',
            span,
            message: `"${reading}" reads as ${prefix}(${a}/${b})·${x}: implicit multiplication binds like * and /, left to right`,
            hint: `write ${prefix}(${a}/${b})${x} or ${prefix}${a}/(${b}${x})`,
          }
        : {
            code: 'implicit-after-power',
            span,
            message: `"${reading}" reads as ${prefix}(${a}^${b})·${x}: the exponent ends before the implicit multiplication`,
            hint: `write ${prefix}(${a}^${b})${x} or ${prefix}${a}^(${b}${x})`,
          },
    );
  }

  private parseUnary(): Node {
    const token = this.current;
    if (token.kind !== '-' && token.kind !== '+') return this.parsePower();
    this.advance();
    this.enter();
    const arg = this.parseUnary();
    this.leave();
    return this.finish(
      { kind: 'unary', op: token.kind, arg, span: { start: token.start, end: arg.span.end } },
      this.depth + 1,
    );
  }

  private parsePower(): Node {
    const base = this.parsePostfix();
    if (this.current.kind !== '^') return base;
    const baseDepth = this.depth;
    this.advance();
    this.enter();
    const exponent = this.parseUnary();
    this.leave();
    return this.binary('^', base, exponent, false, baseDepth);
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (let token = this.current; token.kind === '!'; token = this.current) {
      this.advance();
      node = this.finish(
        { kind: 'factorial', arg: node, span: { start: node.span.start, end: token.end } },
        this.depth + 1,
      );
    }
    return node;
  }

  private parsePrimary(): Node {
    const token = this.current;
    switch (token.kind) {
      case 'number': {
        this.advance();
        return this.finish({ kind: 'number', raw: token.text, span: { start: token.start, end: token.end } }, 1);
      }
      case 'name': {
        return this.parseName();
      }
      case '(': {
        return this.parseGroup();
      }
      case '|': {
        return this.parseBars();
      }
      case 'radical': {
        this.advance();
        this.requireFunction('sqrt', token, 1);
        this.enter();
        const arg = this.parsePrimary();
        this.leave();
        return this.finish(
          {
            kind: 'call',
            fn: 'sqrt',
            args: [arg],
            notation: 'radical',
            span: { start: token.start, end: arg.span.end },
          },
          this.depth + 1,
        );
      }
      case 'end': {
        throw this.error('unexpected-end', token, 'The expression ends where an operand was expected', OPERAND);
      }
      default: {
        throw this.error(
          'unexpected-token',
          token,
          `Expected a number, name, "(" or "|" but found "${describe(token, this.source)}"`,
          OPERAND,
        );
      }
    }
  }

  private parseName(): Node {
    const token = this.advance();
    const name = token.text;
    const spec = this.language.functionSpec(name);
    const next = this.current;
    if (spec !== undefined) {
      if (next.kind === '(') return this.parseCall(token, spec.arity);
      if (next.kind === '^') {
        throw this.error(
          'unexpected-token',
          next,
          `"${name}" is a function and needs parentheses: write ${name}(x)^2 for a power of ${name}`,
          ['('],
        );
      }
      throw this.error(
        next.kind === 'end' ? 'unexpected-end' : 'unexpected-token',
        next,
        `"${name}" is a function and needs parentheses: write ${name}(x)`,
        ['('],
      );
    }
    if (next.kind === '(' && !this.isValue(name)) {
      throw this.error(
        'not-a-function',
        token,
        `"${name}" is not a function in this language. For a product, write ${name}*(…), or declare "${name}" in the variables option`,
        this.language.functionNames(),
      );
    }
    return this.finish({ kind: 'name', name, span: { start: token.start, end: token.end } }, 1);
  }

  /** A constant, a declared variable, or a split of declared single letters (RFC §4.3). */
  private isValue(name: string): boolean {
    const known = (candidate: string): boolean =>
      this.language.constantSpec(candidate) !== undefined || this.variables?.has(candidate) === true;
    return known(name) || splitLetters(name, known) !== undefined;
  }

  private parseCall(nameToken: Token, arity: readonly [number, number]): Node {
    const open = this.advance();
    this.enter();
    this.contexts.push('paren');
    const args: Node[] = [];
    let deepest = 0;
    if (this.current.kind !== ')') {
      for (;;) {
        args.push(this.parseSum());
        deepest = Math.max(deepest, this.depth);
        if (this.current.kind !== 'sep') break;
        this.advance();
      }
    }
    const close = this.expectClose(open, ['sep', ')']);
    this.contexts.pop();
    this.leave();
    const span = { start: nameToken.start, end: close.end };
    const [min, max] = arity;
    if (args.length < min || args.length > max) {
      const wanted = min === max ? `${min}` : `${min} to ${max}`;
      throw new ParseError(`"${nameToken.text}" takes ${wanted} argument(s), got ${args.length}`, {
        code: 'arity',
        span,
        expected: [wanted],
        found: String(args.length),
      });
    }
    const call: CallNode = { kind: 'call', fn: nameToken.text, args, notation: 'call', span };
    return this.finish(call, deepest + 1);
  }

  private parseGroup(): Node {
    const open = this.advance();
    this.enter();
    this.contexts.push('paren');
    const inner = this.parseSum();
    const innerDepth = this.depth;
    const close = this.expectClose(open, [')']);
    this.contexts.pop();
    this.leave();
    return this.finish({ kind: 'group', inner, span: { start: open.start, end: close.end } }, innerDepth + 1);
  }

  private parseBars(): Node {
    const open = this.advance();
    this.requireFunction('abs', open, 1);
    const next = this.current.kind;
    // A bar followed by nothing that can start an operand was meant to close a pair: `|x|y|`.
    if (next === 'end' || next === ')' || next === 'sep' || next === '=') {
      throw this.error('unbalanced-bar', open, 'This "|" opens an absolute value that is never closed', []);
    }
    this.enter();
    this.contexts.push('bar');
    const inner = this.parseSum();
    const innerDepth = this.depth;
    if (this.current.kind !== '|') {
      throw this.error('unbalanced-bar', open, 'This "|" opens an absolute value that is never closed', ['|']);
    }
    const close = this.advance();
    this.contexts.pop();
    this.leave();
    return this.finish(
      { kind: 'call', fn: 'abs', args: [inner], notation: 'bars', span: { start: open.start, end: close.end } },
      innerDepth + 1,
    );
  }

  private expectClose(open: Token, expected: readonly string[]): Token {
    const token = this.current;
    if (token.kind === ')') return this.advance();
    if (token.kind === 'end') {
      throw this.error('unbalanced-paren', open, 'This "(" is never closed', [')']);
    }
    throw this.error('unexpected-token', token, `Expected ")" but found "${describe(token, this.source)}"`, expected);
  }

  private requireFunction(fn: string, token: Token, arity: number): void {
    const spec = this.language.functionSpec(fn);
    if (spec === undefined || spec.arity[0] > arity || spec.arity[1] < arity) {
      throw this.error(
        'not-a-function',
        token,
        `"${describe(token, this.source)}" needs the function "${fn}" in the language`,
        [fn],
      );
    }
  }

  private binary(op: BinaryNode['op'], left: Node, right: Node, implicit: boolean, leftDepth: number): Node {
    const node: BinaryNode = {
      kind: 'binary',
      op,
      left,
      right,
      implicit,
      span: { start: left.span.start, end: right.span.end },
    };
    return this.finish(node, Math.max(leftDepth, this.depth) + 1);
  }

  private finish(node: Node, depth: number): Node {
    this.nodeCount++;
    if (this.nodeCount > this.limits.nodes) throw new ExprLimitError('nodes', this.limits.nodes, this.nodeCount);
    if (depth > this.limits.depth) throw new ExprLimitError('depth', this.limits.depth, depth);
    this.depth = depth;
    return node;
  }

  private enter(): void {
    this.nest++;
    // Each nesting level adds at least one tree level, so this never rejects a tree within budget.
    if (this.nest >= this.limits.depth) throw new ExprLimitError('depth', this.limits.depth, this.nest + 1);
  }

  private leave(): void {
    this.nest--;
  }

  private error(code: ParseError['code'], token: Token, message: string, expected: readonly string[]): ParseError {
    return new ParseError(message, {
      code,
      span: { start: token.start, end: token.end },
      expected,
      found: describe(token, this.source),
    });
  }
}

function validSyntax(syntax: Syntax | undefined): Syntax {
  if (syntax === undefined || syntax === canonical || syntax === decimalComma) return syntax ?? canonical;
  return defineSyntax(syntax);
}

function start(text: string, options: ParseOptions): Parser {
  if (typeof text !== 'string') throw new TypeError('parse expects a string');
  const limits = resolveLimits(options.limits);
  if (text.length > limits.length) throw new ExprLimitError('length', limits.length, text.length);
  const language = options.language ?? scientific;
  if (!isLanguage(language)) throw new InvalidArgumentError('options.language must be built by defineLanguage');
  const syntax = validSyntax(options.syntax);
  const variables = options.variables === undefined ? undefined : new Set(options.variables);
  return new Parser(text, tokenize(text, syntax, limits.tokens), language, variables, limits);
}

/**
 * Parses an expression, or returns `InvalidExpression` (`expr.invalid_text`; the
 * `ParseError` with its span is the `cause`) for text the grammar rejects and
 * `ExpressionOverBudget` (`expr.over_budget`) when a budget breaks. Warnings
 * flag legal but easily misread inputs such as `1/2x`. A non-string `text` or a
 * language not built by `defineLanguage` is a bug and still throws.
 */
export function parse(text: string, options: ParseOptions = {}) {
  return attempt(() => parseText(text, options), parseFailure);
}

/** `parse` for text that is a bug if it fails (the engine's own text): throws the `ParseError` or `ExprLimitError`. */
export function parseText(text: string, options: ParseOptions = {}): Expr {
  const parser = start(text, options);
  const root = parser.parseSum();
  parser.expectEnd(false);
  return { version: 1, source: text, root, warnings: parser.warnings };
}

/** Parses `lhs = rhs`, with exactly one `=`. Returns the same failures as {@link parse}. */
export function parseEquation(text: string, options: ParseOptions = {}) {
  return attempt(() => parseEquationText(text, options), parseFailure);
}

/** `parseEquation` for text that is a bug if it fails: throws the `ParseError` or `ExprLimitError`. */
export function parseEquationText(text: string, options: ParseOptions = {}): Equation {
  const parser = start(text, options);
  const left = parser.parseSum();
  const equals = parser.current;
  if (equals.kind !== '=') {
    if (equals.kind === 'end') {
      throw new ParseError('An equation needs "="', {
        code: 'unexpected-end',
        span: { start: equals.start, end: equals.end },
        expected: ['='],
        found: 'end of input',
      });
    }
    parser.expectEnd(true);
  }
  parser.advance();
  const right = parser.parseSum();
  parser.expectEnd(true);
  return { version: 1, source: text, left, right, warnings: parser.warnings };
}
