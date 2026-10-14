/**
 * Printing (RFC §12). The `canonical` style is the storage form: ASCII, an
 * explicit `*` for every product (so `2e` the product prints as `2 * e`, never
 * as the literal-looking `2e`), single spaces around binary operators, `sqrt(…)`
 * for `√`, groups as written and literals as `raw`. The `display` style keeps
 * what the user typed: juxtaposition for implicit products, `·` for explicit
 * ones, `−`, `√` and `π`.
 *
 * Both styles parse back to the same tree apart from spans; the canonical
 * style also normalises the `implicit` flag and the radical notation.
 * Parentheses are added only where a hand-built tree needs them to keep its
 * meaning; trees from `parse` never need them.
 */
import type { Equation, Expr, Node } from './ast.js';
import type { Syntax } from './syntax.js';
import { ExprLimitError } from './errors.js';
import { codeAt, isDigit, isLetter, LOWER_E, UPPER_E } from './lexer.js';
import { DEFAULT_LIMITS } from './limits.js';
import { canonical, defineSyntax } from './syntax.js';

export type PrintStyle = 'canonical' | 'display';

export type PrintOptions = {
  /** Decimal mark and argument separator. Default `canonical` (`.` and `,`). */
  readonly syntax?: Syntax;
  /** Default `'canonical'`, the form to store. */
  readonly style?: PrintStyle;
  /** Bounds the recursion over hand-built trees. Default 256, as in `parse`. */
  readonly limits?: { readonly depth?: number };
};

const BAR = 124; // |

/** Grammar levels, low to high: sum, product, unary, power, postfix, primary. */
const SUM = 1;
const PRODUCT = 2;
const UNARY = 3;
const POWER = 4;
const POSTFIX = 5;
const PRIMARY = 6;

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

/** The primary a power-level node starts with, or `undefined` for lower levels. */
function leadingPrimary(node: Node): Node | undefined {
  let current = node;
  for (;;) {
    if (current.kind === 'factorial') current = current.arg;
    else if (current.kind === 'binary' && current.op === '^') current = current.left;
    else return level(current) === PRIMARY ? current : undefined;
  }
}

/** The leaf printed last, when the text ends in a word character (a name or number, not `)`, `|` or `!`). */
function rightmostLeaf(node: Node): Node {
  let current = node;
  for (;;) {
    if (current.kind === 'binary') current = current.right;
    else if (current.kind === 'unary') current = current.arg;
    else if (current.kind === 'call' && current.notation === 'radical' && current.args[0] !== undefined)
      current = current.args[0];
    else return current;
  }
}

function isWordChar(code: number): boolean {
  return isLetter(code) || isDigit(code);
}

class Printer {
  private readonly display: boolean;
  private readonly decimalComma: boolean;
  private readonly separator: string;
  private readonly maxDepth: number;

  constructor(options: PrintOptions) {
    const syntax = options.syntax === undefined ? canonical : defineSyntax(options.syntax);
    this.display = options.style === 'display';
    this.decimalComma = syntax.decimal === ',';
    this.separator = `${syntax.separator} `;
    this.maxDepth = options.limits?.depth ?? DEFAULT_LIMITS.depth;
  }

  print(node: Node, depth: number, inBar: boolean): string {
    if (depth > this.maxDepth) throw new ExprLimitError('depth', this.maxDepth, depth);
    const next = depth + 1;
    switch (node.kind) {
      case 'number': {
        return this.decimalComma ? node.raw.replace('.', ',') : node.raw;
      }
      case 'name': {
        return this.display && node.name === 'pi' ? 'π' : node.name;
      }
      case 'unary': {
        const op = this.display && node.op === '-' ? '−' : node.op;
        return `${op}${this.operand(node.arg, UNARY, next, inBar)}`;
      }
      case 'factorial': {
        return `${this.operand(node.arg, POSTFIX, next, inBar)}!`;
      }
      case 'group': {
        return `(${this.print(node.inner, next, false)})`;
      }
      case 'call': {
        const [only] = node.args;
        if (only !== undefined && node.args.length === 1) {
          if (node.notation === 'bars' && node.fn === 'abs') return `|${this.print(only, next, true)}|`;
          if (node.notation === 'radical' && node.fn === 'sqrt' && this.display) {
            return `√${this.operand(only, PRIMARY, next, inBar)}`;
          }
        }
        return `${node.fn}(${node.args.map(arg => this.print(arg, next, false)).join(this.separator)})`;
      }
      case 'binary': {
        const { op, left, right } = node;
        if (op === '^') return `${this.operand(left, POSTFIX, next, inBar)}^${this.operand(right, UNARY, next, inBar)}`;
        if (op === '+' || op === '-') {
          const symbol = this.display && op === '-' ? '−' : op;
          return `${this.operand(left, SUM, next, inBar)} ${symbol} ${this.operand(right, PRODUCT, next, inBar)}`;
        }
        const leftText = this.operand(left, PRODUCT, next, inBar);
        if (op === '*' && node.implicit && this.display) {
          const juxtaposed = this.juxtapose(left, leftText, right, next, inBar);
          if (juxtaposed !== undefined) return juxtaposed;
        }
        const symbol = op === '/' ? '/' : this.display ? '·' : '*';
        return `${leftText} ${symbol} ${this.operand(right, UNARY, next, inBar)}`;
      }
    }
  }

  /** Prints `node` where the grammar needs at least `min`, adding parentheses only when it is lower. */
  private operand(node: Node, min: number, depth: number, inBar: boolean): string {
    return level(node) >= min ? this.print(node, depth, inBar) : `(${this.print(node, depth, false)})`;
  }

  /**
   * Display juxtaposition, when it reads back as the same product: the right
   * side must start with a name, `(`, `|` or `√` (never a number or sign), and
   * a `|` cannot follow inside bars, where it would close them.
   */
  private juxtapose(left: Node, leftText: string, right: Node, depth: number, inBar: boolean): string | undefined {
    const lead = leadingPrimary(right);
    if (lead === undefined || lead.kind === 'number') return undefined;
    const rightText = this.print(right, depth, inBar);
    const first = codeAt(rightText, 0);
    if (first === BAR && inBar) return undefined;
    const last = codeAt(leftText, leftText.length - 1);
    if (!isWordChar(last) || !isLetter(first)) return `${leftText}${rightText}`;
    // `2x` reads back as a product, but `2e2` would read as a literal: keep a space before e/E.
    const glued = rightmostLeaf(left).kind === 'number' && first !== LOWER_E && first !== UPPER_E;
    return glued ? `${leftText}${rightText}` : `${leftText} ${rightText}`;
  }
}

/**
 * Prints an expression, equation or node. The default (canonical style and
 * syntax) is the form to store: `parse(print(expr))` gives the same tree back.
 */
export function print(value: Expr | Equation | Node, options: PrintOptions = {}): string {
  const printer = new Printer(options);
  if ('kind' in value) return printer.print(value, 1, false);
  if ('root' in value) return printer.print(value.root, 1, false);
  return `${printer.print(value.left, 1, false)} = ${printer.print(value.right, 1, false)}`;
}
