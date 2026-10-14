/**
 * `@arki/expr/latex`: LaTeX for display (RFC §12, C-26). `\frac{}{}` for
 * `/`, `^{}` for powers, `\sqrt{}` and `\sqrt[n]{}`, `\left| \right|`,
 * floor and ceiling brackets, `\sin`-style commands, `\pi`, `n!`, `\cdot`
 * for an explicit `*` and plain juxtaposition for an implicit one. A
 * function's command comes from the language; a function without one is
 * `\operatorname{name}`. Output only: LaTeX is never parsed back.
 */
import { InvalidArgumentError } from '@arki/math/errors';

import type { Equation, Expr, Node } from './ast.js';
import type { Language } from './language.js';
import { ExprLimitError } from './errors.js';
import { isLanguage, scientific } from './language.js';
import { DEFAULT_LIMITS } from './limits.js';

export type LatexOptions = {
  /** Supplies function commands and constant symbols. Default `scientific`. */
  readonly language?: Language;
  /** Bounds the recursion over hand-built trees. Default 256, as in `parse`. */
  readonly limits?: { readonly depth?: number };
};

const SUM = 1;
const PRODUCT = 2;
const UNARY = 3;
const POWER = 4;
const POSTFIX = 5;
const PRIMARY = 6;

/** Greek letters that have a LaTeX command, by name and by character. */
const GREEK_NAMES =
  'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega';
const GREEK_LETTERS = 'αβγδεζηθικλμνξπρστυφχψω';
const UPPER_GREEK = new Set([
  'Gamma',
  'Delta',
  'Theta',
  'Lambda',
  'Xi',
  'Pi',
  'Sigma',
  'Upsilon',
  'Phi',
  'Psi',
  'Omega',
]);

function level(node: Node): number {
  switch (node.kind) {
    case 'binary': {
      if (node.op === '+' || node.op === '-') return SUM;
      return node.op === '^' ? POWER : PRODUCT;
    }
    case 'unary': {
      return UNARY;
    }
    case 'factorial': {
      return POSTFIX;
    }
    default: {
      return PRIMARY;
    }
  }
}

function isLetterCode(code: number | undefined): boolean {
  return code !== undefined && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122));
}

function isDigitCode(code: number | undefined): boolean {
  return code !== undefined && code >= 48 && code <= 57;
}

function number(raw: string): string {
  const at = Math.max(raw.indexOf('e'), raw.indexOf('E'));
  if (at < 0) return raw;
  const exponent = raw.slice(at + 1).replace('+', '');
  return `${raw.slice(0, at)} \\times 10^{${exponent}}`;
}

function greek(name: string): string | undefined {
  const words = GREEK_NAMES.split(' ');
  if (words.includes(name) || UPPER_GREEK.has(name)) return `\\${name}`;
  const index = GREEK_LETTERS.indexOf(name);
  return name.length === 1 && index !== -1 ? `\\${words[index] ?? name}` : undefined;
}

class LatexPrinter {
  private readonly language: Language;
  private readonly maxDepth: number;

  constructor(options: LatexOptions) {
    const language = options.language ?? scientific;
    if (!isLanguage(language))
      throw new InvalidArgumentError('options.language must be a language from defineLanguage');
    this.language = language;
    this.maxDepth = options.limits?.depth ?? DEFAULT_LIMITS.depth;
  }

  print(node: Node, depth: number): string {
    if (depth > this.maxDepth) throw new ExprLimitError('depth', this.maxDepth, depth);
    const next = depth + 1;
    switch (node.kind) {
      case 'number': {
        return number(node.raw);
      }
      case 'name': {
        return this.name(node.name);
      }
      case 'group': {
        return `\\left(${this.print(node.inner, next)}\\right)`;
      }
      case 'unary': {
        return `${node.op}${this.operand(node.arg, UNARY, next)}`;
      }
      case 'factorial': {
        return `${this.operand(node.arg, POSTFIX, next)}!`;
      }
      case 'call': {
        return this.call(node.fn, node.args, next);
      }
      case 'binary': {
        const { op, left, right } = node;
        if (op === '^') return this.power(left, right, next);
        if (op === '/') return `\\frac{${this.bare(left, next)}}{${this.bare(right, next)}}`;
        if (op === '+' || op === '-')
          return `${this.operand(left, SUM, next)} ${op} ${this.operand(right, PRODUCT, next)}`;
        const leftText = this.operand(left, PRODUCT, next);
        const rightText = this.operand(right, node.implicit ? PRODUCT : UNARY, next);
        if (!node.implicit) return `${leftText} \\cdot ${rightText}`;
        const first = rightText.codePointAt(0);
        if (isDigitCode(first)) return `${leftText} \\cdot ${rightText}`;
        return isLetterCode(leftText.codePointAt(leftText.length - 1)) && isLetterCode(first)
          ? `${leftText} ${rightText}`
          : `${leftText}${rightText}`;
      }
    }
  }

  private name(name: string): string {
    const symbol = this.language.constantSpec(name)?.latex ?? greek(name);
    if (symbol !== undefined) return symbol;
    return name.length === 1 ? name : `\\mathit{${name.split('_').join('\\_')}}`;
  }

  /** Where `\frac`, `^{}` and `\sqrt{}` already group, the user's outer parentheses are not printed. */
  private bare(node: Node, depth: number): string {
    return node.kind === 'group' ? this.print(node.inner, depth + 1) : this.print(node, depth);
  }

  private operand(node: Node, min: number, depth: number): string {
    return level(node) >= min ? this.print(node, depth) : `\\left(${this.print(node, depth)}\\right)`;
  }

  private power(base: Node, exponent: Node, depth: number): string {
    return `${this.operand(base, POSTFIX, depth)}^{${this.bare(exponent, depth)}}`;
  }

  private call(fn: string, args: readonly Node[], depth: number): string {
    const [first, second] = args;
    if (first !== undefined && args.length === 1) {
      const inner = this.bare(first, depth);
      switch (fn) {
        case 'abs': {
          return `\\left|${inner}\\right|`;
        }
        case 'floor': {
          return `\\left\\lfloor ${inner}\\right\\rfloor`;
        }
        case 'ceil': {
          return `\\left\\lceil ${inner}\\right\\rceil`;
        }
        case 'sqrt':
        case 'nthRoot': {
          return `\\sqrt{${inner}}`;
        }
        case 'cbrt': {
          return `\\sqrt[3]{${inner}}`;
        }
        case 'factorial': {
          return `${this.operand(first, POSTFIX, depth)}!`;
        }
        case 'log': {
          return `\\ln\\left(${this.print(first, depth)}\\right)`;
        }
      }
    }
    if (first !== undefined && second !== undefined && args.length === 2) {
      if (fn === 'nthRoot') return `\\sqrt[${this.bare(second, depth)}]{${this.bare(first, depth)}}`;
      if (fn === 'pow') return this.power(first, second, depth);
      if (fn === 'log') return `\\log_{${this.bare(second, depth)}}\\left(${this.print(first, depth)}\\right)`;
    }
    const command = this.language.functionSpec(fn)?.latex ?? `\\operatorname{${fn}}`;
    return `${command}\\left(${args.map(arg => this.print(arg, depth)).join(', ')}\\right)`;
  }
}

/**
 * LaTeX for an expression, equation or node: `toLatex(parse('sqrt(x)/2'))` is
 * `'\\frac{\\sqrt{x}}{2}'`. Pass the language the expression was parsed with
 * so host functions use their `latex` command.
 */
export function toLatex(value: Expr | Equation | Node, options: LatexOptions = {}): string {
  const printer = new LatexPrinter(options);
  if ('kind' in value) return printer.print(value, 1);
  if ('root' in value) return printer.print(value.root, 1);
  return `${printer.print(value.left, 1)} = ${printer.print(value.right, 1)}`;
}
