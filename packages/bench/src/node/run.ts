/**
 * Runs a benchmark file: the Node host around the portable engine.
 *
 * - `processes` fresh worker processes run one after another (never in
 *   parallel: they would compete for the CPU) and their blocks are merged into
 *   one result, in every profile. Default: 5 for `publish`, 1 otherwise.
 * - One process for `quick` / `explore` runs in this process (or in one child
 *   when Node needs a flag to load a TypeScript suite — the parent is never
 *   changed). `publish` always uses fresh processes.
 * - `runtimes` runs the same file under Node, Bun and Deno and keeps one
 *   result per runtime.
 *
 * Paths resolve from the suite's package root (nearest package.json), not
 * from wherever the command was started.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';

import type {
  BenchResult,
  Block,
  CaseResult,
  GroupResult,
  Profile,
  ProgressEvent,
  RunOptions,
  SuiteSpec,
  Warning,
} from '../core/types.js';
import { assessResult, metricComparisons, runSuite } from '../core/engine.js';
import { validateSuite } from '../core/spec.js';
import { compareBlocks, summarize, summarizeValues } from '../core/stats.js';
import { findDeclaredNode, withNodeVersionCheck } from './node-version.js';
import { applyLoadCheck, collectProvenance, currentLoad } from './provenance.js';
import { parseResult } from './result-schema.js';
import { createSizeRunner } from './size.js';
import { registerTypeScriptResolver } from './ts-resolver.js';

export type Runtime = 'node' | 'bun' | 'deno';

export type RunFileOptions = RunOptions & {
  /** Fresh processes, in any profile. Default 5 for publish, 1 otherwise. */
  processes?: number;
  /** Run the file under each of these runtimes; results land in `result.runtimes`. */
  runtimes?: readonly Runtime[];
  /**
   * The Node binary for the Node leg (a path or a command name). Default: the
   * Node running this code, or `node` from `PATH` when this code runs on
   * another runtime.
   */
  node?: string;
  /** Directory a relative `file` is resolved from. Default: the current directory. */
  cwd?: string;
  /** Keep raw blocks in the result. Default true. */
  samples?: boolean;
};

const DEFAULT_PUBLISH_PROCESSES = 5;

// ---------------------------------------------------------------------------
// Worker protocol (shared with ./worker.ts)
// ---------------------------------------------------------------------------

/**
 * @internal Line prefixes a worker uses so output printed by the suite
 * itself can never be mistaken for its progress, result or error.
 */
export const PROTOCOL = {
  progress: '@arki/bench:progress ',
  result: '@arki/bench:result ',
  error: '@arki/bench:error ',
} as const;

type WorkerOptions = {
  profile?: Profile;
  filter?: string | { source: string; flags: string };
  seed?: number;
  timeoutMs?: number;
  process?: number;
  budget?: RunOptions['budget'];
};

/** @internal What the host sends a worker: the suite file, its package root and serializable run options. */
export type WorkerRequest = { file: string; root: string; options: WorkerOptions };

const PROFILES = new Set<string>(['quick', 'explore', 'publish']);

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

function isBudget(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'object' && value !== null && Object.values(value).every(item => typeof item === 'number'))
  );
}

/** @internal */
export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (typeof value !== 'object' || value === null) return false;
  if (!('file' in value) || typeof value.file !== 'string' || !('root' in value) || typeof value.root !== 'string') {
    return false;
  }
  if (!('options' in value) || typeof value.options !== 'object' || value.options === null) return false;
  const { options } = value;
  const profile = 'profile' in options ? options.profile : undefined;
  const filter = 'filter' in options ? options.filter : undefined;
  return (
    (profile === undefined || (typeof profile === 'string' && PROFILES.has(profile))) &&
    (filter === undefined ||
      typeof filter === 'string' ||
      (typeof filter === 'object' &&
        filter !== null &&
        'source' in filter &&
        typeof filter.source === 'string' &&
        'flags' in filter &&
        typeof filter.flags === 'string')) &&
    isOptionalNumber('seed' in options ? options.seed : undefined) &&
    isOptionalNumber('timeoutMs' in options ? options.timeoutMs : undefined) &&
    isOptionalNumber('process' in options ? options.process : undefined) &&
    isBudget('budget' in options ? options.budget : undefined)
  );
}

function toWorkerOptions(options: RunOptions): WorkerOptions {
  const { filter } = options;
  return {
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(filter === undefined
      ? {}
      : { filter: typeof filter === 'string' ? filter : { source: filter.source, flags: filter.flags } }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.process === undefined ? {} : { process: options.process }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  };
}

/** @internal Rebuilds run options inside a worker. */
export function toRunOptions(options: WorkerOptions): RunOptions {
  const { filter, ...rest } = options;
  if (filter === undefined) return rest;
  return { ...rest, filter: typeof filter === 'string' ? filter : new RegExp(filter.source, filter.flags) };
}

function isProgressEvent(value: unknown): value is ProgressEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value.type === 'check' || value.type === 'measure' || value.type === 'done') &&
    'group' in value &&
    typeof value.group === 'string'
  );
}

// ---------------------------------------------------------------------------
// Loading and measuring in this process
// ---------------------------------------------------------------------------

/** Nearest directory at or above `file` that holds a package.json. */
export function findPackageRoot(file: string): string {
  for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    if (path.dirname(dir) === dir) return path.dirname(path.resolve(file));
  }
}

function isSuiteLike(value: unknown): value is SuiteSpec {
  return typeof value === 'object' && value !== null && 'groups' in value && Array.isArray(value.groups);
}

/**
 * @internal Imports a suite file and checks its default export is a valid
 * suite. Under Node it first registers the `.js` → `.ts` resolver, so the
 * worker and the CLI's `check` / `list` load suites the same way.
 */
export async function loadSuite(file: string): Promise<SuiteSpec> {
  registerTypeScriptResolver();
  const module: unknown = await import(pathToFileURL(file).href);
  const suite = typeof module === 'object' && module !== null && 'default' in module ? module.default : undefined;
  if (!isSuiteLike(suite)) {
    throw new Error(
      `${file} does not export a suite. Make its default export a suite: \`export default defineSuite({ id, groups: [...] })\`.`,
    );
  }
  validateSuite(suite);
  return suite;
}

function dedupeWarnings(warnings: readonly Warning[]): Warning[] {
  const seen = new Set<string>();
  return warnings.filter(warning => {
    // One warning per problem and place: each process words its own numbers (load, cv), so the message is not the key.
    const key = JSON.stringify([warning.code, warning.group, warning.case]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @internal Loads and runs a suite in the current process, then records
 * provenance (this process is the one that measured). Used for in-process
 * runs and by every worker.
 */
export async function measureInThisProcess(file: string, root: string, options: RunOptions): Promise<BenchResult> {
  const suite = await loadSuite(file);
  const start = currentLoad();
  const result = await runSuite(suite, {
    ...options,
    sizeRunner: options.sizeRunner ?? createSizeRunner({ cwd: root }),
  });
  const end = currentLoad();
  const withLoad =
    start === undefined || end === undefined
      ? result
      : { ...result, environment: { ...result.environment, load: [start, end] as const } };
  return collectProvenance(withLoad, { cwd: root });
}

// ---------------------------------------------------------------------------
// Worker processes
// ---------------------------------------------------------------------------

/** @internal The runtime executing this code. */
export function currentRuntime(): Runtime {
  if (typeof process.versions.bun === 'string') return 'bun';
  if (typeof process.versions.deno === 'string') return 'deno';
  return 'node';
}

const TYPESCRIPT = /\.(?:[cm]?ts|tsx)$/;

function isTypeScript(file: string): boolean {
  return TYPESCRIPT.test(file);
}

/** The worker next to this module: compiled `.js` in dist, `.ts` when running from source. */
function workerPath(): string {
  const js = fileURLToPath(new URL('worker.js', import.meta.url));
  if (existsSync(js)) return js;
  return fileURLToPath(new URL('worker.ts', import.meta.url));
}

/** Node flags that change what is measured, carried over to Node workers. */
const FORWARDED_NODE_FLAG =
  /^--(?:expose[-_]gc|allow[-_]natives[-_]syntax|max[-_]old[-_]space[-_]size=|max[-_]semi[-_]space[-_]size=|stack[-_]size=|jitless|no[-_]opt|predictable)/;

const STRIP_TYPES = '--experimental-strip-types';

function assertNodeCanStripTypes(file: string): void {
  if (currentRuntime() === 'node' && !process.allowedNodeEnvironmentFlags.has(STRIP_TYPES)) {
    throw new Error(
      `Node ${process.version} cannot load the TypeScript suite ${file}: it lacks ${STRIP_TYPES} (Node 22.6 or later). ` +
        'Fix it one of these ways: upgrade Node to 22.6+, run with Bun (`bun x arki-bench …`) or Deno, or compile the suite to JavaScript.',
    );
  }
}

/** @internal The program that starts a worker: the chosen Node binary for Node, else this process or `PATH`. */
export function workerExecutable(runtime: Runtime, node?: string): string {
  if (runtime === 'node' && node !== undefined) return node;
  return runtime === currentRuntime() ? process.execPath : runtime;
}

function workerCommand(runtime: Runtime, suite: string, node?: string): [string, string[]] {
  const worker = workerPath();
  const executable = workerExecutable(runtime, node);
  switch (runtime) {
    case 'node': {
      const flags = executable === process.execPath ? process.execArgv.filter(flag => FORWARDED_NODE_FLAG.test(flag)) : [];
      if (isTypeScript(suite) || isTypeScript(worker)) {
        assertNodeCanStripTypes(suite);
        flags.push(STRIP_TYPES, '--disable-warning=ExperimentalWarning');
      }
      return [executable, [...flags, worker]];
    }
    case 'bun': {
      return [executable, [worker]];
    }
    case 'deno': {
      // --sloppy-imports: TypeScript sources import siblings as './x.js'.
      // --no-config --node-modules-dir=manual: resolve packages from the installed node_modules (what the
      // suite compares) instead of auto-discovering a workspace, which reads every member's tsconfig and
      // rejects options Deno does not know (e.g. React Native's `jsx: react-native`).
      return [executable, ['run', '-A', '--sloppy-imports', '--no-config', '--node-modules-dir=manual', worker]];
    }
  }
}

function eachLine(stream: Readable, onLine: (line: string) => void): void {
  createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY }).on('line', onLine);
}

type WorkerFailure = { message: string; problems?: readonly string[] };

function parseFailure(json: string): WorkerFailure {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string') {
      const problems =
        'problems' in value && Array.isArray(value.problems)
          ? value.problems.filter((item): item is string => typeof item === 'string')
          : undefined;
      return { message: value.message, ...(problems === undefined ? {} : { problems }) };
    }
  } catch {
    // Fall through to the raw text.
  }
  return { message: json };
}

/** Runs one worker process and resolves with the result it prints. Its other output goes to stderr. */
function runWorker(
  runtime: Runtime,
  request: WorkerRequest,
  node: string | undefined,
  onProgress?: (event: ProgressEvent) => void,
): Promise<BenchResult> {
  const [command, args] = workerCommand(runtime, request.file, node);
  const label = `Benchmark worker (${runtime}, process ${String(request.options.process ?? 0)})`;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args, JSON.stringify(request)], {
      cwd: request.root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let result: BenchResult | undefined;
    let failure: WorkerFailure | undefined;
    const tail: string[] = [];
    const forward = (line: string): void => {
      process.stderr.write(`${line}\n`);
      tail.push(line);
      if (tail.length > 30) tail.shift();
    };

    eachLine(child.stdout, line => {
      if (line.startsWith(PROTOCOL.result)) {
        try {
          const parsed: unknown = JSON.parse(line.slice(PROTOCOL.result.length));
          result = parseResult(parsed, 'the worker result');
        } catch (error) {
          failure = {
            message: `printed a result that cannot be read: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      } else if (line.startsWith(PROTOCOL.error)) {
        failure = parseFailure(line.slice(PROTOCOL.error.length));
      } else {
        forward(line);
      }
    });
    eachLine(child.stderr, line => {
      if (!line.startsWith(PROTOCOL.progress)) {
        forward(line);
        return;
      }
      try {
        const event: unknown = JSON.parse(line.slice(PROTOCOL.progress.length));
        if (isProgressEvent(event)) onProgress?.(event);
      } catch {
        // A garbled progress line is not worth failing the run.
      }
    });

    child.on('error', reject);
    child.on('close', code => {
      if (failure) {
        const { message, problems: listed = [] } = failure;
        // A SpecError's message already lists its problems; append only the ones it does not contain.
        const problems = listed
          .filter(problem => !message.includes(problem))
          .map(problem => `\n  - ${problem}`)
          .join('');
        const error = new Error(`${label} failed: ${message}${problems}`);
        // Named so the CLI prints it as a clean message instead of a stack trace.
        error.name = 'BenchRunError';
        reject(error);
      } else if (code === 0 && result) {
        resolvePromise(result);
      } else {
        const output = tail.length > 0 ? `\n${tail.join('\n')}` : '';
        reject(new Error(`${label} exited with code ${String(code)} without a result.${output}`));
      }
    });
  });
}

async function runProcesses(
  runtime: Runtime,
  count: number,
  file: string,
  root: string,
  options: RunOptions,
  node?: string,
): Promise<BenchResult> {
  const results: BenchResult[] = [];
  // Sequential on purpose: concurrent processes compete for CPU and corrupt each other's timings.
  // All processes share the seed; the engine mixes the process index into block order.
  for (let index = 0; index < count; index++) {
    const request: WorkerRequest = { file, root, options: toWorkerOptions({ ...options, process: index }) };
    results.push(await runWorker(runtime, request, node, options.onProgress));
  }
  return mergeProcessResults(results, options.budget?.maxCv === undefined ? {} : { maxCv: options.budget.maxCv });
}

// ---------------------------------------------------------------------------
// Merging processes
// ---------------------------------------------------------------------------

/** All peers' blocks of one case (or the floor), each tagged with the index of the process that measured it. */
function mergedBlocks(peers: readonly (readonly Block[] | undefined)[]): Block[] {
  return peers.flatMap((blocks, index) => (blocks ?? []).map(block => ({ ...block, process: index })));
}

function mergeGroup(group: GroupResult, peers: readonly (GroupResult | undefined)[], seed: number): GroupResult {
  const failedCheck = peers.find(peer => peer?.check?.status === 'failed')?.check;
  const withCheck = failedCheck ? { ...group, check: failedCheck } : group;
  // Sizes are exact (bundling is deterministic): the first process's numbers stand.
  if (group.kind === 'size' || peers.includes(undefined)) return withCheck;

  // Flags are left to assessResult, which recomputes them from the merged data.
  const cases: CaseResult[] = group.cases.map(item => {
    const blocks = mergedBlocks(peers.map(peer => peer?.cases.find(other => other.key === item.key)?.blocks));
    if (blocks.length === 0) return item;
    const summary =
      group.kind === 'metric'
        ? summarizeValues(
            blocks.map(block => block.ns),
            { seed },
          )
        : summarize(blocks, { seed });
    return { ...item, blocks, summary };
  });

  if (group.kind === 'metric') {
    return { ...withCheck, cases, comparisons: metricComparisons({ ...group, cases }, seed) };
  }

  const floorBlocks = mergedBlocks(peers.map(peer => peer?.floorBlocks));
  const floor = floorBlocks.length > 0 ? { floorBlocks, floor: summarize(floorBlocks, { seed }) } : {};
  const blocksByKey = new Map(cases.map(item => [item.key, item.blocks]));
  const baseline = group.baseline === undefined ? undefined : blocksByKey.get(group.baseline);
  const comparisons = group.comparisons.map(comparison => {
    const other = blocksByKey.get(comparison.case);
    if (!baseline || baseline.length === 0 || !other || other.length === 0) return comparison;
    return { case: comparison.case, ...compareBlocks(baseline, other, { seed }) };
  });

  return { ...withCheck, ...floor, cases, comparisons };
}

/**
 * @internal Merges the results of several worker processes (same suite,
 * same runtime) into one: each case's blocks (speed) or observations
 * (metric), and each group's floor blocks, are concatenated and tagged with
 * the worker's process index; every summary and comparison is recomputed
 * from all of them. Then `assessResult` derives flags, warnings and
 * `publishable` from the merged data with the same rules as the engine.
 */
export function mergeProcessResults(results: readonly BenchResult[], options: { maxCv?: number } = {}): BenchResult {
  const [first] = results;
  const last = results.at(-1);
  if (!first || !last) throw new Error('mergeProcessResults needs at least one result.');
  if (results.length === 1) return first;

  const groups = first.groups.map(group =>
    mergeGroup(
      group,
      results.map(result => result.groups.find(other => other.id === group.id)),
      first.seed,
    ),
  );
  const startLoad = first.environment.load?.[0];
  const endLoad = last.environment.load?.[1];
  const load = startLoad === undefined || endLoad === undefined ? undefined : ([startLoad, endLoad] as const);
  const { load: _ignored, ...environment } = first.environment;

  return assessResult(
    applyLoadCheck({
      ...first,
      groups,
      warnings: dedupeWarnings(results.flatMap(result => result.warnings)),
      environment: load === undefined ? environment : { ...environment, load },
    }),
    options,
  );
}

/**
 * @internal The result of a runtime matrix: the first runtime's result at the
 * top level, every runtime's in `runtimes`. Publishable only when every
 * runtime is and none is missing; `warnings` is the union, each tagged with
 * the runtime it comes from.
 */
export function combineRuntimes(results: readonly BenchResult[], missing: readonly Warning[]): BenchResult {
  const [first] = results;
  if (!first) throw new Error('combineRuntimes needs at least one result.');
  const warnings = [
    ...results.flatMap(item => item.warnings.map(warning => ({ ...warning, runtime: item.environment.runtime.name }))),
    ...missing,
  ];
  return {
    ...first,
    warnings,
    publishable: missing.length === 0 && results.every(item => item.publishable),
    runtimes: results,
  };
}

function withoutSamples(result: BenchResult): BenchResult {
  return {
    ...result,
    groups: result.groups.map(({ floorBlocks: _floorBlocks, ...group }) => ({
      ...group,
      cases: group.cases.map(({ blocks: _blocks, ...item }) => item),
    })),
    ...(result.runtimes === undefined ? {} : { runtimes: result.runtimes.map(item => withoutSamples(item)) }),
  };
}

// ---------------------------------------------------------------------------
// runFile
// ---------------------------------------------------------------------------

function isInstalled(runtime: Runtime, node?: string): boolean {
  const executable = workerExecutable(runtime, node);
  if (executable === process.execPath) return true;
  const probe = spawnSync(executable, ['--version'], { stdio: 'ignore', timeout: 15_000 });
  return probe.error === undefined;
}

/**
 * Runs the suite exported by `file` and returns its result (it prints
 * nothing itself; progress goes to `onProgress`). See the module comment
 * for how profiles map to processes.
 */
export async function runFile(file: string, options: RunFileOptions = {}): Promise<BenchResult> {
  const publish = options.profile === 'publish';
  const {
    processes = publish ? DEFAULT_PUBLISH_PROCESSES : 1,
    runtimes,
    node,
    cwd = process.cwd(),
    samples = true,
    ...runOptions
  } = options;
  if (!Number.isInteger(processes) || processes < 1) {
    throw new RangeError(`processes must be a whole number of at least 1, got ${String(processes)}.`);
  }
  const suitePath = path.resolve(cwd, file);
  if (!existsSync(suitePath)) throw new Error(`Benchmark file not found: ${suitePath}`);
  const root = findPackageRoot(suitePath);

  const count = processes;

  const declaredNode = findDeclaredNode(suitePath);

  let result: BenchResult;
  if (runtimes !== undefined && runtimes.length > 0) {
    const results: BenchResult[] = [];
    const missing: Warning[] = [];
    for (const runtime of new Set(runtimes)) {
      if (!isInstalled(runtime, node)) {
        missing.push({
          code: 'runtime-missing',
          runtime,
          message:
            runtime === 'node' && node !== undefined
              ? `Node binary "${node}" was not found, so the suite did not run under it.`
              : `${runtime} is not installed (not found on PATH), so the suite did not run under it.`,
        });
        continue;
      }
      results.push(await runProcesses(runtime, count, suitePath, root, runOptions, node));
    }
    if (results.length === 0) {
      throw new Error(`None of the requested runtimes is installed: ${[...new Set(runtimes)].join(', ')}.`);
    }
    result = combineRuntimes(
      results.map(item => withNodeVersionCheck(item, declaredNode)),
      missing,
    );
  } else if (
    publish ||
    count > 1 ||
    (currentRuntime() === 'node' && (isTypeScript(suitePath) || (node !== undefined && node !== process.execPath)))
  ) {
    // Node loads TypeScript only with a flag, and another Node binary is another process: run a child instead of changing this one.
    result = withNodeVersionCheck(
      await runProcesses(currentRuntime(), count, suitePath, root, runOptions, node),
      declaredNode,
    );
  } else {
    result = withNodeVersionCheck(await measureInThisProcess(suitePath, root, runOptions), declaredNode);
  }

  return samples ? result : withoutSamples(result);
}
