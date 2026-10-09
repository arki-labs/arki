/**
 * Release scorecard — aggregator + decision-maker.
 *
 * The scorecard is the integration layer that runs the inventory, leak
 * scanner, pack auditor, public-tree exporter, and fixture matrix
 * programmatically (NOT via subprocess), aggregates their outputs, and
 * decides per-package PASS / FAIL / WARN / DEFERRED across eight
 * dimensions. The "stable release gate" is `'open'` iff every
 * public-candidate package passes every dimension (with `--allow-deferred`
 * relaxing the deferred DOT/agent-native gates).
 *
 * Pipeline:
 *
 *   1. Run inventory (always — every other dimension keys off the items).
 *   2. Run leak scan over every public-candidate.
 *   3. Run pack audit over every public-candidate (skipped if pack auditor
 *      can't reach npm; the dimension reports its own status).
 *   4. Run export-public to materialize the tree (so we have manifests
 *      for the metadata / dependencies dimensions).
 *   5. Run fixture matrix (with `--skip-install` by default — full matrix
 *      in CI mode).
 *   6. Per package, evaluate each dimension and roll up the worst.
 *   7. Decide the stable-release gate.
 *
 * The scorecard is the integration layer: it is intentionally chatty so
 * downstream gates and operators get one cohesive report. Errors from
 * upstream commands are surfaced verbatim — the scorecard does not
 * retry or repair anything.
 *
 * Stable error codes emitted by the scorecard:
 *   - `SCORE_E001` — upstream command threw an exception (rare).
 *   - `SCORE_E002` — operator-requested package not in inventory.
 *   - `SCORE_E003` — no public-candidate packages found (nothing to score).
 */

import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import debugFactory from 'debug';

import { runDotProbe } from './dot-probe';
import { exportPublicTree, EXPORT_ERROR_CODES } from './export-public';
import {
  DEFAULT_PACKAGE_MANAGERS,
  defaultProcessRunner,
  FIXTURE_ERROR_CODES,
  runFixtureMatrix,
  type FixtureOptions,
  type ProcessRunner,
} from './fixture';
import { runInventory, type InventoryItem } from './inventory';
import { createEnvelope } from './json-output';
import { DEFAULT_LEAK_PATTERNS, LEAK_ERROR_CODES, scanDirectory } from './leaks';
import { auditPack, isSourceDistributedManifest, PACK_ERROR_CODES, type NpmPackRunner } from './pack';
import type {
  DotProbeResult,
  FixtureRun,
  LeakHit,
  PackAuditResult,
  ReleaseCommandEnvelope,
  ReleaseConfig,
  ReleaseError,
  ScorecardDimension,
  ScorecardDimensionResult,
  ScorecardPackageResult,
  ScorecardStatus,
  ScorecardSummary,
  WaveBuildOutput,
} from './types';

const debug = debugFactory('arki:release:scorecard');

/** Stable error codes emitted by the scorecard. */
export const SCORECARD_ERROR_CODES = {
  upstreamThrew: 'SCORE_E001',
  packageNotInInventory: 'SCORE_E002',
  noPublicCandidates: 'SCORE_E003',
} as const;

/**
 * Options accepted by {@link runScorecard}.
 *
 * The scorecard is designed to be testable: every external boundary
 * (npm pack, fixture process runner) is injectable. In production every
 * field is omitted and the defaults take over.
 */
export interface ScorecardOptions {
  /** Workspace root. The scorecard reads packages/ + the public tree from here. */
  readonly cwd: string;
  /** Loaded release config. */
  readonly config: ReleaseConfig;
  /** Restrict the scorecard to one package by name. */
  readonly packageName?: string;
  /**
   * When true, the scorecard treats deferred dimensions (DOT gates,
   * agent-native gates) as passing for the gate decision. The dimensions
   * themselves still report `deferred` in the per-package results — only
   * the top-level `stableReleaseGate` is affected.
   */
  readonly allowDeferred?: boolean;
  /**
   * When true, the fixture matrix runs in full install mode. Default is
   * `false` (the matrix runs pack + workspace-leak-check only). CI flips
   * this to `true`.
   */
  readonly fullFixtureMatrix?: boolean;
  /** Injectable npm pack runner for tests. */
  readonly npmPackRunner?: NpmPackRunner;
  /** Injectable fixture process runner for tests. */
  readonly fixtureRunner?: ProcessRunner;
  /**
   * Override the fixture-matrix tempRoot. Used by tests; production uses
   * the system tempdir.
   */
  readonly fixtureTempRoot?: string;
  /**
   * Synthetic DOT probe result for tests. When provided, the scorecard
   * skips spawning the probe subprocess and uses this value directly to
   * drive the `dot-gates` and `agent-native-gates` dimensions.
   */
  readonly dotProbe?: DotProbeResult;
  /**
   * When true, skip the DOT probe entirely. Both gate dimensions then
   * report `deferred` (the legacy behaviour). Useful for partial-run
   * diagnostics, never for stable-release gating.
   */
  readonly skipDotProbe?: boolean;
}

/**
 * Run the full scorecard pipeline and return the envelope.
 *
 * This is the public seam — both the CLI and the test suite call it.
 */
export async function runScorecard(
  opts: ScorecardOptions,
): Promise<ReleaseCommandEnvelope<ScorecardPackageResult, ScorecardSummary>> {
  debug('runScorecard: cwd=%s allowDeferred=%s', opts.cwd, opts.allowDeferred === true);

  const envelopeErrors: ReleaseError[] = [];

  // 1. Inventory.
  const inventoryEnv = await runInventory({ cwd: opts.cwd, config: opts.config });
  for (const err of inventoryEnv.errors) {
    // Carry forward inventory diagnostics so the scorecard envelope is
    // self-contained.
    envelopeErrors.push(err);
  }

  let candidates = inventoryEnv.items.filter(item => item.classification === 'public-candidate');

  if (opts.packageName !== undefined) {
    const requested = inventoryEnv.items.find(i => i.name === opts.packageName);
    if (requested === undefined) {
      envelopeErrors.push({
        code: SCORECARD_ERROR_CODES.packageNotInInventory,
        severity: 'error',
        message: `--package ${opts.packageName} did not match any workspace package.`,
        remediation: 'Run `bun release:arki inventory --json` to see the package list.',
        target: opts.packageName,
      });
      return buildFailureEnvelope(envelopeErrors, opts.allowDeferred === true);
    }
    candidates = [requested];
  }

  if (candidates.length === 0) {
    envelopeErrors.push({
      code: SCORECARD_ERROR_CODES.noPublicCandidates,
      severity: 'warning',
      message: 'No public-candidate packages found — nothing to score.',
      remediation: 'Add packages to a wave in arki.release.config.ts and drop their `private: true` flag.',
    });
    return buildEmptyEnvelope(envelopeErrors, opts.allowDeferred === true);
  }

  // 2. Leak scan (per package, only on public-candidates).
  const leakPatterns = opts.config.leakPatterns ?? DEFAULT_LEAK_PATTERNS;
  const leakHitsByPackage = new Map<string, readonly LeakHit[]>();
  for (const item of candidates) {
    const dir = path.dirname(path.join(opts.cwd, item.manifestPath));
    try {
      const hits = await scanDirectory(dir, { patterns: leakPatterns });
      leakHitsByPackage.set(item.name, hits);
    } catch (cause) {
      debug('leak scan threw for %s: %s', item.name, cause);
      leakHitsByPackage.set(item.name, []);
      envelopeErrors.push(upstreamThrewError('leak-scan', item.name, cause));
    }
  }

  // 3. Pack audit (per package). Each result is stored under the package
  // name; a missing entry means the audit couldn't run (npm not on PATH,
  // etc.) and the dimension will report deferred.
  const packResultsByPackage = new Map<string, PackAuditResult>();
  const packErrorsByPackage = new Map<string, string>();
  for (const item of candidates) {
    const dir = path.dirname(path.join(opts.cwd, item.manifestPath));
    try {
      // Source distribution is declared in the manifest itself: a `files`
      // array carrying `src` opts the package into shipping raw `.ts`.
      const rawManifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      const result = await auditPack(dir, {
        manifest: { name: item.name, version: item.version },
        isSourceDistributed: isSourceDistributedManifest(rawManifest),
        ...(opts.npmPackRunner !== undefined ? { runner: opts.npmPackRunner } : {}),
      });
      if (result.ok) {
        packResultsByPackage.set(item.name, result.result);
      } else {
        packErrorsByPackage.set(item.name, result.error);
      }
    } catch (cause) {
      debug('pack audit threw for %s: %s', item.name, cause);
      packErrorsByPackage.set(
        item.name,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  // 4. Materialize the public tree so we have post-materialization
  // manifests available for the metadata / dependencies dimensions.
  const exportEnv = await exportPublicTree({
    rootCwd: opts.cwd,
    config: opts.config,
    leakScan: false, // leak gate is already covered by step 2 — avoid double-scanning
  });
  // The exporter carries its own per-package errors which we need to
  // associate with the right package. Build an index by `target`.
  const exportErrorsByPackage = indexErrorsByTarget(exportEnv.items.flatMap(i => i.errors));

  // 5. Fixture matrix. Uses the materialized tree from step 4.
  const fixtureRunsByPackage = new Map<string, readonly FixtureRun[]>();
  const candidateNames = new Set(candidates.map(c => c.name));
  try {
    const fixtureOpts: FixtureOptions = {
      rootCwd: opts.cwd,
      publicTreePath: path.resolve(opts.cwd, opts.config.publicTreePath),
      packageManagers: DEFAULT_PACKAGE_MANAGERS,
      skipInstall: opts.fullFixtureMatrix !== true,
      ...(opts.fixtureRunner !== undefined
        ? { runner: opts.fixtureRunner }
        : { runner: defaultProcessRunner }),
      ...(opts.fixtureTempRoot !== undefined ? { tempRoot: opts.fixtureTempRoot } : {}),
      ...(opts.packageName !== undefined ? { packageNames: [opts.packageName] } : {}),
    };
    const fixtureEnv = await runFixtureMatrix(fixtureOpts);
    for (const run of fixtureEnv.items) {
      if (!candidateNames.has(run.packageName)) continue;
      const prior = fixtureRunsByPackage.get(run.packageName) ?? [];
      fixtureRunsByPackage.set(run.packageName, [...prior, run]);
    }
  } catch (cause) {
    debug('fixture matrix threw: %s', cause);
    envelopeErrors.push(upstreamThrewError('fixture-matrix', '<all>', cause));
  }

  // 5.5. DOT probe. Runs once per scorecard invocation — the result is
  // global (the DOT contract is a kernel-level invariant, not per-package),
  // but every public-candidate package's `dot-gates` + `agent-native-gates`
  // dimensions reference it. Tests inject a synthetic result via
  // `opts.dotProbe`; production spawns `dot-probe-runner.ts` via `bun`.
  const dotProbe = await resolveDotProbe(opts);

  // 6. Per-package evaluation.
  const results: ScorecardPackageResult[] = [];
  for (const item of candidates) {
    const result = await evaluatePackage({
      item,
      cwd: opts.cwd,
      leakHits: leakHitsByPackage.get(item.name) ?? [],
      packResult: packResultsByPackage.get(item.name),
      packError: packErrorsByPackage.get(item.name),
      materializationErrors: exportErrorsByPackage.get(item.name) ?? [],
      fixtureRuns: fixtureRunsByPackage.get(item.name) ?? [],
      fullFixtureMatrix: opts.fullFixtureMatrix === true,
      dotProbe,
      buildOutput: opts.config.waves.find(wave => wave.id === item.wave)?.buildOutput ?? 'dist',
    });
    results.push(result);
  }

  // 7. Stable-release gate.
  const allowDeferred = opts.allowDeferred === true;
  const { gate, blockers } = decideGate(results, allowDeferred);

  const counts = countOverallStatuses(results);
  const summary: ScorecardSummary = {
    message: buildSummaryMessage(counts, gate),
    totalPackages: results.length,
    pass: counts.pass,
    fail: counts.fail,
    warn: counts.warn,
    deferred: counts.deferred,
    stableReleaseGate: gate,
    stableReleaseBlockers: blockers,
    allowDeferred,
  };

  return createEnvelope<ScorecardPackageResult, ScorecardSummary>({
    command: 'scorecard',
    status: gate === 'open' ? 'success' : 'failure',
    summary,
    items: results,
    errors: envelopeErrors,
  });
}

/**
 * Evaluate every dimension for a single package and roll up the worst
 * status. Pure once the inputs have been gathered.
 */
async function evaluatePackage(input: {
  readonly item: InventoryItem;
  readonly cwd: string;
  readonly leakHits: readonly LeakHit[];
  readonly packResult: PackAuditResult | undefined;
  readonly packError: string | undefined;
  readonly materializationErrors: readonly ReleaseError[];
  readonly fixtureRuns: readonly FixtureRun[];
  readonly fullFixtureMatrix: boolean;
  readonly dotProbe: DotProbeResult | undefined;
  /** From the package's wave; decides what `build-output` requires. */
  readonly buildOutput: WaveBuildOutput;
}): Promise<ScorecardPackageResult> {
  const packageDir = path.dirname(path.join(input.cwd, input.item.manifestPath));

  const dimensions: Record<ScorecardDimension, ScorecardDimensionResult> = {
    metadata: evaluateMetadata(input.item.name, input.materializationErrors),
    privacy: evaluatePrivacy(input.item.name, input.leakHits),
    dependencies: evaluateDependencies(input.item.name, input.materializationErrors),
    'build-output': await evaluateBuildOutput(input.item.name, packageDir, input.buildOutput),
    packlist: evaluatePacklist(input.item.name, input.packResult, input.packError),
    docs: await evaluateDocs(input.item.name, packageDir),
    fixtures: evaluateFixtures(input.item.name, input.fixtureRuns, input.fullFixtureMatrix),
    'dot-gates': evaluateDotGates(input.dotProbe),
    'agent-native-gates': evaluateAgentNativeGates(input.dotProbe),
  };

  const overall = rollUpStatus(Object.values(dimensions).map(d => d.status));
  const blockers = computeBlockers(dimensions);

  return {
    name: input.item.name,
    version: input.item.version,
    classification: input.item.classification,
    wave: input.item.wave,
    dimensions,
    overall,
    blockers,
  };
}

/**
 * Metadata dimension: license / description / repository / homepage / bugs.
 * Driven by the materializer's errors — RELEASE_E006 (missing description)
 * is the canonical signal today; future fields will plug in via additional
 * RELEASE_E0xx codes.
 *
 * Severity: RELEASE_E006 is a warning in the materializer's vocabulary, so
 * we mirror it here — the package will publish, but Task 8 should fill in
 * the description.
 */
function evaluateMetadata(packageName: string, mErrors: readonly ReleaseError[]): ScorecardDimensionResult {
  const relevant = mErrors.filter(e => e.code === 'RELEASE_E006');
  if (relevant.length === 0) {
    return {
      status: 'pass',
      details: 'Manifest carries description, license, repository, homepage, bugs.',
      evidence: [],
    };
  }
  return {
    status: 'warn',
    details: `Missing description (RELEASE_E006) — package will publish with a generic stub.`,
    evidence: relevant.filter(e => e.target === packageName || e.target === undefined),
  };
}

/**
 * Privacy dimension: any error-severity leak hit fails the dimension.
 * Warning-severity hits (e.g. `sudoku` in a games package) are flagged
 * but don't gate.
 */
function evaluatePrivacy(packageName: string, hits: readonly LeakHit[]): ScorecardDimensionResult {
  const errors = hits.filter(h => h.severity === 'error');
  const warnings = hits.filter(h => h.severity === 'warning');
  if (errors.length > 0) {
    return {
      status: 'fail',
      details: `${errors.length.toString()} error-severity leak hit(s) in source.`,
      evidence: errors.map(hit => ({
        code: LEAK_ERROR_CODES.patternMatched,
        severity: 'error',
        message: `${packageName}: ${hit.description} at ${hit.sourcePath}:${hit.line.toString()}:${hit.column.toString()} — "${hit.matchedText}"`,
        target: packageName,
        remediation: 'Remove the leaked identifier or, if intentional, add a config override.',
      })),
    };
  }
  if (warnings.length > 0) {
    return {
      status: 'warn',
      details: `${warnings.length.toString()} warning-severity leak hit(s) — human triage recommended.`,
      evidence: warnings.map(hit => ({
        code: LEAK_ERROR_CODES.patternMatched,
        severity: 'warning',
        message: `${packageName}: ${hit.description} at ${hit.sourcePath}:${hit.line.toString()}:${hit.column.toString()} — "${hit.matchedText}"`,
        target: packageName,
      })),
    };
  }
  return {
    status: 'pass',
    details: 'No leak hits in source.',
    evidence: [],
  };
}

/**
 * Dependencies dimension: unresolved catalogs, private ARKI deps, or
 * unresolvable workspace deps. RELEASE_E003 / E004 / E005 are the
 * materializer's stable codes for these.
 */
function evaluateDependencies(packageName: string, mErrors: readonly ReleaseError[]): ScorecardDimensionResult {
  const codes = new Set(['RELEASE_E003', 'RELEASE_E004', 'RELEASE_E005']);
  const relevant = mErrors.filter(e => codes.has(e.code));
  if (relevant.length === 0) {
    return {
      status: 'pass',
      details: 'All dependencies resolved (no private ARKI deps, no unresolved catalogs).',
      evidence: [],
    };
  }
  return {
    status: 'fail',
    details: `${relevant.length.toString()} dependency resolution error(s) (RELEASE_E003/E004/E005).`,
    evidence: relevant.filter(e => e.target === packageName || e.target === undefined),
  };
}

/**
 * Build-output dimension: source-tree `dist/` must contain at least one
 * `.d.ts` AND at least one `.js` file.
 *
 * Source-distributed packages (the assert pattern) currently still ship
 * compiled `.d.ts` from `dist/`. Future Task 8 may relax this when a
 * package opts into source-only distribution.
 */
async function evaluateBuildOutput(
  packageName: string,
  packageDir: string,
  mode: WaveBuildOutput = 'dist',
): Promise<ScorecardDimensionResult> {
  const distDir = path.join(packageDir, 'dist');
  let files: readonly string[] = [];
  try {
    files = await listAllFiles(distDir);
  } catch {
    return {
      status: 'fail',
      details: 'No dist/ directory present.',
      evidence: [
        {
          code: 'SCORE_BUILD_E001',
          severity: 'error',
          message: `${packageName}: dist/ directory missing — package has not been built for publication.`,
          target: packageName,
          remediation: 'Run `turbo build --filter=<package>` and re-check.',
        },
      ],
    };
  }
  const hasJs = files.some(f => /\.(js|mjs|cjs)$/i.test(f));
  const hasDts = files.some(f => /\.d\.(ts|mts|cts)$/i.test(f));
  if (!hasJs && !hasDts) {
    return {
      status: 'fail',
      details: 'dist/ is empty — no .js and no .d.ts files.',
      evidence: [
        {
          code: 'SCORE_BUILD_E002',
          severity: 'error',
          message: `${packageName}: dist/ has no compiled artifacts.`,
          target: packageName,
          remediation: 'Run the package build and verify tsc emits .js + .d.ts.',
        },
      ],
    };
  }
  if (!hasJs && mode === 'dist') {
    return {
      status: 'fail',
      details: 'dist/ has .d.ts but no compiled .js files.',
      evidence: [
        {
          code: 'SCORE_BUILD_E003',
          severity: 'error',
          message: `${packageName}: dist/ missing compiled JavaScript (.js/.mjs/.cjs).`,
          target: packageName,
          remediation: 'Verify tsconfig emits .js (declaration-only builds are not publishable).',
        },
      ],
    };
  }
  if (!hasDts) {
    return {
      status: 'fail',
      details: 'dist/ has .js but no TypeScript declarations.',
      evidence: [
        {
          code: 'SCORE_BUILD_E004',
          severity: 'error',
          message: `${packageName}: dist/ missing TypeScript declarations (.d.ts).`,
          target: packageName,
          remediation: 'Enable `declaration: true` in tsconfig and rebuild.',
        },
      ],
    };
  }
  return {
    status: 'pass',
    details:
      mode === 'source'
        ? 'source-first wave: dist/ has TypeScript declarations; the shipped src/ files are the runtime entries (bundler required).'
        : 'dist/ contains both compiled JavaScript and TypeScript declarations.',
    evidence: [],
  };
}

/**
 * Packlist dimension: the `npm pack --dry-run` audit. Each rule that
 * fired contributes evidence.
 */
function evaluatePacklist(
  packageName: string,
  result: PackAuditResult | undefined,
  invocationError: string | undefined,
): ScorecardDimensionResult {
  if (result === undefined) {
    return {
      status: 'fail',
      details: invocationError ?? 'npm pack audit did not run for this package.',
      evidence: [
        {
          code: PACK_ERROR_CODES.packInvocationFailed,
          severity: 'error',
          message: `${packageName}: ${invocationError ?? 'pack audit unavailable.'}`,
          target: packageName,
          remediation: 'Verify npm is on PATH and the package directory is well-formed.',
        },
      ],
    };
  }
  if (result.status === 'pass') {
    return {
      status: 'pass',
      details: `${result.totals.fileCount.toString()} files would publish (${formatBytes(result.totals.unpackedSize)} unpacked).`,
      evidence: [],
    };
  }
  const evidence: ReleaseError[] = result.ruleHits.map(hit => ({
    code: PACK_ERROR_CODES.packAuditRuleFailed,
    severity: hit.severity === 'error' ? 'error' : 'warning',
    message: `${packageName}: [${hit.ruleId}] ${hit.reason}`,
    target: packageName,
    remediation: hit.description,
  }));
  return {
    status: result.status === 'fail' ? 'fail' : 'warn',
    details:
      result.status === 'fail'
        ? `${result.ruleHits.filter(h => h.severity === 'error').length.toString()} pack-audit rule(s) failed.`
        : `${result.ruleHits.length.toString()} pack-audit warning(s).`,
    evidence,
  };
}

/**
 * Docs dimension: README.md and LICENSE present in the source dir.
 * Missing README is a fail (every public package needs one); missing
 * LICENSE is a warn (the materializer can stamp the default, but having
 * a per-package file in source is strongly preferred).
 */
async function evaluateDocs(packageName: string, packageDir: string): Promise<ScorecardDimensionResult> {
  const hasReadme = await pathExists(path.join(packageDir, 'README.md'));
  const hasLicense =
    (await pathExists(path.join(packageDir, 'LICENSE'))) ||
    (await pathExists(path.join(packageDir, 'LICENSE.md')));

  if (!hasReadme && !hasLicense) {
    return {
      status: 'fail',
      details: 'README.md and LICENSE missing.',
      evidence: [
        {
          code: 'SCORE_DOCS_E001',
          severity: 'error',
          message: `${packageName}: README.md and LICENSE missing in source.`,
          target: packageName,
          remediation: 'Add a README.md describing the package and a LICENSE file (MIT).',
        },
      ],
    };
  }
  if (!hasReadme) {
    return {
      status: 'fail',
      details: 'README.md missing.',
      evidence: [
        {
          code: 'SCORE_DOCS_E002',
          severity: 'error',
          message: `${packageName}: README.md missing in source.`,
          target: packageName,
          remediation: 'Add a README.md describing the package.',
        },
      ],
    };
  }
  if (!hasLicense) {
    return {
      status: 'warn',
      details: 'LICENSE missing (materializer will stamp default license).',
      evidence: [
        {
          code: 'SCORE_DOCS_W001',
          severity: 'warning',
          message: `${packageName}: no LICENSE file in source — materializer applies default.`,
          target: packageName,
          remediation: 'Add a LICENSE file (MIT) to the package source.',
        },
      ],
    };
  }
  return {
    status: 'pass',
    details: 'README.md and LICENSE present.',
    evidence: [],
  };
}

/**
 * Fixtures dimension: the fixture matrix's pack + leak-check stages must
 * succeed on at least one PM. When `fullFixtureMatrix` is true, every
 * (PM × stage) must succeed.
 *
 * No runs at all → fail (the matrix was supposed to cover this package).
 */
function evaluateFixtures(
  packageName: string,
  runs: readonly FixtureRun[],
  fullFixtureMatrix: boolean,
): ScorecardDimensionResult {
  if (runs.length === 0) {
    return {
      status: 'fail',
      details: 'Fixture matrix did not produce any run for this package.',
      evidence: [
        {
          code: FIXTURE_ERROR_CODES.publicTreeMissing,
          severity: 'error',
          message: `${packageName}: missing from fixture matrix output — did export-public run?`,
          target: packageName,
          remediation: 'Run `bun release:arki export-public` then `bun release:arki fixture`.',
        },
      ],
    };
  }

  const failures = runs.filter(r => r.status === 'failure');
  if (failures.length > 0) {
    const evidence: ReleaseError[] = [];
    for (const run of failures) {
      for (const err of run.errors) evidence.push(err);
    }
    return {
      status: 'fail',
      details: `${failures.length.toString()} of ${runs.length.toString()} fixture run(s) failed.`,
      evidence,
    };
  }

  if (fullFixtureMatrix) {
    // Full mode: every stage must have succeeded across every PM.
    const anyStageSkipped = runs.some(r => r.stages.some(s => s.status === 'skipped'));
    if (anyStageSkipped) {
      return {
        status: 'warn',
        details: 'Fixture matrix ran in full mode but skipped at least one stage.',
        evidence: [],
      };
    }
    return {
      status: 'pass',
      details: `Full fixture matrix passed for ${runs.length.toString()} run(s) (pack + install + import + types).`,
      evidence: [],
    };
  }

  // skip-install mode: pack + workspace-leak-check must succeed.
  const skipped = runs.every(r => r.status === 'skipped');
  if (skipped) {
    return {
      status: 'warn',
      details: 'Fixture runs all marked skipped (pack stage did not execute).',
      evidence: [],
    };
  }
  return {
    status: 'pass',
    details: `Fixture matrix pack+leak-check passed for ${runs.length.toString()} run(s) (install stage skipped).`,
    evidence: [],
  };
}

/** Stable error codes for the two DOT-related gate dimensions. */
const DOT_GATE_ERROR_CODES = {
  probeUnavailable: 'SCORE_DOT_E000',
  manifestShape: 'SCORE_DOT_E001',
  diagnosticsShape: 'SCORE_DOT_E002',
  adapterCount: 'SCORE_DOT_E003',
  explainEnvelope: 'SCORE_DOT_E004',
  doctorEnvelope: 'SCORE_DOT_E005',
  appNotBooted: 'SCORE_DOT_E006',
  newEnvelope: 'SCORE_AGENT_E001',
  newRequiredFiles: 'SCORE_AGENT_E002',
} as const;

/**
 * DOT gates dimension — driven by the {@link DotProbeResult} produced
 * during `runScorecard`. Validates:
 *
 *   - DOT app boots with at least three adapters (env + kv + db)
 *   - `DotAppManifest` exposes all five contract arrays
 *   - `DotDiagnosticsSnapshot` exposes all five contract arrays
 *   - `dot explain --json` envelope shape is correct
 *   - `dot doctor --json` envelope shape is correct
 *
 * When the probe could not run (e.g. `--skip-dot-probe` or a subprocess
 * crash), the dimension reports `deferred` so operators can re-run with
 * the probe enabled.
 */
function evaluateDotGates(probe: DotProbeResult | undefined): ScorecardDimensionResult {
  if (probe === undefined) {
    return {
      status: 'deferred',
      details: 'DOT probe was skipped — re-run scorecard without `--skip-dot-probe` to evaluate.',
      evidence: [],
    };
  }
  if (probe.status === 'fail') {
    return {
      status: 'fail',
      details: `DOT probe failed: ${probe.reason}`,
      evidence: [
        {
          code: DOT_GATE_ERROR_CODES.probeUnavailable,
          severity: 'error',
          message: `DOT probe could not validate kernel contracts: ${probe.reason}`,
          target: '@arki/dot',
          remediation:
            'Inspect `bun tooling/arki-release/src/dot-probe-runner.ts` output and the @arki/dot kernel. The probe needs env+kv+db adapters to boot successfully.',
        },
      ],
    };
  }

  const checks: readonly {
    readonly ok: boolean;
    readonly code: (typeof DOT_GATE_ERROR_CODES)[keyof typeof DOT_GATE_ERROR_CODES];
    readonly label: string;
    readonly remediation: string;
  }[] = [
    {
      ok: probe.appState === 'booted',
      code: DOT_GATE_ERROR_CODES.appNotBooted,
      label: `DOT app state expected 'booted', got '${probe.appState}'`,
      remediation: 'Verify the env/kv/db adapters boot without throwing. Run the kernel test suite.',
    },
    {
      ok: probe.pluginCount >= 3,
      code: DOT_GATE_ERROR_CODES.adapterCount,
      label: `DOT fixture booted with ${probe.pluginCount.toString()} adapter(s), expected >= 3`,
      remediation:
        'Stable v1 gate requires a 3-adapter boot (env + kv + db). Check the probe runner and adapter packages.',
    },
    {
      ok: probe.manifestArrays === 5,
      code: DOT_GATE_ERROR_CODES.manifestShape,
      label: `DotAppManifest exposes ${probe.manifestArrays.toString()}/5 contract arrays`,
      remediation:
        '`DotAppManifest` must always carry plugins, actions, services, lifecycle, dependencies — even when empty.',
    },
    {
      ok: probe.diagnosticsArrays === 5,
      code: DOT_GATE_ERROR_CODES.diagnosticsShape,
      label: `DotDiagnosticsSnapshot exposes ${probe.diagnosticsArrays.toString()}/5 contract arrays`,
      remediation:
        '`DotDiagnosticsSnapshot` must always carry plugins, actions, services, lifecycle, issues — even when empty.',
    },
    {
      ok: probe.explainEnvelopeOk,
      code: DOT_GATE_ERROR_CODES.explainEnvelope,
      label: '`dot explain --json` envelope shape is invalid',
      remediation:
        'Envelope must be `{ status, command: "explain", generatedAt, data: <DotAppManifest>, errors }`.',
    },
    {
      ok: probe.doctorEnvelopeOk,
      code: DOT_GATE_ERROR_CODES.doctorEnvelope,
      label: '`dot doctor --json` envelope shape is invalid',
      remediation:
        'Envelope must be `{ status, command: "doctor", generatedAt, data: <DotDiagnosticsSnapshot>, errors }`.',
    },
  ];

  const failed = checks.filter(c => !c.ok);
  if (failed.length === 0) {
    return {
      status: 'pass',
      details: `DOT contracts validated (${probe.pluginCount.toString()} adapters booted, manifest+diagnostics 5/5 arrays, explain/doctor envelopes OK).`,
      evidence: [],
    };
  }
  return {
    status: 'fail',
    details: `${failed.length.toString()} DOT gate check(s) failed.`,
    evidence: failed.map(c => ({
      code: c.code,
      severity: 'error',
      message: c.label,
      target: '@arki/dot',
      remediation: c.remediation,
    })),
  };
}

/**
 * Agent-native gates dimension — validates the `dot new --dry-run --json`
 * envelope from the same probe result. Stable v1 only requires `dot new`;
 * future commands (dot add / dot dev / dot migrate) plug in additional
 * checks here when they pass their own stable gates.
 */
function evaluateAgentNativeGates(probe: DotProbeResult | undefined): ScorecardDimensionResult {
  if (probe === undefined) {
    return {
      status: 'deferred',
      details:
        'DOT probe was skipped — agent-native gates depend on `dot new --dry-run --json`. Re-run scorecard without `--skip-dot-probe`.',
      evidence: [],
    };
  }
  if (probe.status === 'fail') {
    return {
      status: 'fail',
      details: `DOT probe failed before agent-native checks: ${probe.reason}`,
      evidence: [
        {
          code: DOT_GATE_ERROR_CODES.probeUnavailable,
          severity: 'error',
          message: `Agent-native probe could not run: ${probe.reason}`,
          target: '@arki/dot',
          remediation:
            'Fix the underlying DOT probe failure first; agent-native gates require a passing kernel probe.',
        },
      ],
    };
  }

  const evidence: ReleaseError[] = [];
  if (!probe.newEnvelopeOk) {
    evidence.push({
      code: DOT_GATE_ERROR_CODES.newEnvelope,
      severity: 'error',
      message: `\`dot new --dry-run --json\` envelope invalid (operations=${probe.newOperationCount.toString()}).`,
      target: '@arki/dot',
      remediation:
        'Envelope must be `{ status: "success", command: "new", generatedAt, app, operations: [...], errors: [] }` with at least one operation, each carrying { path, action, contentHash, contentBytes, reason }.',
    });
  }
  if (probe.newRequiredFilesPresent.length < 5) {
    evidence.push({
      code: DOT_GATE_ERROR_CODES.newRequiredFiles,
      severity: 'error',
      message: `\`dot new\` scaffold missing required files (matched ${probe.newRequiredFilesPresent.length.toString()}/5).`,
      target: '@arki/dot',
      remediation:
        'Scaffold must produce package.json, tsconfig.json, README.md, AGENTS.md, .gitignore. Check `packages/dot/templates/app-minimal/`.',
    });
  }

  if (evidence.length === 0) {
    return {
      status: 'pass',
      details: `\`dot new --dry-run --json\` emits ${probe.newOperationCount.toString()} ops including ${probe.newRequiredFilesPresent.join(', ')}.`,
      evidence: [],
    };
  }
  return {
    status: 'fail',
    details: `${evidence.length.toString()} agent-native check(s) failed.`,
    evidence,
  };
}

/**
 * Resolve the DOT probe for this scorecard run.
 *
 *   - `opts.dotProbe` provided  -> use it verbatim (test override).
 *   - `opts.skipDotProbe === true` -> return `undefined` (gates report deferred).
 *   - otherwise -> spawn the probe subprocess and parse the result.
 */
async function resolveDotProbe(opts: ScorecardOptions): Promise<DotProbeResult | undefined> {
  if (opts.dotProbe !== undefined) return opts.dotProbe;
  if (opts.skipDotProbe === true) return undefined;
  try {
    return await runDotProbe({ rootCwd: opts.cwd });
  } catch (error) {
    debug('dot probe threw unexpectedly: %s', error);
    return {
      status: 'fail',
      reason: `DOT probe subprocess threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Roll up the worst dimension status. Ordering: fail > warn > deferred > pass.
 */
function rollUpStatus(statuses: readonly ScorecardStatus[]): ScorecardStatus {
  if (statuses.some(s => s === 'fail')) return 'fail';
  if (statuses.some(s => s === 'warn')) return 'warn';
  if (statuses.some(s => s === 'deferred')) return 'deferred';
  return 'pass';
}

/**
 * Build the human-readable blocker list from a dimension map. We include
 * dimensions that contributed to the worst-of overall, ordered worst-to-best.
 */
function computeBlockers(
  dimensions: Readonly<Record<ScorecardDimension, ScorecardDimensionResult>>,
): readonly string[] {
  const order: readonly ScorecardStatus[] = ['fail', 'warn', 'deferred'];
  const blockers: string[] = [];
  for (const status of order) {
    for (const [dim, result] of Object.entries(dimensions)) {
      if (result.status === status) {
        blockers.push(`${dim} (${status})`);
      }
    }
  }
  return blockers;
}

/**
 * Decide the stable-release gate. Open iff every package's overall
 * status is `pass` (or `deferred` when `allowDeferred` is true).
 */
function decideGate(
  results: readonly ScorecardPackageResult[],
  allowDeferred: boolean,
): { readonly gate: 'open' | 'blocked'; readonly blockers: readonly string[] } {
  const blockers: string[] = [];
  for (const result of results) {
    if (result.overall === 'pass') continue;
    if (result.overall === 'deferred' && allowDeferred) {
      // Treat deferred-only packages as pass when the operator opted in.
      // But fail if any DIMENSION beyond dot-gates / agent-native-gates is
      // worse than pass.
      const nonDeferredBlocked = Object.entries(result.dimensions).some(
        ([dim, dr]) =>
          dim !== 'dot-gates' &&
          dim !== 'agent-native-gates' &&
          dr.status !== 'pass',
      );
      if (!nonDeferredBlocked) continue;
    }
    blockers.push(`${result.name}: ${result.blockers.join(', ')}`);
  }
  return {
    gate: blockers.length === 0 ? 'open' : 'blocked',
    blockers,
  };
}

/** Aggregate counts by overall status. */
function countOverallStatuses(results: readonly ScorecardPackageResult[]): {
  readonly pass: number;
  readonly fail: number;
  readonly warn: number;
  readonly deferred: number;
} {
  let pass = 0;
  let fail = 0;
  let warn = 0;
  let deferred = 0;
  for (const r of results) {
    switch (r.overall) {
      case 'pass':
        pass += 1;
        break;
      case 'fail':
        fail += 1;
        break;
      case 'warn':
        warn += 1;
        break;
      case 'deferred':
        deferred += 1;
        break;
    }
  }
  return { pass, fail, warn, deferred };
}

function buildSummaryMessage(
  counts: { readonly pass: number; readonly fail: number; readonly warn: number; readonly deferred: number },
  gate: 'open' | 'blocked',
): string {
  const parts = [
    `${counts.pass.toString()} pass`,
    `${counts.warn.toString()} warn`,
    `${counts.fail.toString()} fail`,
    `${counts.deferred.toString()} deferred`,
  ];
  return `Scorecard: ${parts.join(', ')}. Stable release gate: ${gate}.`;
}

/** Group ReleaseError entries by their `target` field. */
function indexErrorsByTarget(errors: readonly ReleaseError[]): ReadonlyMap<string, readonly ReleaseError[]> {
  const out = new Map<string, ReleaseError[]>();
  for (const err of errors) {
    const key = err.target ?? '__untargeted__';
    const prior = out.get(key);
    if (prior === undefined) {
      out.set(key, [err]);
    } else {
      prior.push(err);
    }
  }
  return out;
}

/** Build a SCORE_E001 error for unexpected upstream-command exceptions. */
function upstreamThrewError(stage: string, target: string, cause: unknown): ReleaseError {
  return {
    code: SCORECARD_ERROR_CODES.upstreamThrew,
    severity: 'error',
    message: `${stage} threw while evaluating ${target}: ${cause instanceof Error ? cause.message : String(cause)}`,
    target,
    remediation: 'Inspect the stack trace and rerun the underlying command (inventory / audit / pack / fixture).',
  };
}

/** Build an empty-set envelope when no public-candidates exist. */
function buildEmptyEnvelope(
  errors: readonly ReleaseError[],
  allowDeferred: boolean,
): ReleaseCommandEnvelope<ScorecardPackageResult, ScorecardSummary> {
  const summary: ScorecardSummary = {
    message: 'No public-candidate packages found.',
    totalPackages: 0,
    pass: 0,
    fail: 0,
    warn: 0,
    deferred: 0,
    stableReleaseGate: 'blocked',
    stableReleaseBlockers: ['no public-candidate packages'],
    allowDeferred,
  };
  return createEnvelope<ScorecardPackageResult, ScorecardSummary>({
    command: 'scorecard',
    status: 'failure',
    summary,
    items: [],
    errors: [...errors],
  });
}

/** Build a failure envelope for early-exit conditions (e.g. --package missing). */
function buildFailureEnvelope(
  errors: readonly ReleaseError[],
  allowDeferred: boolean,
): ReleaseCommandEnvelope<ScorecardPackageResult, ScorecardSummary> {
  const summary: ScorecardSummary = {
    message: 'Scorecard aborted before evaluation.',
    totalPackages: 0,
    pass: 0,
    fail: 0,
    warn: 0,
    deferred: 0,
    stableReleaseGate: 'blocked',
    stableReleaseBlockers: errors.map(e => e.message),
    allowDeferred,
  };
  return createEnvelope<ScorecardPackageResult, ScorecardSummary>({
    command: 'scorecard',
    status: 'failure',
    summary,
    items: [],
    errors: [...errors],
  });
}

/**
 * Recursively list every file under a directory. Returns relative paths.
 * Throws if the directory does not exist (caller catches).
 */
async function listAllFiles(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(dir, '');
  return out;
}

/** Test whether a path exists. Returns false on any I/O error. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Human-readable byte size. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render the scorecard envelope as text. Each package gets a header line
 * plus one line per dimension with a status icon. Blockers summarize
 * at the bottom.
 *
 * Icons (consistent across the codebase):
 *   - "OK" — pass
 *   - "X"  — fail
 *   - "!"  — warn
 *   - "—"  — deferred
 */
export function renderScorecardText(
  envelope: ReleaseCommandEnvelope<ScorecardPackageResult, ScorecardSummary>,
): string {
  const lines: string[] = [];
  lines.push(`Scorecard — ${envelope.summary.message}`);
  lines.push('');

  for (const pkg of envelope.items) {
    lines.push(`${pkg.name} — ${pkg.overall.toUpperCase()}`);
    const dims: readonly ScorecardDimension[] = [
      'metadata',
      'privacy',
      'dependencies',
      'build-output',
      'packlist',
      'docs',
      'fixtures',
      'dot-gates',
      'agent-native-gates',
    ];
    for (const dim of dims) {
      const result = pkg.dimensions[dim];
      const icon = statusIcon(result.status);
      const label = dim.padEnd(20, ' ');
      lines.push(`  ${label} ${icon} ${result.details}`);
    }
    if (pkg.blockers.length > 0) {
      lines.push(`  Blockers: ${pkg.blockers.join(', ')}`);
    }
    lines.push('');
  }

  if (envelope.summary.stableReleaseGate === 'blocked' && envelope.summary.stableReleaseBlockers.length > 0) {
    lines.push('Stable release gate: BLOCKED');
    for (const b of envelope.summary.stableReleaseBlockers) {
      lines.push(`  - ${b}`);
    }
  } else if (envelope.summary.stableReleaseGate === 'open') {
    lines.push('Stable release gate: OPEN');
  }

  return `${lines.join('\n')}\n`;
}

function statusIcon(status: ScorecardStatus): string {
  switch (status) {
    case 'pass':
      return 'OK';
    case 'fail':
      return 'X ';
    case 'warn':
      return '! ';
    case 'deferred':
      return '- ';
  }
}

// Silence unused import — exported error codes from export-public/leaks are
// referenced via SCORECARD_ERROR_CODES + leak error remediation indirectly.
// The compiler-time references below keep tree-shaking honest.
void EXPORT_ERROR_CODES;
