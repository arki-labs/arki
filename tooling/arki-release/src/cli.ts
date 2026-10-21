#!/usr/bin/env bun
/**
 * `arki-release` CLI entrypoint.
 *
 * Parses `Bun.argv`, dispatches to a subcommand handler, and emits the
 * shared {@link ReleaseCommandEnvelope}. In this task (Task 1) every
 * subcommand is an honest stub that returns `status: 'pending'` — the real
 * logic lands in Tasks 2-7.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ApiDiff } from '@arki/library-tooling/src/api-diff';
import { apiDiffSchema } from '@arki/library-tooling/src/api-diff';
import debugFactory from 'debug';

import { CANDIDATES_DIR, lastShippedCommits, readCandidate, runCandidate, type CandidateTarget } from './candidate';
import { defaultConfigPath, loadConfig, ReleaseConfigError } from './config';
import { runDemoCheck } from './demo-check';
import { demosUsing, loadDemos } from './demos';
import { EXPORT_ERROR_CODES, exportPublicTree } from './export-public';
import {
  DEFAULT_PACKAGE_MANAGERS,
  FIXTURE_ERROR_CODES,
  runFixtureMatrix,
} from './fixture';
import { renderHistoryText, runHistory } from './history';
import { runImpact, type ImpactPackage } from './impact';
import { discoverManifests, runInventory, type InventoryItem } from './inventory';
import { createEnvelope, emitEnvelope } from './json-output';
import { DEFAULT_LEAK_PATTERNS, LEAK_ERROR_CODES, scanPackage } from './leaks';
import { npmVersionLookup, ORDER_ERROR_CODES, pendingPackages, runOrder } from './order';
import { auditPack, isSourceDistributedManifest, PACK_ERROR_CODES } from './pack';
import { renderReadinessTable } from './readiness';
import { defaultGitRunner, defaultNpmRunner } from './runners';
import { renderScorecardText, runScorecard } from './scorecard';
import { runShip, type ShipMode } from './ship';
import { runSite } from './site';
import { runSmoke } from './smoke';
import { createSourceSnapshot, type SourceSnapshot } from './snapshot';
import { runUpgradeGuide } from './upgrade-guide';
import { runSyncApply, runSyncPrepare } from './sync';
import type {
  ExportItem,
  ExportSummary,
  FixtureMatrixSummary,
  FixtureRun,
  LeakHit,
  PackAuditResult,
  PackageManagerId,
  ParsedCliArgs,
  ReleaseCommand,
  ReleaseCommandEnvelope,
  ReleaseConfig,
  ReleaseError,
} from './types';

const debug = debugFactory('arki:release:cli');

/** Stable error codes of the CLI itself. */
const CLI_ERROR_CODES = {
  /** A required flag is missing or flags conflict (exit 2). */
  usage: 'CLI_E001',
} as const;

/**
 * Known subcommands and their implementation task references.
 *
 * Stable order — used by the help text and the no-args dispatch path.
 */
const SUBCOMMANDS: ReadonlyArray<{
  readonly name: ReleaseCommand;
  readonly task: string;
  readonly description: string;
}> = [
  {
    name: 'inventory',
    task: 'Task 2',
    description: 'Discover workspace packages and classify release waves.',
  },
  {
    name: 'audit',
    task: 'Task 4',
    description: 'Leak-scan publishable packages and run npm pack audits.',
  },
  {
    name: 'export-public',
    task: 'Task 5',
    description: 'Materialize the .release/arki-public/ tree for publication.',
  },
  {
    name: 'pack',
    task: 'Task 4',
    description: 'Run npm pack --dry-run audits across public-candidate packages.',
  },
  {
    name: 'fixture',
    task: 'Task 6',
    description: 'Drive external npm/pnpm/Bun install fixtures.',
  },
  {
    name: 'scorecard',
    task: 'Task 7',
    description: 'Emit the release scorecard gating publication.',
  },
  {
    name: 'history',
    task: 'post-Task-12',
    description: 'Reconcile source / npm / CHANGELOG / GitHub tags; detect drift.',
  },
  {
    name: 'sync',
    task: 'T1.7',
    description: 'GitHub mirrors: --prepare [--candidate <dir>] (local) | --apply [--plan <path>] (founder only).',
  },
  {
    name: 'order',
    task: 'T1.1',
    description: 'Publish order for a wave: --wave <id>. Lists unpublished @arki deps first.',
  },
  {
    name: 'candidate',
    task: 'T1.1',
    description: 'Freeze tarballs + candidate.json: --wave <id> | --affected <ref>.',
  },
  {
    name: 'smoke',
    task: 'T1.2',
    description: 'Install a candidate into a clean consumer and import every export: --candidate <dir> [--keep].',
  },
  {
    name: 'impact',
    task: 'T1.4',
    description: 'docs-impact + demo-impact for a wave\'s pending changesets: --wave <id> [--candidate <dir>].',
  },
  {
    name: 'upgrade-guide',
    task: 'T2.11',
    description: 'Upgrade guide skeleton for a minor: --package <name> --from <v> --to <v> [--write] [--api-diff <file>].',
  },
  {
    name: 'ship',
    task: 'T1.6',
    description: 'Wave to founder packet: --wave <id> [--dry-run] | --wave <id> --resume | --finish --candidate <dir> (founder only).',
  },
  {
    name: 'site',
    task: 'T3.1',
    description: 'Docs + data for apps/arki/start: --channel published | --channel next [--candidate <dir>].',
  },
  {
    name: 'demo-check',
    task: 'T4.2',
    description: 'Install, typecheck, test and build one demo against a candidate: --demo <name> --candidate <dir>.',
  },
];

const KNOWN_COMMANDS: ReadonlySet<ReleaseCommand> = new Set(SUBCOMMANDS.map(sub => sub.name));

/**
 * Parse the raw `Bun.argv` (or any string[] equivalent) into a structured
 * {@link ParsedCliArgs} shape. Argument parsing is intentionally minimal —
 * we lean on Bun's native argv and avoid a third-party parser.
 *
 * Accepted forms:
 *   arki-release                 → help
 *   arki-release help            → help
 *   arki-release --help          → help
 *   arki-release <cmd>           → run <cmd> in text mode
 *   arki-release <cmd> --json    → run <cmd> in JSON mode
 *
 * Unknown commands resolve to `command: null` with `help: true` so the
 * dispatcher can show usage and exit gracefully.
 */
export function parseArgs(argv: readonly string[]): ParsedCliArgs {
  const rest: string[] = [];
  let json = false;
  let help = false;
  let command: ReleaseCommand | null = null;

  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      help = true;
      continue;
    }
    if (command === null && !arg.startsWith('-')) {
      if (isReleaseCommand(arg)) {
        command = arg;
      } else {
        help = true;
        rest.push(arg);
      }
      continue;
    }
    rest.push(arg);
  }

  if (command === null && !help) {
    help = true;
  }

  return { command, json, help, rest };
}

function isReleaseCommand(value: string): value is ReleaseCommand {
  return (KNOWN_COMMANDS as ReadonlySet<string>).has(value);
}

/**
 * Build the help envelope. Returned as an envelope (not raw text) so the
 * `--json` channel exposes the same command catalogue agents see in text.
 */
function buildHelpEnvelope(): ReleaseCommandEnvelope<
  { name: ReleaseCommand; task: string; description: string },
  { message: string; commands: number }
> {
  return createEnvelope({
    command: 'help',
    status: 'pending',
    summary: {
      message: 'arki-release CLI scaffold — subcommand implementations land in Tasks 2-7.',
      commands: SUBCOMMANDS.length,
    },
    items: SUBCOMMANDS.map(sub => ({ ...sub })),
  });
}

/**
 * Build a stub envelope for a real subcommand. Status is `pending` —
 * NOT `success` — because the implementation is intentionally absent in
 * Task 1. Downstream gates that key on `status === 'success'` will
 * correctly treat the stub as not-yet-shippable.
 */
function buildStubEnvelope(command: ReleaseCommand): ReleaseCommandEnvelope<never, { message: string; task: string }> {
  const meta = SUBCOMMANDS.find(sub => sub.name === command);
  const taskRef = meta?.task ?? 'a follow-up task';
  return createEnvelope({
    command,
    status: 'pending',
    summary: {
      message: `${command}: not yet implemented — see ${taskRef}.`,
      task: taskRef,
    },
    items: [],
    errors: [],
  });
}

/**
 * Render the help text manually (in addition to the envelope-driven
 * one-liner from `renderHumanText`) so humans get an actionable usage
 * block.
 */
function renderHelpText(): string {
  const lines: string[] = [];
  lines.push('arki-release — internal release rails for @arki/* packages');
  lines.push('');
  lines.push('Usage: arki-release <command> [--json]');
  lines.push('');
  lines.push('Commands:');
  const width = Math.max(...SUBCOMMANDS.map(sub => sub.name.length));
  for (const sub of SUBCOMMANDS) {
    const padded = sub.name.padEnd(width, ' ');
    lines.push(`  ${padded}  ${sub.description}  (${sub.task})`);
  }
  lines.push('');
  lines.push('Global flags:');
  lines.push('  --json   Emit a ReleaseCommandEnvelope as JSON on stdout.');
  lines.push('  --help   Show this message.');
  lines.push('');
  lines.push('scorecard flags:');
  lines.push('  --package <name>           Score one package.');
  lines.push('  --allow-deferred           Deferred DOT / agent-native gates do not block.');
  lines.push('  --full-fixture             Run the fixture matrix in install mode (CI).');
  lines.push('  --candidate <dir>          Read checks and versions from a frozen candidate.');
  lines.push('  --allow-demo-lag "<why>"   A blocking demo lag becomes a warning.');
  lines.push('  --table                    Print the readiness table instead of the dimension list.');
  lines.push('');
  lines.push('Exit codes:');
  lines.push('  0  open: the command succeeded (scorecard: stable release gate open).');
  lines.push('  1  blocked: the command ran and found blocking problems (or the config is invalid).');
  lines.push('  2  tool error: bad flags (CLI_E001) or an unexpected crash.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Convert a {@link ReleaseConfigError} into a failure envelope. The CLI
 * uses this so config errors don't bubble up as uncaught exceptions; they
 * land in the same envelope channel agents already know how to parse.
 */
function buildConfigErrorEnvelope(
  command: ReleaseCommand,
  cause: ReleaseConfigError,
): ReleaseCommandEnvelope<never, { message: string; configError: true }> {
  return createEnvelope({
    command,
    status: 'failure',
    summary: { message: `Config load failed: ${cause.message}`, configError: true },
    items: [],
    errors: [
      {
        code: cause.code,
        severity: 'error',
        message: cause.message,
        remediation: 'Fix arki.release.config.ts and retry.',
      },
    ],
  });
}

/**
 * Dispatch parsed args to the right envelope-producing handler and emit
 * the result. Returns the process exit code the caller should use.
 */
export async function dispatch(args: ParsedCliArgs): Promise<number> {
  debug('dispatch %o', args);

  if (args.help || args.command === null) {
    const envelope = buildHelpEnvelope();
    if (args.json) {
      emitEnvelope(envelope, { json: true });
    } else {
      process.stdout.write(renderHelpText());
    }
    return 0;
  }

  if (args.command === 'inventory') {
    return runInventoryHandler(args.json);
  }

  if (args.command === 'audit') {
    return runAuditHandler(args);
  }

  if (args.command === 'pack') {
    return runPackHandler(args);
  }

  if (args.command === 'export-public') {
    return runExportPublicHandler(args);
  }

  if (args.command === 'fixture') {
    return runFixtureHandler(args);
  }

  if (args.command === 'scorecard') {
    return runScorecardHandler(args);
  }

  if (args.command === 'history') {
    return runHistoryHandler(args);
  }

  if (args.command === 'sync') {
    return runSyncHandler(args);
  }

  if (args.command === 'order') {
    return runOrderHandler(args);
  }

  if (args.command === 'candidate') {
    return runCandidateHandler(args);
  }

  if (args.command === 'smoke') {
    return runSmokeHandler(args);
  }

  if (args.command === 'demo-check') {
    return runDemoCheckHandler(args);
  }

  if (args.command === 'impact') {
    return runImpactHandler(args);
  }

  if (args.command === 'upgrade-guide') {
    return runUpgradeGuideHandler(args);
  }

  if (args.command === 'ship') {
    return runShipHandler(args);
  }

  if (args.command === 'site') {
    return runSiteHandler(args);
  }

  const envelope = buildStubEnvelope(args.command);
  emitEnvelope(envelope, { json: args.json });
  return 0;
}

/**
 * `scorecard` subcommand handler — drive the aggregator across every
 * public-candidate package and emit the result.
 *
 * Flags:
 *   --json               Emit the {@link ReleaseCommandEnvelope} as JSON.
 *   --allow-deferred     Treat deferred dimensions (DOT gates, agent-native
 *                        gates) as passing for the top-level gate decision.
 *                        Used post-Task-9/10 to validate the flip.
 *   --package <name>     Score a single package by name.
 *   --full-fixture       Run the fixture matrix in install mode (CI default).
 *   --candidate <dir>    Read candidate.json checks + versions (never rebuilds).
 *   --allow-demo-lag "<reason>"  A blocking demo lag becomes a warning.
 *   --table              Print the readiness table (text mode).
 *
 * Exit codes:
 *   - 0 when `stableReleaseGate === 'open'`.
 *   - 1 when `stableReleaseGate === 'blocked'`.
 */
async function runScorecardHandler(args: ParsedCliArgs): Promise<number> {
  const cwd = process.cwd();
  const configPath = defaultConfigPath(cwd);
  const packageFilter = extractOption(args.rest, 'package');
  const allowDeferred = args.rest.includes('--allow-deferred');
  const fullFixtureMatrix = args.rest.includes('--full-fixture');
  const candidateDir = extractOption(args.rest, 'candidate');
  const allowDemoLag = extractOption(args.rest, 'allow-demo-lag');

  try {
    const config = await loadConfig(configPath);
    const envelope = await runScorecard({
      cwd,
      config,
      ...(packageFilter !== null ? { packageName: packageFilter } : {}),
      ...(candidateDir !== null ? { candidateDir: path.resolve(cwd, candidateDir) } : {}),
      ...(allowDemoLag !== null ? { allowDemoLag } : {}),
      allowDeferred,
      fullFixtureMatrix,
    });
    if (args.json) {
      emitEnvelope(envelope, { json: true });
    } else if (args.rest.includes('--table')) {
      const rows = envelope.items.flatMap(pkg =>
        pkg.readiness === undefined ? [] : [{ name: pkg.name, ...pkg.readiness, dimension: pkg.dimensions.readiness }],
      );
      process.stdout.write(`${renderReadinessTable(rows)}\n${envelope.summary.message}\n`);
    } else {
      process.stdout.write(renderScorecardText(envelope));
    }
    return envelope.summary.stableReleaseGate === 'open' ? 0 : 1;
  } catch (cause) {
    if (cause instanceof ReleaseConfigError) {
      const envelope = buildConfigErrorEnvelope('scorecard', cause);
      emitEnvelope(envelope, { json: args.json });
      return 1;
    }
    throw cause;
  }
}

/**
 * `history` subcommand handler — reconcile source / npm / CHANGELOG /
 * GitHub tags across wave-listed packages.
 *
 * Flags:
 *   --json             Emit the {@link ReleaseCommandEnvelope} as JSON.
 *   --skip-network     Skip npm and git ls-remote calls; report source/CHANGELOG only.
 *   --remote <url>     Override the GitHub mirror URL (default: arki-labs/arki).
 *
 * Exit codes:
 *   - 0 when every wave-listed package is `in-sync`, `source-ahead`, or `unpublished`.
 *   - 1 when any package shows real drift (`npm-ahead`, `changelog-drift`, `tag-drift`).
 */
async function runHistoryHandler(args: ParsedCliArgs): Promise<number> {
  const cwd = process.cwd();
  const configPath = defaultConfigPath(cwd);
  const skipNetwork = args.rest.includes('--skip-network');
  const remoteOverride = extractOption(args.rest, 'remote');

  try {
    const config = await loadConfig(configPath);
    const envelope = await runHistory({
      cwd,
      config,
      skipNetwork,
      ...(remoteOverride !== null ? { githubRemote: remoteOverride } : {}),
    });
    if (args.json) {
      emitEnvelope(envelope, { json: true });
    } else {
      process.stdout.write(renderHistoryText(envelope));
    }
    return envelope.status === 'failure' ? 1 : 0;
  } catch (cause) {
    if (cause instanceof ReleaseConfigError) {
      const envelope = buildConfigErrorEnvelope('history', cause);
      emitEnvelope(envelope, { json: args.json });
      return 1;
    }
    throw cause;
  }
}

/**
 * `sync --prepare [--candidate <dir>]`: local, agent-safe; writes `.release/sync-plan.json`.
 * `sync --apply [--plan <path>]`: founder only; pushes, tags, creates GitHub Releases.
 * Exit 1 on failure.
 */
async function runSyncHandler(args: ParsedCliArgs): Promise<number> {
  const prepare = args.rest.includes('--prepare');
  const apply = args.rest.includes('--apply');
  const candidateDir = extractOption(args.rest, 'candidate');
  const planPath = extractOption(args.rest, 'plan');
  if (prepare === apply) return usageError('sync', 'sync needs exactly one of `--prepare` or `--apply`.', args.json);
  if (apply && candidateDir !== null) return usageError('sync', '`--candidate` belongs to `--prepare`; `--apply` reads the plan.', args.json);
  if (prepare && planPath !== null) return usageError('sync', '`--plan` belongs to `--apply`; `--prepare` writes the plan.', args.json);
  const cwd = process.cwd();
  if (apply) {
    const envelope = await runSyncApply({ cwd, ...(planPath === null ? {} : { planPath }) });
    emitEnvelope(envelope, { json: args.json });
    return envelope.status === 'failure' ? 1 : 0;
  }
  return withConfig('sync', args.json, async config => {
    const envelope = await runSyncPrepare({ cwd, config, ...(candidateDir === null ? {} : { candidateDir }) });
    emitEnvelope(envelope, { json: args.json });
    return envelope.status === 'failure' ? 1 : 0;
  });
}

/** Emit a CLI_E001 usage envelope and return exit code 2. */
function usageError(command: ReleaseCommand, message: string, json: boolean): number {
  emitEnvelope(
    createEnvelope({
      command,
      status: 'failure',
      summary: { message },
      errors: [{ code: CLI_ERROR_CODES.usage, severity: 'error', message, remediation: 'Run `bun release:arki --help` for the flags.' }],
    }),
    { json },
  );
  return 2;
}

/** Load the config, run `body`, and turn a config error into a failure envelope (exit 1). */
async function withConfig(command: ReleaseCommand, json: boolean, body: (config: ReleaseConfig) => Promise<number>): Promise<number> {
  try {
    return await body(await loadConfig(defaultConfigPath(process.cwd())));
  } catch (cause) {
    if (cause instanceof ReleaseConfigError) {
      emitEnvelope(buildConfigErrorEnvelope(command, cause), { json });
      return 1;
    }
    throw cause;
  }
}

/** `order --wave <id>`: publish order for the wave's pending changesets. */
async function runOrderHandler(args: ParsedCliArgs): Promise<number> {
  const wave = extractOption(args.rest, 'wave');
  if (wave === null) return usageError('order', 'order needs `--wave <id>`.', args.json);
  return withConfig('order', args.json, async config => {
    const envelope = await runOrder({ cwd: process.cwd(), config, wave });
    emitEnvelope(envelope, { json: args.json });
    return envelope.status === 'failure' ? 1 : 0;
  });
}

/** `candidate --wave <id> | --affected <ref>`: freeze tarballs; prints the folder. */
async function runCandidateHandler(args: ParsedCliArgs): Promise<number> {
  const wave = extractOption(args.rest, 'wave');
  const ref = extractOption(args.rest, 'affected');
  const target: CandidateTarget | null =
    wave !== null && ref === null ? { kind: 'wave', id: wave } : ref !== null && wave === null ? { kind: 'affected', ref } : null;
  if (target === null) return usageError('candidate', 'candidate needs exactly one of `--wave <id>` or `--affected <ref>`.', args.json);
  return withConfig('candidate', args.json, async config => {
    const envelope = await runCandidate({ cwd: process.cwd(), config, target });
    emitEnvelope(envelope, { json: args.json });
    if (!args.json && envelope.summary.directory !== null) process.stdout.write(`${envelope.summary.directory}\n`);
    return envelope.status === 'failure' ? 1 : 0;
  });
}

/** `smoke --candidate <dir> [--keep]`: install the tarballs in a clean consumer. */
async function runSmokeHandler(args: ParsedCliArgs): Promise<number> {
  const candidateDir = extractOption(args.rest, 'candidate');
  if (candidateDir === null) return usageError('smoke', 'smoke needs `--candidate <dir>`.', args.json);
  return withConfig('smoke', args.json, async config => {
    const cwd = process.cwd();
    const envelope = await runSmoke({ candidateDir: path.resolve(cwd, candidateDir), repoRoot: cwd, config, keep: args.rest.includes('--keep') });
    emitEnvelope(envelope, { json: args.json });
    return envelope.status === 'failure' ? 1 : 0;
  });
}

/** `demo-check --demo <name> --candidate <dir>`: run the demo's candidate mode and record `checks["demo:<name>"]`. */
async function runDemoCheckHandler(args: ParsedCliArgs): Promise<number> {
  const demo = extractOption(args.rest, 'demo');
  const candidateDir = extractOption(args.rest, 'candidate');
  if (demo === null || candidateDir === null) return usageError('demo-check', 'demo-check needs `--demo <name>` and `--candidate <dir>`.', args.json);
  return withConfig('demo-check', args.json, async config => {
    const envelope = await runDemoCheck({ cwd: process.cwd(), config, demo, candidateDir });
    emitEnvelope(envelope, { json: args.json });
    return envelope.status === 'failure' ? 1 : 0;
  });
}

/**
 * `impact --wave <id> [--candidate <dir>]`: docs-impact and demo-impact for
 * the wave packages a pending changeset bumps. Demo checks come from the
 * candidate; without one, demos that use a package report no passing check.
 */
async function runImpactHandler(args: ParsedCliArgs): Promise<number> {
  const waveId = extractOption(args.rest, 'wave');
  if (waveId === null) return usageError('impact', 'impact needs `--wave <id>`.', args.json);
  const candidateDir = extractOption(args.rest, 'candidate');
  return withConfig('impact', args.json, async config => {
    const cwd = process.cwd();
    const wave = config.waves.find(w => w.id === waveId);
    if (wave === undefined) {
      return usageError('impact', `Wave \`${waveId}\` is not in arki.release.config.ts (${config.waves.map(w => w.id).join(', ')}).`, args.json);
    }
    const errors: ReleaseError[] = [];
    const registry = await loadDemos(cwd, config);
    errors.push(...registry.errors);
    let candidateChecks = {};
    if (candidateDir !== null) {
      const read = await readCandidate(path.resolve(cwd, candidateDir));
      if (read.ok) candidateChecks = read.candidate.checks;
      else errors.push(...read.errors);
    }
    const pending = await pendingPackages(cwd);
    const { manifests } = await discoverManifests(cwd);
    const lastShipped = await lastShippedCommits(path.join(cwd, CANDIDATES_DIR));
    const lookup = npmVersionLookup(defaultNpmRunner, cwd);
    const packages: ImpactPackage[] = [];
    for (const manifest of manifests.filter(m => wave.packages.includes(m.name) && pending.names.has(m.name))) {
      const found = await lookup(manifest.name);
      if ('error' in found) {
        errors.push({
          code: ORDER_ERROR_CODES.npmViewFailed,
          severity: 'warning',
          message: `${found.error} ${manifest.name} is treated as never published.`,
          remediation: 'Check the network and npm access, then rerun impact.',
          target: manifest.name,
        });
      }
      packages.push({
        name: manifest.name,
        dir: path.basename(path.dirname(manifest.manifestPath)),
        version: manifest.version,
        npmVersion: 'versions' in found ? (found.versions.at(-1) ?? null) : null,
        lastShippedCommit: lastShipped.get(manifest.name) ?? null,
      });
    }
    const envelope = await runImpact({
      root: cwd,
      packages,
      git: defaultGitRunner,
      demosUsing: pkg => demosUsing(registry, pkg).map(use => use.demo),
      candidateChecks,
    });
    const merged = { ...envelope, errors: [...errors, ...envelope.errors] };
    emitEnvelope(merged, { json: args.json });
    return merged.errors.some(e => e.severity === 'error') ? 1 : 0;
  });
}

/**
 * `upgrade-guide --package <name> --from <v> --to <v> [--write] [--api-diff <file>]`:
 * the skeleton for one minor. Without `--write` it only prints.
 */
async function runUpgradeGuideHandler(args: ParsedCliArgs): Promise<number> {
  const pkg = extractOption(args.rest, 'package');
  const from = extractOption(args.rest, 'from');
  const to = extractOption(args.rest, 'to');
  if (pkg === null || from === null || to === null) {
    return usageError('upgrade-guide', 'upgrade-guide needs `--package <name> --from <v> --to <v>`.', args.json);
  }
  const diffFile = extractOption(args.rest, 'api-diff');
  let apiDiff: ApiDiff | undefined;
  if (diffFile !== null) {
    const parsed = apiDiffSchema.safeParse(JSON.parse(await readFile(path.resolve(process.cwd(), diffFile), 'utf8')));
    if (!parsed.success) return usageError('upgrade-guide', `--api-diff ${diffFile} is not an api diff: ${parsed.error.message}`, args.json);
    apiDiff = parsed.data;
  }
  const envelope = await runUpgradeGuide({
    root: process.cwd(),
    pkg,
    from,
    to,
    write: args.rest.includes('--write'),
    ...(apiDiff === undefined ? { npm: defaultNpmRunner } : { apiDiff }),
  });
  emitEnvelope(envelope, { json: args.json });
  return envelope.status === 'failure' ? 1 : 0;
}

/**
 * `ship --wave <id> [--dry-run] [--allow-demo-lag "<reason>"]`: order, version,
 * build, then stop with SHIP_E001 for the commit.
 * `ship --wave <id> --resume [--allow-deferred]`: candidate, checks, packet.
 * `ship --finish --candidate <dir>`: founder only; verify on npm, ledger, sync.
 * Exit 1 on failure; SHIP_E001 (commit needed) is a warning and exits 0.
 */
async function runShipHandler(args: ParsedCliArgs): Promise<number> {
  const wave = extractOption(args.rest, 'wave');
  const candidateDir = extractOption(args.rest, 'candidate');
  const finish = args.rest.includes('--finish');
  const dryRun = args.rest.includes('--dry-run');
  const mode: ShipMode | null = finish
    ? candidateDir !== null && wave === null && !dryRun
      ? { kind: 'finish', candidateDir }
      : null
    : wave !== null
      ? { kind: args.rest.includes('--resume') ? 'resume' : 'start', wave, dryRun }
      : null;
  if (mode === null) {
    return usageError('ship', 'ship needs `--wave <id> [--resume] [--dry-run]` or `--finish --candidate <dir>`.', args.json);
  }
  const allowDemoLag = extractOption(args.rest, 'allow-demo-lag');
  return withConfig('ship', args.json, async config => {
    const envelope = await runShip({
      cwd: process.cwd(),
      config,
      mode,
      allowDeferred: args.rest.includes('--allow-deferred'),
      ...(allowDemoLag === null ? {} : { allowDemoLag }),
      deps: {
        // The founder runs --finish, so apply's own TTY and CLAUDECODE guard is the gate.
        syncApply: async dir => {
          const cwd = process.cwd();
          const prepared = await runSyncPrepare({ cwd, config, candidateDir: dir });
          return prepared.status === 'failure' ? prepared : runSyncApply({ cwd });
        },
      },
    });
    emitEnvelope(envelope, { json: args.json });
    return envelope.status === 'failure' ? 1 : 0;
  });
}

/**
 * Extract `--package <name>` / `--path <abs>` style flags from
 * `args.rest`. Minimal — we only need a handful of options for now.
 */
/**
 * `site --channel published`: npm versions not yet on disk become immutable snapshots.
 * `site --channel next [--candidate <dir>]`: the newest candidate per wave (or `<dir>`) into `<name>/next/`.
 */
async function runSiteHandler(args: ParsedCliArgs): Promise<number> {
  const channel = extractOption(args.rest, 'channel');
  const candidateDir = extractOption(args.rest, 'candidate');
  if (channel !== 'published' && channel !== 'next') return usageError('site', 'site needs `--channel published` or `--channel next`.', args.json);
  if (channel === 'published' && candidateDir !== null) return usageError('site', '`--candidate` belongs to `--channel next`.', args.json);
  return withConfig('site', args.json, async config => {
    const envelope = await runSite({ cwd: process.cwd(), config, channel, ...(candidateDir === null ? {} : { candidateDir }) });
    emitEnvelope(envelope, { json: args.json });
    return envelope.status === 'failure' ? 1 : 0;
  });
}

function extractOption(rest: readonly string[], name: string): string | null {
  const idx = rest.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = rest[idx + 1];
  return value !== undefined && !value.startsWith('-') ? value : null;
}

/**
 * Inventory subcommand handler: load config, run the inventory pass,
 * emit the envelope, and map envelope status → exit code.
 *
 * A `failure` envelope produces exit code 1 so CI gates treat it as a
 * non-recoverable error.
 */
async function runInventoryHandler(json: boolean): Promise<number> {
  const cwd = process.cwd();
  const configPath = defaultConfigPath(cwd);
  try {
    const config = await loadConfig(configPath);
    const envelope = await runInventory({ cwd, config });
    emitEnvelope(envelope, { json });
    return envelope.status === 'failure' ? 1 : 0;
  } catch (cause) {
    if (cause instanceof ReleaseConfigError) {
      const envelope = buildConfigErrorEnvelope('inventory', cause);
      emitEnvelope(envelope, { json });
      return 1;
    }
    throw cause;
  }
}

/** Per-package leak summary item emitted by the audit envelope. */
interface AuditEnvelopeItem {
  readonly name: string;
  readonly manifestPath: string;
  readonly classification: string;
  readonly hitsBySeverity: { readonly error: number; readonly warning: number };
  readonly hits: readonly LeakHit[];
}

/** Aggregate summary for the audit envelope. */
interface AuditSummary {
  readonly message: string;
  readonly packagesScanned: number;
  readonly totalHits: number;
  readonly bySeverity: { readonly error: number; readonly warning: number };
}

/**
 * Resolve the list of inventory items the `audit` / `pack` commands
 * should operate on, based on `--package <name>` (single package) or
 * `--path <abs>` (single directory).
 *
 * Returns null when the operator explicitly asked for a package that
 * doesn't appear in the inventory — the handler converts that to a
 * failure envelope.
 */
async function resolveAuditTargets(args: ParsedCliArgs): Promise<{
  readonly config: ReleaseConfig;
  readonly items: readonly InventoryItem[];
  readonly cwd: string;
  readonly inventoryEnvelope: ReleaseCommandEnvelope<InventoryItem, unknown>;
} | { readonly error: ReleaseError }> {
  const cwd = process.cwd();
  const configPath = defaultConfigPath(cwd);
  const config = await loadConfig(configPath);
  const inventoryEnvelope = await runInventory({ cwd, config });

  const packageFilter = extractOption(args.rest, 'package');
  const pathFilter = extractOption(args.rest, 'path');

  if (packageFilter !== null) {
    const match = inventoryEnvelope.items.find(item => item.name === packageFilter);
    if (match === undefined) {
      return {
        error: {
          code: LEAK_ERROR_CODES.scanIoError,
          severity: 'error',
          message: `--package ${packageFilter} did not match any workspace package.`,
          remediation: 'Run `bun release:arki inventory --json` to see the package list.',
          target: packageFilter,
        },
      };
    }
    return { config, items: [match], cwd, inventoryEnvelope };
  }

  if (pathFilter !== null) {
    // Synthesize a single item for the requested path.
    const item: InventoryItem = {
      name: path.basename(pathFilter),
      version: '0.0.0',
      manifestPath: path.relative(cwd, path.join(pathFilter, 'package.json')),
      private: false,
      wave: null,
      classification: 'public-candidate',
      status: 'candidate',
      blockers: [],
    };
    return { config, items: [item], cwd, inventoryEnvelope };
  }

  return { config, items: inventoryEnvelope.items, cwd, inventoryEnvelope };
}

/**
 * `audit` subcommand handler — runs the leak scanner across the
 * requested package set.
 *
 * Exit codes:
 *   - 0 on success (no error-severity hits — warnings OK)
 *   - 1 on failure (any error-severity hits)
 */
async function runAuditHandler(args: ParsedCliArgs): Promise<number> {
  try {
    const targets = await resolveAuditTargets(args);
    if ('error' in targets) {
      const envelope = createEnvelope<AuditEnvelopeItem, AuditSummary>({
        command: 'audit',
        status: 'failure',
        summary: {
          message: targets.error.message,
          packagesScanned: 0,
          totalHits: 0,
          bySeverity: { error: 0, warning: 0 },
        },
        items: [],
        errors: [targets.error],
      });
      emitEnvelope(envelope, { json: args.json });
      return 1;
    }

    const { items, cwd, config } = targets;
    const patterns = config.leakPatterns ?? DEFAULT_LEAK_PATTERNS;
    const auditAll = args.rest.includes('--all');

    // Default policy: only audit packages we intend to publish — i.e.
    // `public-candidate` and any wave-listed package currently blocked
    // by a private flag, private dep, or future leak/build-shape audit.
    // Pass `--all` to scan every package (private-only included).
    const filtered =
      args.rest.includes('--package') || args.rest.includes('--path') || auditAll
        ? items
        : items.filter(
            i =>
              i.classification === 'public-candidate' ||
              i.classification === 'blocked-by-private-flag' ||
              i.classification === 'blocked-by-private-dependency' ||
              i.classification === 'blocked-by-leak' ||
              i.classification === 'blocked-by-build-shape',
          );

    const auditItems: AuditEnvelopeItem[] = [];
    const errors: ReleaseError[] = [];
    let totalError = 0;
    let totalWarning = 0;

    for (const item of filtered) {
      const packageDir = path.dirname(path.join(cwd, item.manifestPath));
      const hits = await scanPackage(packageDir, { patterns });
      const errorCount = hits.filter(h => h.severity === 'error').length;
      const warningCount = hits.filter(h => h.severity === 'warning').length;
      totalError += errorCount;
      totalWarning += warningCount;

      auditItems.push({
        name: item.name,
        manifestPath: item.manifestPath,
        classification: item.classification,
        hitsBySeverity: { error: errorCount, warning: warningCount },
        hits,
      });

      for (const hit of hits) {
        errors.push({
          code: LEAK_ERROR_CODES.patternMatched,
          severity: hit.severity === 'error' ? 'error' : 'warning',
          message: `${item.name}: ${hit.description} at ${hit.sourcePath}:${hit.line.toString()}:${hit.column.toString()} — "${hit.matchedText}"`,
          target: item.name,
          remediation: 'Remove the leaked identifier or, if intentional, add a config override.',
        });
      }
    }

    const status: 'success' | 'warning' | 'failure' =
      totalError > 0 ? 'failure' : totalWarning > 0 ? 'warning' : 'success';

    const envelope = createEnvelope<AuditEnvelopeItem, AuditSummary>({
      command: 'audit',
      status,
      summary: {
        message:
          totalError === 0 && totalWarning === 0
            ? `Leak scan complete: ${filtered.length.toString()} packages scanned, no hits.`
            : `Leak scan complete: ${filtered.length.toString()} packages, ${totalError.toString()} error hits, ${totalWarning.toString()} warning hits.`,
        packagesScanned: filtered.length,
        totalHits: totalError + totalWarning,
        bySeverity: { error: totalError, warning: totalWarning },
      },
      items: auditItems,
      errors,
    });

    emitEnvelope(envelope, { json: args.json });
    return status === 'failure' ? 1 : 0;
  } catch (cause) {
    if (cause instanceof ReleaseConfigError) {
      const envelope = buildConfigErrorEnvelope('audit', cause);
      emitEnvelope(envelope, { json: args.json });
      return 1;
    }
    throw cause;
  }
}

/** Per-package pack-audit summary item emitted by the pack envelope. */
interface PackEnvelopeItem {
  readonly name: string;
  readonly manifestPath: string;
  readonly classification: string;
  readonly status: 'pass' | 'fail' | 'warn' | 'skipped';
  readonly skipReason?: string;
  readonly result?: PackAuditResult;
}

/** Aggregate summary for the pack envelope. */
interface PackSummary {
  readonly message: string;
  readonly packagesAudited: number;
  readonly byStatus: { readonly pass: number; readonly warn: number; readonly fail: number; readonly skipped: number };
}

/**
 * `pack` subcommand handler — runs `npm pack --dry-run --json` and
 * audits each `public-candidate` package.
 *
 * Only packages classified `public-candidate` are audited; everything
 * else is reported as skipped with a reason so the envelope still
 * documents that the package was considered.
 *
 * Exit codes:
 *   - 0 on success (no fail entries)
 *   - 1 on failure (any fail entries)
 */
async function runPackHandler(args: ParsedCliArgs): Promise<number> {
  try {
    const targets = await resolveAuditTargets(args);
    if ('error' in targets) {
      const envelope = createEnvelope<PackEnvelopeItem, PackSummary>({
        command: 'pack',
        status: 'failure',
        summary: {
          message: targets.error.message,
          packagesAudited: 0,
          byStatus: { pass: 0, warn: 0, fail: 0, skipped: 0 },
        },
        items: [],
        errors: [targets.error],
      });
      emitEnvelope(envelope, { json: args.json });
      return 1;
    }

    const { items, cwd } = targets;
    const packItems: PackEnvelopeItem[] = [];
    const errors: ReleaseError[] = [];
    const counts = { pass: 0, warn: 0, fail: 0, skipped: 0 };

    for (const item of items) {
      if (item.classification !== 'public-candidate') {
        counts.skipped += 1;
        packItems.push({
          name: item.name,
          manifestPath: item.manifestPath,
          classification: item.classification,
          status: 'skipped',
          skipReason: `classification=${item.classification} — only public-candidate packages are pack-audited.`,
        });
        continue;
      }

      const packageDir = path.dirname(path.join(cwd, item.manifestPath));
      // Source distribution is declared in the manifest itself: a `files`
      // array carrying `src` opts the package into shipping raw `.ts`.
      const rawManifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      const auditResult = await auditPack(packageDir, {
        manifest: { name: item.name, version: item.version },
        isSourceDistributed: isSourceDistributedManifest(rawManifest),
      });

      if (!auditResult.ok) {
        counts.fail += 1;
        packItems.push({
          name: item.name,
          manifestPath: item.manifestPath,
          classification: item.classification,
          status: 'fail',
        });
        errors.push({
          code: PACK_ERROR_CODES.packInvocationFailed,
          severity: 'error',
          message: `${item.name}: ${auditResult.error}`,
          target: item.name,
          remediation: 'Inspect the package directory and ensure `npm pack` succeeds locally.',
        });
        continue;
      }

      const result = auditResult.result;
      counts[result.status] += 1;
      packItems.push({
        name: item.name,
        manifestPath: item.manifestPath,
        classification: item.classification,
        status: result.status,
        result,
      });

      for (const hit of result.ruleHits) {
        errors.push({
          code: PACK_ERROR_CODES.packAuditRuleFailed,
          severity: hit.severity === 'error' ? 'error' : 'warning',
          message: `${item.name}: [${hit.ruleId}] ${hit.reason}`,
          target: item.name,
          remediation: hit.description,
        });
      }
    }

    const status: 'success' | 'warning' | 'failure' =
      counts.fail > 0 ? 'failure' : counts.warn > 0 ? 'warning' : 'success';

    const envelope = createEnvelope<PackEnvelopeItem, PackSummary>({
      command: 'pack',
      status,
      summary: {
        message:
          counts.fail === 0 && counts.warn === 0
            ? `Pack audit complete: ${counts.pass.toString()} passed, ${counts.skipped.toString()} skipped.`
            : `Pack audit complete: ${counts.pass.toString()} passed, ${counts.warn.toString()} warned, ${counts.fail.toString()} failed, ${counts.skipped.toString()} skipped.`,
        packagesAudited: counts.pass + counts.warn + counts.fail,
        byStatus: counts,
      },
      items: packItems,
      errors,
    });

    emitEnvelope(envelope, { json: args.json });
    return status === 'failure' ? 1 : 0;
  } catch (cause) {
    if (cause instanceof ReleaseConfigError) {
      const envelope = buildConfigErrorEnvelope('pack', cause);
      emitEnvelope(envelope, { json: args.json });
      return 1;
    }
    throw cause;
  }
}

/**
 * `export-public` subcommand handler.
 *
 * Flags:
 *   --output <path>             Override `config.publicTreePath`. Path
 *                               must resolve inside the workspace root —
 *                               the exporter refuses otherwise.
 *   --no-leak-scan              Disable the pre-output leak gate. The
 *                               exporter records a loud warning when
 *                               this is set.
 *   --include-blocked-by-leak   Attempt packages classified
 *                               `blocked-by-leak` in addition to
 *                               `public-candidate`. Useful for diagnosis.
 *   --no-workspaces-root        Omit `workspaces: ['packages/*']` from
 *                               the materialized root `package.json`.
 *                               Use this when the tree will be the
 *                               source of `npm publish` — npm's
 *                               parent-walk into a workspaces root
 *                               mangles standalone publishes. Default
 *                               keeps the field (dev-friendly for
 *                               `arki-labs/arki` cloners).
 *   --from-working-tree         Read uncommitted files too. Default reads a
 *                               snapshot of HEAD (packages, root
 *                               package.json, release config), so a
 *                               sibling session's unfinished edits never
 *                               reach the public tree. `dist/` is taken
 *                               from the working tree only for packages
 *                               that match HEAD; the others are listed as
 *                               EXPORT_E006 warnings.
 *
 * Exit codes:
 *   - 0 when every candidate exports successfully.
 *   - 1 on any failure.
 */
async function runExportPublicHandler(args: ParsedCliArgs): Promise<number> {
  const cwd = process.cwd();
  const outputOverride = extractOption(args.rest, 'output');
  const leakScan = !args.rest.includes('--no-leak-scan');
  const includeBlockedByLeak = args.rest.includes('--include-blocked-by-leak');
  const skipWorkspacesRoot = args.rest.includes('--no-workspaces-root');
  const fromWorkingTree = args.rest.includes('--from-working-tree');

  let snapshot: SourceSnapshot | undefined;
  try {
    snapshot = fromWorkingTree ? undefined : await createSourceSnapshot({ rootCwd: cwd });
    const sourceRoot = snapshot?.dir ?? cwd;
    const config = await loadConfig(defaultConfigPath(sourceRoot));
    const envelope = await exportPublicTree({
      rootCwd: cwd,
      sourceRoot,
      config,
      ...(outputOverride !== null ? { outputPath: outputOverride } : {}),
      leakScan,
      includeBlockedByLeak,
      skipWorkspacesRoot,
    });
    if (snapshot !== undefined) {
      envelope.summary = {
        ...envelope.summary,
        message: `${envelope.summary.message} Source: commit ${snapshot.commit.slice(0, 10)}.`,
      };
      const exported = new Set(envelope.items.map(item => item.sourcePath));
      envelope.errors.push(...uncommittedSourceWarnings(snapshot, exported));
    }
    emitEnvelope(envelope, { json: args.json });
    return envelope.status === 'failure' ? 1 : 0;
  } catch (cause) {
    if (cause instanceof ReleaseConfigError) {
      const envelope = buildConfigErrorEnvelope('export-public', cause);
      emitEnvelope(envelope, { json: args.json });
      return 1;
    }
    // Last-resort guard: convert unexpected errors into a failure envelope
    // so the operator sees the message via the standard channel.
    const message = cause instanceof Error ? cause.message : String(cause);
    const envelope = createEnvelope<ExportItem, ExportSummary>({
      command: 'export-public',
      status: 'failure',
      summary: {
        message: `Export failed: ${message}`,
        totalCandidates: 0,
        exported: 0,
        skipped: 0,
        failed: 0,
        outputPath: outputOverride ?? '',
      },
      items: [],
      errors: [
        {
          code: EXPORT_ERROR_CODES.materializationFailed,
          severity: 'error',
          message,
          remediation: 'Inspect the stack trace and retry once the underlying issue is fixed.',
        },
      ],
    });
    emitEnvelope(envelope, { json: args.json });
    return 1;
  } finally {
    await snapshot?.cleanup();
  }
}

/** One warning per exported package that differs from the snapshot commit. */
function uncommittedSourceWarnings(snapshot: SourceSnapshot, exported: ReadonlySet<string>): ReleaseError[] {
  return snapshot.dirtyPackages
    .filter(dir => exported.has(dir))
    .map(dir => ({
      code: EXPORT_ERROR_CODES.uncommittedSource,
      severity: 'warning' as const,
      message: `${dir} has uncommitted changes; exported as of commit ${snapshot.commit.slice(0, 10)}, without dist/.`,
      remediation: `Commit ${dir} (and rebuild) to release its current state, or leave it out of this release.`,
    }));
}

/**
 * `fixture` subcommand handler — drive the external fixture matrix
 * against the materialized public tree.
 *
 * Flags:
 *   --package <name>      Restrict the matrix to a single package.
 *   --pm <id>             Restrict the matrix to a single package manager
 *                         (`npm` | `pnpm` | `bun`). May repeat (e.g.
 *                         `--pm npm --pm pnpm`).
 *   --public-tree <path>  Override the default `.release/arki-public`
 *                         path resolved against the workspace root.
 *   --skip-install        Run pack + workspace-leak-check only — skip
 *                         install / import probes. Useful for fast CI
 *                         dry-runs.
 *
 * The handler also appends DOT-fixture forward-dependency stubs so the
 * envelope documents what's planned for Tasks 9 / 10 / 11.5 — these
 * appear as `skipped` runs with severity `info` error entries, never as
 * `success`.
 *
 * Exit codes:
 *   - 0 when every run succeeds.
 *   - 1 on any failure (or if the public tree is missing).
 */
async function runFixtureHandler(args: ParsedCliArgs): Promise<number> {
  const cwd = process.cwd();
  const packageFilter = extractOption(args.rest, 'package');
  const publicTreeOverride = extractOption(args.rest, 'public-tree');
  const skipInstall = args.rest.includes('--skip-install');
  const pmFilters = extractAllOptions(args.rest, 'pm');

  const publicTreePath =
    publicTreeOverride !== null
      ? path.resolve(cwd, publicTreeOverride)
      : path.join(cwd, '.release', 'arki-public');

  const packageManagers: readonly PackageManagerId[] =
    pmFilters.length > 0 ? pmFilters.filter(isPackageManagerId) : DEFAULT_PACKAGE_MANAGERS;

  if (pmFilters.length > 0 && packageManagers.length === 0) {
    const envelope = createEnvelope<FixtureRun, FixtureMatrixSummary>({
      command: 'fixture',
      status: 'failure',
      summary: {
        message: `No supported package manager in --pm filter: ${pmFilters.join(', ')}`,
        totalRuns: 0,
        successCount: 0,
        failureCount: 0,
        skippedCount: 0,
        publicTreePath,
      },
      items: [],
      errors: [
        {
          code: FIXTURE_ERROR_CODES.invalidCliArgument,
          severity: 'error',
          message: `--pm must be one of: ${DEFAULT_PACKAGE_MANAGERS.join(', ')}`,
          remediation: 'Pass one of `--pm npm`, `--pm pnpm`, or `--pm bun` (or omit the flag to run all three).',
        },
      ],
    });
    emitEnvelope(envelope, { json: args.json });
    return 1;
  }

  const envelope = await runFixtureMatrix({
    rootCwd: cwd,
    publicTreePath,
    packageManagers,
    ...(packageFilter !== null ? { packageNames: [packageFilter] } : {}),
    skipInstall,
  });

  emitEnvelope(envelope, { json: args.json });
  return envelope.status === 'failure' ? 1 : 0;
}

/** Extract every value passed via repeating `--<name> <value>` pairs. */
function extractAllOptions(rest: readonly string[], name: string): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === `--${name}`) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        out.push(next);
      }
    }
  }
  return out;
}

function isPackageManagerId(value: string): value is PackageManagerId {
  return value === 'npm' || value === 'pnpm' || value === 'bun';
}

/**
 * Run the CLI when invoked directly (e.g. `bun src/cli.ts inventory`).
 *
 * Bun executes the file top-to-bottom; we use `import.meta.main` to gate
 * the side-effectful dispatch so the module can also be imported for
 * testing without triggering a stdout write.
 */
if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  dispatch(args)
    .then(code => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      // Last-resort guard — should not happen because handlers convert
      // expected errors into envelopes. Surface to stderr and exit 2.
      const message = err instanceof Error ? err.stack ?? err.message : String(err);
      process.stderr.write(`arki-release: unhandled error\n${message}\n`);
      process.exit(2);
    });
}
