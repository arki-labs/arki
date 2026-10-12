/**
 * Time-value-of-money helpers that follow the conventions of Excel and Google
 * Sheets, so formulas port over directly.
 *
 * - `rate` is per period, as a fraction: `0.05` is 5 %. Monthly loan at 6 %
 *   a year → `0.06 / 12` (as a Decimal, not a float).
 * - `periods` is a non-negative safe integer everywhere (`InvalidArgumentError`
 *   otherwise). For fractional compounding, use `pow` from
 *   `@arki/math/decimal-math` with the scale you need.
 * - Cash outflows are negative and inflows positive in `netPresentValue` and
 *   `internalRateOfReturn`. `payment` is the one exception: it returns a
 *   positive number for a positive principal (Excel's `PMT` returns it negated).
 * - `timing` follows Excel's `type` argument: `'end'` is 0, `'begin'` is 1.
 *
 * `payment`, `netPresentValue`, `futureValue`, `presentValue`,
 * `compoundInterest`, `effectiveRate` and `simpleInterest` are exact: every
 * intermediate step stays exact and the result is rounded once, at the end,
 * with the `{ scale, rounding }` you pass, so `rounding: 'unnecessary'` throws
 * exactly when the true result does not fit. `rounding` defaults to
 * `'halfEven'` (banker's rounding). `nominalRate` needs an n-th root, which it
 * computes with guard digits (see its doc for the one caveat).
 * `internalRateOfReturn` and `periodsToReach` are float functions, approximate
 * by nature.
 */

import type { DecimalInput, ScaleOptions } from './decimal.js';
import type { RoundingMode } from './rounding.js';
import { Decimal } from './decimal.js';
import { nthRoot } from './decimal-math.js';
import { InvalidArgumentError, ResourceLimitError } from './errors.js';
import { assertFinite } from './number.js';
import { ratio } from './rational.js';

/** When in the period payments fall: `'end'` is Excel `type` 0, `'begin'` is `type` 1. */
export type PaymentTiming = 'end' | 'begin';

/** Options for `payment` and `amortizationSchedule`. */
export type PaymentOptions = ScaleOptions & { timing?: PaymentTiming };

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
  if (factor.sign() <= 0) throw new InvalidArgumentError(`rate must be greater than -1 (-100 %), got ${Decimal.from(rate).toString()}`);
  return factor;
}

/** `(1 + rate)^periods`, exact. */
function growth(rate: DecimalInput, periods: number): Decimal {
  assertPeriods(periods);
  return growthFactor(rate).pow(periods);
}

function finish(value: Decimal, options: ScaleOptions | undefined): Decimal {
  return options === undefined ? value : value.toScale(options.scale, resolveRounding(options));
}

/**
 * Compound growth: `principal × (1 + rate)^periods`.
 *
 * Exact; pass `{ scale }` to round the result once. `periods` must be a
 * non-negative safe integer. For fractional periods, compute the power yourself
 * with `pow` from `@arki/math/decimal-math`.
 */
export function futureValue(
  principal: DecimalInput,
  rate: DecimalInput,
  periods: number,
  options?: ScaleOptions,
): Decimal {
  return finish(Decimal.from(principal).times(growth(rate, periods)), options);
}

/**
 * Today's worth of a future `amount`: `amount ÷ (1 + rate)^periods`.
 * Always needs `{ scale }` because the division rarely terminates; the one
 * division is the only rounding. `periods` must be a non-negative safe integer
 * (see `futureValue` for fractional periods).
 */
export function presentValue(amount: DecimalInput, rate: DecimalInput, periods: number, options: ScaleOptions): Decimal {
  return Decimal.from(amount).dividedBy(growth(rate, periods), { scale: options.scale, rounding: resolveRounding(options) });
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
    throw new ResourceLimitError(`amortizationSchedule supports at most ${MAX_SCHEDULE_PERIODS} periods, got ${periods}`);
  }
  const level = payment(principal, rate, periods, options);
  const { scale } = options;
  const rounding = resolveRounding(options);
  const periodRate = Decimal.from(rate);
  const atBegin = options.timing === 'begin';
  const rows: AmortizationRow[] = [];
  let balance = Decimal.from(principal).toScale(scale, rounding);
  for (let period = 1; period <= periods; period++) {
    const interest = atBegin && period === 1 ? Decimal.from(0).toScale(scale) : balance.times(periodRate).toScale(scale, rounding);
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
export function netPresentValue(rate: DecimalInput, cashFlows: readonly DecimalInput[], options: ScaleOptions): Decimal {
  if (cashFlows.length === 0) throw new InvalidArgumentError('cashFlows must not be empty');
  const factor = growthFactor(rate);
  let numerator = Decimal.from(0);
  for (const flow of cashFlows) numerator = numerator.times(factor).plus(flow);
  return numerator.dividedBy(factor.pow(cashFlows.length), { scale: options.scale, rounding: resolveRounding(options) });
}

function npvAt(rate: number, cashFlows: readonly number[]): number {
  let total = 0;
  for (let t = 0; t < cashFlows.length; t++) total += (cashFlows[t] ?? 0) / (1 + rate) ** t;
  return total;
}

function npvSlope(rate: number, cashFlows: readonly number[]): number {
  let total = 0;
  for (let t = 1; t < cashFlows.length; t++) total -= (t * (cashFlows[t] ?? 0)) / (1 + rate) ** (t + 1);
  return total;
}

function newton(cashFlows: readonly number[], guess: number, tolerance: number): number | undefined {
  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const slope = npvSlope(rate, cashFlows);
    if (slope === 0 || !Number.isFinite(slope)) return undefined;
    const next = rate - npvAt(rate, cashFlows) / slope;
    if (!Number.isFinite(next) || next <= -1) return undefined;
    if (Math.abs(next - rate) < tolerance) return next;
    rate = next;
  }
  return undefined;
}

/**
 * Bisects `u` in `[a, b]` (rate `e^u - 1`) down to float precision. Gives up
 * if a midpoint's NPV is not finite (it under- or overflowed).
 */
function refineBracket(cashFlows: readonly number[], lo: number, hi: number, fLo: number): number | undefined {
  let a = lo;
  let b = hi;
  let fa = fLo;
  for (let i = 0; i < 200; i++) {
    const mid = (a + b) / 2;
    if (mid <= a || mid >= b) break;
    const fMid = npvAt(Math.expm1(mid), cashFlows);
    if (!Number.isFinite(fMid)) return undefined;
    if (fMid === 0) return Math.expm1(mid);
    if (Math.sign(fMid) === Math.sign(fa)) {
      a = mid;
      fa = fMid;
    } else {
      b = mid;
    }
  }
  return Math.expm1((a + b) / 2);
}

/**
 * Scans `rate = e^u - 1` for a sign change of the NPV, then bisects on `u`.
 * Only two neighbouring finite NPVs form a bracket: an NPV that under- or
 * overflowed (`NaN`, `±Infinity`) is no evidence of a sign change.
 */
function bisect(cashFlows: readonly number[]): number | undefined {
  const start = -9;
  const step = 0.05;
  const steps = 580; // u from -9 to 20
  let lo: number | undefined;
  let fLo = 0;
  for (let k = 0; k <= steps; k++) {
    const u = start + k * step;
    const fU = npvAt(Math.expm1(u), cashFlows);
    if (!Number.isFinite(fU)) {
      lo = undefined;
      continue;
    }
    if (fU === 0) return Math.expm1(u);
    if (lo !== undefined && Math.sign(fU) !== Math.sign(fLo)) {
      const root = refineBracket(cashFlows, lo, u, fLo);
      if (root !== undefined) return root;
    }
    lo = u;
    fLo = fU;
  }
  return undefined;
}

/**
 * Whether `rate` really zeroes the NPV: `|npv| ≤ tolerance × Σ|discounted flow|`.
 * The relative bound never drops below float noise (`n × ε`), which no float
 * root can beat.
 */
function isRoot(rate: number, cashFlows: readonly number[], tolerance: number): boolean {
  if (!Number.isFinite(rate) || rate <= -1) return false;
  let total = 0;
  let magnitude = 0;
  for (const [t, flow] of cashFlows.entries()) {
    const term = flow / (1 + rate) ** t;
    total += term;
    magnitude += Math.abs(term);
  }
  if (!Number.isFinite(total) || !Number.isFinite(magnitude)) return false;
  return Math.abs(total) <= Math.max(tolerance, cashFlows.length * Number.EPSILON) * magnitude;
}

/**
 * Internal rate of return as a JS number (the rate that makes NPV zero), like
 * Excel `IRR`. Cash flows start at t = 0 and need at least one negative and one
 * positive value.
 *
 * Inherently approximate: Newton's method from `guess` (default 0.1), falling
 * back to a bracketed bisection. `tolerance` (default `1e-10`) is Newton's step
 * size at convergence, and the check every answer must pass: the NPV at the
 * returned rate is at most `tolerance` times the sum of the absolute
 * discounted flows. Throws `InvalidArgumentError` when there is no sign change
 * or no rate passes that check.
 */
export function internalRateOfReturn(
  cashFlows: readonly number[],
  options: { guess?: number; tolerance?: number } = {},
): number {
  const { guess = 0.1, tolerance = 1e-10 } = options;
  assertFinite(guess, 'guess');
  assertFinite(tolerance, 'tolerance');
  if (tolerance <= 0) throw new InvalidArgumentError(`tolerance must be positive, got ${tolerance}`);
  if (cashFlows.length < 2) throw new InvalidArgumentError('cashFlows needs at least two values');
  for (const [i, flow] of cashFlows.entries()) assertFinite(flow, `cashFlows[${i}]`);
  if (!cashFlows.some(flow => flow > 0) || !cashFlows.some(flow => flow < 0)) {
    throw new InvalidArgumentError('cashFlows needs at least one positive and one negative value');
  }
  const fromNewton = newton(cashFlows, guess, tolerance);
  const found =
    fromNewton !== undefined && isRoot(fromNewton, cashFlows, tolerance) ? fromNewton : bisect(cashFlows);
  if (found === undefined || !isRoot(found, cashFlows, tolerance)) {
    throw new InvalidArgumentError('internalRateOfReturn: no convergence');
  }
  return found === 0 ? 0 : found;
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

/**
 * Periods needed for `principal` to grow to `target` at `rate` per period:
 * `ln(target ÷ principal) ÷ ln(1 + rate)`. A float, so the result is
 * approximate and may be fractional. Throws when the target is unreachable.
 */
export function periodsToReach(principal: number, target: number, rate: number): number {
  assertFinite(principal, 'principal');
  assertFinite(target, 'target');
  assertFinite(rate, 'rate');
  if (principal <= 0) throw new InvalidArgumentError(`principal must be positive, got ${principal}`);
  if (target <= 0) throw new InvalidArgumentError(`target must be positive, got ${target}`);
  if (rate <= -1) throw new InvalidArgumentError(`rate must be greater than -1, got ${rate}`);
  if (rate === 0) throw new InvalidArgumentError('rate must not be 0: the balance never changes');
  // Difference of logs, not log of the ratio: target ÷ principal can overflow to Infinity.
  const periods = (Math.log(target) - Math.log(principal)) / Math.log1p(rate);
  if (periods < 0) throw new InvalidArgumentError('target cannot be reached at this rate');
  return periods;
}
