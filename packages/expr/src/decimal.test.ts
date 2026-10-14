import { describe, expect, it } from 'vitest';

import type { Decimal } from '@arki/math/decimal';
import { decimal, isDecimal } from '@arki/math/decimal';
import { DivisionByZeroError, InvalidArgumentError, RoundingNecessaryError } from '@arki/math/errors';

import { compile, compileEquation, evaluate } from './decimal.js';
import { ExprLimitError, ParseError } from './errors.js';
import { defineLanguage, scientific } from './language.js';
import { parse, parseEquation } from './parser.js';

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function parseError(run: () => unknown): ParseError {
  const error = thrown(run);
  if (error instanceof ParseError) return error;
  throw error;
}

const HALF_EVEN = { rounding: 'halfEven' } as const;

/** A host function: the net amount of a gross one at 25 % tax. */
const net = (gross: Decimal): Decimal => gross.dividedBy('1.25', { scale: 2, rounding: 'halfEven' });

/** The value as text and whether it is exact, in the given context. */
function detailed(text: string, options: { scale?: number; rounding?: 'halfEven' | 'floor' | 'ceiling' } = HALF_EVEN) {
  const { value, exact } = compile(parse(text), options).detailed();
  return [value.toString(), exact] as const;
}

describe('RFC §8: the decimal row', () => {
  it('+ - * never round, even when the result has more digits than scale', () => {
    // Money and measurements keep their digits: 1.10 × 3 is 3.30, not 3.3 or 3.
    const f = compile(parse('a * b + c - d'), { variables: ['a', 'b', 'c', 'd'], scale: 0, rounding: 'halfEven' });
    const result = f.detailed({ a: '1.10', b: '3', c: '0.001', d: '0.0001' });
    expect(result.value.toString()).toBe('3.3009');
    expect(result.exact).toBe(true);
    expect(evaluate('0.1 + 0.2').toString()).toBe('0.3');
  });

  it('/ is exact when the quotient terminates, and rounds to { scale, rounding } only when it does not', () => {
    // 1/8 needs three digits: it stays exact at scale 2 rather than rounding a terminating quotient.
    expect(detailed('1/8', { scale: 2, rounding: 'halfEven' })).toEqual(['0.125', true]);
    expect(detailed('10/3', { scale: 2, rounding: 'halfEven' })).toEqual(['3.33', false]);
    expect(detailed('2/3', { scale: 2, rounding: 'floor' })).toEqual(['0.66', false]);
    expect(() => evaluate('1/0')).toThrow(DivisionByZeroError);
  });

  it('^ with an integer exponent is exact; a negative one rounds only when 1/base does not terminate', () => {
    expect(detailed('1.1^3')).toEqual(['1.331', true]);
    expect(detailed('2^-3')).toEqual(['0.125', true]);
    expect(detailed('3^-1', { scale: 4, rounding: 'halfEven' })).toEqual(['0.3333', false]);
    expect(detailed('0^0')).toEqual(['1', true]);
    expect(() => evaluate('0^-1')).toThrow(DivisionByZeroError);
  });

  it('^ with a non-integer exponent is decimal-math pow at scale, exact when the root is', () => {
    expect(detailed('4^0.5', { scale: 3, rounding: 'halfEven' })).toEqual(['2.000', true]);
    expect(detailed('2^0.5', { scale: 3, rounding: 'halfEven' })).toEqual(['1.414', false]);
    // The exponent 1/3 itself rounds to 0.33 first, so this is 8^0.33, not a cube root.
    expect(detailed('pow(8, 1/3)', { scale: 2, rounding: 'halfEven' })).toEqual(['1.99', false]);
    expect(() => evaluate('(-8)^0.5', HALF_EVEN)).toThrow(InvalidArgumentError);
  });

  it('sqrt cbrt nthRoot exp ln log log10 log2 are correctly rounded at scale', () => {
    const at10 = { scale: 10, rounding: 'halfEven' } as const;
    expect(detailed('sqrt(2)', at10)).toEqual(['1.4142135624', false]);
    expect(detailed('cbrt(2)', at10)).toEqual(['1.2599210499', false]);
    expect(detailed('nthRoot(2, 5)', at10)).toEqual(['1.1486983550', false]);
    expect(detailed('exp(1)', at10)).toEqual(['2.7182818285', false]);
    expect(detailed('ln(2)', at10)).toEqual(['0.6931471806', false]);
    expect(detailed('log(2)', at10)).toEqual(['0.6931471806', false]);
    expect(detailed('log(2, 10)', at10)).toEqual(['0.3010299957', false]);
    expect(detailed('log10(2)', at10)).toEqual(['0.3010299957', false]);
    expect(detailed('log2(10)', at10)).toEqual(['3.3219280949', false]);
    // Exact results are recognised, so a calculator shows "=" rather than "≈".
    expect(detailed('sqrt(2.25)', { scale: 2, rounding: 'halfEven' })).toEqual(['1.50', true]);
    expect(detailed('nthRoot(1024, 10)', { scale: 0, rounding: 'halfEven' })).toEqual(['2', true]);
    expect(detailed('ln(1)', { scale: 2, rounding: 'halfEven' })).toEqual(['0.00', true]);
    expect(detailed('exp(0)', { scale: 2, rounding: 'halfEven' })).toEqual(['1.00', true]);
    expect(detailed('log(8, 4)', { scale: 2, rounding: 'halfEven' })).toEqual(['1.50', true]);
    expect(detailed('log10(0.001)', { scale: 0, rounding: 'halfEven' })).toEqual(['-3', true]);
    expect(detailed('log2(0.125)', { scale: 0, rounding: 'halfEven' })).toEqual(['-3', true]);
    expect(() => evaluate('sqrt(-1)', HALF_EVEN)).toThrow(InvalidArgumentError);
    expect(() => evaluate('ln(0)', HALF_EVEN)).toThrow(InvalidArgumentError);
  });

  it('trigonometry is a compile-time not-in-domain error pointing at the call, never a float fallback', () => {
    // gamma has no exact decimal value at non-integers either, so it is rejected the same way.
    for (const fn of ['sin', 'acos', 'tanh', 'asech', 'gamma']) {
      const error = parseError(() => compile(parse(`1 + ${fn}(x)`), { variables: ['x'] }));
      expect(error.code).toBe('not-in-domain');
      expect(error.span).toEqual({ start: 4, end: 4 + fn.length });
    }
    // i is not a real number; it may be declared as a variable instead.
    expect(parseError(() => compile(parse('2i'))).code).toBe('not-in-domain');
    expect(compile(parse('2i'), { variables: ['i'] })({ i: '1.5' }).toString()).toBe('3.0');
  });

  it('pi and e are rounded at scale in the caller’s rounding mode', () => {
    expect(detailed('pi', { scale: 4, rounding: 'floor' })).toEqual(['3.1415', false]);
    expect(detailed('pi', { scale: 4, rounding: 'ceiling' })).toEqual(['3.1416', false]);
    expect(detailed('pi', { scale: 4, rounding: 'halfEven' })).toEqual(['3.1416', false]);
    expect(detailed('e', { scale: 5, rounding: 'halfEven' })).toEqual(['2.71828', false]);
    // The flag survives constant folding: pi is folded at compile, the call still reports ≈.
    const f = compile(parse('2 * pi * r'), { variables: ['r'], scale: 2, rounding: 'halfEven' });
    expect(f.detailed({ r: '1' })).toEqual({ value: decimal('6.28'), exact: false });
    // pi and e are constants of this domain, so they cannot be declared as variables.
    expect(parseError(() => compile(parse('2e'), { variables: ['e'] })).code).toBe('name-conflict');
  });
});

describe('RFC §10: the decimal example', () => {
  it('multiplication never rounds; a non-terminating quotient rounds half-even at scale 2', () => {
    const price = compile(parse('base * (1 + rate)'), {
      variables: ['base', 'rate'],
      scale: 2,
      rounding: 'halfEven',
    });
    expect(price({ base: '19.99', rate: '0.19' }).toString()).toBe('23.7881');
    const third = compile(parse('total / 3'), { variables: ['total'], scale: 2, rounding: 'halfEven' });
    expect(third({ total: '10' }).toString()).toBe('3.33');
  });
});

describe('the default rounding is unnecessary', () => {
  it('an inexact step throws RoundingNecessaryError unless the caller chose a mode, like Decimal#dividedBy', () => {
    // Silent rounding is how 0.1 + 0.2 bugs start: the caller must opt in.
    for (const text of ['1/3', '3^-1', 'sqrt(2)', 'ln(2)', 'pi', 'e', '2^0.5']) {
      expect(() => evaluate(text)).toThrow(RoundingNecessaryError);
    }
    expect(() => decimal(1).dividedBy(3)).toThrow(RoundingNecessaryError);
  });

  it('exact steps succeed under the default: terminating quotients, exact roots and logarithms', () => {
    expect(evaluate('1/8').toString()).toBe('0.125');
    expect(evaluate('sqrt(2.25)', { scale: 1 }).toString()).toBe('1.5');
    expect(evaluate('log10(1000)', { scale: 0 }).toString()).toBe('3');
    // At the default scale of 20 the exact root is returned with 20 fraction digits.
    expect(evaluate('sqrt(4)').eq(2)).toBe(true);
  });
});

describe('exact reporting', () => {
  it('detailed() is exact until a step rounds, and a later exact step does not restore it', () => {
    // 1/3 × 3 rounds at 1/3: the product 0.99… is not 1, and the flag must say so.
    expect(detailed('1/3 * 3', { scale: 4, rounding: 'halfEven' })).toEqual(['0.9999', false]);
    expect(detailed('1/4 * 3')).toEqual(['0.75', true]);
  });

  it('f() and f.detailed() agree on the value; each call starts exact again', () => {
    const f = compile(parse('x / 3'), { variables: ['x'], scale: 3, rounding: 'halfUp' });
    expect(f.detailed({ x: '1' }).exact).toBe(false);
    expect(f.detailed({ x: '3' })).toEqual({ value: decimal(1), exact: true });
    expect(f({ x: '2' }).toString()).toBe('0.667');
  });
});

describe('integer-only operations are exact', () => {
  it('factorial uses @arki/math/integer: 25! keeps every digit a double would lose', () => {
    expect(evaluate('25!').toString()).toBe('15511210043330985984000000');
    expect(evaluate('factorial(0)').toString()).toBe('1');
    expect(() => evaluate('2.5!')).toThrow(InvalidArgumentError);
    expect(() => evaluate('(-1)!')).toThrow(InvalidArgumentError);
  });

  it('floor ceil round fix sign abs mod follow the float domain’s definitions, exactly', () => {
    expect(
      ['floor(-2.5)', 'ceil(-2.5)', 'round(-2.5)', 'round(2.5)', 'fix(-2.7)'].map(text => evaluate(text).toString()),
    ).toEqual(['-3', '-2', '-3', '3', '-2']);
    expect(
      ['sign(-0.5)', 'abs(-0.5)', 'mod(-7, 3)', 'mod(7, -3)', 'mod(5.5, 2)'].map(text => evaluate(text).toString()),
    ).toEqual(['-1', '0.5', '2', '-2', '1.5']);
    expect(() => evaluate('mod(1, 0)')).toThrow(DivisionByZeroError);
  });
});

describe('literals and scope', () => {
  it('reads each literal from its text: 0.1 is exactly one tenth', () => {
    const f = compile(parse('x - 0.1'), { variables: ['x'] });
    expect(f({ x: '0.1' }).isZero()).toBe(true);
    expect(evaluate('1e-3 + .5').toString()).toBe('0.501');
  });

  it('scope values accept what decimal() accepts, and nothing else', () => {
    const f = compile(parse('x + 1'), { variables: ['x'] });
    expect([decimal('1.5'), '1.5', 1.5, 2n].map(x => f({ x }).toString())).toEqual(['2.5', '2.5', '2.5', '3']);
    expect(() => f()).toThrow(InvalidArgumentError);
    // A wrong type from untyped callers is a typed error, not a TypeError from deep inside math.
    expect(() => {
      Reflect.apply(f, undefined, [{ x: { value: 1 } }]);
    }).toThrow(InvalidArgumentError);
  });

  it('rejects a context it cannot honour', () => {
    expect(() => compile(parse('1'), { scale: -1 })).toThrow(InvalidArgumentError);
    expect(() => compile(parse('1'), { scale: 1.5 })).toThrow(InvalidArgumentError);
    expect(() => {
      Reflect.apply(compile, undefined, [parse('1'), { rounding: 'nearest' }]);
    }).toThrow(InvalidArgumentError);
  });
});

describe('the digits budget (RFC §11)', () => {
  it('checks literal digits at compile', () => {
    expect(thrown(() => compile(parse('1e5000')))).toMatchObject({ budget: 'digits', limit: 1000, actual: 5001 });
    expect(evaluate('1e1500', { limits: { digits: 2000 } }).toString()).toHaveLength(1501);
  });

  it('estimates a power before computing it: 9^9^9 throws in well under a millisecond of bigint work', () => {
    const started = Date.now();
    const error = thrown(() => evaluate('9^9^9'));
    expect(error).toBeInstanceOf(ExprLimitError);
    expect(Date.now() - started).toBeLessThan(100);
    // 0.1^n grows in fraction digits, not in the coefficient: still caught.
    expect(thrown(() => evaluate('0.1^5000'))).toBeInstanceOf(ExprLimitError);
    // Bases 0, 1 and -1 never grow, whatever the exponent.
    expect(evaluate('(-1)^(10^30 + 1)').toString()).toBe('-1');
  });
});

describe('cancellation', () => {
  it('checks the signal before an operation on a value above 100 digits, not on small ones', () => {
    const reason = new Error('stop');
    // The AbortSignal shape the call reads; an aborted AbortController's signal behaves the same.
    const signal = { aborted: true, reason };
    const f = compile(parse('x^20 * x'), { variables: ['x'] });
    // 123456789^20 has 162 digits: the multiplication that follows is where the check fires.
    expect(thrown(() => f({ x: '123456789' }, { signal: signal }))).toBe(reason);
    expect(f({ x: '2' }, { signal: signal }).toString()).toBe('2097152');
    // evaluate folds everything at compile; the fold honours the signal too.
    expect(thrown(() => evaluate('(10^150) * 2', { signal: signal }))).toBe(reason);
  });
});

describe('host functions and constants', () => {
  it('receive and must return Decimals', () => {
    const vat = defineLanguage({ extends: scientific, functions: { net: { arity: 1 } }, constants: { tax: {} } });
    const f = compile(parse('net(x) * tax', { language: vat }), {
      language: vat,
      variables: ['x'],
      functions: { net },
      constants: { tax: '0.25' },
    });
    expect(f({ x: '100' }).toString()).toBe('20.0000');
    const bad = compile(parse('net(1)', { language: vat }), {
      language: vat,
      functions: { net: () => decimal(1) },
      constants: { tax: 1 },
    });
    expect(isDecimal(bad())).toBe(true);
    // A host returning a float would be silent coercion: it is refused at the call.
    const options = { language: vat, functions: { net: () => 1 }, constants: { tax: 1 } };
    const g: unknown = Reflect.apply(compile, undefined, [parse('net(1)', { language: vat }), options]);
    expect(() => {
      if (typeof g === 'function') Reflect.apply(g, undefined, []);
    }).toThrow(InvalidArgumentError);
  });
});

describe('compileEquation', () => {
  it('compiles both sides and their difference on one set of slots', () => {
    const { left, right, difference } = compileEquation(parseEquation('2x = x + 0.5'), { variables: ['x'] });
    expect([left, right, difference].map(f => f({ x: '0.5' }).toString())).toEqual(['1.0', '1.0', '0.0']);
  });

  it('reports split readings and warnings like float', () => {
    const f = compile(parse('a/bc'), { variables: ['a', 'b', 'c'] });
    expect(f.readings.map(reading => reading.letters)).toEqual([['b', 'c']]);
    expect(f.warnings.map(warning => warning.code)).toEqual(['split-after-division']);
    expect(f({ a: '1', b: '2', c: '4' }).toString()).toBe('0.125');
  });
});
