/**
 * A hand-written, single-pass lexer (RFC §4.1, §15: no regular expressions
 * anywhere on the parse path). Aliases are folded here: `×` and `·` read as
 * `*`, `÷` as `/`, `−` (U+2212) as `-`, `π` as the name `pi`, and `√` becomes
 * the radical token.
 */
import type { Syntax } from './syntax.js';
import { ExprLimitError, ParseError } from './errors.js';

export type TokenKind =
  'number' | 'name' | '+' | '-' | '*' | '/' | '^' | '!' | '(' | ')' | '|' | '=' | 'sep' | 'radical' | 'end';

export type Token = {
  readonly kind: TokenKind;
  readonly start: number;
  readonly end: number;
  /** The canonical value of a `number` (raw text with a `.` mark) or `name` token; the source text otherwise. */
  readonly text: string;
};

/** Character codes the lexer compares against. */
const PI = 960; // π
export const DOT = 46; // .
const COMMA = 44;
const SEMICOLON = 59;
const PLUS = 43;
const MINUS = 45;
export const LOWER_E = 101;
export const UPPER_E = 69;

/** `letter` of the RFC grammar: A–Z, a–z, `_`, Greek α–ω and Α–Ω. `π` is excluded: it is always the alias for `pi`. */
export function isLetter(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a–z
    (code >= 65 && code <= 90) || // A–Z
    code === 95 || // _
    (code >= 945 && code <= 969 && code !== PI) || // α–ω
    (code >= 913 && code <= 937) // Α–Ω
  );
}

/** The code point at `index`, or -1 past the end. */
export function codeAt(text: string, index: number): number {
  return text.codePointAt(index) ?? -1;
}

export function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** True when `text` matches `name = letter { letter | digit | "_" }`. */
export function isName(text: string): boolean {
  if (text.length === 0 || !isLetter(codeAt(text, 0))) return false;
  for (let index = 1; index < text.length; index++) {
    const code = codeAt(text, index);
    if (!isLetter(code) && !isDigit(code)) return false;
  }
  return true;
}

function isSpace(code: number): boolean {
  // Space, tab to carriage return, no-break space, thin space, narrow no-break space.
  return code === 32 || (code >= 9 && code <= 13) || code === 160 || code === 8201 || code === 8239;
}

/**
 * Scans `number = ( digits [ dot digits ] | dot digits ) [ ( "e" | "E" ) [ "+" | "-" ] digits ]`
 * from `start`. Returns the end offset, or the negated end of a malformed
 * literal (`2.` or `1.2.3`) as `-(end + 1)`. An `e` not followed by digits is
 * left alone, so `2e` lexes as `2` then the name `e`.
 */
export function scanNumber(text: string, start: number, dot: number): number {
  let index = start;
  while (isDigit(codeAt(text, index))) index++;
  if (codeAt(text, index) === dot) {
    if (!isDigit(codeAt(text, index + 1))) return -(index + 2);
    index++;
    while (isDigit(codeAt(text, index))) index++;
  }
  const marker = codeAt(text, index);
  if (marker === LOWER_E || marker === UPPER_E) {
    let exponent = index + 1;
    const sign = codeAt(text, exponent);
    if (sign === PLUS || sign === MINUS) exponent++;
    if (isDigit(codeAt(text, exponent))) {
      while (isDigit(codeAt(text, exponent))) exponent++;
      index = exponent;
    }
  }
  // A second decimal mark right after a literal (`1.2.3`) is a malformed number, not two numbers.
  if (codeAt(text, index) === dot) {
    let end = index + 1;
    while (isDigit(codeAt(text, end))) end++;
    return -(end + 1);
  }
  return index;
}

/** True when `raw` is a whole number literal in canonical (`.`) syntax. */
export function isNumberLiteral(raw: string): boolean {
  const first = codeAt(raw, 0);
  const startsNumber = isDigit(first) || (first === DOT && isDigit(codeAt(raw, 1)));
  return startsNumber && scanNumber(raw, 0, DOT) === raw.length;
}

const SINGLE: Readonly<Record<string, TokenKind>> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '*': '*',
  '×': '*',
  '·': '*',
  '/': '/',
  '÷': '/',
  '^': '^',
  '!': '!',
  '(': '(',
  ')': ')',
  '|': '|',
  '=': '=',
  '√': 'radical',
};

function charAt(text: string, index: number): string {
  const code = text.codePointAt(index) ?? 0;
  return String.fromCodePoint(code);
}

export function tokenize(source: string, syntax: Syntax, maxTokens: number): Token[] {
  const tokens: Token[] = [];
  const dot = codeAt(syntax.decimal, 0);
  const separator = codeAt(syntax.separator, 0);
  const push = (kind: TokenKind, start: number, end: number, text: string): void => {
    if (tokens.length >= maxTokens) throw new ExprLimitError('tokens', maxTokens, tokens.length + 1);
    tokens.push({ kind, start, end, text });
  };

  let index = 0;
  while (index < source.length) {
    const code = codeAt(source, index);
    if (isSpace(code)) {
      index++;
      continue;
    }
    if (isDigit(code) || (code === dot && isDigit(codeAt(source, index + 1)))) {
      const end = scanNumber(source, index, dot);
      if (end < 0) {
        const badEnd = -end - 1;
        throw new ParseError(
          `Malformed number "${source.slice(index, badEnd)}": use one decimal mark, with digits after it`,
          {
            code: 'bad-number',
            span: { start: index, end: badEnd },
            expected: ['digit'],
            found: source.slice(index, badEnd),
          },
        );
      }
      const text = source.slice(index, end);
      push('number', index, end, dot === DOT ? text : text.replace(syntax.decimal, '.'));
      index = end;
      continue;
    }
    if (isLetter(code)) {
      let end = index + 1;
      while (end < source.length && (isLetter(codeAt(source, end)) || isDigit(codeAt(source, end)))) end++;
      const name = source.slice(index, end);
      push('name', index, end, name);
      index = end;
      continue;
    }
    if (code === PI) {
      push('name', index, index + 1, 'pi');
      index++;
      continue;
    }
    if (code === separator) {
      push('sep', index, index + 1, syntax.separator);
      index++;
      continue;
    }
    const char = charAt(source, index);
    const kind = SINGLE[char];
    if (kind === undefined) {
      const hint =
        code === DOT && dot !== DOT
          ? ` (this syntax writes decimals with "${syntax.decimal}")`
          : code === COMMA || code === SEMICOLON
            ? ` (this syntax separates arguments with "${syntax.separator}")`
            : '';
      throw new ParseError(`Unexpected character "${char}"${hint}`, {
        code: 'unexpected-token',
        span: { start: index, end: index + char.length },
        found: char,
      });
    }
    push(kind, index, index + 1, char);
    index++;
  }
  tokens.push({ kind: 'end', start: source.length, end: source.length, text: '' });
  return tokens;
}
