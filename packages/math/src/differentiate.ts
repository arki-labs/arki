/**
 * Numerical derivatives and limits of a function of one real variable,
 * `f: (x: number) => number`, by Richardson extrapolation on float64.
 *
 * Both functions return **numerical estimates with an error estimate**, never
 * proofs. They sample `f` at a shrinking sequence of steps and extrapolate the
 * samples to step 0, assuming `f` is smooth there (a power series in the
 * step). A function that is not, such as `sin(1/x)` near 0, may fail to
 * converge or converge to a wrong value; the error estimate measures how well
 * the samples agree, not what happens between them.
 *
 * - `derivative(f, x)` is Ridders' method (Ridders 1982; Numerical Recipes
 *   `dfridr`): central differences `(f(x + h) − f(x − h)) / 2h` for
 *   `h = step, step/1.4, step/1.4², …` (10 steps), extrapolated in `h²` with a
 *   Neville tableau. It stops early once the error estimate grows, which is
 *   where rounding error starts to dominate. It typically reaches 10–13
 *   correct digits. `step` (default `max(0.1, 0.001 · |x|)`) should be about
 *   the distance over which `f` changes appreciably, not tiny; `f` must be
 *   defined on `[x − step, x + step]`. Complex-step differentiation is not
 *   offered: it needs `f` on complex numbers.
 * - `limit(f, x0)` samples `f(x0 ± h)` for `h = step, step/2, …, step/2¹¹`
 *   (default `step` as above) and extrapolates in powers of `h`. It never
 *   evaluates `f(x0)` itself, so it works where `f` is undefined at `x0`
 *   (`sin(x)/x` at 0). `side` is `'left'`, `'right'` or `'both'` (default):
 *   `'both'` computes both one-sided limits and requires them to agree within
 *   their error estimates, returning their mean. `x0` may be `±Infinity`: the
 *   samples are then `f(±1/h)`, extrapolated in powers of `1/x`, and `side`
 *   must be omitted or name the finite side (`'left'` for `+Infinity`).
 *
 * **Error estimate.** Twice the disagreement between neighbouring entries
 * of the extrapolation tableau, plus a rounding floor (4× the largest rounding
 * noise of one sample: `ε · |f|`, divided by the spacing for a difference
 * quotient). Cancellation inside `f` itself is invisible to the floor and only
 * shows through the tableau.
 *
 * **Tolerance and failures.** An estimate is accepted when `errorEstimate ≤
 * max(absoluteTolerance, relativeTolerance · |value|)`, defaults `1e-10` and
 * `1e-8`. Otherwise `ExtrapolationConvergenceError` (a `ConvergenceError`)
 * is thrown with the best estimate in `best`; so are one-sided limits that
 * disagree. `f` returning `NaN` or `±Infinity` at a sample point throws
 * `NumericRangeError` naming the point; bad arguments throw
 * `InvalidArgumentError`. Results are `{ value, errorEstimate, evaluations }`.
 */

import type { RealFunction } from './internal/calculus.js';
import { ConvergenceError, InvalidArgumentError } from './errors.js';
import { assertFunction, call, noNegativeZero, readStep, readTolerance } from './internal/calculus.js';

export type { RealFunction } from './internal/calculus.js';

export type ExtrapolationOptions = {
  /** First (largest) sample step (default `max(0.1, 0.001 · |x|)`). */
  readonly step?: number;
  /** Absolute tolerance on the error estimate (default `1e-10`). */
  readonly absoluteTolerance?: number;
  /** Relative tolerance, times `|value|` (default `1e-8`). */
  readonly relativeTolerance?: number;
};

export type LimitSide = 'left' | 'right' | 'both';

export type LimitOptions = ExtrapolationOptions & {
  /** Approach `x0` from below, above, or both (default). */
  readonly side?: LimitSide;
};

export type ExtrapolationResult = {
  readonly value: number;
  /** Estimated absolute error of `value`, from the agreement of the extrapolation tableau. */
  readonly errorEstimate: number;
  /** Calls of `f`. */
  readonly evaluations: number;
};

/** `derivative` or `limit` missed its tolerance; `best` is the best estimate it reached. */
export class ExtrapolationConvergenceError extends ConvergenceError {
  /** The best value, its error estimate and the evaluations spent. */
  readonly best: ExtrapolationResult;

  constructor(message: string, best: ExtrapolationResult) {
    super(message);
    this.best = best;
  }
}

/** Stop once the newest diagonal is this many times worse than the best error so far (Numerical Recipes). */
const SAFE = 2;

type Tableau = { value: number; error: number };

/**
 * Neville/Richardson extrapolation of `sample(h)` to `h = 0` for
 * `h = h0, h0/ratio, …` (`rows` samples), when the error expands in powers of
 * `h^p` with `factor = ratio^p`.
 */
function extrapolate(sample: (h: number) => number, h0: number, ratio: number, factor: number, rows: number): Tableau {
  let previous = [sample(h0)];
  const best: Tableau = { value: previous[0]!, error: Infinity };
  let h = h0;
  for (let i = 1; i < rows; i++) {
    h /= ratio;
    const row = [sample(h)];
    let power = factor;
    for (let j = 1; j <= i; j++) {
      const next = (row[j - 1]! * power - previous[j - 1]!) / (power - 1);
      row.push(next);
      power *= factor;
      const error = Math.max(Math.abs(next - row[j - 1]!), Math.abs(next - previous[j - 1]!));
      if (error <= best.error) {
        best.value = next;
        best.error = error;
      }
    }
    if (Math.abs(row[i]! - previous[i - 1]!) >= SAFE * best.error) break;
    previous = row;
  }
  return best;
}

type Settings = { readonly absolute: number; readonly relative: number };

function readSettings(options: ExtrapolationOptions | undefined): Settings {
  return {
    absolute: readTolerance(options?.absoluteTolerance, 'absoluteTolerance', 1e-10),
    relative: readTolerance(options?.relativeTolerance, 'relativeTolerance', 1e-8),
  };
}

/**
 * The reported error: twice the tableau's disagreement (it can understate the
 * error by chance) plus a rounding floor of 4× the largest per-sample rounding
 * noise, which the extrapolation amplifies.
 */
function accept(
  settings: Settings,
  tableau: Tableau,
  noise: number,
  evaluations: number,
  what: string,
): ExtrapolationResult {
  const errorEstimate = 2 * tableau.error + 4 * noise;
  const result = { value: noNegativeZero(tableau.value), errorEstimate, evaluations };
  if (!(errorEstimate <= Math.max(settings.absolute, settings.relative * Math.abs(tableau.value)))) {
    throw new ExtrapolationConvergenceError(
      `${what} did not converge: the best estimate ${tableau.value} has an error estimate of ${errorEstimate}. ` +
        'f may not be smooth there, or the step may be too large or too small for it.',
      result,
    );
  }
  return result;
}

function defaultStep(x: number): number {
  return Math.max(0.1, 0.001 * Math.abs(x));
}

/**
 * The derivative `f'(x)`, by Ridders' extrapolation of central differences.
 *
 * @example
 * derivative(Math.exp, 1).value; // 2.718281828459045 (to about 1e-12)
 */
export function derivative(f: RealFunction, x: number, options?: ExtrapolationOptions): ExtrapolationResult {
  assertFunction(f, 'f');
  if (typeof x !== 'number') throw new TypeError('x must be a number');
  if (!Number.isFinite(x)) throw new InvalidArgumentError(`x must be finite, got ${x}`);
  const settings = readSettings(options);
  const step = readStep(options?.step, 'step', defaultStep(x));
  let evaluations = 0;
  let noise = 0;
  const centralDifference = (h: number): number => {
    const above = x + h;
    const below = x - h;
    // The actual spacing after rounding x ± h, so the quotient stays exact for large |x|.
    const spacing = above - below;
    if (spacing === 0) throw new InvalidArgumentError(`step ${h} is too small to change x = ${x} in float64`);
    evaluations += 2;
    const fAbove = call(f, above);
    const fBelow = call(f, below);
    noise = Math.max(noise, (Number.EPSILON * (Math.abs(fAbove) + Math.abs(fBelow))) / spacing);
    return (fAbove - fBelow) / spacing;
  };
  const ratio = 1.4;
  const tableau = extrapolate(centralDifference, step, ratio, ratio * ratio, 10);
  return accept(settings, tableau, noise, evaluations, `derivative at x = ${x}`);
}

/**
 * `lim f(x)` as `x → x0`, by Richardson extrapolation of `f(x0 ± h)`. A
 * numerical estimate, not a proof that the limit exists.
 *
 * @example
 * limit(x => Math.sin(x) / x, 0).value; // 1
 * limit(x => (1 + 1 / x) ** x, Infinity).value; // 2.718281828… (to about 1e-9)
 */
export function limit(f: RealFunction, x0: number, options?: LimitOptions): ExtrapolationResult {
  assertFunction(f, 'f');
  if (typeof x0 !== 'number') throw new TypeError('x0 must be a number');
  if (Number.isNaN(x0)) throw new InvalidArgumentError('x0 must not be NaN');
  const settings = readSettings(options);
  const side = options?.side ?? 'both';
  if (side !== 'left' && side !== 'right' && side !== 'both') {
    throw new InvalidArgumentError(`side must be 'left', 'right' or 'both', got ${String(side)}`);
  }
  const step = readStep(options?.step, 'step', Number.isFinite(x0) ? defaultStep(x0) : 0.1);
  if (!Number.isFinite(x0)) {
    const finiteSide = x0 > 0 ? 'left' : 'right';
    if (side !== 'both' && side !== finiteSide) {
      throw new InvalidArgumentError(`x0 = ${x0} can only be approached from the ${finiteSide}`);
    }
    return oneSided(f, x0, x0 > 0 ? 1 : -1, step, settings);
  }
  if (side !== 'both') return oneSided(f, x0, side === 'right' ? 1 : -1, step, settings);
  const right = oneSided(f, x0, 1, step, settings);
  const left = oneSided(f, x0, -1, step, settings);
  const gap = Math.abs(right.value - left.value);
  const errorEstimate = Math.max(right.errorEstimate, left.errorEstimate) + gap / 2;
  const result = {
    value: noNegativeZero(left.value / 2 + right.value / 2),
    errorEstimate,
    evaluations: right.evaluations + left.evaluations,
  };
  if (
    gap >
    right.errorEstimate + left.errorEstimate + Math.max(settings.absolute, settings.relative * Math.abs(result.value))
  ) {
    throw new ExtrapolationConvergenceError(
      `the one-sided limits at x0 = ${x0} differ (left ≈ ${left.value}, right ≈ ${right.value}), so the two-sided limit does not exist numerically`,
      result,
    );
  }
  return result;
}

/** One-sided limit: `direction` +1 approaches from above (or `+∞` via `f(1/h)`), −1 from below. */
function oneSided(
  f: RealFunction,
  x0: number,
  direction: 1 | -1,
  step: number,
  settings: Settings,
): ExtrapolationResult {
  let evaluations = 0;
  let noise = 0;
  const finite = Number.isFinite(x0);
  const sample = (h: number): number => {
    const x = finite ? x0 + direction * h : direction / h;
    if (x === x0) throw new InvalidArgumentError(`step ${h} is too small to move away from x0 = ${x0} in float64`);
    evaluations++;
    const y = call(f, x);
    noise = Math.max(noise, Number.EPSILON * Math.abs(y));
    return y;
  };
  const tableau = extrapolate(sample, step, 2, 2, 12);
  const from = direction > 0 ? 'above' : 'below';
  return accept(settings, tableau, noise, evaluations, `limit at x0 = ${x0} from ${from}`);
}
