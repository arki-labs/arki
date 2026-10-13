import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, NumericRangeError, ResourceLimitError } from './errors.js';
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
} from './finance-float.js';
import * as exact from './finance.js';

/** Relative error, the right yardstick for money amounts of any size. */
function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

// Reference values are what Excel / Google Sheets compute, checked to 40
// digits with `bc -l`. Excel returns cash flows (negated); this layer returns
// balances, so each Excel figure appears here with its sign flipped.
describe('payment', () => {
  it('matches Excel PMT for a 30-year mortgage', () => {
    // PMT(0.05/12, 360, 200000) = -1073.643246
    expect(relativeError(payment(200_000, 0.05 / 12, 360), 1073.643_246_024_278)).toBeLessThan(1e-14);
  });
  it('accepts fractional periods, which the exact layer cannot', () => {
    // PMT(0.004, 90.5, 15000) = -197.8795997572
    expect(relativeError(payment(15_000, 0.004, 90.5), 197.879_599_757_239_2)).toBeLessThan(1e-13);
  });
  it('divides by 1 + rate when paid at the start of the period, like Excel type 1', () => {
    expect(payment(10_000, 0.01, 12, { timing: 'begin' })).toBeCloseTo(payment(10_000, 0.01, 12) / 1.01, 10);
  });
  // The naive formula is rate × P ÷ (1 − (1 + rate)^-n): at rate 1e-20 that is 0 ÷ 0.
  it('reaches the zero-rate limit P ÷ n smoothly instead of dividing 0 by 0', () => {
    expect(payment(1200, 0, 12)).toBe(100);
    expect(relativeError(payment(1200, 1e-20, 12), 100)).toBeLessThan(1e-15);
  });
  it('rejects input it cannot price', () => {
    expect(() => payment(1000, 0.01, 0)).toThrow(InvalidArgumentError);
    expect(() => payment(1000, 0.01, -3)).toThrow(InvalidArgumentError);
    expect(() => payment(1000, -1, 3)).toThrow(InvalidArgumentError);
    expect(() => payment(1000, 0.01, Number.NaN)).toThrow(InvalidArgumentError);
    expect(() => payment(Number.POSITIVE_INFINITY, 0.01, 3)).toThrow(InvalidArgumentError);
  });
});

describe('futureValue', () => {
  it('matches Excel FV with a monthly deposit on top of a lump sum', () => {
    // FV(0.06/12, 120, -100, -1000, 0) = 18207.33141467858
    expect(relativeError(futureValue(1000, 0.005, 120, { payment: 100 }), 18_207.331_414_678_58)).toBeLessThan(1e-14);
  });
  it('grows over fractional periods (7.5 years)', () => {
    // FV(0.05, 7.5, 0, -1000) = 1441.848875371954
    expect(relativeError(futureValue(1000, 0.05, 7.5), 1441.848_875_371_954)).toBeLessThan(1e-14);
  });
  it('discounts over negative periods', () => {
    expect(futureValue(1441.848_875_371_954, 0.05, -7.5)).toBeCloseTo(1000, 9);
  });
  it('pays a loan off to zero with the payment from `payment`', () => {
    const level = payment(200_000, 0.05 / 12, 360);
    expect(Math.abs(futureValue(200_000, 0.05 / 12, 360, { payment: -level }))).toBeLessThan(1e-6);
  });
  // ((1 + r)^n − 1) ÷ r computed naively at r = 1e-12 loses ~4 of 16 digits to cancellation.
  it('keeps full precision at a tiny rate', () => {
    // 360 payments of 1 at 1e-12: 360 + 1e-12 × 360 × 359 ÷ 2 + … = 360.00000006462000000771
    expect(relativeError(futureValue(0, 1e-12, 360, { payment: 1 }), 360.000_000_064_62)).toBeLessThan(1e-15);
    expect(futureValue(0, 0, 360, { payment: 1 })).toBe(360);
  });
  it('handles growth the exact layer refuses for its digit limit', () => {
    // 1000 × 1.0001234567^3650 = 1569.236415426459; exactly that power has 40 150 digits.
    expect(() => exact.futureValue(1000, '0.0001234567', 3650)).toThrow(ResourceLimitError);
    expect(relativeError(futureValue(1000, 0.000_123_456_7, 3650), 1569.236_415_426_459)).toBeLessThan(1e-12);
  });
  it('throws instead of returning Infinity, and rejects a rate of -100 %', () => {
    expect(() => futureValue(1, 1, 5000)).toThrow(NumericRangeError);
    expect(() => futureValue(1, -1, 5)).toThrow(InvalidArgumentError);
    expect(() => futureValue(1, 0.05, 5, { payment: Number.NaN })).toThrow(InvalidArgumentError);
  });
});

describe('presentValue', () => {
  it('matches Excel PV for payments at the start of each period (type 1)', () => {
    // PV(0.08/12, 240, 500, 0, 1) = -60175.66015686261
    const value = presentValue(0, 0.08 / 12, 240, { payment: 500, timing: 'begin' });
    expect(relativeError(value, 60_175.660_156_862_61)).toBeLessThan(1e-13);
  });
  it('discounts over fractional periods', () => {
    // PV(0.07, 7.5, 0, 1000) = -602.0348990236029
    expect(relativeError(presentValue(1000, 0.07, 7.5), 602.034_899_023_602_9)).toBeLessThan(1e-14);
  });
  it('is the future value brought back: FV of payments ÷ (1 + r)^n', () => {
    const fv = futureValue(0, 0.0075, 60, { payment: 250 });
    expect(relativeError(presentValue(fv, 0.0075, 60), presentValue(0, 0.0075, 60, { payment: 250 }))).toBeLessThan(
      1e-14,
    );
  });
  it('is n × payment at rate 0', () => {
    expect(presentValue(0, 0, 12, { payment: 50 })).toBe(600);
  });
});

describe('agreement with the exact layer', () => {
  // Same inputs, both layers: the float layer must not drift from the exact one
  // beyond float noise, or calculators would switch answers when they switch layers.
  const cases = [
    { principal: 200_000, rate: '0.005', periods: 360, payment: -1000, timing: 'end' },
    { principal: 1000, rate: '0.0075', periods: 60, payment: 250, timing: 'begin' },
    { principal: 0, rate: '0.004', periods: 90, payment: 15, timing: 'end' },
    { principal: 5000, rate: '-0.02', periods: 12, payment: 100, timing: 'begin' },
  ] as const;
  it.each(cases)('futureValue and presentValue agree to 1e-12 at rate $rate', c => {
    const options = { payment: c.payment, timing: c.timing };
    const rate = Number(c.rate);
    expect(
      relativeError(
        futureValue(c.principal, rate, c.periods, options),
        exact.futureValue(c.principal, c.rate, c.periods, options).toNumber(),
      ),
    ).toBeLessThan(1e-12);
    expect(
      relativeError(
        presentValue(c.principal, rate, c.periods, options),
        exact.presentValue(c.principal, c.rate, c.periods, { ...options, scale: 30 }).toNumber(),
      ),
    ).toBeLessThan(1e-12);
  });
  it('payment, compound interest and rates agree to 1e-12', () => {
    const exactPayment = exact.payment(200_000, '0.005', 360, { scale: 30, timing: 'begin' }).toNumber();
    expect(relativeError(payment(200_000, 0.005, 360, { timing: 'begin' }), exactPayment)).toBeLessThan(1e-12);
    expect(
      relativeError(compoundInterest(1000, 0.05, 10), exact.compoundInterest(1000, '0.05', 10).toNumber()),
    ).toBeLessThan(1e-12);
    expect(
      relativeError(effectiveRate(0.06, 12), exact.effectiveRate('0.06', 12, { scale: 30 }).toNumber()),
    ).toBeLessThan(1e-12);
    expect(
      relativeError(
        netPresentValue(0.1, [-10_000, 3000, 4200, 6800]),
        exact.netPresentValue('0.1', [-10_000, 3000, 4200, 6800], { scale: 30 }).toNumber(),
      ),
    ).toBeLessThan(1e-12);
  });
  it('shares one implementation of the float-only functions', () => {
    expect(exact.internalRateOfReturn).toBe(internalRateOfReturn);
    expect(exact.periodsToReach).toBe(periodsToReach);
  });
});

describe('compoundInterest', () => {
  // principal × (1 + r)^n − principal cancels to 0 in floats when r is tiny; expm1 does not.
  it('keeps tiny interest that subtraction would cancel away', () => {
    expect(relativeError(compoundInterest(1, 1e-17, 10), 1e-16)).toBeLessThan(1e-15);
    expect(compoundInterest(1000, 0, 10)).toBe(0);
  });
  it('round-trips with periodsToReach on fractional periods', () => {
    const periods = periodsToReach(1000, 2000, 0.07);
    expect(compoundInterest(1000, 0.07, periods)).toBeCloseTo(1000, 9);
  });
});

describe('effectiveRate / nominalRate', () => {
  it('matches Excel EFFECT for monthly and daily compounding', () => {
    // EFFECT(0.06, 12) = 0.06167781186449957; EFFECT(0.06, 365) = 0.06183131067785369
    expect(relativeError(effectiveRate(0.06, 12), 0.061_677_811_864_499_57)).toBeLessThan(1e-14);
    expect(relativeError(effectiveRate(0.06, 365), 0.061_831_310_677_853_69)).toBeLessThan(1e-13);
  });
  it('inverts with nominalRate, like Excel NOMINAL', () => {
    expect(relativeError(nominalRate(effectiveRate(0.06, 365), 365), 0.06)).toBeLessThan(1e-14);
  });
  it('accepts compounding less than once a year', () => {
    expect(effectiveRate(0.1, 0.5)).toBeCloseTo(Math.sqrt(1.2) - 1, 15);
  });
  it('rejects rates and frequencies with no meaning', () => {
    expect(() => effectiveRate(-12, 12)).toThrow(InvalidArgumentError);
    expect(() => effectiveRate(0.06, 0)).toThrow(InvalidArgumentError);
    expect(() => nominalRate(-1, 12)).toThrow(InvalidArgumentError);
  });
});

describe('netPresentValue', () => {
  it('matches the Excel NPV documentation example', () => {
    // NPV(10%, -10000, 3000, 4200, 6800) = 1188.443412335223
    expect(relativeError(netPresentValue(0.1, [-10_000, 3000, 4200, 6800]), 1188.443_412_335_223)).toBeLessThan(1e-14);
  });
  it('rejects empty or non-finite flows and impossible rates', () => {
    expect(() => netPresentValue(0.1, [])).toThrow(InvalidArgumentError);
    expect(() => netPresentValue(0.1, [1, Number.NaN])).toThrow(InvalidArgumentError);
    expect(() => netPresentValue(-1, [1])).toThrow(InvalidArgumentError);
  });
});

describe('amortizationSchedule', () => {
  it('pays the loan down to exactly zero and keeps payment = interest + principal', () => {
    const rows = amortizationSchedule(200_000, 0.005, 360);
    expect(rows).toHaveLength(360);
    expect(rows.at(-1)?.balance).toBe(0);
    expect(rows[0]?.interest).toBe(1000);
    expect(rows[0]?.payment).toBeCloseTo(1199.101_050_305_4, 9);
    for (const r of rows) expect(r.payment).toBeCloseTo(r.interest + r.principal, 9);
    expect(rows.reduce((sum, r) => sum + r.principal, 0)).toBeCloseTo(200_000, 6);
  });
  it('charges no interest on the first row when paying at the start', () => {
    const rows = amortizationSchedule(10_000, 0.01, 12, { timing: 'begin' });
    expect(rows[0]?.interest).toBe(0);
    expect(rows[0]?.payment).toBeCloseTo(879.69, 2);
    expect(rows.at(-1)?.balance).toBe(0);
  });
  it('refuses fractional, empty or huge schedules', () => {
    expect(() => amortizationSchedule(1, 0.01, 2.5)).toThrow(InvalidArgumentError);
    expect(() => amortizationSchedule(1, 0.01, 0)).toThrow(InvalidArgumentError);
    expect(() => amortizationSchedule(1, 0, 100_001)).toThrow(ResourceLimitError);
    expect(amortizationSchedule(100_000, 0, 100_000)).toHaveLength(100_000);
  });
});
