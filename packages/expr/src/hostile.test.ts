import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';
import { InvalidArgumentError, ResourceLimitError } from '@arki/math/errors';

import type { Limits } from './limits.js';
import { ExprLimitError, ParseError } from './errors.js';
import { names } from './names.js';
import { parse, parseEquation, parseEquationText, parseText } from './parser.js';
import { print } from './print.js';
import { decimalComma } from './syntax.js';

const roomy: Limits = { length: 1_000_000, tokens: 1_000_000 };

function limitError(run: () => unknown): ExprLimitError {
  try {
    run();
  } catch (error) {
    if (error instanceof ExprLimitError) return error;
    throw error;
  }
  throw new Error('expected an ExprLimitError');
}

describe('security', () => {
  it('constructor, __proto__ and toString are plain variable names', () => {
    const expr = parseText('constructor + __proto__ * toString - hasOwnProperty');
    expect(names(expr).variables).toEqual(['__proto__', 'constructor', 'hasOwnProperty', 'toString']);
    expect(print(expr)).toBe('constructor + __proto__ * toString - hasOwnProperty');
  });

  it('prototype names are never callable', () => {
    for (const text of ['constructor(1)', 'toString(x)', '__proto__(x)', 'valueOf()']) {
      expect(() => parseText(text)).toThrow(expect.objectContaining({ code: 'not-a-function' }));
    }
  });

  it('there is no member access, indexing or strings to reach anything else', () => {
    for (const text of ['x.constructor', 'x["a"]', "'a'", 'x[0]', 'a;b', 'f = x', '`x`', 'import(x)']) {
      expect(() => parseText(text)).toThrow(ParseError);
    }
  });

  it('100 000 nested parentheses throw ExprLimitError (depth), never RangeError', () => {
    const text = `${'('.repeat(100_000)}x${')'.repeat(100_000)}`;
    expect(limitError(() => parseText(text, { limits: roomy }))).toMatchObject({ budget: 'depth', limit: 256 });
    // With the default budgets the length check fires first, before lexing.
    expect(limitError(() => parseText(text)).budget).toBe('length');
  });

  it('every other nesting form is bounded by the same depth budget', () => {
    const forms = [
      `${'-'.repeat(100_000)}x`,
      `${'√'.repeat(100_000)}x`,
      `${'2^'.repeat(50_000)}2`,
      `${'|'.repeat(100_000)}`,
      `${'sin('.repeat(50_000)}x${')'.repeat(50_000)}`,
      `x${'!'.repeat(100_000)}`,
      Array.from({ length: 50_000 }, () => 'x').join('+'),
    ];
    for (const text of forms) {
      const error = limitError(() => parseText(text, { limits: { ...roomy, nodes: 1_000_000 } }));
      expect(error.budget).toBe('depth');
      expect(error).toBeInstanceOf(ResourceLimitError);
    }
  });

  it('a 256-deep expression parses; one level more does not', () => {
    const fits = `${'('.repeat(255)}x${')'.repeat(255)}`;
    expect(print(parseText(fits))).toBe(fits);
    expect(limitError(() => parseText(`(${fits})`))).toMatchObject({ budget: 'depth', limit: 256, actual: 257 });
  });
});

describe('budgets', () => {
  it('length is checked before lexing, so even garbage is a limit error', () => {
    expect(limitError(() => parseText('$'.repeat(10_001)))).toMatchObject({
      budget: 'length',
      limit: 10_000,
      actual: 10_001,
    });
    expect(limitError(() => parseText('x+y', { limits: { length: 2 } })).budget).toBe('length');
  });

  it('tokens are counted while lexing', () => {
    expect(limitError(() => parseText('1+1+1', { limits: { tokens: 4 } }))).toMatchObject({
      budget: 'tokens',
      actual: 5,
    });
    expect(parseText('1+1+1', { limits: { tokens: 5 } }).root.kind).toBe('binary');
  });

  it('nodes are counted while parsing', () => {
    expect(limitError(() => parseText('sin(1, 2, 3)', { limits: { nodes: 2 } })).budget).toBe('nodes');
    expect(limitError(() => parseEquationText('a = b + c', { limits: { nodes: 3 } })).budget).toBe('nodes');
  });

  it('limits must be positive integers', () => {
    expect(() => parseText('x', { limits: { depth: 0 } })).toThrow(InvalidArgumentError);
    expect(() => parseText('x', { limits: { nodes: Number.NaN } })).toThrow(InvalidArgumentError);
  });
});

const ALPHABET = [
  ...'0123456789.,;eExyz+-*/^!()|= ',
  'sin',
  'log',
  'pi',
  '√',
  'π',
  '×',
  '÷',
  '−',
  '·',
  '\u{1F600}',
  '\0',
  'θ',
];

const tight: Limits = { length: 200, tokens: 80, depth: 12, nodes: 60 };

/**
 * Parses `text` as both an expression and an equation and asserts that nothing
 * escapes: bad text and broken budgets come back as failures (a `ParseError` with
 * an in-range span, or an `ExprLimitError`), within 50 ms per entry.
 */
function survives(text: string, limits: Limits | undefined): void {
  for (const entry of [parse, parseEquation]) {
    const started = Date.now();
    for (const syntax of [undefined, decimalComma]) {
      const parsed = entry(text, { limits, syntax });
      if (!isFailure(parsed)) {
        print(parsed);
        continue;
      }
      expect(['expr.invalid_text', 'expr.over_budget']).toContain(parsed.code);
      if (parsed.cause instanceof ParseError) {
        expect(parsed.code).toBe('expr.invalid_text');
        expect(parsed.cause.span.start).toBeGreaterThanOrEqual(0);
        expect(parsed.cause.span.end).toBeLessThanOrEqual(text.length);
      } else {
        expect(parsed.code).toBe('expr.over_budget');
        expect(parsed.cause).toBeInstanceOf(ExprLimitError);
      }
    }
    expect(Date.now() - started).toBeLessThan(50);
  }
}

const SEEDS = ['2x^2 + sin(x)', '||x|-|y||', 'log(0.5, 2) / 3!', '-(a + b)^-2', '√(x)(y)', '1/2x', '2e+1'];

describe('parser fuzz', () => {
  it('random strings: nothing escapes parse, failures are returned, each in < 50 ms', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...ALPHABET), { maxLength: 120 }), fc.boolean(), (parts, budgets) => {
        survives(parts.join(''), budgets ? tight : undefined);
      }),
      { numRuns: 3000 },
    );
  });

  it('grammar-aware mutations of valid input: delete, insert, duplicate, swap', () => {
    const mutation = fc.record({
      seed: fc.constantFrom(...SEEDS),
      edits: fc.array(
        fc.record({
          kind: fc.integer({ min: 0, max: 3 }),
          at: fc.nat(),
          length: fc.nat(8),
          token: fc.constantFrom(...ALPHABET),
        }),
        { minLength: 1, maxLength: 6 },
      ),
      repeat: fc.integer({ min: 1, max: 40 }),
    });
    fc.assert(
      fc.property(mutation, fc.boolean(), ({ seed, edits, repeat }, budgets) => {
        let text = seed.repeat(repeat);
        for (const { kind, at, length, token } of edits) {
          const index = at % (text.length + 1);
          switch (kind) {
            case 0: {
              text = text.slice(0, index) + text.slice(index + length);
              break;
            }
            case 1: {
              text = text.slice(0, index) + token + text.slice(index);
              break;
            }
            case 2: {
              text = text.slice(0, index) + text.slice(index, index + length).repeat(3) + text.slice(index);
              break;
            }
            default: {
              text = text.slice(index) + text.slice(0, index);
            }
          }
        }
        survives(text, budgets ? tight : undefined);
      }),
      { numRuns: 3000 },
    );
  });
});
