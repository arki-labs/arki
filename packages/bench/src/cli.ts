#!/usr/bin/env node
/**
 * `arki-bench` — run suites, render saved results, compare runs in CI, keep
 * the README section honest. Data goes to stdout, progress and diagnostics to
 * stderr. Exit codes: 0 ok, 1 a check failed, 2 the command line is wrong.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BenchResult, Profile, RunOptions, SuiteSpec } from './core/types.js';
import { collectLosses } from './core/losses.js';
import { formatTime } from './core/report/format.js';
import { renderComparison, renderLosses, renderMarkdown, renderText } from './core/report/index.js';
import { specHash } from './core/spec.js';
import { compareRuns } from './core/stats.js';
import { checkReadme, readReadmeMeta, writeReadme } from './node/readme.js';
import { parseResult, ResultError } from './node/result-schema.js';

// ---------------------------------------------------------------------------
// Command-line grammar
// ---------------------------------------------------------------------------

type FlagSpec = {
  description: string;
  /** Absent: a boolean switch. Present: the flag takes a value shown as `<value>`. */
  value?: string;
  /** Allowed values, checked with a "did you mean" suggestion. */
  values?: readonly string[];
  /** The value may be left out (`--write-readme` alone means the package README). */
  optional?: boolean;
};

type CommandName = 'run' | 'report' | 'compare' | 'losses' | 'check' | 'list' | 'doctor';

type CommandSpec = {
  usage: string;
  summary: string;
  flags: Readonly<Record<string, FlagSpec>>;
  examples: readonly string[];
};

const PROFILES = ['quick', 'explore', 'publish'] as const satisfies readonly Profile[];
const RUNTIMES = ['node', 'bun', 'deno'] as const;
type RuntimeName = (typeof RUNTIMES)[number];

const NO_COLOR: FlagSpec = { description: 'Plain output even on a terminal (NO_COLOR is honoured too).' };

const COMMANDS: Readonly<Record<CommandName, CommandSpec>> = {
  run: {
    usage: 'arki-bench [run] [files…] [options]',
    summary: 'Run suites. Without files, runs bench/**/*.bench.{ts,mts,js,mjs} under the nearest package root.',
    flags: {
      profile: {
        value: 'name',
        values: PROFILES,
        description:
          'quick (smoke, never publishable) · explore (default) · publish (several processes, for READMEs and CI).',
      },
      filter: { value: 'group[/case]', description: 'Only groups or cases whose id contains this text.' },
      seed: { value: 'n', description: 'Seed for block order and resampling (recorded in the result).' },
      processes: {
        value: 'n',
        description: 'Fresh processes per suite, in any profile. Default 5 for publish, 1 otherwise.',
      },
      runtime: { value: 'list', description: 'Comma-separated runtimes for a runtime matrix: node,bun,deno.' },
      node: {
        value: 'path',
        description:
          'Node binary for the Node leg (or set ARKI_BENCH_NODE). Default: the Node running arki-bench. A result on a Node the project does not target (.nvmrc, .node-version, volta, engines.node) is not publishable.',
      },
      timeout: { value: 'ms', description: 'Per-call timeout for async cases. Default 10000.' },
      out: {
        value: 'file',
        description: 'Also write the result JSON here (it is always saved to .bench/<suite>.json).',
      },
      json: { description: 'Print the results as a JSON array (one entry per suite) instead of the table.' },
      markdown: { description: 'Print the README section instead of the table.' },
      'write-readme': {
        value: 'README.md',
        optional: true,
        description:
          'Replace the section between <!-- bench:start --> and <!-- bench:end -->. Refuses non-publishable results.',
      },
      reproduce: { value: 'text', description: 'The reproduce line under the README tables (Markdown).' },
      force: { description: 'Write the README even when the result is not publishable (the warning banner stays).' },
      ci: { description: 'Exit 1 on a failed contract, a size over budget, or a publish run that is not publishable.' },
      'no-samples': { description: 'Leave raw blocks out of the result JSON.' },
      'no-color': NO_COLOR,
    },
    examples: [
      'arki-bench                                     # explore every suite, print tables',
      'arki-bench bench/money.bench.ts --filter round # one file, one group',
      'arki-bench --profile publish --write-readme    # measure and update README.md',
      'arki-bench --profile publish --runtime node,bun --ci',
    ],
  },
  report: {
    usage: 'arki-bench report <result.json> [options]',
    summary: 'Render a saved result. Rendering is deterministic: the same JSON always gives the same table.',
    flags: {
      format: {
        value: 'format',
        values: ['text', 'markdown', 'json'],
        description: 'text (default) · markdown · json.',
      },
      write: { value: 'README.md', description: 'Replace the marked README section with this result.' },
      reproduce: { value: 'text', description: 'The reproduce line under the README tables (Markdown).' },
      force: { description: 'Write the README even when the result is not publishable.' },
      'no-color': NO_COLOR,
    },
    examples: ['arki-bench report .bench/money.json', 'arki-bench report .bench/money.json --write README.md'],
  },
  compare: {
    usage: 'arki-bench compare <base.json> <head.json> [options]',
    summary: 'Compare two runs case by case. Run base and head on the same machine, one after the other.',
    flags: {
      threshold: {
        value: 'percent',
        description: 'Smallest change that counts as a regression, e.g. 5% or 0.05. Default 5%.',
      },
      format: {
        value: 'format',
        values: ['text', 'markdown'],
        description: 'text (default) · markdown (for a PR comment).',
      },
      ci: { description: 'Exit 1 when any case regressed beyond the threshold.' },
    },
    examples: [
      'arki-bench compare .bench/base.json .bench/head.json --ci',
      'arki-bench compare base.json head.json --threshold 3% --format markdown',
    ],
  },
  losses: {
    usage: 'arki-bench losses [results or directories…] [options]',
    summary:
      'List where our library is slower, larger or higher than another row, across saved results. Without arguments, reads .bench/*.json in the package root; a directory is searched for **/.bench/*.json (node_modules and hidden directories skipped).',
    flags: {
      markdown: { description: 'Print Markdown (for an issue or a PR) instead of the table.' },
      json: { description: 'Print the losses as JSON.' },
      ci: {
        description:
          'Exit 1 when a listed loss comes from a publishable result. Rough (not publishable) results are listed but never fail.',
      },
      'no-variants': {
        description: 'Hide variant losses (another way to call our own library is cheaper). Listed by default.',
      },
    },
    examples: [
      'arki-bench losses                       # this package',
      'arki-bench losses .                     # every package under this directory',
      'arki-bench losses packages --markdown   # for an issue',
      'arki-bench losses .bench/money.json --ci',
    ],
  },
  check: {
    usage: 'arki-bench check [README.md]',
    summary:
      'Exit 1 when the README section is missing or was generated from a different version of the suite. Imports the suites; measures nothing.',
    flags: {},
    examples: ['arki-bench check', 'arki-bench check docs/benchmarks.md'],
  },
  list: {
    usage: 'arki-bench list [files…] [options]',
    summary: 'Show suites, groups, cases and contracts without running anything.',
    flags: { json: { description: 'Print the listing as JSON.' } },
    examples: ['arki-bench list'],
  },
  doctor: {
    usage: 'arki-bench doctor',
    summary: 'Check this machine before measuring: runtime, timer resolution, GC, CPU, load, other runtimes.',
    flags: {},
    examples: ['arki-bench doctor'],
  },
};

const COMMAND_NAMES: readonly string[] = Object.keys(COMMANDS);

const isCommand = (name: string): name is CommandName => COMMAND_NAMES.includes(name);

export class UsageError extends Error {
  override name = 'UsageError';
}

/** A failure the user can act on; printed without a stack trace. */
class CommandError extends Error {
  override name = 'CommandError';
}

export type ParsedArgs = {
  command: CommandName;
  positionals: readonly string[];
  flags: ReadonlyMap<string, string | true>;
  help: boolean;
  version: boolean;
};

function distance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(above + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length] ?? 0;
}

/** The closest known name, if it is close enough to be a typo. */
export function suggest(input: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const score = candidate.startsWith(input) && input.length >= 3 ? 0.5 : distance(input, candidate);
    if (score < bestDistance) {
      best = candidate;
      bestDistance = score;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

const looksLikeFile = (arg: string): boolean => /[./\\]/.test(arg);

/** A suite file name (`*.bench.*`): never taken as the value of an optional flag. */
const SUITE_NAME = /\.bench\.[^./\\]+$/;

/**
 * Parses `argv` (without the node and script paths). Rejects unknown commands,
 * flags and values with a suggestion; never reads process state.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  let command: CommandName = 'run';
  const first = args[0];
  if (first !== undefined && !first.startsWith('-')) {
    if (isCommand(first)) {
      command = first;
      args.shift();
    } else if (!looksLikeFile(first)) {
      const hint = suggest(first, COMMAND_NAMES);
      throw new UsageError(
        `Unknown command "${first}".${hint ? ` Did you mean "${hint}"?` : ''} Commands: ${COMMAND_NAMES.join(', ')}.`,
      );
    }
  }
  const spec = COMMANDS[command];
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let help = false;
  let version = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      version = true;
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    if (!arg.startsWith('--'))
      throw new UsageError(
        `Unknown option ${arg}. Options are spelled with two dashes; run arki-bench ${command} --help.`,
      );
    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const flag = spec.flags[name];
    if (!flag) {
      const hint = suggest(name, Object.keys(spec.flags));
      throw new UsageError(
        `Unknown option --${name} for "arki-bench ${command}".${hint ? ` Did you mean --${hint}?` : ''} Run arki-bench ${command} --help for the options.`,
      );
    }
    if (flag.value === undefined) {
      if (inline !== undefined) throw new UsageError(`--${name} is a switch and takes no value.`);
      flags.set(name, true);
      continue;
    }
    let value: string | true | undefined = inline;
    if (value === undefined) {
      const next = args[index + 1];
      // An optional value (`--write-readme [path]`) takes any next word except an option or a suite file.
      const takesNext = next !== undefined && !next.startsWith('-') && (!flag.optional || !SUITE_NAME.test(next));
      if (takesNext) {
        value = next;
        index++;
      } else if (flag.optional) {
        value = true;
      } else {
        throw new UsageError(`--${name} needs a value: --${name} <${flag.value}>.`);
      }
    }
    if (typeof value === 'string' && flag.values && !flag.values.includes(value)) {
      const hint = suggest(value, flag.values);
      throw new UsageError(
        `--${name} must be one of ${flag.values.join(', ')}; got "${value}".${hint ? ` Did you mean ${hint}?` : ''}`,
      );
    }
    flags.set(name, value);
  }
  return { command, positionals, flags, help, version };
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

const has = (args: ParsedArgs, name: string): boolean => args.flags.has(name);

function integerFlag(args: ParsedArgs, name: string, minimum: number): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum)
    throw new UsageError(`--${name} must be a whole number ≥ ${minimum}; got "${raw}".`);
  return value;
}

/** `5%` → 0.05; `0.05` → 0.05. A bare number ≥ 1 is ambiguous and rejected. */
export function parseThreshold(raw: string): number {
  const percent = raw.endsWith('%');
  const value = Number(percent ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new UsageError(`--threshold must be positive, e.g. 5% or 0.05; got "${raw}".`);
  if (percent) return value / 100;
  if (value >= 1) throw new UsageError(`--threshold ${raw} is ambiguous; write ${raw}% or ${value / 100}.`);
  return value;
}

function parseRuntimes(raw: string): readonly RuntimeName[] {
  const names = raw
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
  if (names.length === 0) throw new UsageError('--runtime needs at least one of node, bun, deno.');
  return names.map(name => {
    const known = RUNTIMES.find(runtime => runtime === name);
    if (known) return known;
    const hint = suggest(name, RUNTIMES);
    throw new UsageError(
      `Unknown runtime "${name}".${hint ? ` Did you mean ${hint}?` : ''} Runtimes: ${RUNTIMES.join(', ')}.`,
    );
  });
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const ROOT_HELP = `arki-bench — benchmarks you can publish

Usage
  arki-bench [run] [files…] [options]          run suites and print a table
  arki-bench report <result.json> [options]     render a saved result
  arki-bench compare <base.json> <head.json>    compare two runs (CI)
  arki-bench losses [results or dirs…]          where our library is slower, larger or higher
  arki-bench check [README.md]                  exit 1 when the README section is stale
  arki-bench list                               show suites, groups, cases, contracts
  arki-bench doctor                             check this machine before measuring

Examples
  arki-bench                                    explore every bench/**/*.bench.ts suite
  arki-bench --profile publish --write-readme   measure for the README and update it
  arki-bench compare .bench/base.json .bench/head.json --ci

Run arki-bench <command> --help for options. Exit codes: 0 ok, 1 a check failed, 2 bad command line.
`;

export function helpText(command?: CommandName): string {
  if (!command) return ROOT_HELP;
  const spec = COMMANDS[command];
  const entries = Object.entries(spec.flags).map(([name, flag]) => {
    const value = flag.value ? (flag.optional ? ` [${flag.value}]` : ` <${flag.value}>`) : '';
    return [`--${name}${value}`, flag.description] as const;
  });
  const width = Math.max(0, ...entries.map(([left]) => left.length));
  const lines = [`Usage: ${spec.usage}`, '', spec.summary, ''];
  if (entries.length > 0)
    lines.push('Options', ...entries.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`), '');
  lines.push('Examples', ...spec.examples.map(example => `  ${example}`), '');
  return lines.join('\n');
}

function packageVersion(): string {
  const file = fileURLToPath(new URL('../package.json', import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string')
    return parsed.version;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const SUITE_FILE = /\.bench\.(?:ts|mts|js|mjs)$/;

/** The nearest directory at or above `cwd` with a package.json. */
export function findPackageRoot(cwd: string): string {
  let directory = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(directory, 'package.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new CommandError(`No package.json found at or above ${cwd}. Run arki-bench inside a package.`);
    directory = parent;
  }
}

/** `bench/**\/*.bench.{ts,mts,js,mjs}` under the package root, sorted. */
export function discoverSuites(root: string): readonly string[] {
  const directory = path.join(root, 'bench');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter(entry => SUITE_FILE.test(entry) && !entry.split(/[/\\]/).includes('node_modules'))
    .map(entry => path.join(directory, entry))
    .toSorted();
}

const STARTER = `No suites found. arki-bench looks for bench/**/*.bench.{ts,mts,js,mjs} in the package root.
Create bench/example.bench.ts:

  import { compare, defineSuite } from '@arki/bench';

  export default defineSuite({
    id: 'my-lib',
    groups: [
      compare({
        id: 'sum', title: 'Sum an array', baseline: 'loop',
        contract: { id: 'sum@1', description: 'the sum of the numbers' },
        inputs: [[1, 2, 3], [], [-1, 1]],
        cases: {
          loop: { run: (xs: number[]) => { let s = 0; for (const x of xs) s += x; return s; } },
          reduce: { run: (xs: number[]) => xs.reduce((a, b) => a + b, 0) },
        },
      }),
    ],
  });
`;

function suiteFiles(args: ParsedArgs, cwd: string, root: string): readonly string[] {
  if (args.positionals.length > 0) {
    return args.positionals.map(file => {
      const absolute = path.resolve(cwd, file);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new CommandError(`${file} does not exist.`);
      return absolute;
    });
  }
  const found = discoverSuites(root);
  if (found.length === 0) throw new CommandError(STARTER);
  return found;
}

/** Imports a suite without running it (the same loader `run` uses). */
async function loadSuite(file: string): Promise<SuiteSpec> {
  const { loadSuite: load } = await import('./node/run.js');
  try {
    return await load(file);
  } catch (error) {
    if (error instanceof Error && error.name !== 'SpecError') throw new CommandError(error.message, { cause: error });
    throw error;
  }
}

/** Reads a saved result and validates the full schema-1 structure (see ./node/result-schema). */
function readResult(file: string, cwd: string): BenchResult {
  const absolute = path.resolve(cwd, file);
  if (!existsSync(absolute)) throw new CommandError(`${file} does not exist.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    throw new CommandError(`${file} is not JSON.`);
  }
  try {
    return parseResult(parsed, file);
  } catch (error) {
    if (error instanceof ResultError) throw new CommandError(error.message, { cause: error });
    throw error;
  }
}

/** `.bench/<suite-id>.json` under the package root; `@arki/money` → `arki-money.json`. */
export function resultPath(root: string, suiteId: string): string {
  const name = suiteId.replace(/^@/, '').replaceAll(/[^\w.-]+/g, '-') || 'suite';
  return path.join(root, '.bench', `${name}.json`);
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
};

function processIo(): Io {
  return {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
    cwd: process.cwd(),
    env: process.env,
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
  };
}

const useColor = (args: ParsedArgs, io: Io): boolean => io.stdoutIsTTY && !has(args, 'no-color') && !io.env.NO_COLOR;

const CLEAR_LINE = `\r${String.fromCodePoint(27)}[2K`;

/** One updating line on a terminal; one line per group and case in logs. */
function progress(io: Io): {
  start: (label: string) => void;
  event: NonNullable<RunOptions['onProgress']>;
  end: () => void;
} {
  let open = false;
  const seen = new Set<string>();
  let current = '';
  const show = (line: string): void => {
    if (io.stderrIsTTY) {
      io.stderr(`${CLEAR_LINE}${line}`);
      open = true;
    } else {
      io.stderr(`${line}\n`);
    }
  };
  return {
    start: label => {
      current = label;
      seen.clear();
      show(`${label}: starting`);
    },
    event: event => {
      if (event.type === 'check') show(`${current} › ${event.group}: checking the contract`);
      else if (event.type === 'done') {
        if (!io.stderrIsTTY) show(`${current} › ${event.group}: done`);
      } else if (io.stderrIsTTY)
        show(`${current} › ${event.group} › ${event.case}  block ${event.block}/${event.blocks}`);
      else if (!seen.has(`${event.group}/${event.case}`)) {
        seen.add(`${event.group}/${event.case}`);
        show(`${current} › ${event.group} › ${event.case}`);
      }
    },
    end: () => {
      if (open) io.stderr(CLEAR_LINE);
      open = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Why `--ci` fails this result; empty when it passes. */
export function ciProblems(result: BenchResult): readonly string[] {
  const problems: string[] = [];
  const groups = [...result.groups, ...(result.runtimes ?? []).flatMap(runtime => runtime.groups)];
  for (const group of groups) {
    if (group.check?.status === 'failed')
      problems.push(`${group.id}: contract check failed (${group.check.failures.length} mismatches)`);
    for (const row of group.cases) {
      if (row.flags.includes('over-limit')) problems.push(`${group.id}/${row.key}: over its size budget`);
    }
  }
  if (result.profile === 'publish' && !result.publishable) {
    const reasons = result.warnings.map(warning => warning.message).join('; ');
    problems.push(`the publish run is not publishable${reasons ? `: ${reasons}` : ''}`);
  }
  return [...new Set(problems)];
}

function refusal(result: BenchResult, target: string): string {
  const reasons =
    result.warnings.length > 0
      ? result.warnings.map(warning => `  • ${warning.message}`)
      : [`  • ${result.profile} runs are never publishable`];
  return [
    `Not writing ${target}: this result is not publishable.`,
    ...reasons,
    'Fix the causes and rerun with --profile publish, or pass --force to write it with a warning banner.',
    '',
  ].join('\n');
}

function updateReadme(result: BenchResult, target: string, args: ParsedArgs, io: Io): boolean {
  if (!result.publishable && !has(args, 'force')) {
    io.stderr(refusal(result, path.relative(io.cwd, target) || target));
    return false;
  }
  writeReadme(target, renderMarkdown(result, { reproduce: stringFlag(args, 'reproduce') }));
  io.stderr(`Updated the benchmark section of ${path.relative(io.cwd, target) || target}\n`);
  return true;
}

async function commandRun(args: ParsedArgs, io: Io): Promise<number> {
  if (has(args, 'json') && has(args, 'markdown')) throw new UsageError('Choose one of --json and --markdown.');
  const root = findPackageRoot(io.cwd);
  const files = suiteFiles(args, io.cwd, root);
  const out = stringFlag(args, 'out');
  const readme = args.flags.get('write-readme');
  if (files.length > 1 && (out !== undefined || readme !== undefined)) {
    throw new UsageError(
      `--out and --write-readme take one suite; ${files.length} were found. Name the file: arki-bench bench/x.bench.ts --write-readme.`,
    );
  }
  const profileValue = stringFlag(args, 'profile');
  const profile = PROFILES.find(name => name === profileValue) ?? 'explore';
  const seed = integerFlag(args, 'seed', 0);
  const timeoutMs = integerFlag(args, 'timeout', 1);
  const processes = integerFlag(args, 'processes', 1) ?? (profile === 'publish' ? 5 : 1);
  const runtimeFlag = stringFlag(args, 'runtime');
  const runtimes = runtimeFlag === undefined ? undefined : parseRuntimes(runtimeFlag);

  const node = stringFlag(args, 'node') ?? (io.env.ARKI_BENCH_NODE || undefined);

  const { runFile } = await import('./node/run.js');
  const status = progress(io);
  const results: BenchResult[] = [];
  for (const file of files) {
    status.start(path.relative(root, file));
    try {
      results.push(
        await runFile(file, {
          profile,
          filter: stringFlag(args, 'filter'),
          seed,
          timeoutMs,
          processes,
          runtimes,
          node,
          cwd: root,
          samples: !has(args, 'no-samples'),
          onProgress: status.event,
        }),
      );
    } finally {
      status.end();
    }
  }

  for (const result of results) {
    const saved = resultPath(root, result.suite.id);
    writeJson(saved, result);
    io.stderr(`Saved ${path.relative(io.cwd, saved)}\n`);
    if (out !== undefined) writeJson(path.resolve(io.cwd, out), result);
  }

  // Always an array, so a script reads one shape whether one suite ran or several.
  if (has(args, 'json')) io.stdout(`${JSON.stringify(results, null, 2)}\n`);
  else if (has(args, 'markdown'))
    io.stdout(results.map(result => renderMarkdown(result, { reproduce: stringFlag(args, 'reproduce') })).join('\n'));
  else io.stdout(results.map(result => renderText(result, { color: useColor(args, io) })).join('\n'));

  let code = 0;
  const [single] = results;
  if (readme !== undefined && single) {
    const target = typeof readme === 'string' ? path.resolve(io.cwd, readme) : path.join(root, 'README.md');
    if (!updateReadme(single, target, args, io)) code = 1;
  }
  if (has(args, 'ci')) {
    const problems = results.flatMap(result => ciProblems(result).map(problem => `${result.suite.id}: ${problem}`));
    for (const problem of problems) io.stderr(`✗ ${problem}\n`);
    if (problems.length > 0) code = 1;
  }
  return code;
}

function commandReport(args: ParsedArgs, io: Io): number {
  const [file, ...extra] = args.positionals;
  if (!file) throw new UsageError('report needs a result file: arki-bench report .bench/<suite>.json');
  if (extra.length > 0) throw new UsageError(`report takes one result file; got ${args.positionals.length}.`);
  const result = readResult(file, io.cwd);
  const format = stringFlag(args, 'format');
  const target = stringFlag(args, 'write');
  if (target === undefined || format !== undefined) {
    if (format === 'json') io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else if (format === 'markdown') io.stdout(renderMarkdown(result, { reproduce: stringFlag(args, 'reproduce') }));
    else io.stdout(renderText(result, { color: useColor(args, io) }));
  }
  if (target !== undefined && !updateReadme(result, path.resolve(io.cwd, target), args, io)) return 1;
  return 0;
}

function commandCompare(args: ParsedArgs, io: Io): number {
  const [baseFile, headFile, ...extra] = args.positionals;
  if (!baseFile || !headFile || extra.length > 0)
    throw new UsageError('compare needs two result files: arki-bench compare <base.json> <head.json>');
  const thresholdFlag = stringFlag(args, 'threshold');
  const threshold = thresholdFlag === undefined ? undefined : parseThreshold(thresholdFlag);
  const comparison = compareRuns(
    readResult(baseFile, io.cwd),
    readResult(headFile, io.cwd),
    threshold === undefined ? {} : { threshold },
  );
  io.stdout(renderComparison(comparison, stringFlag(args, 'format') === 'markdown' ? 'markdown' : 'text'));
  return has(args, 'ci') && comparison.status === 'fail' ? 1 : 0;
}

/** `.bench/*.json` directly in `directory`, sorted. */
function benchResults(directory: string): string[] {
  const folder = path.join(directory, '.bench');
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return [];
  return readdirSync(folder)
    .filter(name => name.endsWith('.json'))
    .map(name => path.join(folder, name))
    .toSorted();
}

/** `**\/.bench/*.json` under `directory`, pruning node_modules and hidden directories (except `.bench`). */
export function findResults(directory: string): readonly string[] {
  const found: string[] = [];
  const pending = [directory];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    found.push(...benchResults(next));
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
        pending.push(path.join(next, entry.name));
    }
  }
  return found.toSorted();
}

function commandLosses(args: ParsedArgs, io: Io): number {
  const explicit: string[] = [];
  const discovered: string[] = [];
  if (args.positionals.length === 0) {
    const root = findPackageRoot(io.cwd);
    discovered.push(...benchResults(root));
    if (discovered.length === 0)
      throw new CommandError(`No saved results in ${path.join(root, '.bench')}. Run arki-bench first.`);
  }
  for (const target of args.positionals) {
    const absolute = path.resolve(io.cwd, target);
    if (!existsSync(absolute)) throw new CommandError(`${target} does not exist.`);
    if (statSync(absolute).isDirectory()) {
      const found = findResults(absolute);
      if (found.length === 0) throw new CommandError(`No .bench/*.json results under ${target}.`);
      discovered.push(...found);
    } else {
      explicit.push(absolute);
    }
  }
  const results: BenchResult[] = explicit.map(file => readResult(file, io.cwd));
  for (const file of new Set(discovered)) {
    // One stale or foreign file in a tree of results is reported, not fatal.
    try {
      results.push(readResult(file, io.cwd));
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      io.stderr(`arki-bench: skipped ${path.relative(io.cwd, file) || file}: ${error.message}\n`);
    }
  }
  const losses = collectLosses(results).filter(loss => loss.role === 'competitor' || !has(args, 'no-variants'));
  if (has(args, 'json')) io.stdout(`${JSON.stringify(losses, null, 2)}\n`);
  else io.stdout(renderLosses(losses, { format: has(args, 'markdown') ? 'markdown' : 'text' }));
  io.stderr(`Read ${results.length} ${results.length === 1 ? 'result' : 'results'}.\n`);
  const failing = losses.filter(loss => loss.publishable).length;
  if (!has(args, 'ci') || failing === 0) return 0;
  io.stderr(`FAIL — ${failing} ${failing === 1 ? 'loss' : 'losses'} in publishable results.\n`);
  return 1;
}

async function loadSuites(
  args: ParsedArgs,
  io: Io,
): Promise<{ root: string; suites: readonly { file: string; spec: SuiteSpec }[] }> {
  const root = findPackageRoot(io.cwd);
  const files = suiteFiles(args, io.cwd, root);
  const suites: { file: string; spec: SuiteSpec }[] = [];
  for (const file of files) suites.push({ file, spec: await loadSuite(file) });
  return { root, suites };
}

async function commandCheck(args: ParsedArgs, io: Io): Promise<number> {
  const [readmeArg, ...extra] = args.positionals;
  if (extra.length > 0) throw new UsageError('check takes at most one README path.');
  const root = findPackageRoot(io.cwd);
  const readme = readmeArg === undefined ? path.join(root, 'README.md') : path.resolve(io.cwd, readmeArg);
  const shown = path.relative(io.cwd, readme) || readme;
  const { suites } = await loadSuites({ ...args, positionals: [] }, io);
  const { meta } = readReadmeMeta(readme);
  const suite = suites.length === 1 ? suites[0] : (suites.find(entry => entry.spec.id === meta?.suite) ?? suites[0]);
  if (!suite) throw new CommandError(STARTER);
  const verdict = checkReadme(readme, { schema: 1, suite: { id: suite.spec.id, specHash: specHash(suite.spec) } });
  if (verdict.upToDate) {
    io.stdout(`✓ ${shown} is up to date with ${path.relative(root, suite.file)}\n`);
    return 0;
  }
  io.stdout(
    `✗ ${shown} is stale: ${verdict.reason ?? 'unknown reason'}\n  Regenerate it: arki-bench ${path.relative(root, suite.file)} --profile publish --write-readme${readmeArg ? ` ${readmeArg}` : ''}\n`,
  );
  return 1;
}

function describeSuite(file: string, root: string, spec: SuiteSpec) {
  return {
    file: path.relative(root, file),
    id: spec.id,
    title: spec.title ?? 'Benchmarks',
    groups: spec.groups.map(group => ({
      kind: group.kind ?? 'compare',
      id: group.id,
      title: group.title,
      contract: 'contract' in group ? group.contract : undefined,
      baseline: 'baseline' in group ? group.baseline : undefined,
      cases: Object.entries(group.cases).map(([key, entry]) => ({
        key,
        label: entry.label ?? key,
        package: entry.package,
        differs: 'differs' in entry ? entry.differs : undefined,
        variant: 'variant' in entry ? entry.variant : undefined,
      })),
    })),
  };
}

async function commandList(args: ParsedArgs, io: Io): Promise<number> {
  const { root, suites } = await loadSuites(args, io);
  const listing = suites.map(({ file, spec }) => describeSuite(file, root, spec));
  if (has(args, 'json')) {
    io.stdout(`${JSON.stringify(listing, null, 2)}\n`);
    return 0;
  }
  const lines: string[] = [];
  for (const suite of listing) {
    lines.push(`${suite.file}  ${suite.id} — ${suite.title}`);
    for (const group of suite.groups) {
      lines.push(`  ${group.kind.padEnd(8)} ${group.id}  ${group.title}`);
      if (group.contract) lines.push(`           contract ${group.contract.id}: ${group.contract.description}`);
      const cases = group.cases.map(entry => {
        const tags = [
          entry.key === group.baseline ? 'baseline' : undefined,
          entry.variant ? 'variant' : undefined,
          entry.differs ? `differs: ${entry.differs}` : undefined,
        ].filter(Boolean);
        return `${entry.key}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`;
      });
      lines.push(`           cases: ${cases.join(', ')}`);
    }
    lines.push('');
  }
  io.stdout(lines.join('\n'));
  return 0;
}

function onPath(name: string, env: Io['env']): string | undefined {
  const extensions = platform() === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return undefined;
}

function toolVersion(executable: string): string | undefined {
  const output = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return output.status === 0 ? output.stdout.trim().split('\n')[0] : undefined;
}

async function commandDoctor(io: Io): Promise<number> {
  const { now } = await import('mitata/src/lib.mjs');
  let resolution = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 2000; attempt++) {
    const start = now();
    let next = now();
    while (next === start) next = now();
    resolution = Math.min(resolution, next - start);
  }
  const calls = 100_000;
  const loopStart = now();
  for (let index = 0; index < calls; index++) now();
  const overhead = (now() - loopStart) / calls;

  const runtime = process.versions.bun
    ? `bun ${process.versions.bun}`
    : process.versions.deno
      ? `deno ${process.versions.deno}`
      : `node ${process.versions.node} (V8 ${process.versions.v8})`;
  const gcExposed = typeof globalThis.gc === 'function' || Boolean(process.versions.bun);
  const cores = availableParallelism();
  const cpu = cpus()[0]?.model.trim() ?? 'unknown CPU';
  const load = platform() === 'win32' ? undefined : loadavg()[0];
  const bun = onPath('bun', io.env);
  const deno = onPath('deno', io.env);

  const rows: (readonly [string, string])[] = [
    ['runtime', runtime],
    ['timer', `resolution ~${formatTime(resolution)}, ${formatTime(overhead)} per call`],
    ['gc', gcExposed ? 'exposed (GC runs between cases)' : 'not exposed in this process'],
    ['cpu', `${cpu}, ${cores} cores`],
    [
      'load',
      load === undefined ? 'not available on this OS' : `${load.toFixed(1)} (1-minute average) on ${cores} cores`,
    ],
    ['bun', bun ? `${toolVersion(bun) ?? 'unknown version'} at ${bun}` : 'not on PATH'],
    ['deno', deno ? `${toolVersion(deno) ?? 'unknown version'} at ${deno}` : 'not on PATH'],
  ];
  const advice: string[] = [];
  if (load !== undefined && load > cores / 2) {
    advice.push(
      `Close other processes: load ${load.toFixed(0)} on ${cores} cores. Publish runs on a busy machine are marked not publishable.`,
    );
  }
  if (resolution > 100)
    advice.push(
      `The timer is coarse (~${formatTime(resolution)}). mitata batches calls to compensate; cases under ~50 ns will be noisy.`,
    );
  if (!gcExposed)
    advice.push(
      'Start Node with --expose-gc (node --expose-gc …) to collect garbage between cases and record GC time.',
    );
  if (!bun) advice.push('Install Bun to add it to the runtime matrix (--runtime node,bun).');
  if (!deno) advice.push('Install Deno to add it to the runtime matrix (--runtime node,deno).');

  const lines = rows.map(([label, value]) => `  ${label.padEnd(8)} ${value}`);
  lines.push(
    '',
    advice.length > 0 ? 'Advice' : 'Nothing to fix: this machine is ready for publish runs.',
    ...advice.map(line => `  • ${line}`),
    '',
  );
  io.stdout(`arki-bench doctor\n${lines.join('\n')}`);
  return 0;
}

/** Runs one command. Returns the exit code; never calls process.exit. */
export async function main(argv: readonly string[], io: Io = processIo()): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.version) {
      io.stdout(`${packageVersion()}\n`);
      return 0;
    }
    if (args.help) {
      io.stdout(helpText(isCommand(argv[0] ?? '') ? args.command : undefined));
      return 0;
    }
    switch (args.command) {
      case 'run': {
        return await commandRun(args, io);
      }
      case 'report': {
        return commandReport(args, io);
      }
      case 'compare': {
        return commandCompare(args, io);
      }
      case 'losses': {
        return commandLosses(args, io);
      }
      case 'check': {
        return await commandCheck(args, io);
      }
      case 'list': {
        return await commandList(args, io);
      }
      case 'doctor': {
        return await commandDoctor(io);
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`arki-bench: ${error.message}\n`);
      return 2;
    }
    if (
      error instanceof CommandError ||
      (error instanceof Error && ['ReadmeError', 'SpecError', 'BenchRunError'].includes(error.name))
    ) {
      // A SpecError lists every problem; print the ones its message does not already contain.
      const listed = 'problems' in error && Array.isArray(error.problems) ? error.problems.map(String) : [];
      const problems = listed.filter(problem => !error.message.includes(problem)).map(problem => `  • ${problem}`);
      io.stderr(`arki-bench: ${error.message}\n${problems.length > 0 ? `${problems.join('\n')}\n` : ''}`);
      return 1;
    }
    throw error;
  }
}

/**
 * Node before 22.18 / 23.6 cannot import TypeScript suite files without
 * `--experimental-strip-types`. Bun and Deno run TypeScript natively.
 */
function needsTypeScriptFlag(): boolean {
  if (process.versions.bun || process.versions.deno) return false;
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)) return false;
  // Node ≥ 22.10 reports the loader in process.features (it covers NODE_OPTIONS too).
  if ('typescript' in process.features) return !process.features.typescript;
  return !process.execArgv.some(
    flag => flag.startsWith('--experimental-strip-types') || flag.startsWith('--experimental-transform-types'),
  );
}

function isEntry(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function runAsEntry(): Promise<void> {
  const argv = process.argv.slice(2);
  let importsSuites = false;
  try {
    const parsed = parseArgs(argv);
    // `run` needs no flag: runFile starts its own child process when Node cannot load TypeScript.
    importsSuites = !parsed.help && !parsed.version && ['check', 'list'].includes(parsed.command);
  } catch {
    // main() reports the usage error.
  }
  if (importsSuites && needsTypeScriptFlag()) {
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        ...argv,
      ],
      { stdio: 'inherit' },
    );
    process.exitCode = child.status ?? 1;
    return;
  }
  process.exitCode = await main(argv);
}

if (isEntry()) await runAsEntry();
