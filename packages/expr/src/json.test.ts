import { describe, expect, it } from 'vitest';

import type { ParseError } from './errors.js';
import { ExprLimitError } from './errors.js';
import { fromJSON } from './json.js';
import { defineLanguage } from './language.js';
import { parseEquationText, parseText } from './parser.js';

/** What a cache or worker hands back: the JSON text of a tree, parsed again. */
function viaJSON(value: unknown): unknown {
  const text = JSON.stringify(value);
  return JSON.parse(text);
}

function rejection(value: unknown, code: ParseError['code'] = 'unexpected-token'): void {
  expect(fromJSON(value)).toMatchObject({
    code: 'expr.invalid_text',
    cause: expect.objectContaining({ name: 'ParseError', code }),
  });
}

describe('fromJSON', () => {
  it('rebuilds expressions and equations exactly, as fresh objects', () => {
    const expr = parseText('2x^2 + |y| - √z! / log(t, 2) + 1/2x');
    const restored = fromJSON(viaJSON(expr));
    expect(restored).toEqual(expr);
    const equation = parseEquationText('x^2 = 2x + 1');
    expect(fromJSON(viaJSON(equation))).toEqual(equation);
    const input = viaJSON(expr);
    expect(fromJSON(input)).not.toBe(input);
  });

  it('accepts only version 1: a stored AST is a cache, never migrated', () => {
    const json = { ...parseText('x') };
    rejection({ ...json, version: 2 });
    rejection({ ...json, version: '1' });
  });

  it('rejects unknown kinds, extra or missing keys and non-plain objects', () => {
    const base = { version: 1, source: 'x', warnings: [] };
    const span = { start: 0, end: 1 };
    rejection({ ...base, root: { kind: 'member', object: 'x', span } });
    rejection({ ...base, root: { kind: 'name', name: 'x', span, extra: true } });
    rejection({ ...base, root: { kind: 'name', span } });
    rejection({ ...base, root: [] });
    rejection({ ...base, root: new Map() });
    rejection({ ...base, root: { kind: 'name', name: 'x', span }, extra: 1 });
    // JSON.parse makes "__proto__" an own key; it is an unexpected key, never a prototype.
    rejection(
      JSON.parse(
        '{"version":1,"source":"x","warnings":[],"root":{"kind":"name","name":"x","span":{"start":0,"end":1},"__proto__":{"polluted":true}}}',
      ),
    );
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('checks every field: operators, flags, literals, names, spans', () => {
    const base = { version: 1, source: 'abcdef', warnings: [] };
    const span = { start: 0, end: 1 };
    const x = { kind: 'name', name: 'x', span };
    rejection({ ...base, root: { kind: 'binary', op: '%', left: x, right: x, implicit: false, span } });
    rejection({ ...base, root: { kind: 'binary', op: '+', left: x, right: x, implicit: true, span } });
    rejection({ ...base, root: { kind: 'unary', op: '!', arg: x, span } });
    rejection({ ...base, root: { kind: 'number', raw: '0x10', span } }, 'bad-number');
    rejection({ ...base, root: { kind: 'number', raw: '1e', span } }, 'bad-number');
    rejection({ ...base, root: { kind: 'number', raw: '-1', span } }, 'bad-number');
    rejection({ ...base, root: { kind: 'name', name: 'a.b', span } });
    rejection({ ...base, root: { kind: 'name', name: 'sin', span } });
    rejection({ ...base, root: { kind: 'name', name: 'x', span: { start: 2, end: 1 } } });
    rejection({ ...base, root: { kind: 'name', name: 'x', span: { start: 0, end: 99 } } });
    rejection({ ...base, root: x, warnings: [{ code: 'eval', span, message: '', hint: '' }] });
  });

  it('calls must name a registered function, with a valid arity and notation', () => {
    const base = { version: 1, source: 'x', warnings: [] };
    const span = { start: 0, end: 1 };
    const x = { kind: 'name', name: 'x', span };
    rejection(
      { ...base, root: { kind: 'call', fn: 'constructor', args: [x], notation: 'call', span } },
      'not-a-function',
    );
    rejection({ ...base, root: { kind: 'call', fn: 'eval', args: [x], notation: 'call', span } }, 'not-a-function');
    rejection({ ...base, root: { kind: 'call', fn: 'pow', args: [x], notation: 'call', span } }, 'arity');
    rejection({ ...base, root: { kind: 'call', fn: 'sin', args: [x], notation: 'bars', span } });
    rejection({ ...base, root: { kind: 'call', fn: 'sin', args: [x], notation: 'infix', span } });
    const custom = defineLanguage({ functions: { hypot: { arity: [2, 16] } } });
    const call = { ...base, root: { kind: 'call', fn: 'hypot', args: [x, x], notation: 'call', span } };
    expect(fromJSON(call, { language: custom })).toEqual(call);
    rejection(call, 'not-a-function');
  });

  it('runs the depth, node and length budgets without recursing past them', () => {
    let deep: unknown = { kind: 'name', name: 'x', span: { start: 0, end: 1 } };
    for (let index = 0; index < 100_000; index++) deep = { kind: 'group', inner: deep, span: { start: 0, end: 1 } };
    expect(fromJSON({ version: 1, source: 'x', warnings: [], root: deep })).toMatchObject({
      code: 'expr.over_budget',
      cause: expect.objectContaining({ name: 'ExprLimitError', budget: 'depth' }),
    });
    const wide = parseText(Array.from({ length: 40 }, () => 'x').join(' * '), { limits: { depth: 1000 } });
    expect(fromJSON(viaJSON(wide), { limits: { nodes: 20, depth: 1000 } })).toMatchObject({
      code: 'expr.over_budget',
      cause: expect.any(ExprLimitError),
    });
    expect(fromJSON({ ...parseText('x'), source: 'x'.repeat(10_001) })).toMatchObject({
      code: 'expr.over_budget',
      cause: expect.objectContaining({ budget: 'length' }),
    });
  });
});
