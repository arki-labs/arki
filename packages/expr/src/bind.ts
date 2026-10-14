/**
 * Compile-time name resolution (RFC §4.3, §10), shared by every domain's
 * `compile`. Only `compile` knows the declared variables, so this is where an
 * identifier becomes a slot, a constant or a product of single letters.
 *
 * Order: (1) a declared variable or a constant with exactly that name; (2) a
 * split into single letters when every letter is a declared variable or a
 * constant (`xy` → `x·y`); (3) otherwise `unknown-name`. Function names never
 * split. Domain-free: the domain decides what a constant's value is.
 */
import { InvalidArgumentError } from '@arki/math/errors';

import type { BinaryNode, NameNode, Node, Warning } from './ast.js';
import type { Span } from './errors.js';
import { walk } from './ast.js';
import { ParseError } from './errors.js';
import { isName } from './lexer.js';
import { splitLetters } from './resolve.js';

/** A multi-letter name that `compile` read as a product of single letters. */
export type Reading = {
  readonly span: Span;
  /** The name as typed, e.g. `'xy'`. */
  readonly name: string;
  /** The letters it was read as, e.g. `['x', 'y']`. */
  readonly letters: readonly string[];
};

export type Part =
  | { readonly kind: 'variable'; readonly name: string; readonly slot: number }
  | { readonly kind: 'constant'; readonly name: string };

export type Resolution = Part | { readonly kind: 'split'; readonly parts: readonly Part[] };

export type BinderOptions = {
  readonly variables: readonly string[];
  readonly isConstant: (name: string) => boolean;
  readonly isFunction: (name: string) => boolean;
  /** The trees being compiled, to point a `name-conflict` at a use of the name. */
  readonly roots: readonly Node[];
  readonly source: string;
};

function firstUse(roots: readonly Node[], name: string): Span {
  let found: Span | undefined;
  for (const root of roots) {
    walk(root, node => {
      if (found === undefined && node.kind === 'name' && node.name === name) found = node.span;
      return found === undefined;
    });
  }
  return found ?? { start: 0, end: 0 };
}

function slice(source: string, node: Node): string {
  return source.slice(node.span.start, node.span.end);
}

export class Binder {
  readonly readings: Reading[] = [];
  readonly warnings: Warning[] = [];
  private readonly slots = new Map<string, number>();
  private readonly isConstant: (name: string) => boolean;
  private readonly isFunction: (name: string) => boolean;
  private readonly source: string;

  constructor(options: BinderOptions) {
    this.isConstant = options.isConstant;
    this.isFunction = options.isFunction;
    this.source = options.source;
    for (const name of options.variables) {
      if (typeof name !== 'string' || !isName(name)) {
        throw new InvalidArgumentError(`"${String(name)}" is not a valid variable name`);
      }
      if (this.slots.has(name)) throw new InvalidArgumentError(`Variable "${name}" is declared twice`);
      if (this.isConstant(name) || this.isFunction(name)) {
        const kind = this.isConstant(name) ? 'constant' : 'function';
        throw new ParseError(`"${name}" is a ${kind}; it cannot also be a variable`, {
          code: 'name-conflict',
          span: firstUse(options.roots, name),
          found: name,
        });
      }
      this.slots.set(name, this.slots.size);
    }
  }

  /** Slots in declaration order: the variable at index `i` lives in slot `i`. */
  get slotCount(): number {
    return this.slots.size;
  }

  private isValue = (name: string): boolean => this.slots.has(name) || this.isConstant(name);

  private part(name: string): Part {
    const slot = this.slots.get(name);
    return slot === undefined ? { kind: 'constant', name } : { kind: 'variable', name, slot };
  }

  /** The letters `name` splits into, or `undefined` when it resolves exactly or cannot split. */
  private split(name: string): string[] | undefined {
    if (this.isValue(name) || this.isFunction(name)) return undefined;
    return splitLetters(name, this.isValue);
  }

  resolve(node: NameNode): Resolution {
    const { name, span } = node;
    if (this.isValue(name)) return this.part(name);
    if (this.isFunction(name)) {
      throw new ParseError(`"${name}" is a function: call it as ${name}(…)`, {
        code: 'unknown-name',
        span,
        found: name,
      });
    }
    const letters = splitLetters(name, this.isValue);
    if (letters !== undefined) {
      this.readings.push(Object.freeze({ span: { start: span.start, end: span.end }, name, letters }));
      return { kind: 'split', parts: letters.map(letter => this.part(letter)) };
    }
    const missing = [...new Set(name)].filter(letter => !this.isValue(letter));
    const message =
      name.length === 1
        ? `Unknown name "${name}": declare it as a variable`
        : `Unknown name "${name}": declare it as a variable, or declare each letter (missing: ${missing.join(', ')})`;
    throw new ParseError(message, { code: 'unknown-name', span, found: name });
  }

  /**
   * `a/bc` with `bc` split reads as `a/(b·c)`, while `a/b c` reads as
   * `(a/b)·c`: flag the split so a UI can show the reading.
   */
  checkDivision(node: BinaryNode): void {
    const { left, right } = node;
    if (node.op !== '/' || right.kind !== 'name') return;
    const letters = this.split(right.name);
    const [first, ...rest] = letters ?? [];
    if (first === undefined) return;
    const a = slice(this.source, left);
    this.warnings.push({
      code: 'split-after-division',
      span: { start: node.span.start, end: node.span.end },
      message: `"${slice(this.source, node)}" reads as ${a}/(${[first, ...rest].join('·')}): "${right.name}" is one name, split into letters`,
      hint: `write ${a}/(${[first, ...rest].join('*')}) or (${a}/${first})*${rest.join('*')}`,
    });
  }
}
