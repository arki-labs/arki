/**
 * Definite integrals of a function of one real variable,
 * `f: (x: number) => number`, over finite or infinite intervals, on float64.
 *
 * **Methods.** `integrate(f, [a, b])` picks one with `{ method }`:
 * - `'gaussKronrod'` (the default) is globally adaptive Gauss–Kronrod
 *   quadrature with the 7-point Gauss / 15-point Kronrod pair, as in QUADPACK
 *   `qag`/`qagi` (Piessens et al. 1983; SciPy `quad`). Each sub-interval gets a
 *   15-point estimate and an error estimate from its difference to the
 *   embedded 7-point Gauss rule; the sub-interval with the largest error is
 *   bisected next (a priority queue), until the summed error estimate meets the
 *   tolerance. The error estimate is QUADPACK's
 *   `resasc · min(1, (200 · |K15 − G7| / resasc)^1.5)`, floored at
 *   `50 · ε · ∫|f|`: deliberately pessimistic for smooth integrands. There is
 *   no Wynn epsilon extrapolation (`qags`), so integrable endpoint
 *   singularities converge by brute subdivision; prefer `'tanhSinh'` for them.
 *   Best for smooth, oscillatory or piecewise-smooth integrands; split `[a, b]`
 *   at known interior kinks or jumps.
 * - `'tanhSinh'` is double-exponential quadrature (Takahasi & Mori 1974; Boost
 *   `tanh_sinh`, mpmath `quad`): the substitution `x = c + h·tanh(π/2·sinh t)`
 *   makes the integrand decay double-exponentially, so the trapezoidal rule in
 *   `t` converges very fast even with integrable endpoint singularities such as
 *   `x^(−1/2)` or `log x`. The step in `t` is halved per level (reusing every
 *   point) and the error estimate is the change between the last two levels,
 *   plus the size of the outermost terms (the truncated tails) and a rounding
 *   term `ε · ∫|f|`; at least four levels run before it may stop. It is poor
 *   for oscillatory integrands and for singularities inside `(a, b)`. The
 *   nodes are computed from their distance to the nearer endpoint, so they get
 *   within about `1e-308` of an endpoint at `0` but only within one unit in the
 *   last place of any other endpoint: put a singularity at `0` (substitute
 *   `u = x − a`) for full accuracy. A singularity anywhere else shows up as a
 *   large error estimate, never as a silently wrong value.
 *
 * **Infinite intervals.** `±Infinity` bounds are allowed (`[-Infinity,
 * Infinity]` too); the integrand must decay fast enough to be integrable.
 * Gauss–Kronrod maps them onto `(0, 1]` as QUADPACK `qagi` does:
 * `∫_a^∞ f(x) dx = ∫_0^1 f(a + (1 − t)/t) / t² dt`, with `f(b − u)` for
 * `(−∞, b]` and `f(u) + f(−u)` for the whole line. Tanh-sinh uses its own
 * double-exponential maps instead: `x = a + exp(π/2·sinh t)` (exp-sinh) for a
 * half line and `x = sinh(π/2·sinh t)` (sinh-sinh) for the whole line.
 *
 * **Tolerance.** Converged means `errorEstimate ≤ max(absoluteTolerance,
 * relativeTolerance · |value|)`; the defaults are `1e-12` and `1e-10`, and
 * they cannot both be 0. `maxEvaluations` (default 20,000) bounds the calls of
 * `f`; at least one 15-point rule, or four tanh-sinh levels, always run. The
 * error estimate is an estimate, not a bound: no method that only samples `f`
 * can bound the error of an arbitrary function (a narrow spike between the
 * sample points is invisible), but on the test suite it is never smaller than
 * the actual error.
 *
 * **Results and failures.** `integrate` returns `{ value, errorEstimate,
 * evaluations }`. Reversed bounds give the negated integral
 * (`∫_b^a = −∫_a^b`); equal finite bounds give exactly 0 without calling `f`.
 * Failures are typed errors, never `NaN`:
 * - `f` returning `NaN` or `±Infinity` at a sample point throws
 *   `NumericRangeError` naming the point (a non-integrable singularity usually
 *   ends this way), as does a sum that overflows;
 * - missing the tolerance within `maxEvaluations`, or a Gauss–Kronrod
 *   sub-interval too narrow to bisect, throws `IntegrationConvergenceError`, a
 *   `ConvergenceError` whose `best` field holds the best value and error
 *   estimate reached, so a caller that can live with less accuracy can still
 *   use it on purpose;
 * - `NaN` bounds, equal infinite bounds or bad options throw
 *   `InvalidArgumentError`.
 */

import type { RealFunction } from './internal/calculus.js';
import { ConvergenceError, InvalidArgumentError, NumericRangeError } from './errors.js';
import { assertFunction, call, noNegativeZero, readBounds, readCount, readTolerance } from './internal/calculus.js';

export type { RealFunction } from './internal/calculus.js';

export type IntegrationMethod = 'gaussKronrod' | 'tanhSinh';

export type IntegrateOptions = {
  /** `'gaussKronrod'` (default, adaptive G7–K15) or `'tanhSinh'` (double-exponential, for endpoint singularities). */
  readonly method?: IntegrationMethod;
  /** Absolute tolerance on the error estimate (default `1e-12`). */
  readonly absoluteTolerance?: number;
  /** Relative tolerance, times `|value|` (default `1e-10`). */
  readonly relativeTolerance?: number;
  /** Most calls of `f` before `IntegrationConvergenceError` (default 20,000). */
  readonly maxEvaluations?: number;
};

export type IntegrationResult = {
  readonly value: number;
  /** Estimated absolute error of `value`. */
  readonly errorEstimate: number;
  /** Calls of `f`. */
  readonly evaluations: number;
};

/** `integrate` missed its tolerance; `best` is the best estimate it reached. */
export class IntegrationConvergenceError extends ConvergenceError {
  /** The best value, its error estimate and the evaluations spent (sign already applied for reversed bounds). */
  readonly best: IntegrationResult;

  constructor(message: string, best: IntegrationResult) {
    super(message);
    this.best = best;
  }
}

/** State of one `integrate` call: the counted integrand, the targets and the orientation. */
type Run = {
  readonly f: RealFunction;
  readonly absolute: number;
  readonly relative: number;
  readonly maxEvaluations: number;
  readonly sign: 1 | -1;
  evaluations: number;
};

function evaluate(run: Run, x: number): number {
  run.evaluations++;
  return call(run.f, x);
}

function target(run: Run, value: number): number {
  return Math.max(run.absolute, run.relative * Math.abs(value));
}

function finish(run: Run, value: number, errorEstimate: number): IntegrationResult {
  return { value: noNegativeZero(run.sign * value), errorEstimate, evaluations: run.evaluations };
}

function fail(run: Run, message: string, value: number, errorEstimate: number): never {
  throw new IntegrationConvergenceError(message, finish(run, value, errorEstimate));
}

function assertSumFinite(value: number): void {
  if (!Number.isFinite(value)) {
    throw new NumericRangeError('the integral overflows float64; the integrand may not be integrable');
  }
}

/**
 * `∫ f(x) dx` from `bounds[0]` to `bounds[1]`, with an error estimate. Either
 * bound may be infinite. See the module docs for the methods, the tolerance and
 * the failure policy.
 *
 * @example
 * integrate(Math.sin, [0, Math.PI]).value; // 2
 * integrate(x => 1 / Math.sqrt(x), [0, 1], { method: 'tanhSinh' }).value; // 2
 * integrate(x => Math.exp(-x * x), [0, Infinity]).value; // 0.886226925452758 (√π/2)
 */
export function integrate(
  f: RealFunction,
  bounds: readonly [number, number],
  options?: IntegrateOptions,
): IntegrationResult {
  assertFunction(f, 'f');
  const [lower, upper] = readBounds(bounds, 'bounds', true);
  const method = options?.method ?? 'gaussKronrod';
  if (method !== 'gaussKronrod' && method !== 'tanhSinh') {
    throw new InvalidArgumentError(`method must be 'gaussKronrod' or 'tanhSinh', got ${String(method)}`);
  }
  const absolute = readTolerance(options?.absoluteTolerance, 'absoluteTolerance', 1e-12);
  const relative = readTolerance(options?.relativeTolerance, 'relativeTolerance', 1e-10);
  if (absolute === 0 && relative === 0) {
    throw new InvalidArgumentError('absoluteTolerance and relativeTolerance cannot both be 0');
  }
  const maxEvaluations = readCount(options?.maxEvaluations, 'maxEvaluations', 20_000);
  if (lower === upper) {
    if (!Number.isFinite(lower)) throw new InvalidArgumentError(`bounds [${lower}, ${upper}] give no interval`);
    return { value: 0, errorEstimate: 0, evaluations: 0 };
  }
  const run: Run = { f, absolute, relative, maxEvaluations, sign: lower < upper ? 1 : -1, evaluations: 0 };
  const a = Math.min(lower, upper);
  const b = Math.max(lower, upper);
  if (method === 'tanhSinh') {
    const finiteEnds = Number.isFinite(a) && Number.isFinite(b);
    const name = finiteEnds ? 'tanh-sinh' : Number.isFinite(a) || Number.isFinite(b) ? 'exp-sinh' : 'sinh-sinh';
    return doubleExponential(run, nodeMap(a, b), name);
  }
  if (Number.isFinite(a) && Number.isFinite(b))
    return gaussKronrod(
      run,
      a,
      b,
      x => evaluate(run, x),
      t => t,
    );
  return gaussKronrod(run, 0, 1, ...infiniteToUnit(run, a, b));
}

// ---- Gauss–Kronrod (QUADPACK qk15) ----

/** Kronrod abscissae on [0, 1]; odd indices are the 7-point Gauss nodes, index 7 is the center. */
const XGK: readonly number[] = [
  0.991_455_371_120_812_6, 0.949_107_912_342_758_5, 0.864_864_423_359_769_1, 0.741_531_185_599_394_5, 0.586_087_235_467_691_1,
  0.405_845_151_377_397_2, 0.207_784_955_007_898_48, 0,
];
/** Weights of the 15-point Kronrod rule, matching `XGK`. */
const WGK: readonly number[] = [
  0.022_935_322_010_529_224, 0.063_092_092_629_978_56, 0.104_790_010_322_250_19, 0.140_653_259_715_525_92, 0.169_004_726_639_267_9,
  0.190_350_578_064_785_42, 0.204_432_940_075_298_89, 0.209_482_141_084_727_82,
];
/** Weights of the 7-point Gauss rule: `WG[j]` for `XGK[2j + 1]`, and `WG[3]` for the center. */
const WG: readonly number[] = [0.129_484_966_168_869_7, 0.279_705_391_489_276_64, 0.381_830_050_505_118_9, 0.417_959_183_673_469_4];

const EPSILON = Number.EPSILON;
const MIN_NORMAL = 2 ** -1022;

type Piece = { readonly a: number; readonly b: number; readonly value: number; readonly error: number };

/** The 15-point Kronrod estimate of `∫_a^b g` with QUADPACK's error estimate. */
function kronrod15(g: RealFunction, a: number, b: number): Piece {
  const center = a / 2 + b / 2;
  const half = b / 2 - a / 2;
  const fc = g(center);
  let gauss = fc * WG[3]!;
  let kronrod = fc * WGK[7]!;
  let absolute = Math.abs(kronrod);
  const left: number[] = [];
  const right: number[] = [];
  for (let k = 0; k < 7; k++) {
    const dx = half * XGK[k]!;
    const y1 = g(center - dx);
    const y2 = g(center + dx);
    left.push(y1);
    right.push(y2);
    kronrod += WGK[k]! * (y1 + y2);
    absolute += WGK[k]! * (Math.abs(y1) + Math.abs(y2));
    if (k % 2 === 1) gauss += WG[(k - 1) / 2]! * (y1 + y2);
  }
  const mean = kronrod / 2;
  let deviation = WGK[7]! * Math.abs(fc - mean);
  for (let k = 0; k < 7; k++) deviation += WGK[k]! * (Math.abs(left[k]! - mean) + Math.abs(right[k]! - mean));
  const width = Math.abs(half);
  absolute *= width;
  deviation *= width;
  let error = Math.abs((kronrod - gauss) * half);
  if (deviation !== 0 && error !== 0) error = deviation * Math.min(1, ((200 * error) / deviation) ** 1.5);
  if (absolute > MIN_NORMAL / (50 * EPSILON)) error = Math.max(50 * EPSILON * absolute, error);
  return { a, b, value: kronrod * half, error };
}

/** `∫_a^∞`, `∫_−∞^b` or `∫_−∞^∞` of f as `∫_0^1 g(t) dt` with `u = (1 − t)/t` (QUADPACK qagi); also maps t back to x. */
function infiniteToUnit(run: Run, a: number, b: number): [RealFunction, (t: number) => number] {
  const toX = (t: number): number => {
    const u = (1 - t) / t;
    return Number.isFinite(a) ? a + u : Number.isFinite(b) ? b - u : u;
  };
  const halfLine = Number.isFinite(a) || Number.isFinite(b);
  const g = (t: number): number => {
    const x = toX(t);
    const sum = halfLine ? evaluate(run, x) : evaluate(run, x) + evaluate(run, -x);
    const y = sum / (t * t);
    if (!Number.isFinite(y)) {
      throw new NumericRangeError(
        `the integrand overflows near x = ${x} after mapping the infinite interval onto (0, 1]`,
      );
    }
    return y;
  };
  return [g, toX];
}

function gaussKronrod(run: Run, a: number, b: number, g: RealFunction, toX: (t: number) => number): IntegrationResult {
  const heap: Piece[] = [];
  const first = kronrod15(g, a, b);
  const perRule = run.evaluations;
  heapPush(heap, first);
  let value = first.value;
  let error = first.error;
  for (;;) {
    assertSumFinite(value);
    if (error <= target(run, value)) {
      // Confirm on exact sums: the running totals drift by rounding as pieces come and go.
      value = sumPieces(heap, piece => piece.value);
      error = sumPieces(heap, piece => piece.error);
      if (error <= target(run, value)) return finish(run, value, error);
    }
    if (run.evaluations + 2 * perRule > run.maxEvaluations) {
      fail(
        run,
        `adaptive Gauss–Kronrod did not reach the tolerance within ${run.maxEvaluations} evaluations ` +
          `(estimate ${run.sign * value} ± ${error}). The integrand may be singular, discontinuous or highly ` +
          "oscillatory: split the interval at trouble points, try { method: 'tanhSinh' } for endpoint singularities, " +
          'or raise maxEvaluations.',
        sumPieces(heap, piece => piece.value),
        sumPieces(heap, piece => piece.error),
      );
    }
    const worst = heapPop(heap);
    const mid = worst.a / 2 + worst.b / 2;
    if (!(worst.a < mid && mid < worst.b)) {
      heapPush(heap, worst);
      fail(
        run,
        `adaptive Gauss–Kronrod cannot bisect the sub-interval near x = ${toX(mid)} any further; the integrand ` +
          "is probably singular or discontinuous there (try { method: 'tanhSinh' } for an endpoint singularity)",
        sumPieces(heap, piece => piece.value),
        sumPieces(heap, piece => piece.error),
      );
    }
    const left = kronrod15(g, worst.a, mid);
    const right = kronrod15(g, mid, worst.b);
    value += left.value + right.value - worst.value;
    error += left.error + right.error - worst.error;
    heapPush(heap, left);
    heapPush(heap, right);
  }
}

/** Neumaier-compensated sum of one field over the pieces. */
function sumPieces(pieces: readonly Piece[], field: (piece: Piece) => number): number {
  let sum = 0;
  let compensation = 0;
  for (const piece of pieces) {
    const x = field(piece);
    const t = sum + x;
    compensation += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
    sum = t;
  }
  return sum + compensation;
}

/** Binary max-heap on `error`. */
function heapPush(heap: Piece[], piece: Piece): void {
  heap.push(piece);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent]!.error >= piece.error) break;
    heap[i] = heap[parent]!;
    i = parent;
  }
  heap[i] = piece;
}

function heapPop(heap: Piece[]): Piece {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) return top;
  let i = 0;
  for (;;) {
    const l = 2 * i + 1;
    if (l >= heap.length) break;
    const r = l + 1;
    const child = r < heap.length && heap[r]!.error > heap[l]!.error ? r : l;
    if (heap[child]!.error <= last.error) break;
    heap[i] = heap[child]!;
    i = child;
  }
  heap[i] = last;
  return top;
}

// ---- Double-exponential (tanh-sinh, exp-sinh, sinh-sinh) ----

const HALF_PI = Math.PI / 2;
/** Levels (halvings of the step in t) before tanh-sinh may stop: levels 0–3. */
const MIN_LEVEL = 3;
/** No node map is valid beyond |t| = 7 in float64; a hard stop in case one ever were. */
const T_MAX = 8;

type Node = { x: number; w: number };
/** Writes the abscissa and weight for `t` into `node`; false when they are not representable (stop sweeping). */
type NodeMap = (t: number, node: Node) => boolean;

function nodeMap(a: number, b: number): NodeMap {
  if (Number.isFinite(a) && Number.isFinite(b)) {
    const center = a / 2 + b / 2;
    const half = b / 2 - a / 2;
    return (t, node) => {
      const u = HALF_PI * Math.sinh(t);
      const coshU = Math.cosh(u);
      node.w = (half * HALF_PI * Math.cosh(t)) / (coshU * coshU);
      if (t === 0) {
        node.x = center;
        return true;
      }
      // Distance to the nearer endpoint, computed directly so nodes near an endpoint at 0 keep full precision.
      const delta = half * (2 / (1 + Math.exp(2 * Math.abs(u))));
      node.x = t < 0 ? a + delta : b - delta;
      return node.w > 0 && delta > 0 && node.x > a && node.x < b;
    };
  }
  if (Number.isFinite(a) || Number.isFinite(b)) {
    const end = Number.isFinite(a) ? a : b;
    const direction = Number.isFinite(a) ? 1 : -1;
    return (t, node) => {
      const e = Math.exp(HALF_PI * Math.sinh(t));
      node.x = end + direction * e;
      node.w = HALF_PI * Math.cosh(t) * e;
      return Number.isFinite(node.x) && Number.isFinite(node.w) && node.w > 0 && node.x !== end;
    };
  }
  return (t, node) => {
    const u = HALF_PI * Math.sinh(t);
    node.x = Math.sinh(u);
    node.w = HALF_PI * Math.cosh(t) * Math.cosh(u);
    return Number.isFinite(node.x) && Number.isFinite(node.w);
  };
}

function doubleExponential(run: Run, map: NodeMap, name: string): IntegrationResult {
  const node: Node = { x: 0, w: 0 };
  /** Outermost |t| reached on each side, and |w·f| there: the truncated tail is about that size. */
  const edge = { low: { t: 0, term: 0 }, high: { t: 0, term: 0 } };
  let estimate = 0;
  let absolute = 0;
  let nodes = 0;
  let bestError = Infinity;
  for (let level = 0; ; level++) {
    const h = 2 ** -level;
    if (level > 0 && run.evaluations + nodes > run.maxEvaluations) {
      fail(
        run,
        `${name} quadrature did not reach the tolerance within ${run.maxEvaluations} evaluations ` +
          `(estimate ${run.sign * estimate} ± ${bestError}). The integrand may be oscillatory or singular inside ` +
          "the interval (try { method: 'gaussKronrod' } and split at trouble points), or raise maxEvaluations.",
        estimate,
        bestError,
      );
    }
    let sum = 0;
    let sumAbs = 0;
    if (level === 0 && map(0, node)) {
      const y = node.w * evaluate(run, node.x);
      sum += y;
      sumAbs += Math.abs(y);
      nodes++;
    }
    const start = level === 0 ? 1 : h;
    const stride = level === 0 ? 1 : 2 * h;
    for (const side of [edge.low, edge.high]) {
      const direction = side === edge.low ? -1 : 1;
      for (let t = start; t <= T_MAX && map(direction * t, node); t += stride) {
        const y = node.w * evaluate(run, node.x);
        sum += y;
        sumAbs += Math.abs(y);
        nodes++;
        if (t > side.t) {
          side.t = t;
          side.term = Math.abs(y);
        }
      }
    }
    const previous = estimate;
    estimate = level === 0 ? sum : previous / 2 + h * sum;
    absolute = level === 0 ? sumAbs : absolute / 2 + h * sumAbs;
    assertSumFinite(estimate);
    if (level > 0) {
      const error = Math.abs(estimate - previous) + edge.low.term + edge.high.term + EPSILON * absolute;
      bestError = error;
      if (level >= MIN_LEVEL && error <= target(run, estimate)) return finish(run, estimate, error);
    }
  }
}
