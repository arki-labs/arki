import { describe, expect, it } from 'vitest';

import { Decimal } from './decimal.js';
import { InvalidArgumentError, ResourceLimitError, RoundingNecessaryError } from './errors.js';
import {
  amortizationSchedule,
  compoundInterest,
  effectiveRate,
  futureValue,
  internalRateOfReturn,
  netPresentValue,
  nominalRate,
  payment,
  periodsToReach,
  presentValue,
  simpleInterest,
} from './finance.js';

const cents = { scale: 2, rounding: 'halfEven' } as const;

describe('payment', () => {
  it('matches the well-known 30-year mortgage figure', () => {
    expect(payment(200_000, 0.005, 360, cents).toString()).toBe('1199.10');
  });
  it('splits evenly when the rate is zero', () => {
    expect(payment(1000, 0, 10, cents).toString()).toBe('100.00');
  });
  it('is smaller when paid at the start of the period', () => {
    const end = payment(10_000, 0.01, 12, cents);
    const begin = payment(10_000, 0.01, 12, { ...cents, timing: 'begin' });
    expect(begin.toString()).toBe('879.69');
    expect(end.toString()).toBe('888.49');
  });
  it('rejects bad input', () => {
    expect(() => payment(1000, 0.01, 0, cents)).toThrow(InvalidArgumentError);
    expect(() => payment(1000, 0.01, 2.5, cents)).toThrow(InvalidArgumentError);
    expect(() => payment(1000, 0.01, -3, cents)).toThrow(InvalidArgumentError);
    expect(() => payment(1000, -1, 3, cents)).toThrow(InvalidArgumentError);
    expect(() => payment(1000, 0.01, Number.NaN, cents)).toThrow(InvalidArgumentError);
  });
});

describe('futureValue / presentValue', () => {
  it('is exact for integer periods', () => {
    const exact = futureValue(1000, 0.05, 10);
    expect(exact.eq('1628.89462677744140625')).toBe(true);
    expect(exact.scale).toBe(20);
  });
  it('rounds once when asked', () => {
    expect(futureValue(1000, 0.05, 10, { scale: 2 }).toString()).toBe('1628.89');
  });
  // Fractional periods were dropped: guard-digit rounding of a fractional power
  // misrounded near boundaries and made `rounding: 'unnecessary'` lie.
  it('rejects fractional periods, including the inputs that used to misround', () => {
    expect(() => futureValue(100, 0.21, 0.5, { scale: 4 })).toThrow(InvalidArgumentError);
    expect(() => futureValue(1, '0.010025000000000000000001', 0.5, { scale: 2 })).toThrow(InvalidArgumentError);
    expect(() => presentValue(121, 0.21, 0.5, { scale: 2 })).toThrow(InvalidArgumentError);
    expect(() => presentValue(1, '-0.999999999999999999999999999999', 0.5, { scale: 2 })).toThrow(InvalidArgumentError);
    expect(() => compoundInterest(100, 0.21, 0.5, { scale: 2 })).toThrow(InvalidArgumentError);
    expect(() => futureValue(100, 0.21, Number.MAX_SAFE_INTEGER + 1)).toThrow(InvalidArgumentError);
  });
  it("makes rounding: 'unnecessary' honest", () => {
    expect(() => futureValue(1, '0.21', 1, { scale: 1, rounding: 'unnecessary' })).toThrow(RoundingNecessaryError);
    expect(futureValue(1, '0.21', 2, { scale: 4, rounding: 'unnecessary' }).toString()).toBe('1.4641');
  });
  it('divides exactly by a tiny growth factor', () => {
    expect(presentValue(1, '-0.999999999999999999999999999999', 1, { scale: 2 }).toString()).toBe(
      '1000000000000000000000000000000.00',
    );
  });
  it('discounts back to the starting amount', () => {
    expect(presentValue('1628.89', 0.05, 10, cents).toString()).toBe('1000.00');
    expect(presentValue(121, 0.1, 2, { scale: 2 }).toString()).toBe('100.00');
  });
  it('rejects a rate of -100 % or lower', () => {
    expect(() => futureValue(100, -1, 2)).toThrow(InvalidArgumentError);
    expect(() => presentValue(100, -2, 2, cents)).toThrow(InvalidArgumentError);
  });
});

describe('futureValue / presentValue with a payment', () => {
  // Excel FV(0.06/12, 120, -100, -1000, 0) = 18207.33: the same deposits, read as a balance.
  it('adds each payment grown to the end, as Excel FV does', () => {
    expect(futureValue(1000, '0.005', 120, { payment: 100, scale: 2 }).toString()).toBe('18207.33');
  });
  // ((1 + r)^n − 1) ÷ r is the polynomial Σ (1 + r)^k, so no rounding is needed.
  it('stays exact without a scale', () => {
    expect(futureValue(0, '0.1', 2, { payment: 100 }).eq(210)).toBe(true);
    expect(futureValue(0, '0.1', 2, { payment: 100, timing: 'begin' }).eq(231)).toBe(true);
    expect(futureValue(0, 0, 12, { payment: 50 }).eq(600)).toBe(true);
  });
  it('pays a loan off to zero with a negative payment', () => {
    expect(futureValue(100, '0.1', 2, { payment: '-57.619047619047619047619', scale: 10 }).isZero()).toBe(true);
  });
  // PV(0.0075, 60, -250, -5000, 1) = 15327.1669485566
  it('discounts the payments and the amount with one rounding, as Excel PV does', () => {
    expect(presentValue(5000, '0.0075', 60, { payment: 250, timing: 'begin', scale: 2 }).toString()).toBe('15327.17');
    expect(presentValue(0, 0, 12, { payment: 50, scale: 2 }).toString()).toBe('600.00');
  });
});

describe('netPresentValue', () => {
  it('discounts flows from t = 1', () => {
    expect(netPresentValue(0.1, [100, 100, 100], cents).toString()).toBe('248.69');
  });
  it('lets the caller add the t = 0 flow', () => {
    expect(
      Decimal.from(-250)
        .plus(netPresentValue(0.1, [100, 100, 100], cents))
        .toString(),
    ).toBe('-1.31');
  });
  it('rejects empty flows', () => {
    expect(() => netPresentValue(0.1, [], cents)).toThrow(InvalidArgumentError);
  });
});

describe('internalRateOfReturn', () => {
  it('finds the rate that zeroes the NPV', () => {
    expect(internalRateOfReturn([-100, 60, 60])).toBeCloseTo(0.130_662, 6);
  });
  it('falls back to bisection when Newton starts badly', () => {
    expect(internalRateOfReturn([-100, 60, 60], { guess: 50 })).toBeCloseTo(0.130_662, 6);
    expect(internalRateOfReturn([-100, 0, 0, 0, 200], { guess: -0.9 })).toBeCloseTo(2 ** 0.25 - 1, 6);
  });
  // Underflowed NPVs (0/0 = NaN) used to count as a sign change and give a false root near -1.
  it('ignores underflowed NPVs when bracketing a long series', () => {
    const flows = [-100, ...Array.from({ length: 99 }, () => 0), 200];
    const rate = internalRateOfReturn(flows);
    expect(rate).toBeCloseTo(2 ** (1 / 100) - 1, 12);
    expect(rate).toBeCloseTo(0.006_955_550_056_718_809, 12);
  });
  it('rejects flows without a sign change', () => {
    expect(() => internalRateOfReturn([100, 50])).toThrow(InvalidArgumentError);
    expect(() => internalRateOfReturn([-100])).toThrow(InvalidArgumentError);
    expect(() => internalRateOfReturn([-100, Number.NaN])).toThrow(InvalidArgumentError);
  });
});

describe('effectiveRate / nominalRate', () => {
  it('compounds a nominal rate', () => {
    expect(effectiveRate(0.12, 12, { scale: 6, rounding: 'halfEven' }).toString()).toBe('0.126825');
    expect(effectiveRate(0.1, 1).toString()).toBe('0.1');
  });
  it('inverts it', () => {
    expect(nominalRate(0.126_825, 12, { scale: 4, rounding: 'halfEven' }).toString()).toBe('0.1200');
    expect(nominalRate(0.21, 2, { scale: 4 }).toString()).toBe('0.2000');
  });
  it('keeps nominal ÷ n exact instead of rounding it as a Decimal', () => {
    expect(effectiveRate('0.1', 12, { scale: 4 }).toString()).toBe('0.1047');
    // Terminating: 1.05^2 − 1 is exact without options.
    expect(effectiveRate('0.1', 2).toString()).toBe('0.1025');
    // Non-terminating without options follows the exact-or-throw rule.
    expect(() => effectiveRate('0.1', 3)).toThrow(RoundingNecessaryError);
    expect(() => effectiveRate(-12, 12)).toThrow(InvalidArgumentError);
  });
  it('returns the exact nominal rate when the root is exact', () => {
    // (1 + 7)^(1/3) = 2, so the nominal rate is 3 × (2 − 1) = 3 exactly.
    expect(nominalRate(7, 3, { scale: 60 }).eq(3)).toBe(true);
    expect(nominalRate(7, 3, { scale: 60, rounding: 'unnecessary' }).eq(3)).toBe(true);
    expect(nominalRate('0.1025', 2, { scale: 30, rounding: 'unnecessary' }).eq('0.1')).toBe(true);
  });
  it('rejects bad frequencies', () => {
    expect(() => effectiveRate(0.1, 0)).toThrow(InvalidArgumentError);
    expect(() => nominalRate(0.1, 1.5, cents)).toThrow(InvalidArgumentError);
  });
});

describe('interest', () => {
  it('compound interest is future value minus principal', () => {
    expect(compoundInterest(1000, 0.05, 10, { scale: 2 }).toString()).toBe('628.89');
    expect(compoundInterest(1000, 0.1, 2).toString()).toBe('210.00');
  });
  it('simple interest is exact', () => {
    expect(simpleInterest('1000', '0.05', 2).toString()).toBe('100.00');
    expect(simpleInterest(1000, '0.05', '1.5').toString()).toBe('75.000');
    expect(() => simpleInterest(1000, 0.05, -1)).toThrow(InvalidArgumentError);
  });
});

describe('periodsToReach', () => {
  it('uses logarithms', () => {
    expect(periodsToReach(1000, 2000, 0.07)).toBeCloseTo(10.24, 2);
  });
  it('does not overflow when target ÷ principal is beyond float range', () => {
    expect(periodsToReach(1e-300, 1e300, 0.1)).toBeCloseTo(14_495.314_756_858_084, 8);
  });
  it('rejects impossible goals', () => {
    expect(() => periodsToReach(1000, 2000, 0)).toThrow(InvalidArgumentError);
    expect(() => periodsToReach(1000, 2000, -0.05)).toThrow(InvalidArgumentError);
    expect(() => periodsToReach(0, 2000, 0.05)).toThrow(InvalidArgumentError);
    expect(() => periodsToReach(1000, -5, 0.05)).toThrow(InvalidArgumentError);
  });
});

describe('amortizationSchedule', () => {
  const opts = { scale: 2, rounding: 'halfEven' } as const;
  it('pays the loan down to exactly zero', () => {
    const rows = amortizationSchedule(10_000, 0.01, 12, opts);
    expect(rows).toHaveLength(12);
    expect(rows.at(-1)?.balance.toString()).toBe('0.00');
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.balance.lt(rows[i - 1]?.balance ?? 0)).toBe(true);
    }
    expect(Decimal.sum(rows.map(r => r.principal)).toString()).toBe('10000.00');
    expect(rows[0]?.payment.toString()).toBe('888.49');
    expect(rows[0]?.interest.toString()).toBe('100.00');
  });
  it('keeps payment = interest + principal in every row', () => {
    for (const r of amortizationSchedule(200_000, 0.005, 360, opts)) {
      expect(r.payment.eq(r.interest.plus(r.principal))).toBe(true);
    }
  });
  it('charges no interest on the first row when paying at the start', () => {
    const rows = amortizationSchedule(10_000, 0.01, 12, { ...opts, timing: 'begin' });
    expect(rows[0]?.interest.toString()).toBe('0.00');
    expect(rows[0]?.payment.toString()).toBe('879.69');
    expect(rows.at(-1)?.balance.toString()).toBe('0.00');
    expect(Decimal.sum(rows.map(r => r.principal)).toString()).toBe('10000.00');
  });
  it('refuses huge schedules before doing any work', () => {
    expect(() => amortizationSchedule(1, 0, Number.MAX_SAFE_INTEGER, opts)).toThrow(ResourceLimitError);
    expect(() => amortizationSchedule(1, 0, 100_001, opts)).toThrow(ResourceLimitError);
    expect(amortizationSchedule(100_000, 0, 100_000, opts)).toHaveLength(100_000);
  });
  it('works with a zero rate and a single period', () => {
    const flat = amortizationSchedule(100, 0, 3, opts);
    expect(flat.map(r => r.payment.toString())).toEqual(['33.33', '33.33', '33.34']);
    expect(amortizationSchedule(100, 0.05, 1, opts)[0]?.balance.toString()).toBe('0.00');
  });
});
