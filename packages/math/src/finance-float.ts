/**
 * Time-value-of-money on plain `number`: the float layer of
 * `@arki/math/finance`.
 *
 * **Naming rule: same name, different import path.** Every function here has
 * the same name, argument order and sign convention as its exact twin in
 * `@arki/math/finance` (on `Decimal`). Only the import path says which layer
 * you get, as with `@arki/math/decimal` and `@arki/math/number`. To use both in
 * one file, import one layer as a namespace:
 * `import * as float from '@arki/math/finance/float'`.
 *
 * Use this layer when the exact one cannot serve: periods that are fractional
 * or negative (7.5 years, a `periodsToReach` result fed back in), growth
 * factors too large for exact digits (daily compounding over decades), or
 * loops that run thousands of times (projection tables). Use the exact layer
 * for amounts that must be right to the cent and be reproducible.
 *
 * Conventions, shared with the exact layer:
 * - `rate` is per period, as a fraction (`0.05` is 5 %), and must be greater
 *   than -1. `periods` may be any finite number unless a function says so.
 * - Results are balances, not Excel cash flows: same-sign inputs add up.
 *   `futureValue(pv, rate, n, { payment, timing })` is `-FV(rate, n, payment,
 *   pv, type)`, `presentValue(fv, rate, n, { payment, timing })` is
 *   `-PV(rate, n, payment, fv, type)`, and `payment(pv, rate, n)` is
 *   `-PMT(rate, n, pv)`. A loan is a positive principal paid off by negative
 *   payments: `futureValue(p, r, n, { payment: -payment(p, r, n) })` is 0.
 * - `timing` is Excel's `type`: `'end'` (0, the default) or `'begin'` (1).
 *
 * Accuracy: `(1 + rate)^periods` is `exp(periods × log1p(rate))`, and the
 * annuity factor `((1 + rate)^n − 1) ÷ rate` is built from `expm1` and
 * `log1p`, so a rate of `1e-12` keeps full precision and a rate of 0 gives
 * the exact limit `n` instead of `0 ÷ 0`.
 *
 * Nothing here returns `NaN` or `±Infinity`: non-finite inputs and a rate of
 * -100 % or lower throw `InvalidArgumentError`, and a result beyond the float
 * range throws `NumericRangeError`.
 */

import { InvalidArgumentError, NumericRangeError, ResourceLimitError } from './errors.js';
import { assertFinite } from './number.js';

/** When in the period payments fall: `'end'` is Excel `type` 0, `'begin'` is `type` 1. */
export type PaymentTiming = 'end' | 'begin';

/** A level payment made every period, added to the balance (negative to withdraw). */
export type AnnuityOptions = {
  /** Paid in (positive) or taken out (negative) every period. Defaults to 0. */
  payment?: number;
  /** When in the period the payment falls. Defaults to `'end'`. */
  timing?: PaymentTiming;
};

/** One line of an amortization schedule. */
export type AmortizationRow = {
  /** 1-based period number. */
  period: number;
  /** Total paid this period: `interest + principal`. */
  payment: number;
  /** Interest part of the payment. */
  interest: number;
  /** Part of the payment that reduces the debt. */
  principal: number;
  /** Debt left after this payment. */
  balance: number;
};

/** Most rows `amortizationSchedule` builds; more throws `ResourceLimitError`. */
const MAX_SCHEDULE_PERIODS = 100_000;

/** `ln(1 + rate)`, after checking that `rate` is finite and above -1. */
function logGrowth(rate: number, name = 'rate'): number {
  assertFinite(rate, name);
  if (rate <= -1) throw new InvalidArgumentError(`${name} must be greater than -1 (-100 %), got ${rate}`);
  return Math.log1p(rate);
}

/**
 * The annuity factor `((1 + rate)^periods − 1) ÷ rate`, written as
 * `periods × (ln(1+r) ÷ r) × (expm1(x) ÷ x)` with `x = periods × ln(1+r)`.
 * Each ratio tends to 1 as its argument tends to 0, so there is no `0 ÷ 0`
 * and no cancellation at tiny rates; at rate 0 it is exactly `periods`.
 */
function annuityFactor(rate: number, lnGrowth: number, periods: number): number {
  if (rate === 0) return periods;
  const x = periods * lnGrowth;
  const growthRatio = x === 0 ? 1 : Math.expm1(x) / x;
  return periods * (lnGrowth / rate) * growthRatio;
}

/** `1 + rate` for payments at the start of the period, `1` at the end. */
function timingFactor(rate: number, timing: PaymentTiming | undefined): number {
  return timing === 'begin' ? 1 + rate : 1;
}

/** Throws `NumericRangeError` for a non-finite result and turns `-0` into `0`. */
function finiteResult(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new NumericRangeError(`${name} is beyond the float range`);
  return value === 0 ? 0 : value;
}

function readAnnuity(options: AnnuityOptions): { payment: number; timing: PaymentTiming | undefined } {
  const { payment = 0, timing } = options;
  assertFinite(payment, 'payment');
  return { payment, timing };
}

/**
 * Balance after `periods`: `principal × (1 + rate)^periods`, plus each
 * `payment` grown to the end (Excel `FV`, negated). `periods` may be
 * fractional or negative (negative discounts).
 */
export function futureValue(principal: number, rate: number, periods: number, options: AnnuityOptions = {}): number {
  assertFinite(principal, 'principal');
  assertFinite(periods, 'periods');
  const { payment, timing } = readAnnuity(options);
  const lnGrowth = logGrowth(rate);
  const grown = principal * Math.exp(periods * lnGrowth);
  if (payment === 0) return finiteResult(grown, 'futureValue');
  return finiteResult(
    grown + payment * timingFactor(rate, timing) * annuityFactor(rate, lnGrowth, periods),
    'futureValue',
  );
}

/**
 * Today's worth of `amount` due after `periods`, plus each `payment`
 * discounted to today (Excel `PV`, negated): `amount ÷ (1 + rate)^periods +
 * payment × (1 − (1 + rate)^-periods) ÷ rate`. `periods` may be fractional or
 * negative.
 */
export function presentValue(amount: number, rate: number, periods: number, options: AnnuityOptions = {}): number {
  assertFinite(amount, 'amount');
  assertFinite(periods, 'periods');
  const { payment, timing } = readAnnuity(options);
  const lnGrowth = logGrowth(rate);
  const discounted = amount * Math.exp(-periods * lnGrowth);
  if (payment === 0) return finiteResult(discounted, 'presentValue');
  const annuity = -annuityFactor(rate, lnGrowth, -periods);
  return finiteResult(discounted + payment * timingFactor(rate, timing) * annuity, 'presentValue');
}

/**
 * Excel `PMT`, negated: the level payment that pays off `principal` over
 * `periods` at `rate` per period. `periods` must be positive and may be
 * fractional. A rate of 0 gives `principal ÷ periods`; `timing: 'begin'`
 * divides the payment by `1 + rate`.
 */
export function payment(
  principal: number,
  rate: number,
  periods: number,
  options: { timing?: PaymentTiming } = {},
): number {
  assertFinite(principal, 'principal');
  assertFinite(periods, 'periods');
  if (periods <= 0) throw new InvalidArgumentError(`periods must be positive, got ${periods}`);
  const lnGrowth = logGrowth(rate);
  const annuity = -annuityFactor(rate, lnGrowth, -periods);
  return finiteResult(principal / (annuity * timingFactor(rate, options.timing)), 'payment');
}

/**
 * Interest earned only: `principal × ((1 + rate)^periods − 1)`, via `expm1`
 * so tiny rates do not cancel to 0. `periods` may be fractional or negative.
 */
export function compoundInterest(principal: number, rate: number, periods: number): number {
  assertFinite(principal, 'principal');
  assertFinite(periods, 'periods');
  return finiteResult(principal * Math.expm1(periods * logGrowth(rate)), 'compoundInterest');
}

function assertPeriodsPerYear(periodsPerYear: number): void {
  assertFinite(periodsPerYear, 'periodsPerYear');
  if (periodsPerYear <= 0) throw new InvalidArgumentError(`periodsPerYear must be positive, got ${periodsPerYear}`);
}

/**
 * Effective annual rate (Excel `EFFECT`) from a nominal rate compounded
 * `periodsPerYear` times: `(1 + nominal ÷ n)^n − 1`. `periodsPerYear` must be
 * positive and may be fractional (0.5 compounds every two years).
 */
export function effectiveRate(nominalRate: number, periodsPerYear: number): number {
  assertFinite(nominalRate, 'nominalRate');
  assertPeriodsPerYear(periodsPerYear);
  const lnGrowth = logGrowth(nominalRate / periodsPerYear, 'nominalRate ÷ periodsPerYear');
  return finiteResult(Math.expm1(periodsPerYear * lnGrowth), 'effectiveRate');
}

/**
 * Nominal annual rate (Excel `NOMINAL`) that compounds `periodsPerYear` times
 * to the given effective rate: `n × ((1 + effective)^(1/n) − 1)`.
 */
export function nominalRate(effectiveRate: number, periodsPerYear: number): number {
  assertPeriodsPerYear(periodsPerYear);
  const lnGrowth = logGrowth(effectiveRate, 'effectiveRate');
  return finiteResult(periodsPerYear * Math.expm1(lnGrowth / periodsPerYear), 'nominalRate');
}

/**
 * Net present value of `cashFlows` at t = 1..n, like Excel `NPV`: the first
 * flow is discounted one full period. Add a t = 0 flow yourself:
 * `initial + netPresentValue(rate, flows)`.
 */
export function netPresentValue(rate: number, cashFlows: readonly number[]): number {
  logGrowth(rate);
  if (cashFlows.length === 0) throw new InvalidArgumentError('cashFlows must not be empty');
  const factor = 1 + rate;
  let total = 0;
  for (let t = cashFlows.length - 1; t >= 0; t--) {
    const flow = cashFlows[t] ?? 0;
    assertFinite(flow, `cashFlows[${t}]`);
    total = (total + flow) / factor;
  }
  return finiteResult(total, 'netPresentValue');
}

/**
 * Full repayment schedule, one row per period, unrounded (round for display
 * with `round` from `@arki/math/number`).
 *
 * The payment is `payment(...)`. Each period's interest is `balance × rate`;
 * the principal part is `payment − interest`. The last row's principal is
 * whatever balance is left, so the final balance is exactly 0 despite float
 * drift. With `timing: 'begin'` the first row has no interest, as in Excel
 * `IPMT`.
 *
 * `periods` must be a positive safe integer, at most 100 000; more throws
 * `ResourceLimitError` before any work.
 */
export function amortizationSchedule(
  principal: number,
  rate: number,
  periods: number,
  options: { timing?: PaymentTiming } = {},
): AmortizationRow[] {
  assertFinite(periods, 'periods');
  if (periods > MAX_SCHEDULE_PERIODS) {
    throw new ResourceLimitError(
      `amortizationSchedule supports at most ${MAX_SCHEDULE_PERIODS} periods, got ${periods}`,
    );
  }
  if (!Number.isSafeInteger(periods) || periods < 1) {
    throw new InvalidArgumentError(`periods must be a positive integer, got ${periods}`);
  }
  const level = payment(principal, rate, periods, options);
  const atBegin = options.timing === 'begin';
  const rows: AmortizationRow[] = [];
  let balance = principal;
  for (let period = 1; period <= periods; period++) {
    const interest = atBegin && period === 1 ? 0 : balance * rate;
    const principalPart = period === periods ? balance : level - interest;
    balance -= principalPart;
    rows.push({ period, payment: principalPart + interest, interest, principal: principalPart, balance });
  }
  return rows;
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
 *
 * The same function is exported from `@arki/math/finance`.
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
  const found = fromNewton !== undefined && isRoot(fromNewton, cashFlows, tolerance) ? fromNewton : bisect(cashFlows);
  if (found === undefined || !isRoot(found, cashFlows, tolerance)) {
    throw new InvalidArgumentError('internalRateOfReturn: no convergence');
  }
  return found === 0 ? 0 : found;
}

/**
 * Periods until the balance goes from `principal` to `target` at `rate` per
 * period: the `periods` that makes `futureValue(principal, rate, periods,
 * options)` equal `target`. Approximate and possibly fractional; round up
 * yourself for whole months. The result can be passed straight back to
 * `futureValue`.
 *
 * Without a payment it is `ln(target ÷ principal) ÷ ln(1 + rate)`, and
 * `principal` and `target` must be positive and `rate` non-zero.
 *
 * With `{ payment, timing }` it is Excel `NPER(rate, payment, principal,
 * -target, type)`, under the balance sign rule: paying off a card of 5000 at
 * 200 a month is `periodsToReach(5000, 0, 0.18 / 12, { payment: -200 })`, and
 * saving 100 a month from 0 to 10 000 is `periodsToReach(0, 10_000, 0.005,
 * { payment: 100 })`. At rate 0 it is exactly `(target − principal) ÷ payment`.
 *
 * Throws `InvalidArgumentError` when the target is never reached, including
 * a payment that only covers (or does not cover) the interest.
 *
 * The same function is exported from `@arki/math/finance`.
 */
export function periodsToReach(principal: number, target: number, rate: number, options: AnnuityOptions = {}): number {
  assertFinite(principal, 'principal');
  assertFinite(target, 'target');
  assertFinite(rate, 'rate');
  if (rate <= -1) throw new InvalidArgumentError(`rate must be greater than -1, got ${rate}`);
  const { payment, timing } = readAnnuity(options);
  if (payment !== 0) return periodsWithPayment(principal, target, rate, payment * timingFactor(rate, timing));
  if (principal <= 0) throw new InvalidArgumentError(`principal must be positive, got ${principal}`);
  if (target <= 0) throw new InvalidArgumentError(`target must be positive, got ${target}`);
  if (rate === 0) throw new InvalidArgumentError('rate must not be 0: the balance never changes');
  // Difference of logs, not log of the ratio: target ÷ principal can overflow to Infinity.
  const periods = (Math.log(target) - Math.log(principal)) / Math.log1p(rate);
  if (periods < 0) throw new InvalidArgumentError('target cannot be reached at this rate');
  return periods;
}

/**
 * Solves `P·g + p·(g − 1) ÷ r = T` for `g = (1 + r)^n`, where `p` already
 * includes the timing factor. Written as `ln g = log1p((T − P)·r ÷ d)` with
 * `d = P·r + p` (the balance's change in the first period) rather than
 * `ln((T + p/r) ÷ (P + p/r))`, which cancels catastrophically at tiny rates.
 */
function periodsWithPayment(principal: number, target: number, rate: number, perPeriod: number): number {
  if (rate === 0) return nonNegativePeriods((target - principal) / perPeriod);
  const change = principal * rate + perPeriod;
  if (change === 0) {
    if (target === principal) return 0;
    throw new InvalidArgumentError('target cannot be reached: the payment exactly matches the interest');
  }
  const ratio = ((target - principal) * rate) / change;
  if (ratio <= -1) {
    throw new InvalidArgumentError('target cannot be reached: the payment does not outpace the interest');
  }
  return nonNegativePeriods(finiteResult(Math.log1p(ratio) / Math.log1p(rate), 'periodsToReach'));
}

function nonNegativePeriods(periods: number): number {
  if (periods < 0) throw new InvalidArgumentError('target cannot be reached at this rate and payment');
  return periods === 0 ? 0 : periods;
}
