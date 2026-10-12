import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, DivisionByZeroError, InvalidArgumentError, NumberFormatError, RoundingNecessaryError } from './errors.js';
import { Money, currencyScale, isMoney, money } from './money.js';

const eur = (v: string) => money(v, 'EUR');
const strings = (parts: Money[]) => parts.map((p) => p.amount.toString());

describe('construction', () => {
  it('keeps the currency scale and upper-cases the code', () => {
    expect(money(5, 'eur').toString()).toBe('5.00 EUR');
    expect(money('19.9', 'EUR').amount.scale).toBe(2);
  });

  it('refuses to lose cents silently, but rounds when told how', () => {
    expect(() => money('1.005', 'EUR')).toThrow(RoundingNecessaryError);
    expect(money('1.005', 'EUR', { rounding: 'halfEven' }).toString()).toBe('1.00 EUR');
    expect(money('1.005', 'EUR', { rounding: 'halfUp' }).toString()).toBe('1.01 EUR');
  });

  it('accepts trailing zeros beyond the scale without rounding', () => {
    expect(money('1.500', 'EUR').toString()).toBe('1.50 EUR');
  });

  it('uses scale 0 for JPY and 3 for BHD', () => {
    expect(currencyScale('JPY')).toBe(0);
    expect(currencyScale('BHD')).toBe(3);
    expect(money(500, 'JPY').toString()).toBe('500 JPY');
    expect(() => money('1.5', 'JPY')).toThrow(RoundingNecessaryError);
    expect(money('1.5', 'BHD').toString()).toBe('1.500 BHD');
    expect(money(1, 'BHD').toMinorUnits()).toBe(1000n);
  });

  it('builds from minor units', () => {
    expect(Money.fromMinorUnits(1999n, 'EUR').toString()).toBe('19.99 EUR');
    expect(Money.fromMinorUnits(-5, 'EUR').toString()).toBe('-0.05 EUR');
    expect(Money.fromMinorUnits(500, 'JPY').toString()).toBe('500 JPY');
    expect(() => Money.fromMinorUnits(1.5, 'EUR')).toThrow(InvalidArgumentError);
  });

  it('accepts a Money of the same currency only', () => {
    expect(money(eur('2'), 'EUR').toString()).toBe('2.00 EUR');
    expect(() => money(eur('2'), 'USD')).toThrow(CurrencyMismatchError);
  });

  it('rejects bad currency codes', () => {
    expect(() => money(1, 'EURO')).toThrow(InvalidArgumentError);
    expect(() => money(1, 'E1R')).toThrow(InvalidArgumentError);
    expect(() => currencyScale('')).toThrow(InvalidArgumentError);
  });

  it('cannot be built with new', () => {
    expect(isMoney(eur('1'))).toBe(true);
    expect(isMoney('1 EUR')).toBe(false);
    // @ts-expect-error the constructor is private
    expect(() => new Money(eur('1').amount, 'EUR', Symbol('x'))).toThrow(TypeError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts at the currency scale', () => {
    expect(eur('19.99').plus(eur('0.01')).toString()).toBe('20.00 EUR');
    expect(eur('1.00').minus(eur('1.01')).toString()).toBe('-0.01 EUR');
  });

  it('multiplies with halfEven by default', () => {
    expect(eur('19.99').times('1.19').toString()).toBe('23.79 EUR');
    expect(eur('0.25').times('0.5').toString()).toBe('0.12 EUR');
    expect(eur('0.25').times('0.5', { rounding: 'up' }).toString()).toBe('0.13 EUR');
  });

  it('divides with halfEven by default and honors rounding', () => {
    expect(eur('20.00').dividedBy(3).toString()).toBe('6.67 EUR');
    expect(eur('19.99').dividedBy(3).toString()).toBe('6.66 EUR');
    expect(eur('19.99').dividedBy(3, { rounding: 'up' }).toString()).toBe('6.67 EUR');
    expect(() => eur('1').dividedBy(0)).toThrow(DivisionByZeroError);
  });

  it('computes percentages', () => {
    expect(eur('200').percentage(15).toString()).toBe('30.00 EUR');
    expect(eur('19.99').percentage('7.5').toString()).toBe('1.50 EUR');
  });

  it('negates and takes absolute values', () => {
    expect(eur('3').negated().toString()).toBe('-3.00 EUR');
    expect(eur('-3').abs().toString()).toBe('3.00 EUR');
  });

  it('rejects mixed currencies', () => {
    expect(() => eur('1').plus(money(1, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => eur('1').minus(money(1, 'USD'))).toThrow(CurrencyMismatchError);
  });
});

describe('allocate', () => {
  it('gives the leftover cent to the earliest parts on a tie', () => {
    expect(strings(eur('100').allocate([1, 1, 1]))).toEqual(['33.34', '33.33', '33.33']);
  });

  it('can leave a part empty', () => {
    expect(strings(eur('0.01').allocate([50, 50]))).toEqual(['0.01', '0.00']);
  });

  it('gives leftovers to the largest remainder, not the first part', () => {
    // 0.03 over [3, 3, 4]: floors 0,0,1; remainders 9,9,2 of 10; the two leftover cents go to parts 0 and 1... 
    expect(strings(eur('0.03').allocate([3, 3, 4]))).toEqual(['0.01', '0.01', '0.01']);
    // 0.02 over [1, 8, 1]: floors 0,1,0; the leftover cent goes to part 1 (remainder 6 of 10 beats 2).
    expect(strings(eur('0.02').allocate([1, 8, 1]))).toEqual(['0.00', '0.02', '0.00']);
  });

  it('splits negative amounts and keeps the sum', () => {
    const parts = eur('-10').allocate([1, 2]);
    expect(strings(parts)).toEqual(['-3.33', '-6.67']);
    expect(Money.sum(parts).toString()).toBe('-10.00 EUR');
  });

  it('always sums back to the whole', () => {
    const whole = eur('123.45');
    const parts = whole.allocate([3, 7, 11, 0, 5]);
    expect(Money.sum(parts).eq(whole)).toBe(true);
    expect(parts[3]?.isZero()).toBe(true);
  });

  it('works in JPY and with bigint or fractional ratios', () => {
    expect(strings(money(100, 'JPY').allocate([1, 1, 1]))).toEqual(['34', '33', '33']);
    expect(strings(eur('10').allocate([1n, 1n]))).toEqual(['5.00', '5.00']);
    expect(strings(eur('10').allocate([0.5, 1.5]))).toEqual(['2.50', '7.50']);
  });

  it('validates ratios', () => {
    expect(() => eur('1').allocate([])).toThrow(InvalidArgumentError);
    expect(() => eur('1').allocate([0, 0])).toThrow(InvalidArgumentError);
    expect(() => eur('1').allocate([1, -1])).toThrow(InvalidArgumentError);
    expect(() => eur('1').allocate([1, Number.NaN])).toThrow();
  });
});

describe('comparison', () => {
  it('compares within a currency', () => {
    expect(eur('1').lt(eur('2'))).toBe(true);
    expect(eur('2').lte(eur('2'))).toBe(true);
    expect(eur('3').gt(eur('2'))).toBe(true);
    expect(eur('2').gte(eur('3'))).toBe(false);
    expect(eur('2').eq(eur('2.00'))).toBe(true);
    expect(eur('2').compareTo(eur('3'))).toBe(-1);
  });

  it('throws on mixed currencies instead of guessing', () => {
    expect(() => eur('1').eq(money(1, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => Money.compare(eur('1'), money(1, 'USD'))).toThrow(CurrencyMismatchError);
    expect(eur('1').hasSameCurrency(money(1, 'USD'))).toBe(false);
    expect(eur('1').hasSameCurrency(eur('9'))).toBe(true);
  });

  it('reports sign', () => {
    expect(eur('0').isZero()).toBe(true);
    expect(eur('1').isPositive()).toBe(true);
    expect(eur('-1').isNegative()).toBe(true);
  });

  it('sorts with Money.compare', () => {
    const sorted = [eur('3'), eur('1'), eur('2')].toSorted((a, b) => Money.compare(a, b)).map(String);
    expect(sorted).toEqual(['1.00 EUR', '2.00 EUR', '3.00 EUR']);
  });
});

describe('sum', () => {
  it('adds a list', () => {
    expect(Money.sum([eur('1.10'), eur('2.20')]).toString()).toBe('3.30 EUR');
  });

  it('needs a currency for an empty list', () => {
    expect(() => Money.sum([])).toThrow(InvalidArgumentError);
    expect(Money.sum([], 'USD').toString()).toBe('0.00 USD');
  });

  it('rejects mixed currencies, including against the given one', () => {
    expect(() => Money.sum([eur('1'), money(1, 'USD')])).toThrow(CurrencyMismatchError);
    expect(() => Money.sum([eur('1')], 'USD')).toThrow(CurrencyMismatchError);
  });
});

describe('conversion', () => {
  it('round-trips through toString and parse', () => {
    for (const m of [eur('19.99'), money(-5, 'JPY'), money('1.5', 'BHD')]) {
      expect(Money.parse(m.toString()).eq(m)).toBe(true);
      expect(Money.parse(m.toString()).toString()).toBe(m.toString());
    }
    expect(Money.parse('EUR 19.99').toString()).toBe('19.99 EUR');
  });

  it('rejects unparseable text', () => {
    expect(() => Money.parse('19.99')).toThrow(NumberFormatError);
    expect(() => Money.parse('abc EUR')).toThrow(NumberFormatError);
    expect(() => Money.parse('1.005 EUR')).toThrow(RoundingNecessaryError);
  });

  it('exposes decimal, minor units and number', () => {
    expect(eur('19.99').toMinorUnits()).toBe(1999n);
    expect(eur('19.99').toNumber()).toBe(19.99);
    expect(eur('19.99').toDecimal().toString()).toBe('19.99');
  });

  it('formats with Intl', () => {
    expect(money('19.99', 'USD').format()).toBe('$19.99');
    expect(eur('1234.5').format({ locale: 'de-DE' })).toBe('1.234,50 €');
  });

  it('round-trips through JSON', () => {
    const m = eur('19.99');
    expect(JSON.stringify(m)).toBe('{"amount":"19.99","currency":"EUR"}');
    expect(Money.fromJSON(m.toJSON()).eq(m)).toBe(true);
    // @ts-expect-error wrong shape on purpose
    expect(() => Money.fromJSON({ amount: 1 })).toThrow(InvalidArgumentError);
  });

  it('refuses to become a float', () => {
    expect(() => Number(eur('1'))).toThrow(TypeError);
    expect(String(eur('1'))).toBe('1.00 EUR');
    expect(() => eur('1').valueOf()).toThrow(TypeError);
  });

  it('shows nicely in Node and Deno consoles', () => {
    const m = eur('1');
    expect(Reflect.apply(Reflect.get(m, Symbol.for('nodejs.util.inspect.custom')), m, [])).toBe('Money(1.00 EUR)');
    expect(Reflect.apply(Reflect.get(m, Symbol.for('Deno.customInspect')), m, [])).toBe('Money(1.00 EUR)');
  });
});

describe('immutability', () => {
  it('is frozen', () => {
    const m = eur('1');
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      Reflect.defineProperty(m, 'currency', { value: 'USD' });
      if (m.currency !== 'EUR') throw new Error('mutated');
    }).not.toThrow();
    expect(m.currency).toBe('EUR');
    expect(m.plus(eur('1'))).not.toBe(m);
  });
});

describe('review regressions', () => {
  it('fromMinorUnits rejects non-integer types', () => {
    expect(() => Money.fromMinorUnits(true as never, 'EUR')).toThrow(TypeError);
    expect(() => Money.fromMinorUnits('5' as never, 'EUR')).toThrow(TypeError);
  });
  it('sum rejects non-Money elements', () => {
    expect(() => Money.sum([5 as never])).toThrow('Money.sum expects Money values');
  });
  it('rejects unknown currency codes', () => {
    expect(() => currencyScale('ZZZ')).toThrow(InvalidArgumentError);
    expect(() => money(1, 'ZZZ')).toThrow('Unknown currency code "ZZZ"');
    expect(currencyScale('EUR')).toBe(2);
  });
  it('sum adds in one pass, checks currency, and handles empty lists', () => {
    expect(Money.sum([eur('1.10'), eur('2.25'), eur('0.65')]).toString()).toBe('4.00 EUR');
    expect(Money.sum([], 'JPY').toString()).toBe('0 JPY');
    expect(() => Money.sum([eur('1'), money(1, 'USD')])).toThrow(CurrencyMismatchError);
  });
  it('Money.from is the constructor', () => {
    expect(Money.from('1.5', 'EUR').toString()).toBe('1.50 EUR');
  });
});
