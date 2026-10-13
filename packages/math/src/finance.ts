/**
 * Time-value-of-money helpers that follow the conventions of Excel and Google
 * Sheets, so formulas port over directly.
 *
 * - `rate` is per period, as a fraction: `0.05` is 5 %. Monthly loan at 6 %
 *   a year → `0.06 / 12` (as a Decimal, not a float).
 * - `periods` is a non-negative safe integer everywhere (`InvalidArgumentError`
 *   otherwise). For fractional or negative periods, growth too large for exact
 *   digits, or tight loops, use the float layer `@arki/math/finance/float`: the
 *   same function names and sign conventions on plain `number`.
 * - Cash outflows are negative and inflows positive in `netPresentValue` and
 *   `internalRateOfReturn`. `payment` is the one exception: it returns a
 *   positive number for a positive principal (Excel's `PMT` returns it negated).
 * - `timing` follows Excel's `type` argument: `'end'` is 0, `'begin'` is 1.
 * - `futureValue` and `presentValue` return balances, not Excel cash flows:
 *   `futureValue(pv, rate, n, { payment, timing })` is `-FV(rate, n, payment,
 *   pv, type)` and `presentValue(fv, rate, n, { payment, timing, scale })` is
 *   `-PV(rate, n, payment, fv, type)`. Same-sign inputs add up; a negative
 *   `payment` is a withdrawal or a loan repayment.
 *
 * `payment`, `netPresentValue`, `futureValue`, `presentValue`,
 * `compoundInterest`, `effectiveRate` and `simpleInterest` are exact: every
 * intermediate step stays exact and the result is rounded once, at the end,
 * with the `{ scale, rounding }` you pass, so `rounding: 'unnecessary'` throws
 * exactly when the true result does not fit. `rounding` defaults to
 * `'halfEven'` (banker's rounding). `nominalRate` needs an n-th root, which it
 * computes with guard digits (see its doc for the one caveat).
 * `internalRateOfReturn` and `periodsToReach` are float functions, approximate
 * by nature (a root and a logarithm, which no exact type holds); they are
 * re-exported from the float layer. `periodsToReach` with `{ payment }` is
 * Excel `NPER`.
 */

import type { DecimalInput, ScaleOptions } from './decimal.js';
import type { PaymentTiming } from './finance-float.js';
import type { RoundingMode } from './rounding.js';
import { nthRoot } from './decimal-math.js';
import { Decimal } from './decimal.js';
import { InvalidArgumentError, ResourceLimitError } from './errors.js';
import { assertFinite } from './number.js';
import { ratio } from './rational.js';

export type { PaymentTiming } from './finance-float.js';
export { internalRateOfReturn, periodsToReach } from './finance-float.js';

/** Options for `payment` and `amortizationSchedule`. */
export type PaymentOptions = ScaleOptions & { timing?: PaymentTiming };

/** A level payment made every period, added to the balance (negative to withdraw). */
export type AnnuityOptions = {
  /** Paid in (positive) or taken out (negative) every period. Defaults to 0. */
  payment?: DecimalInput;
  /** When in the period the payment falls. Defaults to `'end'`. */
  timing?: PaymentTiming;
};

/** `futureValue` options: an optional payment, and `{ scale, rounding }` only together. */
export type FutureValueOptions = AnnuityOptions & (ScaleOptions | { scale?: undefined; rounding?: undefined });

/** `presentValue` options: an optional payment and the required `{ scale }`. */
export type PresentValueOptions = AnnuityOptions & ScaleOptions;

/** One line of an amortization schedule. */
export type AmortizationRow = {
  /** 1-based period number. */
  period: number;
  /** Total paid this period: `interest + principal`. */
  payment: Decimal;
  /** Interest part of the payment. */
  interest: Decimal;
  /** Part of the payment that reduces the debt. */
  principal: Decimal;
  /** Debt left after this payment. */
  balance: Decimal;
};

/** Extra digits carried through `nominalRate`'s n-th root, so the final rounding is the only visible one. */
const GUARD_DIGITS = 10;

/** Most rows `amortizationSchedule` builds; more throws `ResourceLimitError`. */
const MAX_SCHEDULE_PERIODS = 100_000;

const ONE = Decimal.from(1);

function resolveRounding(options: ScaleOptions): RoundingMode {
  return options.rounding ?? 'halfEven';
}

function assertPeriods(periods: number): void {
  assertFinite(periods, 'periods');
  if (periods < 0) throw new InvalidArgumentError(`periods must not be negative, got ${periods}`);
  if (!Number.isSafeInteger(periods)) throw new InvalidArgumentError(`periods must be a safe integer, got ${periods}`);
}

function assertPositivePeriods(periods: number): void {
  assertPeriods(periods);
  if (periods === 0) throw new InvalidArgumentError('periods must be at least 1');
}

/** `1 + rate`, which must stay positive: a rate of -100 % or lower has no meaning here. */
function growthFactor(rate: DecimalInput): Decimal {
  const factor = ONE.plus(rate);
  if (factor.sign() <= 0)
    throw new InvalidArgumentError(`rate must be greater than -1 (-100 %), got ${Decimal.from(rate).toString()}`);
  return factor;
}

/** `(1 + rate)^periods`, exact. */
function growth(rate: DecimalInput, periods: number): Decimal {
  assertPeriods(periods);
  return growthFactor(rate).pow(periods);
}

function finish(value: Decimal, options: Partial<ScaleOptions> | undefined): Decimal {
  return options?.scale === undefined ? value : value.toScale(options.scale, options.rounding ?? 'halfEven');
}

/**
 * Every `payment` grown to the end of `periods`:
 * `payment × timing × ((1 + rate)^periods − 1) ÷ rate`, where `timing` is
 * `1 + rate` for `'begin'` and 1 for `'end'`. The quotient is the polynomial
 * `Σ (1 + rate)^k`, so the division is exact. A rate of 0 gives
 * `payment × periods`.
 */
function grownPayments(rate: DecimalInput, periods: number, compounded: Decimal, options: AnnuityOptions): Decimal {
  const { payment: level = 0, timing } = options;
  const periodRate = Decimal.from(rate);
  if (periodRate.isZero()) return Decimal.from(level).times(periods);
  const perUnit = compounded.minus(1).dividedBy(periodRate);
  const due = timing === 'begin' ? perUnit.times(ONE.plus(periodRate)) : perUnit;
  return due.times(level);
}

/**
 * Balance after `periods`: `principal × (1 + rate)^periods`, plus each
 * `payment` grown to the end (Excel `FV`, negated; see the module doc).
 *
 * Exact; pass `{ scale }` to round the result once. `periods` must be a
 * non-negative safe integer. For fractional periods, use
 * `@arki/math/finance/float`.
 */
export function futureValue(
  principal: DecimalInput,
  rate: DecimalInput,
  periods: number,
  options?: FutureValueOptions,
): Decimal {
  const compounded = growth(rate, periods);
  const grown = Decimal.from(principal).times(compounded);
  if (options?.payment === undefined) return finish(grown, options);
  return finish(grown.plus(grownPayments(rate, periods, compounded, options)), options);
}

/**
 * Today's worth of `amount` due after `periods`, plus each `payment`
 * discounted to today (Excel `PV`, negated; see the module doc):
 * `(amount + payment × timing × ((1 + rate)^periods − 1) ÷ rate) ÷ (1 + rate)^periods`.
 *
 * Always needs `{ scale }` because the division rarely terminates; the one
 * division is the only rounding. `periods` must be a non-negative safe integer
 * (see `futureValue` for fractional periods).
 */
export function presentValue(
  amount: DecimalInput,
  rate: DecimalInput,
  periods: number,
  options: PresentValueOptions,
): Decimal {
  const compounded = growth(rate, periods);
  const atEnd =
    options.payment === undefined
      ? Decimal.from(amount)
      : Decimal.from(amount).plus(grownPayments(rate, periods, compounded, options));
  return atEnd.dividedBy(compounded, { scale: options.scale, rounding: resolveRounding(options) });
}

/**
 * Excel `PMT`: the level payment that pays off a loan of `principal` over
 * `periods` at `rate` per period.
 *
 * Sign: a positive principal gives a positive payment. Excel returns it
 * negated; multiply by -1 if you need that.
 *
 * `(1 + rate)^periods` is computed exactly with `Decimal#pow`, and the whole
 * formula is one fraction, so there is exactly one rounding: the single division
 * at the end, with your `{ scale, rounding }`. A rate of 0 gives
 * `principal ÷ periods`. `timing: 'begin'` (Excel `type` 1) divides the payment
 * by `1 + rate`.
 */
export function payment(
  principal: DecimalInput,
  rate: DecimalInput,
  periods: number,
  options: PaymentOptions,
): Decimal {
  assertPositivePeriods(periods);
  const factor = growthFactor(rate);
  const rounding = resolveRounding(options);
  const loan = Decimal.from(principal);
  const periodRate = Decimal.from(rate);
  if (periodRate.isZero()) return loan.dividedBy(periods, { scale: options.scale, rounding });
  const compounded = factor.pow(periods);
  const numerator = loan.times(periodRate).times(compounded);
  const denominator = compounded.minus(1);
  const due = options.timing === 'begin' ? denominator.times(factor) : denominator;
  return numerator.dividedBy(due, { scale: options.scale, rounding });
}

/**
 * Full repayment schedule, one row per period.
 *
 * The payment is `payment(...)` rounded to `scale`. Each period's interest is
 * `balance × rate`, rounded to `scale` with your `rounding`; the principal part
 * is `payment − interest`. The last row absorbs the accumulated rounding: its
 * principal is whatever balance is left, so the final balance is exactly 0 and
 * the principal parts sum to the loan (the usual bank convention).
 *
 * With `timing: 'begin'` each payment falls at the start of its period, so the
 * first row has no interest (nothing has accrued yet), as in Excel `IPMT`.
 *
 * At most 100 000 periods; more throws `ResourceLimitError` before any work.
 */
export function amortizationSchedule(
  principal: DecimalInput,
  rate: DecimalInput,
  periods: number,
  options: PaymentOptions,
): AmortizationRow[] {
  if (periods > MAX_SCHEDULE_PERIODS) {
    throw new ResourceLimitError(
      `amortizationSchedule supports at most ${MAX_SCHEDULE_PERIODS} periods, got ${periods}`,
    );
  }
  const level = payment(principal, rate, periods, options);
  const { scale } = options;
  const rounding = resolveRounding(options);
  const periodRate = Decimal.from(rate);
  const atBegin = options.timing === 'begin';
  const rows: AmortizationRow[] = [];
  let balance = Decimal.from(principal).toScale(scale, rounding);
  for (let period = 1; period <= periods; period++) {
    const interest =
      atBegin && period === 1 ? Decimal.from(0).toScale(scale) : balance.times(periodRate).toScale(scale, rounding);
    const isLast = period === periods;
    const principalPart = isLast ? balance : level.minus(interest);
    balance = balance.minus(principalPart);
    rows.push({ period, payment: principalPart.plus(interest), interest, principal: principalPart, balance });
  }
  return rows;
}

/**
 * Net present value of `cashFlows` at t = 1..n, like Excel `NPV`: the first
 * flow is discounted one full period. Add a t = 0 flow yourself:
 * `initial.plus(netPresentValue(rate, flows, options))`.
 *
 * Evaluated as one exact fraction (Horner on the numerator), so rounding
 * happens once.
 */
export function netPresentValue(
  rate: DecimalInput,
  cashFlows: readonly DecimalInput[],
  options: ScaleOptions,
): Decimal {
  if (cashFlows.length === 0) throw new InvalidArgumentError('cashFlows must not be empty');
  const factor = growthFactor(rate);
  let numerator = Decimal.from(0);
  for (const flow of cashFlows) numerator = numerator.times(factor).plus(flow);
  return numerator.dividedBy(factor.pow(cashFlows.length), {
    scale: options.scale,
    rounding: resolveRounding(options),
  });
}

function assertPeriodsPerYear(periodsPerYear: number): void {
  assertFinite(periodsPerYear, 'periodsPerYear');
  if (!Number.isSafeInteger(periodsPerYear) || periodsPerYear < 1) {
    throw new InvalidArgumentError(`periodsPerYear must be a positive safe integer, got ${periodsPerYear}`);
  }
}

/**
 * Effective annual rate from a nominal rate compounded `periodsPerYear` times:
 * `(1 + nominal ÷ n)^n − 1`. Computed as an exact fraction and rounded once
 * with `{ scale }`. Without options the exact value is returned when it
 * terminates, and `RoundingNecessaryError` is thrown when it does not.
 */
export function effectiveRate(nominalRate: DecimalInput, periodsPerYear: number, options?: ScaleOptions): Decimal {
  assertPeriodsPerYear(periodsPerYear);
  const factor = ratio(1).plus(ratio(nominalRate).dividedBy(periodsPerYear));
  if (factor.sign() <= 0) {
    throw new InvalidArgumentError(
      `nominalRate ÷ periodsPerYear must be greater than -1 (-100 %), got ${Decimal.from(nominalRate).toString()} ÷ ${periodsPerYear}`,
    );
  }
  const result = factor.pow(periodsPerYear).minus(1);
  return options === undefined
    ? result.toDecimal()
    : result.toDecimal({ scale: options.scale, rounding: resolveRounding(options) });
}

/**
 * Nominal annual rate that compounds `periodsPerYear` times to the given
 * effective rate: `n × ((1 + effective)^(1/n) − 1)`.
 *
 * The n-th root is exact when one exists (`nominalRate(7, 3, …)` is exactly
 * 3) and is otherwise truncated to `scale + 10 + digits(n)` places, so `n ×`
 * its error stays below `10^-(scale + 10)`. The result is then rounded once to
 * `scale`. It is correctly rounded except when the exact value sits within
 * `10^-(scale + 10)` of a rounding boundary.
 */
export function nominalRate(effectiveRate: DecimalInput, periodsPerYear: number, options: ScaleOptions): Decimal {
  assertPeriodsPerYear(periodsPerYear);
  const factor = growthFactor(effectiveRate);
  const root = nthRoot(factor, periodsPerYear, {
    scale: options.scale + GUARD_DIGITS + String(periodsPerYear).length,
    rounding: 'down',
  });
  return root.minus(1).times(periodsPerYear).toScale(options.scale, resolveRounding(options));
}

/**
 * Interest earned only: `futureValue − principal`. Exact; with `{ scale }` it
 * is rounded once. `periods` must be a non-negative safe integer.
 */
export function compoundInterest(
  principal: DecimalInput,
  rate: DecimalInput,
  periods: number,
  options?: ScaleOptions,
): Decimal {
  return finish(Decimal.from(principal).times(growth(rate, periods)).minus(principal), options);
}

/** `principal × rate × periods`, exact. `periods` may be fractional (pass it as a string or Decimal). */
export function simpleInterest(principal: DecimalInput, rate: DecimalInput, periods: DecimalInput): Decimal {
  const time = Decimal.from(periods);
  if (time.isNegative()) throw new InvalidArgumentError(`periods must not be negative, got ${time.toString()}`);
  return Decimal.from(principal).times(rate).times(time);
}
