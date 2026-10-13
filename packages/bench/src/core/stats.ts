/**
 * Statistics for @arki/bench. Pure and portable (no host APIs), and
 * deterministic for a given seed: the same blocks and seed always give the
 * same intervals and verdicts.
 *
 * Design (from the Fable + Astra review):
 * - The estimate of a speed case is total time over total operations
 *   (Σns / Σops). That is the cost of doing the work, the quantity throughput
 *   is about. A median of per-block averages hides stalls the work really
 *   pays for, and a mean of averages over-weights short blocks.
 * - The interval comes from the design that produced the data. Blocks in one
 *   process share JIT state, heap and machine conditions, so they are not
 *   independent. The bootstrap is two-stage: resample processes with
 *   replacement, then blocks within each chosen process with replacement.
 *   With one process it is plain block resampling.
 * - A difference is a verdict only when the interval establishes it beyond a
 *   practical-equivalence band. An uncertain difference is `inconclusive`,
 *   not a tie; a tiny but certain difference is a `tie`, not a win.
 */
import type {
  BenchResult,
  Block,
  CaseResult,
  Comparison,
  GroupResult,
  Interval,
  RunComparison,
  Summary,
} from './types.js';

/** Seed used when the caller gives none, so results stay reproducible by default. */
export const DEFAULT_SEED = 1_592_639_052; /* 0x5EEDBE4C */

/**
 * Bootstrap resamples per 95% interval. The cost is resamples × blocks, so
 * even tiny inputs keep the full count: fewer resamples would only add Monte
 * Carlo noise to the interval ends without saving anything measurable.
 */
export const RESAMPLES = 2000;

/** Upper bound on resamples when a multiple-comparison correction asks for far tails. */
const MAX_RESAMPLES = 20_000;

/** Family-wise error rate for intervals (95%). */
const ALPHA = 0.05;

// ---------------------------------------------------------------------------
// Random numbers
// ---------------------------------------------------------------------------

/**
 * mulberry32 (Tommy Ettinger, public domain): a 32-bit state PRNG with a full
 * 2^32 period that passes gjrand and PractRand to 2^32 outputs. Plenty for
 * bootstrap resampling, tiny, and identical on every JavaScript engine.
 * The seed is taken modulo 2^32. Returns floats in [0, 1).
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 1_831_565_813) /* 0x6D2B79F5 */ >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** Linear-interpolation quantile (R type 7) of an ascending array. */
function quantile(sorted: ArrayLike<number>, p: number): number {
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.min(low + 1, sorted.length - 1);
  const lowValue = sorted[low] ?? Number.NaN;
  const highValue = sorted[high] ?? Number.NaN;
  return lowValue + (position - low) * (highValue - lowValue);
}

/** Inverse standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9). */
function normalQuantile(p: number): number {
  const [a0, a1, a2, a3, a4, a5] = [
    -39.696_830_286_653_76, 220.946_098_424_520_5, -275.928_510_446_968_7, 138.357_751_867_269, -30.664_798_066_147_16,
    2.506_628_277_459_239,
  ] as const;
  const [b0, b1, b2, b3, b4] = [
    -54.476_098_798_224_06, 161.585_836_858_040_9, -155.698_979_859_886_6, 66.801_311_887_719_72,
    -13.280_681_552_885_72,
  ] as const;
  const [c0, c1, c2, c3, c4, c5] = [
    -0.007_784_894_002_430_293, -0.322_396_458_041_136_5, -2.400_758_277_161_838, -2.549_732_539_343_734,
    4.374_664_141_464_968, 2.938_163_982_698_783,
  ] as const;
  const [d0, d1, d2, d3] = [
    0.007_784_695_709_041_462, 0.322_467_129_070_039_8, 2.445_134_137_142_996, 3.754_408_661_907_416,
  ] as const;
  const tail = (q: number): number =>
    (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  const pLow = 0.024_25;
  if (p < pLow) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - pLow) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
    (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
  );
}

const Z95 = normalQuantile(1 - ALPHA / 2);

/** median/min/max/p75/p99/cv of a set of values (cv = sample sd / mean; 0 for one value). */
function describe(values: readonly number[]): Omit<Summary, 'estimate' | 'interval' | 'n'> {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  let sum = 0;
  for (const value of sorted) sum += value;
  const mean = sum / n;
  let squares = 0;
  for (const value of sorted) squares += (value - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(squares / (n - 1)) : 0;
  return {
    median: quantile(sorted, 0.5),
    min: sorted[0] ?? Number.NaN,
    max: sorted[n - 1] ?? Number.NaN,
    p75: quantile(sorted, 0.75),
    p99: quantile(sorted, 0.99),
    cv: mean === 0 ? 0 : sd / mean,
  };
}

/** Ratio that stays meaningful when the base is zero (e.g. an empty bundle). */
function safeRatio(head: number, base: number): number {
  if (base === 0) return head === 0 ? 1 : Number.POSITIVE_INFINITY;
  return head / base;
}

/** FNV-1a, so each CI row gets its own stream: adding a row never moves another row's interval. */
function hashString(text: string): number {
  let hash = 2_166_136_261; /* 0x811C9DC5 */
  for (let index = 0; index < text.length; index++) {
    hash ^= text.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Hierarchical bootstrap over the process → block design
// ---------------------------------------------------------------------------

/** Blocks grouped by process (ascending process id), as flat columns. */
type Design = { readonly processes: readonly { readonly ns: Float64Array; readonly ops: Float64Array }[] };

function toDesign(blocks: readonly Block[], caller: string): Design {
  if (blocks.length === 0) throw new RangeError(`${caller}: no blocks to summarize.`);
  const byProcess = new Map<number, { ns: number[]; ops: number[] }>();
  for (const block of blocks) {
    if (!Number.isFinite(block.ns) || block.ns < 0) {
      throw new RangeError(`${caller}: block ${block.process}/${block.block} has invalid ns ${block.ns}.`);
    }
    if (!Number.isFinite(block.ops) || block.ops <= 0) {
      throw new RangeError(`${caller}: block ${block.process}/${block.block} has invalid ops ${block.ops}.`);
    }
    let column = byProcess.get(block.process);
    if (!column) {
      column = { ns: [], ops: [] };
      byProcess.set(block.process, column);
    }
    column.ns.push(block.ns);
    column.ops.push(block.ops);
  }
  const ids = [...byProcess.keys()].sort((a, b) => a - b);
  return {
    processes: ids.map(id => {
      const column = byProcess.get(id) ?? { ns: [], ops: [] };
      return { ns: Float64Array.from(column.ns), ops: Float64Array.from(column.ops) };
    }),
  };
}

/** Σns / Σops of the observed design. */
function totalOverTotal(design: Design): number {
  let ns = 0;
  let ops = 0;
  for (const process of design.processes) {
    for (const value of process.ns) ns += value;
    for (const value of process.ops) ops += value;
  }
  return ns / ops;
}

/** One two-stage resample: processes with replacement, then blocks within each chosen process. */
function resample(design: Design, random: () => number): number {
  const { processes } = design;
  let ns = 0;
  let ops = 0;
  let draws = processes.length;
  while (draws-- > 0) {
    const process = processes[Math.floor(random() * processes.length)];
    if (!process) continue;
    const count = process.ns.length;
    for (let pick = 0; pick < count; pick++) {
      const index = Math.floor(random() * count);
      ns += process.ns[index] ?? 0;
      ops += process.ops[index] ?? 0;
    }
  }
  return ns / ops;
}

/** Resamples needed so each tail of a (1 - alpha) percentile interval holds at least ten resamples. */
function resamplesFor(alpha: number): number {
  return Math.min(MAX_RESAMPLES, Math.max(RESAMPLES, Math.ceil(20 / alpha)));
}

function percentileInterval(values: Float64Array, alpha: number): Interval {
  values.sort();
  return [quantile(values, alpha / 2), quantile(values, 1 - alpha / 2)];
}

function estimateInterval(design: Design, random: () => number, alpha: number): Interval {
  const resamples = resamplesFor(alpha);
  const values = new Float64Array(resamples);
  for (let index = 0; index < resamples; index++) values[index] = resample(design, random);
  return percentileInterval(values, alpha);
}

/** Median of one two-stage resample of single-op observations (metric values). */
function resampleMedian(design: Design, random: () => number, pool: Float64Array): number {
  const { processes } = design;
  let size = 0;
  let draws = processes.length;
  while (draws-- > 0) {
    const process = processes[Math.floor(random() * processes.length)];
    if (!process) continue;
    const count = process.ns.length;
    for (let pick = 0; pick < count; pick++) pool[size++] = process.ns[Math.floor(random() * count)] ?? 0;
  }
  return quantile(pool.subarray(0, size).sort(), 0.5);
}

/** Pool large enough for any resample of the design (processes × its largest process). */
function poolFor(design: Design): Float64Array {
  let largest = 0;
  for (const process of design.processes) largest = Math.max(largest, process.ns.length);
  return new Float64Array(design.processes.length * largest);
}

/** Like `ratioInterval`, but for the ratio of medians of metric observations. */
function medianRatioInterval(base: Design, other: Design, random: () => number, alpha: number): Interval {
  const resamples = resamplesFor(alpha);
  const values = new Float64Array(resamples);
  const basePool = poolFor(base);
  const otherPool = poolFor(other);
  for (let index = 0; index < resamples; index++) {
    const baseValue = resampleMedian(base, random, basePool);
    values[index] = safeRatio(resampleMedian(other, random, otherPool), baseValue);
  }
  return percentileInterval(values, alpha);
}

/** Median of single-op observations (ns of each block). */
function designMedian(design: Design): number {
  const values: number[] = [];
  for (const process of design.processes) values.push(...process.ns);
  return quantile(Float64Array.from(values).sort(), 0.5);
}

/** Both sides resampled independently with the same design; the ratio is taken per resample. */
function ratioInterval(base: Design, other: Design, random: () => number, alpha: number): Interval {
  const resamples = resamplesFor(alpha);
  const values = new Float64Array(resamples);
  for (let index = 0; index < resamples; index++) {
    const baseValue = resample(base, random);
    values[index] = safeRatio(resample(other, random), baseValue);
  }
  return percentileInterval(values, alpha);
}

// ---------------------------------------------------------------------------
// Public: summaries
// ---------------------------------------------------------------------------

/**
 * Summary of timed blocks. `estimate` = Σns / Σops; `interval` = 95%
 * two-stage (process → block) percentile bootstrap of that estimate with
 * {@link RESAMPLES} resamples; the spread fields (median, p75, p99, cv…) are
 * over per-block ns/op. One block gives interval [x, x] and cv 0. Throws a
 * RangeError on empty input or blocks with invalid ns/ops.
 */
export function summarize(blocks: readonly Block[], options: { seed?: number } = {}): Summary {
  const design = toDesign(blocks, 'summarize');
  const estimate = totalOverTotal(design);
  const spread = describe(blocks.map(block => block.ns / block.ops));
  const interval: Interval =
    blocks.length === 1
      ? [estimate, estimate]
      : estimateInterval(design, createRandom(options.seed ?? DEFAULT_SEED), ALPHA);
  return { estimate, interval, ...spread, n: blocks.length };
}

/** Lower rank l (1-based) of the distribution-free 95% interval for the median: [x(l), x(n-l+1)]. */
function medianRank(n: number): number {
  if (n > 1000) return Math.max(1, Math.floor(n / 2 - (Z95 * Math.sqrt(n)) / 2));
  // P(Binomial(n, 1/2) <= k), built up term by term.
  let pmf = 0.5 ** n;
  let cdf = pmf;
  let rank = 1;
  for (let k = 0; k < n; k++) {
    // The interval [x(k+1), x(n-k)] misses the median with probability 2·P(B <= k).
    if (cdf > ALPHA / 2) break;
    rank = k + 1;
    pmf = (pmf * (n - k)) / (k + 1);
    cdf += pmf;
  }
  return rank;
}

/**
 * Summary of plain repeated measurements (metric groups: compile time,
 * instantiation count…). Each value is one whole measurement, not a block of
 * operations, so `estimate` is the MEDIAN: a compile or a request runs once in
 * practice, the typical run is what a user sees, and host stalls (GC, a cold
 * disk cache) inflate a mean without being a property of the code. Repeats
 * are few (often 5–10), where one outlier moves a mean a lot and a median not
 * at all.
 *
 * `interval` is the distribution-free order-statistic interval for the median
 * (exact binomial coverage ≥ 95%, no resampling, so `seed` is accepted for
 * symmetry and unused). Below six values no pair of order statistics reaches
 * 95%, and the interval is [min, max] (coverage 1 − 2·0.5ⁿ). A single value,
 * or identical values from a deterministic metric, give [v, v].
 */
export function summarizeValues(values: readonly number[], _options: { seed?: number } = {}): Summary {
  if (values.length === 0) throw new RangeError('summarizeValues: no values to summarize.');
  for (const value of values) {
    if (!Number.isFinite(value)) throw new RangeError(`summarizeValues: invalid value ${value}.`);
  }
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  const rank = medianRank(n);
  const spread = describe(values);
  return {
    estimate: spread.median,
    interval: [sorted[rank - 1] ?? Number.NaN, sorted[n - rank] ?? Number.NaN],
    ...spread,
    n,
  };
}

// ---------------------------------------------------------------------------
// Public: comparing two cases
// ---------------------------------------------------------------------------

/** Practical-equivalence band for case-vs-baseline verdicts: ±2% on the log scale. */
export const TIE_BAND = 0.02;

/**
 * Verdict against the practical-equivalence band (1/(1+t), 1+t), for
 * ratio = other / base (lower is better). The band is symmetric on the log
 * scale, so "2% lower" and "2% higher" are the same size of effect. An exact
 * ratio is the interval [r, r].
 */
export function bandVerdict(interval: Interval, threshold = TIE_BAND): Comparison['verdict'] {
  const [low, high] = interval;
  const lower = 1 / (1 + threshold);
  const upper = 1 + threshold;
  if (high < lower) return 'lower';
  if (low > upper) return 'higher';
  if (low >= lower && high <= upper) return 'tie';
  return 'inconclusive';
}

/**
 * Fewest blocks (timed blocks, or observations of a repeated metric) each side
 * of a sampled comparison needs, in total over all processes, before it can
 * carry a verdict. One block resamples to itself, so its bootstrap interval
 * has zero width and would turn one noisy sample into a confident "50× slower
 * [50–50]". (The profiles' `minSamples` is a different thing: mitata's samples
 * inside one block.) Exact comparisons (sizes, deterministic metrics) never
 * need it.
 */
export const MIN_COMPARISON_BLOCKS = 2;

/**
 * A sampled comparison with fewer than {@link MIN_COMPARISON_BLOCKS} blocks on
 * a side: the point ratio, interval [ratio, ratio] (no interval was measured;
 * the field stays required) and always `inconclusive`.
 */
function unmeasuredComparison(ratio: number): Omit<Comparison, 'case'> {
  return { ratio, interval: [ratio, ratio], verdict: 'inconclusive' };
}

/**
 * Blocks behind the thinner side of a sampled comparison in `group` (the
 * smaller `summary.n` of the baseline and `key`), or undefined when the
 * comparison is exact (size, deterministic metric) or a row is missing.
 * Below {@link MIN_COMPARISON_BLOCKS} the comparison has no measured interval
 * and no verdict, whatever an older result recorded: reports say so instead
 * of printing `[x–x]`, and `collectLosses` skips it.
 */
export function comparisonBlocks(group: GroupResult, key: string): number | undefined {
  if (group.kind === 'size' || group.kind === 'scenario' || group.deterministic === true) return undefined;
  const base = group.cases.find(entry => entry.key === group.baseline);
  const other = group.cases.find(entry => entry.key === key);
  if (!base || !other) return undefined;
  return Math.min(base.summary.n, other.summary.n);
}

/**
 * Ratio of two cases, other / base (Σns/Σops each), with a 95% interval from
 * resampling both sides independently with the hierarchical design.
 *
 * With fewer than {@link MIN_COMPARISON_BLOCKS} blocks on either side there is
 * nothing to resample: the result is the point ratio, interval
 * [ratio, ratio], verdict `inconclusive`.
 *
 * Verdicts, with t = threshold (default 0.02):
 * - `lower` / `higher`: the whole interval lies beyond the band, so the
 *   difference is both established and large enough to matter;
 * - `tie`: the whole interval lies inside the band, so any difference is
 *   established to be too small to matter;
 * - `inconclusive`: anything else. An interval that straddles the band edge
 *   has NOT shown equivalence; calling it a tie would turn "we could not tell"
 *   into "they are equal".
 */
export function compareBlocks(
  base: readonly Block[],
  other: readonly Block[],
  options: { seed?: number; threshold?: number } = {},
): Omit<Comparison, 'case'> {
  const threshold = options.threshold ?? TIE_BAND;
  const baseDesign = toDesign(base, 'compareBlocks(base)');
  const otherDesign = toDesign(other, 'compareBlocks(other)');
  const ratio = safeRatio(totalOverTotal(otherDesign), totalOverTotal(baseDesign));
  if (Math.min(base.length, other.length) < MIN_COMPARISON_BLOCKS) return unmeasuredComparison(ratio);
  const interval = ratioInterval(baseDesign, otherDesign, createRandom(options.seed ?? DEFAULT_SEED), ALPHA);
  return { ratio, interval, verdict: bandVerdict(interval, threshold) };
}

/** A comparison of two exactly known values (sizes, deterministic metrics): interval [r, r]. */
export function exactComparison(base: number, other: number, threshold = TIE_BAND): Omit<Comparison, 'case'> {
  const ratio = safeRatio(other, base);
  return { ratio, interval: [ratio, ratio], verdict: bandVerdict([ratio, ratio], threshold) };
}

/**
 * Ratio of the MEDIANS of two sets of metric observations (blocks with
 * `ops` = 1, `ns` = the value), other / base, with a 95% interval from the
 * same two-stage bootstrap as `compareBlocks` (processes, then observations),
 * taking the median of each resample. The median is the metric estimator
 * (see `summarizeValues`), so the ratio compares the numbers the report shows.
 * Fewer than {@link MIN_COMPARISON_BLOCKS} observations on a side give the
 * point ratio, interval [ratio, ratio] and `inconclusive`, as in `compareBlocks`.
 */
export function compareMedians(
  base: readonly Block[],
  other: readonly Block[],
  options: { seed?: number; threshold?: number } = {},
): Omit<Comparison, 'case'> {
  const threshold = options.threshold ?? TIE_BAND;
  const baseDesign = toDesign(base, 'compareMedians(base)');
  const otherDesign = toDesign(other, 'compareMedians(other)');
  const ratio = safeRatio(designMedian(otherDesign), designMedian(baseDesign));
  if (Math.min(base.length, other.length) < MIN_COMPARISON_BLOCKS) return unmeasuredComparison(ratio);
  const interval = medianRatioInterval(baseDesign, otherDesign, createRandom(options.seed ?? DEFAULT_SEED), ALPHA);
  return { ratio, interval, verdict: bandVerdict(interval, threshold) };
}

// ---------------------------------------------------------------------------
// Public: comparing two runs (CI)
// ---------------------------------------------------------------------------

type Row = RunComparison['rows'][number];

/** A case pair still to be measured against the threshold, after compatibility checks. */
type Pending = {
  group: string;
  kind: GroupResult['kind'];
  base: CaseResult;
  head: CaseResult;
  method: 'blocks' | 'summaries' | 'exact' | 'too-few';
};

/** The `case` of the one row a group gets when its head contract check failed. */
export const CONTRACT_ROW = '(contract)';

function caseValue(kind: GroupResult['kind'], result: CaseResult): number {
  return kind === 'size' && result.size !== undefined ? result.size.gzip : result.summary.estimate;
}

function methodFor(group: GroupResult, base: CaseResult, head: CaseResult): Pending['method'] {
  if (group.kind === 'size' || (group.kind === 'metric' && group.deterministic === true)) return 'exact';
  if (Math.min(base.summary.n, head.summary.n) < MIN_COMPARISON_BLOCKS) return 'too-few';
  if (base.blocks?.length && head.blocks?.length) return 'blocks';
  const [baseLow, baseHigh] = base.summary.interval;
  const [headLow, headHigh] = head.summary.interval;
  return baseLow === baseHigh && headLow === headHigh ? 'exact' : 'summaries';
}

/**
 * Ratio interval from two stored 95% summary intervals (samples omitted).
 * Conservative: the union of
 * (a) the box [head.low / base.high, head.high / base.low], and
 * (b) a log-normal approximation that reads each interval as ±1.96 se on the
 *     log scale, adds the variances, and widens to the corrected level.
 * (b) carries the multiple-comparison correction; (a) guards against skewed
 * intervals that (b) would under-cover. Wider intervals mean more
 * `inconclusive` rows, never a false `regressed` or `improved`.
 */
function summaryRatioInterval(base: CaseResult, head: CaseResult, alpha: number): Interval {
  const [baseLow, baseHigh] = base.summary.interval;
  const [headLow, headHigh] = head.summary.interval;
  const boxLow = baseHigh > 0 ? headLow / baseHigh : 0;
  const boxHigh = baseLow > 0 ? headHigh / baseLow : Number.POSITIVE_INFINITY;
  if (baseLow <= 0 || headLow <= 0) return [boxLow, boxHigh];
  const logSe = (low: number, high: number): number => (Math.log(high) - Math.log(low)) / (2 * Z95);
  const se = Math.hypot(logSe(baseLow, baseHigh), logSe(headLow, headHigh));
  const center = Math.log(safeRatio(head.summary.estimate, base.summary.estimate));
  const z = normalQuantile(1 - alpha / 2);
  return [Math.min(boxLow, Math.exp(center - z * se)), Math.max(boxHigh, Math.exp(center + z * se))];
}

function runVerdict(interval: Interval, threshold: number): Row['status'] {
  const verdict = bandVerdict(interval, threshold);
  if (verdict === 'higher') return 'regressed';
  if (verdict === 'lower') return 'improved';
  if (verdict === 'tie') return 'within';
  return 'inconclusive';
}

/**
 * Why a base case and a head case cannot be compared, or undefined when they
 * can. Per case: a changed `workHash` makes only that case incompatible.
 * Results without work hashes fall back to the group's spec hash, then the
 * suite's.
 */
function caseIncompatibility(
  pair: { base: GroupResult; head: GroupResult; baseCase: CaseResult; headCase: CaseResult },
  baseRun: BenchResult,
  headRun: BenchResult,
): string | undefined {
  const { base, head, baseCase, headCase } = pair;
  const reasons: string[] = [];
  if (base.kind !== head.kind) reasons.push(`group kind changed (${base.kind} → ${head.kind})`);
  if (base.unit !== head.unit) reasons.push(`unit changed (${base.unit} → ${head.unit})`);
  if (base.contract?.id !== head.contract?.id) {
    reasons.push(`contract changed (${base.contract?.id ?? 'none'} → ${head.contract?.id ?? 'none'})`);
  }
  if (baseCase.workHash !== undefined && headCase.workHash !== undefined) {
    if (baseCase.workHash !== headCase.workHash) reasons.push('the case measures different work (work hash differs)');
  } else if (base.specHash !== undefined && head.specHash !== undefined) {
    if (base.specHash !== head.specHash)
      reasons.push('group definition changed (spec hash differs; no work hash recorded)');
  } else if (baseRun.suite.specHash !== headRun.suite.specHash) {
    reasons.push('suite definition changed (spec hash differs; no work or group hash recorded)');
  }
  if (base.check?.status === 'failed') reasons.push('contract check failed in base');
  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

/** Why two whole runs cannot be compared, or undefined when they can. */
function runIncompatibility(base: BenchResult, head: BenchResult): string | undefined {
  const reasons: string[] = [];
  if (base.profile !== head.profile) reasons.push(`profiles differ (${base.profile} vs ${head.profile})`);
  if (base.profile === 'quick') reasons.push('base is a quick run');
  if (head.profile === 'quick') reasons.push('head is a quick run');
  const baseRuntime = base.environment.runtime.name;
  const headRuntime = head.environment.runtime.name;
  if (baseRuntime !== headRuntime) reasons.push(`runtime changed (${baseRuntime} → ${headRuntime})`);
  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

/** A head size row over its gzip budget, whatever else is true of it. */
function overBudget(kind: GroupResult['kind'], head: CaseResult): string | undefined {
  if (kind !== 'size' || head.limit === undefined) return undefined;
  const gzip = caseValue(kind, head);
  if (!head.flags.includes('over-limit') && gzip <= head.limit) return undefined;
  return `over its size budget (${gzip} > ${head.limit} bytes gzip)`;
}

/** Budgets are absolute: a head row over its limit regresses, even when added or incompatible. */
function withBudget(row: Row, kind: GroupResult['kind'], head: CaseResult): Row {
  const over = overBudget(kind, head);
  if (over === undefined) return row;
  return { ...row, status: 'regressed', reason: row.reason ? `${over}; ${row.reason}` : over };
}

function contractRow(group: string, failed?: GroupResult): Row {
  const count = failed?.check?.failures.length;
  const first = failed?.check?.failures[0];
  const detail =
    count === undefined
      ? 'it was not timed'
      : `${count} mismatch(es)${first ? `; first: case "${first.case}", input ${first.input}: expected ${first.expected}, got ${first.actual}` : ''}`;
  return { group, case: CONTRACT_ROW, status: 'contract-failed', reason: `contract check failed in head (${detail})` };
}

/**
 * Compares a head run against a base run for CI.
 *
 * Matching: groups by `id`, cases by `key`. When either result carries a
 * `runtimes` matrix, runtimes are paired by `environment.runtime.name` and
 * each row's `group` is prefixed `<runtime>/<group id>`; a runtime present on
 * one side only yields `added` / `removed` rows. A result without a matrix
 * counts as a matrix of itself.
 *
 * `contract-failed` (one row per group, case `(contract)`) when a head
 * group's contract check failed, or the head lost a group to a failed check:
 * the comparison fails, and its cases are never reported `removed`.
 *
 * `incompatible` (never a speed verdict), per case, when the runs' profiles
 * differ, either run is a `quick` run, the runtime, group kind, unit or
 * contract id differs, the case's `workHash` differs (the group spec hash,
 * then the suite hash, when cases carry none), or the base contract check
 * failed. A changed workload needs a new baseline, not an apparent win.
 *
 * Per row, ratio = head / base (lower is better), judged against the band
 * (1/(1+t), 1+t), t = threshold (default 0.05):
 * - both sides carry blocks: hierarchical bootstrap ratio interval (of
 *   Σns/Σops for speed, of medians for metrics);
 * - samples omitted: the conservative interval of `summaryRatioInterval`;
 * - size rows and deterministic metrics: exact values, compared directly
 *   against the band.
 * Interval wholly above → `regressed`, wholly below → `improved`, wholly
 * inside → `within`, otherwise `inconclusive`.
 *
 * Multiple comparisons: with m uncertain (non-exact) rows, each interval is
 * built at level 1 − 0.05/m (Bonferroni), so the chance that ANY row is
 * falsely `regressed` stays ≤ 5%. Resamples grow to keep ≥ 10 in each tail
 * (capped at 20,000). Exact rows need no correction.
 *
 * Size budgets are checked on every head row, whatever its status: a row over
 * its `limit` is `regressed` (a budget is absolute, so CI fails even when the
 * base was already over it, the row is new, or the work changed).
 *
 * `status` is `fail` iff some row is `regressed` or `contract-failed`.
 * `warnings` notes a base run that is not publishable (it does not fail).
 */
export function compareRuns(
  base: BenchResult,
  head: BenchResult,
  options: { threshold?: number; seed?: number } = {},
): RunComparison {
  const threshold = options.threshold ?? 0.05;
  const seed = options.seed ?? DEFAULT_SEED;
  const prefixed = Boolean(base.runtimes?.length || head.runtimes?.length);
  const baseRuns = base.runtimes?.length ? base.runtimes : [base];
  const headRuns = head.runtimes?.length ? head.runtimes : [head];

  // Pass 1: match, check compatibility, collect pending comparisons in display order.
  const entries: (Row | Pending)[] = [];
  // Row label → unit, so renderers print `40.3 ns` or `12.1 kB` instead of a bare number.
  const units = new Map<string, string>();
  const label = (runtime: string, group: string): string => (prefixed ? `${runtime}/${group}` : group);
  const added = (group: string, kind: GroupResult['kind'], result: CaseResult): Row =>
    withBudget({ group, case: result.key, status: 'added', head: caseValue(kind, result) }, kind, result);
  const removed = (group: string, kind: GroupResult['kind'], result: CaseResult): Row => ({
    group,
    case: result.key,
    status: 'removed',
    base: caseValue(kind, result),
  });
  const failedInHead = (run: BenchResult, id: string): boolean =>
    run.warnings.some(warning => warning.code === 'contract-failed' && warning.group === id);

  const pairs: { base?: BenchResult; head?: BenchResult; runtime: string }[] = [];
  if (prefixed) {
    for (const run of headRuns) {
      const name = run.environment.runtime.name;
      pairs.push({ head: run, runtime: name, base: baseRuns.find(other => other.environment.runtime.name === name) });
    }
    for (const run of baseRuns) {
      const name = run.environment.runtime.name;
      if (!headRuns.some(other => other.environment.runtime.name === name)) pairs.push({ base: run, runtime: name });
    }
  } else {
    pairs.push({ base, head, runtime: head.environment.runtime.name });
  }

  for (const pair of pairs) {
    if (!pair.base && pair.head) {
      for (const group of pair.head.groups) {
        const name = label(pair.runtime, group.id);
        units.set(name, group.unit);
        if (group.check?.status === 'failed') entries.push(contractRow(name, group));
        else for (const result of group.cases) entries.push(added(name, group.kind, result));
      }
      continue;
    }
    if (!pair.head && pair.base) {
      for (const group of pair.base.groups) {
        units.set(label(pair.runtime, group.id), group.unit);
        for (const result of group.cases) entries.push(removed(label(pair.runtime, group.id), group.kind, result));
      }
      continue;
    }
    if (!pair.base || !pair.head) continue;
    const runReasons = [runIncompatibility(pair.base, pair.head), prefixed ? runIncompatibility(base, head) : undefined]
      .filter((reason): reason is string => reason !== undefined)
      .join('; ');

    for (const headGroup of pair.head.groups) {
      const baseGroup = pair.base.groups.find(group => group.id === headGroup.id);
      const group = label(pair.runtime, headGroup.id);
      units.set(group, headGroup.unit);
      if (headGroup.check?.status === 'failed') {
        entries.push(contractRow(group, headGroup));
        continue;
      }
      if (!baseGroup) {
        for (const result of headGroup.cases) entries.push(added(group, headGroup.kind, result));
        continue;
      }
      for (const headCase of headGroup.cases) {
        const baseCase = baseGroup.cases.find(result => result.key === headCase.key);
        if (!baseCase) {
          entries.push(added(group, headGroup.kind, headCase));
          continue;
        }
        const reason =
          [
            runReasons,
            caseIncompatibility({ base: baseGroup, head: headGroup, baseCase, headCase }, pair.base, pair.head),
          ]
            .filter(Boolean)
            .join('; ') || undefined;
        if (reason) {
          const row: Row = {
            group,
            case: headCase.key,
            base: caseValue(baseGroup.kind, baseCase),
            head: caseValue(headGroup.kind, headCase),
            status: 'incompatible',
            reason,
          };
          entries.push(withBudget(row, headGroup.kind, headCase));
        } else {
          entries.push({
            group,
            kind: headGroup.kind,
            base: baseCase,
            head: headCase,
            method: methodFor(headGroup, baseCase, headCase),
          });
        }
      }
      for (const baseCase of baseGroup.cases) {
        if (!headGroup.cases.some(result => result.key === baseCase.key)) {
          entries.push(removed(group, baseGroup.kind, baseCase));
        }
      }
    }
    for (const baseGroup of pair.base.groups) {
      if (pair.head.groups.some(group => group.id === baseGroup.id)) continue;
      const group = label(pair.runtime, baseGroup.id);
      units.set(group, baseGroup.unit);
      if (failedInHead(pair.head, baseGroup.id)) {
        entries.push(contractRow(group));
        continue;
      }
      for (const result of baseGroup.cases) entries.push(removed(group, baseGroup.kind, result));
    }
  }

  // Pass 2: Bonferroni over the uncertain rows, then judge each pending row.
  const gated = entries.filter(entry => 'method' in entry && entry.method !== 'exact').length;
  const alpha = ALPHA / Math.max(1, gated);
  const rows: Row[] = entries.map(entry => {
    const row = 'method' in entry ? judge(entry, threshold, alpha, seed) : entry;
    const unit = units.get(row.group);
    return unit === undefined ? row : { ...row, unit };
  });
  const warnings: string[] = [];
  if (!base.publishable) {
    const reasons = [...new Set(base.warnings.map(warning => warning.code))].join(', ');
    warnings.push(
      `The base run is not publishable${reasons ? ` (${reasons})` : ''}: its numbers may be noisy or incomplete, so treat this comparison as a hint.`,
    );
  }
  const failed = rows.some(row => row.status === 'regressed' || row.status === 'contract-failed');
  return { status: failed ? 'fail' : 'pass', threshold, warnings, rows };
}

function judge(entry: Pending, threshold: number, alpha: number, seed: number): Row {
  const base = caseValue(entry.kind, entry.base);
  const head = caseValue(entry.kind, entry.head);
  const ratio = safeRatio(head, base);
  if (entry.method === 'too-few') {
    // One block (or one observation) has no interval: never a regression or an improvement.
    const blocks = Math.min(entry.base.summary.n, entry.head.summary.n);
    const reason = `${blocks} ${blocks === 1 ? 'block' : 'blocks'}: too few to compare (needs ${MIN_COMPARISON_BLOCKS} per side)`;
    return withBudget(
      { group: entry.group, case: entry.head.key, base, head, ratio, status: 'inconclusive', reason },
      entry.kind,
      entry.head,
    );
  }
  let interval: Interval;
  let reason: string | undefined;
  if (entry.method === 'blocks') {
    const random = createRandom((seed ^ hashString(`${entry.group}\u0000${entry.head.key}`)) >>> 0);
    const baseDesign = toDesign(entry.base.blocks ?? [], 'compareRuns(base)');
    const headDesign = toDesign(entry.head.blocks ?? [], 'compareRuns(head)');
    interval =
      entry.kind === 'metric'
        ? medianRatioInterval(baseDesign, headDesign, random, alpha)
        : ratioInterval(baseDesign, headDesign, random, alpha);
  } else if (entry.method === 'summaries') {
    interval = summaryRatioInterval(entry.base, entry.head, alpha);
    reason = 'samples omitted: conservative interval from the stored summaries';
  } else {
    interval = [ratio, ratio];
  }
  const row: Row =
    reason === undefined
      ? {
          group: entry.group,
          case: entry.head.key,
          base,
          head,
          ratio,
          interval,
          status: runVerdict(interval, threshold),
        }
      : {
          group: entry.group,
          case: entry.head.key,
          base,
          head,
          ratio,
          interval,
          status: runVerdict(interval, threshold),
          reason,
        };
  return withBudget(row, entry.kind, entry.head);
}
