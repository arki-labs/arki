/**
 * `fromJSON` (RFC §6, §15): rebuilds an `Expr` or `Equation` from untrusted
 * AST JSON (a cache, a worker message). Every object must be plain with
 * exactly the expected keys; every field is checked; calls must name a
 * registered function with a valid arity; the length, depth and node budgets
 * run as in `parse`. The result is a fresh copy, never the input.
 */
import { is, plainObjectSchema } from '@arki/schema';

import type { CallNotation, Equation, Expr, Node, Warning, WarningCode } from './ast.js';
import type { Span } from './errors.js';
import type { Language } from './language.js';
import type { Limits, ResolvedLimits } from './limits.js';
import { ExprLimitError, ParseError } from './errors.js';
import { isLanguage, scientific } from './language.js';
import { isName, isNumberLiteral } from './lexer.js';
import { resolveLimits } from './limits.js';

export type FromJSONOptions = {
  /** The language the tree must belong to. Default `scientific`. */
  readonly language?: Language;
  readonly limits?: Limits;
};

type Fields = Readonly<Record<string, unknown>>;

const NODE_KEYS: Readonly<Record<Node['kind'], readonly string[]>> = {
  number: ['kind', 'raw', 'span'],
  name: ['kind', 'name', 'span'],
  unary: ['kind', 'op', 'arg', 'span'],
  binary: ['kind', 'op', 'left', 'right', 'implicit', 'span'],
  call: ['kind', 'fn', 'args', 'notation', 'span'],
  factorial: ['kind', 'arg', 'span'],
  group: ['kind', 'inner', 'span'],
};

const NODE_KINDS: readonly Node['kind'][] = ['number', 'name', 'unary', 'binary', 'call', 'factorial', 'group'];
const WARNING_CODES: readonly WarningCode[] = [
  'implicit-after-division',
  'implicit-after-power',
  'split-after-division',
];
const BINARY_OPS = ['+', '-', '*', '/', '^'] as const;
const NOTATIONS: readonly CallNotation[] = ['call', 'bars', 'radical'];
const NO_SPAN: Span = { start: 0, end: 0 };

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value;
}

function invalid(path: string, expected: readonly string[], found: unknown, span: Span = NO_SPAN): ParseError {
  return new ParseError(`Invalid AST at ${path}: expected ${expected.join(' or ')}, found ${describe(found)}`, {
    code: 'unexpected-token',
    span,
    expected,
    found: describe(found),
  });
}

function oneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  const names: readonly string[] = options;
  return typeof value === 'string' && names.includes(value);
}

class Reader {
  private readonly language: Language;
  private readonly limits: ResolvedLimits;
  private sourceLength = 0;
  private nodeCount = 0;

  constructor(options: FromJSONOptions) {
    const language = options.language ?? scientific;
    if (!isLanguage(language)) throw invalid('options.language', ['a language from defineLanguage'], language);
    this.language = language;
    this.limits = resolveLimits(options.limits);
  }

  record(value: unknown, keys: readonly string[], path: string): Fields {
    if (!is(value, plainObjectSchema)) throw invalid(path, ['a plain object'], value);
    const own = Object.keys(value);
    if (own.length !== keys.length || own.some(key => !keys.includes(key))) {
      throw invalid(path, [`exactly the keys ${keys.join(', ')}`], own.join(', '));
    }
    return value;
  }

  string(value: unknown, path: string): string {
    if (typeof value !== 'string') throw invalid(path, ['a string'], value);
    return value;
  }

  source(value: unknown): string {
    const source = this.string(value, 'source');
    if (source.length > this.limits.length) throw new ExprLimitError('length', this.limits.length, source.length);
    this.sourceLength = source.length;
    return source;
  }

  span(value: unknown, path: string): Span {
    const span = this.record(value, ['start', 'end'], path);
    const { start, end } = span;
    if (!isOffset(start) || !isOffset(end) || start > end || end > this.sourceLength) {
      throw invalid(path, [`0 <= start <= end <= ${this.sourceLength}`], `${describe(start)}..${describe(end)}`);
    }
    return { start, end };
  }

  warnings(value: unknown): Warning[] {
    if (!Array.isArray(value)) throw invalid('warnings', ['an array'], value);
    const items: unknown[] = value;
    if (items.length > this.limits.nodes) throw new ExprLimitError('nodes', this.limits.nodes, items.length);
    return items.map((item, index) => {
      const path = `warnings[${index}]`;
      const warning = this.record(item, ['code', 'span', 'message', 'hint'], path);
      const { code } = warning;
      if (!oneOf(WARNING_CODES, code)) throw invalid(`${path}.code`, WARNING_CODES, code);
      return {
        code,
        span: this.span(warning.span, `${path}.span`),
        message: this.string(warning.message, `${path}.message`),
        hint: this.string(warning.hint, `${path}.hint`),
      };
    });
  }

  node(value: unknown, path: string, depth: number): Node {
    if (depth > this.limits.depth) throw new ExprLimitError('depth', this.limits.depth, depth);
    this.nodeCount++;
    if (this.nodeCount > this.limits.nodes) throw new ExprLimitError('nodes', this.limits.nodes, this.nodeCount);
    if (!is(value, plainObjectSchema)) throw invalid(path, ['a node object'], value);
    const { kind } = value;
    if (!oneOf(NODE_KINDS, kind)) {
      throw invalid(`${path}.kind`, NODE_KINDS, kind);
    }
    const node = this.record(value, NODE_KEYS[kind], path);
    const span = this.span(node.span, `${path}.span`);
    const next = depth + 1;
    switch (kind) {
      case 'number': {
        const raw = this.string(node.raw, `${path}.raw`);
        if (!isNumberLiteral(raw)) {
          throw new ParseError(`Invalid AST at ${path}.raw: ${describe(raw)} is not a number literal`, {
            code: 'bad-number',
            span,
            expected: ['number literal'],
            found: describe(raw),
          });
        }
        return { kind, raw, span };
      }
      case 'name': {
        const name = this.string(node.name, `${path}.name`);
        if (!isName(name)) throw invalid(`${path}.name`, ['a name'], name, span);
        if (this.language.functionSpec(name) !== undefined) {
          throw invalid(`${path}.name`, ['a variable or constant'], `function ${name}`, span);
        }
        return { kind, name, span };
      }
      case 'unary': {
        const { op } = node;
        if (op !== '-' && op !== '+') throw invalid(`${path}.op`, ['-', '+'], op, span);
        return { kind, op, arg: this.node(node.arg, `${path}.arg`, next), span };
      }
      case 'factorial': {
        return { kind, arg: this.node(node.arg, `${path}.arg`, next), span };
      }
      case 'group': {
        return { kind, inner: this.node(node.inner, `${path}.inner`, next), span };
      }
      case 'binary': {
        const { op, implicit } = node;
        if (!oneOf(BINARY_OPS, op)) throw invalid(`${path}.op`, BINARY_OPS, op, span);
        if (typeof implicit !== 'boolean' || (implicit && op !== '*')) {
          throw invalid(`${path}.implicit`, op === '*' ? ['a boolean'] : ['false'], implicit, span);
        }
        const left = this.node(node.left, `${path}.left`, next);
        const right = this.node(node.right, `${path}.right`, next);
        return { kind, op, left, right, implicit, span };
      }
      case 'call': {
        return this.call(node, path, span, next);
      }
    }
  }

  private call(node: Fields, path: string, span: Span, next: number): Node {
    const fn = this.string(node.fn, `${path}.fn`);
    const { notation, args } = node;
    if (!oneOf(NOTATIONS, notation)) throw invalid(`${path}.notation`, NOTATIONS, notation, span);
    if (!Array.isArray(args)) throw invalid(`${path}.args`, ['an array'], args, span);
    const items: unknown[] = args;
    const spec = this.language.functionSpec(fn);
    if (spec === undefined) {
      throw new ParseError(`Invalid AST at ${path}.fn: "${fn}" is not a function in this language`, {
        code: 'not-a-function',
        span,
        expected: this.language.functionNames(),
        found: fn,
      });
    }
    const [min, max] = spec.arity;
    const required = notation === 'bars' ? 'abs' : notation === 'radical' ? 'sqrt' : undefined;
    if (required !== undefined && (fn !== required || items.length !== 1)) {
      throw invalid(
        `${path}`,
        [`${notation} notation with ${required} and one argument`],
        `${fn} with ${items.length}`,
        span,
      );
    }
    if (items.length < min || items.length > max) {
      throw new ParseError(`Invalid AST at ${path}: "${fn}" takes ${min} to ${max} argument(s), got ${items.length}`, {
        code: 'arity',
        span,
        expected: [min === max ? `${min}` : `${min} to ${max}`],
        found: String(items.length),
      });
    }
    // Arity is bounded by the language, so this loop is bounded before any recursion.
    const parsed = items.map((arg, index) => this.node(arg, `${path}.args[${index}]`, next));
    return { kind: 'call', fn, args: parsed, notation, span };
  }
}

/**
 * Rebuilds an expression or equation from AST JSON (the value, not the
 * text: pass `JSON.parse(text)`). Throws `ParseError` for anything that is
 * not a valid version-1 tree in `options.language`, and `ExprLimitError`
 * when it is over budget. Pre-1.0 there is no migration: only version 1 is
 * accepted.
 */
export function fromJSON(value: unknown, options: FromJSONOptions = {}): Expr | Equation {
  const reader = new Reader(options);
  if (!is(value, plainObjectSchema)) throw invalid('(root)', ['an object'], value);
  const isEquation = 'left' in value;
  const record = reader.record(
    value,
    isEquation ? ['version', 'source', 'left', 'right', 'warnings'] : ['version', 'source', 'root', 'warnings'],
    '(root)',
  );
  if (record.version !== 1) throw invalid('version', ['1'], record.version);
  const source = reader.source(record.source);
  const warnings = reader.warnings(record.warnings);
  if (isEquation) {
    const left = reader.node(record.left, 'left', 1);
    const right = reader.node(record.right, 'right', 1);
    return { version: 1, source, left, right, warnings };
  }
  return { version: 1, source, root: reader.node(record.root, 'root', 1), warnings };
}
