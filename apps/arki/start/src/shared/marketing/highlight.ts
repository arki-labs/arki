/** What a piece of code is, so the stylesheet can colour it. */
export type TokenKind =
  | 'keyword'
  | 'string'
  | 'template'
  | 'number'
  | 'comment'
  | 'call'
  | 'method'
  | 'prop'
  | 'key'
  | 'type'
  | 'operator'
  | 'bracket'
  | 'punct'
  | 'plain';

export type Token = {
  kind: TokenKind;
  text: string;
  /** For brackets: how deeply nested, so each level can take its own colour. */
  depth?: number;
};

const KEYWORDS = new Set([
  'const',
  'let',
  'export',
  'default',
  'return',
  'if',
  'else',
  'await',
  'async',
  'new',
  'throw',
  'import',
  'from',
  'true',
  'false',
  'null',
  'undefined',
]);

/** One alternative per kind of token, tried in this order at each position. */
const SCAN =
  /(?<comment>\/\/.*)|(?<string>'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(?<template>`(?:[^`\\]|\\.)*`)|(?<number>\d[\d_]*(?:\.\d+)?)|(?<word>[A-Z_$][\w$]*)|(?<operator>=>|[=+\-*/<>!&|?]+|\.\.\.)|(?<bracket>[()[\]{}])|(?<punct>[,;.:])|(?<space>\s+)|(?<other>\S)/gi;

const OPENING = new Set(['(', '[', '{']);

/** The first character after `index` that is not a space, or an empty string at the end of the line. */
function nextChar(line: string, index: number): string {
  return line.slice(index).trimStart().charAt(0);
}

/** The last character before `index` that is not a space. */
function previousChar(line: string, index: number): string {
  return line.slice(0, index).trimEnd().slice(-1);
}

function classifyWord(line: string, start: number, word: string): TokenKind {
  if (KEYWORDS.has(word)) return 'keyword';
  const before = previousChar(line, start);
  const after = nextChar(line, start + word.length);
  if (before === '.') return after === '(' ? 'method' : 'prop';
  if (after === '(') return 'call';
  if (after === ':' && before !== '?') return 'key';
  if (/^[A-Z]/.test(word)) return 'type';
  return 'plain';
}

/** Splits code into tokens. Joining their `text` gives the input back, exactly. Brackets are numbered from `depth`. */
export function tokenizeLines(lines: readonly string[], startDepth = 0): Token[][] {
  let depth = startDepth;
  return lines.map(line => {
    const tokens: Token[] = [];
    for (const match of line.matchAll(SCAN)) {
      const [text] = match;
      const { groups } = match;
      if (groups === undefined) continue;
      if (groups.comment !== undefined) tokens.push({ kind: 'comment', text });
      else if (groups.string !== undefined) tokens.push({ kind: 'string', text });
      else if (groups.template !== undefined) tokens.push({ kind: 'template', text });
      else if (groups.number !== undefined) tokens.push({ kind: 'number', text });
      else if (groups.word === undefined) {
        if (groups.operator !== undefined) tokens.push({ kind: 'operator', text });
        else if (groups.bracket !== undefined) {
          if (OPENING.has(text)) {
            tokens.push({ kind: 'bracket', text, depth });
            depth += 1;
          } else {
            depth = Math.max(0, depth - 1);
            tokens.push({ kind: 'bracket', text, depth });
          }
        } else if (groups.punct === undefined) {
          tokens.push({ kind: 'plain', text });
        } else {
          tokens.push({ kind: 'punct', text });
        }
      } else tokens.push({ kind: classifyWord(line, match.index, text), text });
    }
    return tokens;
  });
}
