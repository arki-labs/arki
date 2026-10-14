/**
 * Real roots of a function of one real variable, `f: (x: number) => number`,
 * on float64.
 *
 * **Methods.**
 * - `findRoot(f, [a, b])` is Brent's method (Brent 1973; netlib `zeroin`, the
 *   algorithm behind SciPy `brentq` and MATLAB `fzero`). It mixes inverse
 *   quadratic interpolation and secant steps with bisection, and keeps the root
 *   bracketed the whole time, so it converges for every continuous `f` that
 *   changes sign on `[a, b]`, usually in a handful of steps, and never much
 *   slower than bisection. Start here.
 * - `bisect(f, [a, b])` halves the bracket every step: slower (one bit per
 *   evaluation), but the simplest guarantee there is.
 * - `newton(f, df, x0)` uses the derivative `df` and converges quadratically
 *   near a simple root. It needs no bracket, and it is the only method here
 *   that can reach a root of even multiplicity (`(x - 1)²` touches zero without
 *   changing sign). Unbracketed, every step is damped: when the full step
 *   `-f(x)/f'(x)` does not reduce `|f|`, it is halved until it does, which tames
 *   the classic overshoots (`atan(x)` from `x0 = 1.5`, `cbrt(x)`). With
 *   `{ bracket }` it is the safeguarded Newton of Numerical Recipes (`rtsafe`):
 *   any step that would leave the bracket, or shrinks it too slowly, becomes a
 *   bisection step, so it converges whenever bisection would.
 * - `findRoots(f, [a, b], { samples })` evaluates `f` on `samples + 1` evenly
 *   spaced points and runs Brent's method on every sub-interval where the sign
 *   changes. It is a scan, not a proof of completeness: it **misses roots of
 *   even multiplicity** (no sign change) and **pairs of roots closer together
 *   than the grid spacing** (their sign changes cancel). Raise `samples` or
 *   narrow the interval when that matters.
 *
 * **Tolerance.** A method stops once its error estimate is at most
 * `absoluteTolerance + relativeTolerance · |root|`. The defaults, `2e-12` and
 * `4 · Number.EPSILON`, are SciPy's `brentq` defaults; pass
 * `absoluteTolerance: 0` to iterate to full float64 precision (Brent's method
 * then stops within a few units in the last place). `maxIterations` (default
 * 200) bounds the number of steps; an iteration is one evaluation of `f` (one
 * of `f` and one of `df` for Newton).
 *
 * **Results.** Every method returns `{ root, errorEstimate, iterations,
 * evaluations }` (`evaluations` counts calls of `f` and `df` together). For
 * the bracketed methods `errorEstimate` is the width of the final sign-change
 * bracket around `root`: a true bound on the distance to a root whenever `f` is
 * continuous. It is `0` when `f(root)` is exactly `0`. For unbracketed Newton
 * it is the length of the last step, an estimate that is usually pessimistic
 * near a simple root but not a bound.
 *
 * **Failures** are typed errors, never `NaN`:
 * - a bracket whose ends have the same sign throws `InvalidArgumentError`
 *   (as does a reversed, empty or non-finite bracket);
 * - `f` (or `df`) returning `NaN` or `±Infinity` throws `NumericRangeError`
 *   naming the point;
 * - no convergence within `maxIterations`, or a Newton step that cannot make
 *   progress (zero derivative, overflow, a local minimum of `|f|` that is not a
 *   root), throws `RootConvergenceError`, a `ConvergenceError` whose `best`
 *   field holds the last iterate and its error estimate.
 *
 * A sign change across a pole looks exactly like a root to every bracketed
 * method: `findRoot(x => Math.tan(x), [1, 2])` converges to `π/2`, where `tan`
 * is unbounded. Check `|f(root)|` when `f` may be discontinuous.
 */

import type { RealFunction } from './internal/calculus.js';
import { ConvergenceError, InvalidArgumentError } from './errors.js';
import { assertFunction, call, readBounds, readCount, readTolerance } from './internal/calculus.js';
import { assertFinite } from './number.js';

export type { RealFunction } from './internal/calculus.js';

export type RootOptions = {
  /** Absolute part of the stopping tolerance (default `2e-12`). */
  readonly absoluteTolerance?: number;
  /** Relative part of the stopping tolerance, times `|root|` (default `4 · Number.EPSILON`). */
  readonly relativeTolerance?: number;
  /** Most steps before `RootConvergenceError` (default 200). */
  readonly maxIterations?: number;
};

export type NewtonOptions = RootOptions & {
  /** A sign-change bracket containing `x0`; turns on the bisection fallback of `rtsafe`. */
  readonly bracket?: readonly [number, number];
};

export type FindRootsOptions = RootOptions & {
  /** Number of equal sub-intervals scanned for a sign change (default 100). */
  readonly samples?: number;
};

export type RootResult = {
  readonly root: number;
  /** Bracket width for `findRoot`/`bisect` (a bound); last step length for unbracketed `newton` (an estimate). */
  readonly errorEstimate: number;
  readonly iterations: number;
  /** Calls of `f` (plus `df` for Newton), including the bracket ends. */
  readonly evaluations: number;
};

/** A root-finding method stopped before its tolerance; `best` is where it stopped. */
export class RootConvergenceError extends ConvergenceError {
  /** The last iterate and its error estimate (`Infinity` when there is none). */
  readonly best: RootResult;

  constructor(message: string, best: RootResult) {
    super(message);
    this.best = best;
  }
}

type Settings = {
  readonly absolute: number;
  readonly relative: number;
  readonly maxIterations: number;
};

function readSettings(options: RootOptions | undefined): Settings {
  return {
    absolute: readTolerance(options?.absoluteTolerance, 'absoluteTolerance', 2e-12),
    relative: readTolerance(options?.relativeTolerance, 'relativeTolerance', 4 * Number.EPSILON),
    maxIterations: readCount(options?.maxIterations, 'maxIterations', 200),
  };
}

function tolerance(settings: Settings, x: number): number {
  return settings.absolute + settings.relative * Math.abs(x);
}

function result(root: number, errorEstimate: number, iterations: number, evaluations: number): RootResult {
  return { root: root === 0 ? 0 : root, errorEstimate, iterations, evaluations };
}

type Bracket = { readonly a: number; readonly b: number; readonly fa: number; readonly fb: number };

/** Checks `[a, b]` (finite, a < b) and evaluates its ends, which must not have the same sign. */
function signChangeBracket(f: RealFunction, bracket: unknown, name: string): Bracket {
  const [a, b] = readBounds(bracket, name, false);
  if (!(a < b)) throw new InvalidArgumentError(`${name} [${a}, ${b}] must have lower < upper`);
  if (!Number.isFinite(b - a)) throw new InvalidArgumentError(`${name} [${a}, ${b}] is wider than the largest float`);
  const fa = call(f, a);
  const fb = call(f, b);
  if (fa !== 0 && fb !== 0 && fa > 0 === fb > 0) {
    throw new InvalidArgumentError(
      `f does not change sign on [${a}, ${b}] (f(a) = ${fa}, f(b) = ${fb}); a bracketed method needs ends of opposite sign. ` +
        'A root of even multiplicity, such as x = 1 in (x - 1)², never changes sign: use newton.',
    );
  }
  return { a, b, fa, fb };
}

/**
 * The root of a continuous `f` inside `bracket`, by Brent's method. `f(a)` and
 * `f(b)` must have opposite signs (or one of them be 0). `errorEstimate` is the
 * width of the final bracket, so `root` is within it of a sign change.
 *
 * @example
 * findRoot(x => x ** 3 - 2 * x - 5, [2, 3]).root; // 2.0945514815423265 (Wallis's cubic)
 */
export function findRoot(f: RealFunction, bracket: readonly [number, number], options?: RootOptions): RootResult {
  assertFunction(f, 'f');
  const settings = readSettings(options);
  const { a, b, fa, fb } = signChangeBracket(f, bracket, 'bracket');
  return brent(f, a, b, fa, fb, settings, 2);
}

/** Brent's `zeroin`, from known end values. `c` is always the far end of the bracket around `b`. */
function brent(
  f: RealFunction,
  a0: number,
  b0: number,
  fa0: number,
  fb0: number,
  settings: Settings,
  evaluations0: number,
): RootResult {
  let evaluations = evaluations0;
  if (fa0 === 0) return result(a0, 0, 0, evaluations);
  if (fb0 === 0) return result(b0, 0, 0, evaluations);
  let a = a0;
  let b = b0;
  let fa = fa0;
  let fb = fb0;
  let c = a;
  let fc = fa;
  let d = b - a;
  let e = d;
  for (let iterations = 0; ; iterations++) {
    // Keep b as the best estimate: the end with the smaller |f|.
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = c;
      c = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }
    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tolerance(settings, b);
    const xm = 0.5 * (c - b);
    if (fb === 0) return result(b, 0, iterations, evaluations);
    if (Math.abs(xm) <= tol1) return result(b, Math.abs(c - b), iterations, evaluations);
    if (iterations === settings.maxIterations) {
      throw new RootConvergenceError(
        `Brent's method did not converge in ${settings.maxIterations} iterations; the root is in [${Math.min(b, c)}, ${Math.max(b, c)}]`,
        result(b, Math.abs(c - b), iterations, evaluations),
      );
    }
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      // Interpolate: secant when only two points are distinct, inverse quadratic otherwise.
      const s = fb / fa;
      let p: number;
      let q: number;
      if (a === c) {
        p = 2 * xm * s;
        q = 1 - s;
      } else {
        const qa = fa / fc;
        const r = fb / fc;
        p = s * (2 * xm * qa * (qa - r) - (b - a) * (r - 1));
        q = (qa - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      else p = -p;
      // Accept the interpolation only if it lands well inside the bracket and shrinks fast enough.
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) {
        e = d;
        d = p / q;
      } else {
        d = xm;
        e = d;
      }
    } else {
      d = xm;
      e = d;
    }
    a = b;
    fa = fb;
    b += Math.abs(d) > tol1 ? d : xm > 0 ? tol1 : -tol1;
    fb = call(f, b);
    evaluations++;
    if (fb !== 0 && fb > 0 === fc > 0) {
      c = a;
      fc = fa;
      d = b - a;
      e = d;
    }
  }
}

/**
 * The root of a continuous `f` inside `bracket`, by bisection. Each step halves
 * the bracket, so reaching a tolerance `t` from width `w` takes
 * `ceil(log2(w / t))` steps; `errorEstimate` bounds the distance to a sign
 * change.
 */
export function bisect(f: RealFunction, bracket: readonly [number, number], options?: RootOptions): RootResult {
  assertFunction(f, 'f');
  const settings = readSettings(options);
  const ends = signChangeBracket(f, bracket, 'bracket');
  let evaluations = 2;
  if (ends.fa === 0) return result(ends.a, 0, 0, evaluations);
  if (ends.fb === 0) return result(ends.b, 0, 0, evaluations);
  let a = ends.a;
  let b = ends.b;
  let fa = ends.fa;
  for (let iterations = 0; ; iterations++) {
    const mid = a / 2 + b / 2;
    // Once a and b are adjacent floats, mid equals one of them; the bound then is b - a.
    const errorEstimate = Math.max(mid - a, b - mid);
    if (errorEstimate <= tolerance(settings, mid) || mid <= a || mid >= b) {
      return result(mid, errorEstimate, iterations, evaluations);
    }
    if (iterations === settings.maxIterations) {
      throw new RootConvergenceError(
        `bisection did not converge in ${settings.maxIterations} iterations; the root is in [${a}, ${b}]`,
        result(mid, errorEstimate, iterations, evaluations),
      );
    }
    const fm = call(f, mid);
    evaluations++;
    if (fm === 0) return result(mid, 0, iterations + 1, evaluations);
    if (fm > 0 === fa > 0) {
      a = mid;
      fa = fm;
    } else {
      b = mid;
    }
  }
}

/** Halvings tried before a damped Newton step gives up on reducing |f|. */
const MAX_HALVINGS = 60;

/**
 * A root of `f` near `x0` by Newton's method, given the derivative `df`.
 * Unbracketed steps are damped (halved until `|f|` decreases); with
 * `{ bracket }` the method falls back to bisection whenever Newton would leave
 * the bracket or stall, and `errorEstimate` is at most the bracket width.
 *
 * @example
 * newton(x => x * x - 2, x => 2 * x, 1).root; // 1.4142135623730951
 */
export function newton(f: RealFunction, df: RealFunction, x0: number, options?: NewtonOptions): RootResult {
  assertFunction(f, 'f');
  assertFunction(df, 'df');
  assertFinite(x0, 'x0');
  const settings = readSettings(options);
  if (options?.bracket !== undefined) return safeguardedNewton(f, df, x0, options.bracket, settings);

  let x = x0;
  let fx = call(f, x);
  let evaluations = 1;
  let lastStep = Infinity;
  if (fx === 0) return result(x, 0, 0, evaluations);
  for (let iterations = 1; iterations <= settings.maxIterations; iterations++) {
    const slope = call(df, x, 'df');
    evaluations++;
    let step = fx / slope;
    if (slope === 0 || !Number.isFinite(step)) {
      throw new RootConvergenceError(
        `Newton's method cannot step from x = ${x}: f'(x) = ${slope}. Pass { bracket } to fall back to bisection.`,
        result(x, lastStep, iterations, evaluations),
      );
    }
    // Converged on the full (undamped) step: the next iterate moves less than the tolerance.
    if (Math.abs(step) <= tolerance(settings, x - step)) {
      return result(x - step, Math.abs(step), iterations, evaluations);
    }
    let next = x - step;
    let fNext = call(f, next);
    evaluations++;
    for (let halvings = 0; Math.abs(fNext) > Math.abs(fx); halvings++) {
      if (halvings === MAX_HALVINGS) {
        throw new RootConvergenceError(
          `Newton's method stalled at x = ${x}: no step along -f(x)/f'(x) reduces |f(x)| = ${Math.abs(fx)} ` +
            '(a local minimum of |f| that is not a root, or a root that float64 cannot resolve to this tolerance)',
          result(x, lastStep, iterations, evaluations),
        );
      }
      step /= 2;
      next = x - step;
      fNext = call(f, next);
      evaluations++;
    }
    x = next;
    fx = fNext;
    lastStep = Math.abs(step);
    if (fx === 0) return result(x, 0, iterations, evaluations);
  }
  throw new RootConvergenceError(
    `Newton's method did not converge in ${settings.maxIterations} iterations (last x = ${x}, last step ${lastStep})`,
    result(x, lastStep, settings.maxIterations, evaluations),
  );
}

/** Numerical Recipes `rtsafe`: Newton inside a sign-change bracket, bisecting when Newton misbehaves. */
function safeguardedNewton(
  f: RealFunction,
  df: RealFunction,
  x0: number,
  bracket: unknown,
  settings: Settings,
): RootResult {
  const ends = signChangeBracket(f, bracket, 'bracket');
  let evaluations = 2;
  if (ends.fa === 0) return result(ends.a, 0, 0, evaluations);
  if (ends.fb === 0) return result(ends.b, 0, 0, evaluations);
  if (x0 < ends.a || x0 > ends.b) {
    throw new InvalidArgumentError(`x0 = ${x0} lies outside the bracket [${ends.a}, ${ends.b}]`);
  }
  const lowerIsPositive = ends.fa > 0;
  let lower = ends.a;
  let upper = ends.b;
  let x = x0;
  let fx = call(f, x);
  evaluations++;
  if (fx === 0) return result(x, 0, 0, evaluations);
  if (fx > 0 === lowerIsPositive) lower = x;
  else upper = x;
  let step = upper - lower;
  let stepBefore = step;
  for (let iterations = 1; iterations <= settings.maxIterations; iterations++) {
    const slope = call(df, x, 'df');
    evaluations++;
    const newtonStep = fx / slope;
    const target = x - newtonStep;
    const inside = slope !== 0 && Number.isFinite(target) && target > lower && target < upper;
    // rtsafe's "too slow" test: Newton must at least halve the step from two iterations ago.
    const fastEnough = Math.abs(2 * fx) <= Math.abs(stepBefore * slope);
    stepBefore = step;
    if (inside && fastEnough) {
      step = newtonStep;
      x = target;
    } else {
      const mid = lower / 2 + upper / 2;
      step = x - mid;
      x = mid;
    }
    fx = call(f, x);
    evaluations++;
    if (fx === 0) return result(x, 0, iterations, evaluations);
    if (fx > 0 === lowerIsPositive) lower = x;
    else upper = x;
    const errorEstimate = Math.min(Math.abs(step), upper - lower);
    const middle = lower / 2 + upper / 2;
    // A bracket of two adjacent floats cannot shrink further.
    if (errorEstimate <= tolerance(settings, x) || middle <= lower || middle >= upper) {
      return result(x, errorEstimate, iterations, evaluations);
    }
  }
  throw new RootConvergenceError(
    `safeguarded Newton did not converge in ${settings.maxIterations} iterations; the root is in [${lower}, ${upper}]`,
    result(x, upper - lower, settings.maxIterations, evaluations),
  );
}

/**
 * Every root that a sign-change scan of `interval` can see, ascending. `f` is
 * evaluated on `samples + 1` evenly spaced points (default `samples` 100);
 * grid points where `f` is exactly 0 are reported as they are, and each
 * sub-interval whose ends differ in sign is refined by Brent's method. The
 * `iterations`/`evaluations` of each result count only its refinement; the scan
 * itself costs `samples + 1` evaluations.
 *
 * It can miss roots: a root of even multiplicity never changes sign, and two
 * roots inside one sub-interval cancel each other's sign change.
 */
export function findRoots(
  f: RealFunction,
  interval: readonly [number, number],
  options?: FindRootsOptions,
): RootResult[] {
  assertFunction(f, 'f');
  const settings = readSettings(options);
  const samples = readCount(options?.samples, 'samples', 100);
  const [a, b] = readBounds(interval, 'interval', false);
  if (!(a < b)) throw new InvalidArgumentError(`interval [${a}, ${b}] must have lower < upper`);
  if (!Number.isFinite(b - a)) throw new InvalidArgumentError(`interval [${a}, ${b}] is wider than the largest float`);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const x = i === samples ? b : a + (b - a) * (i / samples);
    xs.push(x);
    ys.push(call(f, x));
  }
  const roots: RootResult[] = [];
  for (let i = 0; i <= samples; i++) {
    const y = ys[i]!;
    if (y === 0) {
      roots.push(result(xs[i]!, 0, 0, 0));
    } else if (i < samples) {
      const yNext = ys[i + 1]!;
      if (yNext !== 0 && y > 0 !== yNext > 0) roots.push(brent(f, xs[i]!, xs[i + 1]!, y, yNext, settings, 0));
    }
  }
  return roots;
}
