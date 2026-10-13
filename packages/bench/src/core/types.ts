/**
 * The public contract of @arki/bench: what a benchmark file declares (the
 * spec), and what a run produces (the versioned result). Every other module
 * codes against these types; renderers, comparers and CI read only results.
 *
 * Design rules (from the Fable + Astra review, 2026-10-13):
 * - A suite is data. Running it returns a result; nothing prints by itself.
 * - A `compare` group proves equal work (executable contract) before timing,
 *   and only ranks cases that share the contract. Different work is a
 *   `scenario`, shown without ratios.
 * - Every estimate carries an interval; a difference that is not established
 *   is reported as `tie` or `inconclusive`, never as a winner.
 * - Results carry full provenance and say whether they are publishable.
 */

// ---------------------------------------------------------------------------
// Spec: what a benchmark file declares
// ---------------------------------------------------------------------------

/**
 * sync: `run` returns its result; a promise from a sync-mode case is an error
 * (only its synchronous start would be timed). async: every call is awaited,
 * so `run` may return a promise or a plain value.
 */
export type Mode = 'sync' | 'async';

export type CaseSpec<Input, State = Input, Result = unknown> = {
  /** Display name. Defaults to the case key. */
  label?: string;
  /** npm package this case exercises; its installed version is recorded in the result. */
  package?: string;
  // setup/run/normalize/expected are method signatures on purpose: methods
  // compare bivariantly, so a case with a precise state type is assignable to
  // the erased `CaseSpec<Input, unknown, unknown>` the group stores, without a
  // cast. `compare()` / `scenario()` still check each case precisely (see CaseBuilder).
  /**
   * Untimed and synchronous. Turns one input into the state `run` receives.
   * Defaults to the input itself. It receives its own copy of the input
   * (`structuredClone`), so it may change it. Returning a promise is an error.
   */
  setup?(input: Input): State;
  /** Timed. Must return the result (it is consumed so the work cannot be optimized away). */
  run(state: State): Result;
  /**
   * Untimed. Maps the result (awaited, in async mode) to a comparable value
   * for the contract check. May return a promise, e.g. to read a response
   * body. Defaults to the result.
   */
  normalize?(result: Awaited<Result>): unknown;
  /**
   * Untimed. Releases what `setup` made (connections, timers, temp files),
   * once per state, after the contract check and after timing. May return a
   * promise. Every state is torn down even when another teardown or a
   * later setup throws; a throw fails the case in the contract check, and
   * after timing it adds a blocking `teardown-failed` warning.
   */
  teardown?(state: State): unknown;
  /**
   * Declares that this case does NOT meet the group's contract, in plain words
   * (e.g. 'rounds half-up only'). The case is measured and shown, skipped by
   * the contract check, and never ranked.
   */
  differs?: string;
  /** Another way to call the baseline's own library (e.g. 'string factor'). Shown, not ranked against competitors. */
  variant?: boolean;
};

export type CompareSpec<Input> = {
  kind?: 'compare';
  /** Stable id: baselines and CI match groups by it. */
  id: string;
  title: string;
  /** The shared promise every ranked case keeps. Its id is versioned: change it when the work changes. */
  contract: { id: string; description: string };
  /**
   * Inputs, cycled through during timing (varying inputs defeat constant
   * folding) and all used by the contract check. Include boundary cases.
   */
  inputs: readonly Input[];
  /** Oracle: the normalized value every ranked case must produce for an input. Called on a pristine copy of each input before any case runs. */
  expected?(input: Input): unknown;
  /** Key of the reference case (usually the @arki library). Ratios are case / baseline. */
  baseline: string;
  mode?: Mode;
  note?: string;
  // `any` is not allowed in this repo; `never` here would reject real states, so cases are typed per key.
  cases: Record<string, CaseSpec<Input, unknown, unknown>>;
};

/** Independent measurements of different work: shown side by side, never ranked. */
export type ScenarioSpec<Input = undefined> = {
  kind: 'scenario';
  id: string;
  title: string;
  inputs?: readonly Input[];
  mode?: Mode;
  note?: string;
  cases: Record<string, ScenarioCaseSpec<Input, unknown, unknown>>;
};

/** Bundle cost of what a consumer imports. Runs in the Node host only. */
export type SizeSpec = {
  kind: 'size';
  id: string;
  title: string;
  note?: string;
  /** Modules left out of every bundle. Default: react, react-dom, react/jsx-runtime. */
  externals?: readonly string[];
  baseline: string;
  cases: Record<
    string,
    {
      label?: string;
      package?: string;
      /** Entry module source, e.g. `export { Button } from '@arki/ui/button';` or `@import 'x/styles.css';`. */
      source: string;
      /** Entry file type. Default 'js'. */
      ext?: 'js' | 'css';
      /** Budget on the gzipped total, e.g. '8 kB'. Exceeding it fails `arki-bench run --ci`. */
      limit?: string;
      differs?: string;
      /** Another entry point or build of the baseline's own library (e.g. 'tokens + bridge'). Shown with a ratio, labelled as a variant. */
      variant?: boolean;
    }
  >;
};

/** A custom deterministic or measured metric (type instantiations, compile time, request count…). */
export type MetricSpec = {
  kind: 'metric';
  id: string;
  title: string;
  note?: string;
  /** Unit label, e.g. 'instantiations' or 'ms'. */
  unit: string;
  /** Deterministic metrics are collected once; others are repeated and summarized. */
  deterministic: boolean;
  baseline: string;
  cases: Record<
    string,
    {
      label?: string;
      package?: string;
      collect: () => number | Promise<number>;
      differs?: string;
    }
  >;
};

/**
 * Types one case precisely: `setup`'s return type flows into `run`, `run`'s
 * into `normalize`. Passed to `cases: c => ({ key: c({...}) })` by `compare()`
 * and `scenario()`; it returns the case unchanged.
 */
export type CaseBuilder<Input> = <State = Input, Result = unknown>(
  spec: CaseSpec<Input, State, Result>,
) => CaseSpec<Input, unknown, unknown>;

/** Scenario cases: no contract, so no `normalize`, `differs` or `variant`. */
export type ScenarioCaseSpec<Input, State = Input, Result = unknown> = Omit<
  CaseSpec<Input, State, Result>,
  'normalize' | 'differs' | 'variant'
>;

export type ScenarioCaseBuilder<Input> = <State = Input, Result = unknown>(
  spec: ScenarioCaseSpec<Input, State, Result>,
) => ScenarioCaseSpec<Input, unknown, unknown>;

/** What `compare()` accepts: a CompareSpec whose cases may be a builder for per-case inference. */
export type CompareDefinition<Input> = Omit<CompareSpec<Input>, 'cases'> & {
  cases: CompareSpec<Input>['cases'] | ((c: CaseBuilder<Input>) => CompareSpec<Input>['cases']);
};

/** What `scenario()` accepts: `kind` optional, cases may be a builder. */
export type ScenarioDefinition<Input> = Omit<ScenarioSpec<Input>, 'kind' | 'cases'> & {
  kind?: 'scenario';
  cases: ScenarioSpec<Input>['cases'] | ((c: ScenarioCaseBuilder<Input>) => ScenarioSpec<Input>['cases']);
};

export type GroupSpec = CompareSpec<unknown> | ScenarioSpec<unknown> | SizeSpec | MetricSpec;

export type SuiteSpec = {
  /** Stable id, usually the package name. */
  id: string;
  /** Section heading. Default 'Benchmarks'. */
  title?: string;
  /** One or two sentences: what is compared and why these competitors. */
  intro?: string;
  /** Plain-words caveats printed under the tables. */
  notes?: readonly string[];
  groups: readonly GroupSpec[];
};

/** Measures one size group. Provided by the Node host (`@arki/bench/node`); the portable core has no bundler. */
export type SizeRunner = (group: SizeSpec) => Promise<GroupResult>;

// ---------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------

/**
 * quick   — smoke run; checks the suite works. Never publishable.
 * explore — interleaved randomized blocks, for development. Never publishable.
 * publish — several fresh processes × interleaved blocks. For READMEs and CI.
 *           The only profile whose result can be publishable.
 */
export type Profile = 'quick' | 'explore' | 'publish';

export type RunOptions = {
  profile?: Profile;
  /** Group or case id filter: substring or RegExp. */
  filter?: string | RegExp;
  /** Seed for block order and resampling; recorded in the result. */
  seed?: number;
  /** Per-call timeout for async cases, ms. Default 10_000. */
  timeoutMs?: number;
  /** Progress events (the CLI prints them to stderr). */
  onProgress?: (event: ProgressEvent) => void;
  /** Size groups need a bundler; without one they are skipped with a warning. */
  sizeRunner?: SizeRunner;
  /** Process index when a host runs several processes (publish profile). Default 0. */
  process?: number;
  /** Overrides parts of the profile's measurement budget (rounds, block time…). */
  budget?: Partial<Budget>;
};

/** How much measuring a profile does. Defaults per profile live in `PROFILE_BUDGETS` (engine). */
export type Budget = {
  /** Interleaved rounds per group; each round times one block per case, in a fresh random order. */
  rounds: number;
  /** CPU-time budget of one block, ms (mitata `min_cpu_time`). */
  blockMs: number;
  /** Time-based warm-up per case before the first round, ms. */
  warmupMs: number;
  /** Minimum mitata samples per block (a sample is one call, or a batch of calls for fast work). */
  minSamples: number;
  /** A case whose block cv exceeds this is flagged `unstable`. */
  maxCv: number;
  /** Repetitions of a non-deterministic metric. */
  metricRepeats: number;
};

export type ProgressEvent =
  | { type: 'check'; group: string }
  | { type: 'measure'; group: string; case: string; block: number; blocks: number }
  | { type: 'done'; group: string };

// ---------------------------------------------------------------------------
// Result: what a run produces (schema 1)
// ---------------------------------------------------------------------------

export type Interval = readonly [low: number, high: number];

export type Summary = {
  /** Point estimate: total time / total operations, in ns/op (or the metric's unit). */
  estimate: number;
  /** 95% interval of the estimate, from the resampling design (processes → blocks). */
  interval: Interval;
  median: number;
  min: number;
  max: number;
  p75: number;
  p99: number;
  /** Coefficient of variation across blocks. */
  cv: number;
  /** Number of timed blocks behind the estimate. */
  n: number;
};

/** Ratio = case / baseline (lower is better for every kind: time, bytes, metric). */
export type Comparison = {
  case: string;
  ratio: number;
  interval: Interval;
  /**
   * lower/higher: the whole interval lies beyond the practical-equivalence
   * band; tie: the whole interval lies inside it; else inconclusive. Reports
   * word it per kind: faster/slower, smaller/larger, lower/higher.
   */
  verdict: 'lower' | 'higher' | 'tie' | 'inconclusive';
};

export type CaseRole = 'baseline' | 'competitor' | 'variant' | 'differs';

export type Flag =
  | 'optimized-out' // within noise of the empty-function floor
  | 'unstable' // cv above the profile's limit
  | 'over-limit'; // size above its budget

/**
 * One timed block: `ns` spent on `ops` operations in process `process`.
 * Metric groups reuse it for raw observations: one block per collected value,
 * `ns` holding the value in the group's unit and `ops` = 1.
 */
export type Block = { process: number; block: number; ns: number; ops: number };

export type CaseResult = {
  key: string;
  label: string;
  package?: string;
  role: CaseRole;
  differs?: string;
  /**
   * Hash of what changes this case's measured work only: group kind, contract
   * id, mode, inputs, unit, externals, and the case's own key, source/ext,
   * differs and variant. Labels, titles, notes, packages, limits and other
   * cases do not affect it. `compareRuns` matches base and head cases by it.
   */
  workHash?: string;
  summary: Summary;
  /** Raw timed blocks (speed groups) or observations (metric groups, `ops` = 1). Omitted with --no-samples. */
  blocks?: readonly Block[];
  /** mitata GC / heap diagnostics when the runtime exposes them. */
  gc?: { total: number; avg: number };
  heap?: { avg: number };
  /** Size groups: bytes. */
  size?: {
    raw: number;
    gzip: number;
    brotli: number;
    files: readonly { path: string; raw: number; gzip: number; brotli: number }[];
    /** Largest input modules by minified bytes in the output (from the bundler's metafile), biggest first. */
    contributors?: readonly { path: string; bytes: number }[];
  };
  limit?: number;
  flags: readonly Flag[];
};

export type ContractCheck = {
  status: 'passed' | 'failed';
  /** How many inputs were checked. */
  inputs: number;
  failures: readonly { case: string; input: number; expected: string; actual: string }[];
};

export type GroupResult = {
  kind: 'compare' | 'scenario' | 'size' | 'metric';
  id: string;
  title: string;
  note?: string;
  unit: string;
  contract?: { id: string; description: string };
  /**
   * Stable hash of this group's full definition (`specHash` of a suite holding
   * only this group). `compareRuns` falls back to it when cases carry no
   * `workHash`, and to the suite hash when groups carry none.
   */
  specHash?: string;
  /** Metric groups: the spec's `deterministic` (collected once, interval [v, v]). */
  deterministic?: boolean;
  check?: ContractCheck;
  baseline?: string;
  /** Speed groups: the empty-function floor (harness overhead per op), measured like a case. */
  floor?: Summary;
  /** Speed groups: the floor's raw blocks, so a host can merge floors across processes. Omitted with --no-samples. */
  floorBlocks?: readonly Block[];
  cases: readonly CaseResult[];
  comparisons: readonly Comparison[];
  /**
   * Problems found while measuring this group (e.g. a size group whose bundler
   * is missing). Hosts copy them into `BenchResult.warnings`.
   */
  warnings?: readonly Warning[];
};

export type Warning = {
  code: string;
  message: string;
  group?: string;
  case?: string;
  /** Runtime-matrix runs: the runtime the warning comes from. */
  runtime?: Environment['runtime']['name'];
};

export type Environment = {
  runtime: { name: 'node' | 'bun' | 'deno' | 'browser' | 'hermes' | 'unknown'; version: string };
  os?: string;
  arch?: string;
  cpu?: string;
  cores?: number;
  /** Runtime flags, e.g. --expose-gc. */
  flags: readonly string[];
  harness: { version: string; mitata: string };
  git?: { revision: string; dirty: boolean };
  /** 1-minute load average at start and end, when the host can read it. */
  load?: readonly [start: number, end: number];
  date: string;
};

export type BenchResult = {
  schema: 1;
  suite: { id: string; title: string; intro?: string; notes: readonly string[]; specHash: string };
  profile: Profile;
  seed: number;
  /** True only for a clean publish run: no blocking warning (see `BLOCKING_WARNINGS`). `warnings` says why not. */
  publishable: boolean;
  warnings: readonly Warning[];
  environment: Environment;
  /** Installed versions of every package named by a case, plus the harness. */
  packages: Readonly<Record<string, string>>;
  groups: readonly GroupResult[];
  /** Runtime matrix: one result per runtime, merged by the host. */
  runtimes?: readonly BenchResult[];
};

/** Comparing two results (CI): per case, with compatibility checks. */
export type RunComparison = {
  /** fail when a row regressed (a size over budget counts) or a head contract check failed. */
  status: 'pass' | 'fail';
  threshold: number;
  /** Problems that do not fail the comparison but weaken it (e.g. a base run that is not publishable). */
  warnings: readonly string[];
  rows: readonly {
    group: string;
    case: string;
    base?: number;
    head?: number;
    /** The group's unit (e.g. 'ns', 'B'), so reports can format base and head. */
    unit?: string;
    ratio?: number;
    interval?: Interval;
    status:
      'regressed' | 'improved' | 'within' | 'inconclusive' | 'incompatible' | 'added' | 'removed' | 'contract-failed';
    reason?: string;
  }[];
};

/**
 * A row where another way of doing the work costs less than the suite's own
 * library: a `lower` comparison in a group whose baseline is the suite's
 * library (see `collectLosses`).
 */
export type Loss = {
  /** The suite id of the result it came from. */
  suite: string;
  /** The runtime it was measured on (each runtime of a matrix separately). */
  runtime: Environment['runtime']['name'];
  group: { id: string; title: string; kind: GroupResult['kind'] };
  /** Label of the baseline row: the suite's own library. */
  baseline: string;
  /** The row that costs less. */
  case: { key: string; label: string };
  /** `competitor`: a rival is cheaper. `variant`: another way to call our own library is cheaper. */
  role: 'competitor' | 'variant';
  /** The baseline is `factor`× the other row (time, bytes or the metric): 1 / the comparison's ratio, > 1. */
  factor: number;
  /** 95% interval of `factor`; [factor, factor] for exact comparisons (sizes, deterministic metrics). */
  interval: Interval;
  /** Whether the result it came from was publishable. */
  publishable: boolean;
  /** Why that result is not publishable, in words (`quick profile`, `busy machine`); empty when it is. */
  rough: readonly string[];
};
