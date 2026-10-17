/**
 * Release scorecard — aggregator + decision-maker.
 *
 * The scorecard is the integration layer that runs the inventory, leak
 * scanner, pack auditor, public-tree exporter, and fixture matrix
 * programmatically (NOT via subprocess), aggregates their outputs, and
 * decides per-package PASS / FAIL / WARN / DEFERRED across every
 * `SCORECARD_DIMENSIONS` entry. The "stable release gate" is `'open'` iff every
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
 *   5.5 Run the DOT probe once.
 *   5.6 Read the release inputs once: changesets, demo registry, the
 *      `--candidate` folder, `npm view` versions, docs files, readiness
 *      baseline. A missing input makes its dimension `warn` or `deferred`,
 *      never a silent pass.
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

import { checkDocs } from '@arki/library-tooling/src/docs';
import { readManifest } from '@arki/library-tooling/src/manifest';
import debugFactory from 'debug';
import { z } from 'zod';

import { evaluateAdmission, isAdmissionFailure } from './admission';
import {
  CANDIDATES_DIR,
  docsCheckOf,
  lastShippedCommits,
  readCandidate,
  readTarball,
  type Candidate,
  type CandidatePackage,
  type TarballContents,
} from './candidate';
import { demosUsing, evaluateDemoLag, loadDemos, type DemoRegistry, type DemoUse } from './demos';
import {
  evaluateBenchFresh,
  evaluateDocsFresh,
  exportedNames,
  FRESH_ERROR_CODES,
  loadDocsFiles,
  unmentionedExports,
  type DocExamplesReport,
  type DocsFreshFiles,
} from './docs-fresh';
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
import {
  bumpedPackages,
  changedSince,
  checkBumps,
  evaluateDemoImpact,
  evaluateDocsImpact,
  loadChangesets,
  resolveBase,
  withBumpErrors,
  type Changeset,
} from './impact';
import { runInventory, type InventoryItem } from './inventory';
import { createEnvelope } from './json-output';
import { DEFAULT_LEAK_PATTERNS, LEAK_ERROR_CODES, scanDirectory } from './leaks';
import { npmVersionLookup } from './order';
import { auditPack, auditPackEntry, isSourceDistributedManifest, PACK_ERROR_CODES } from './pack';
import {
  evaluateReadiness,
  isLeafLibrary,
  loadReadinessBaseline,
  READINESS_ERROR_CODES,
  type ExternalResults,
  type ReadinessBaseline,
} from './readiness';
import { defaultGitRunner, defaultNpmRunner, type GitRunner, type NpmRunner } from './runners';
import { SMOKE_CHECK_STATUSES } from './smoke';
import { loadMirrorReadiness } from './sync';
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
  ScorecardReadiness,
  ScorecardStatus,
  ScorecardSummary,
  WaveBuildOutput,
} from './types';
import { SCORECARD_DIMENSIONS } from './types';

const debug = debugFactory('arki:release:scorecard');

/** Stable error codes emitted by the scorecard. */
export const SCORECARD_ERROR_CODES = {
  upstreamThrew: 'SCORE_E001',
  packageNotInInventory: 'SCORE_E002',
  noPublicCandidates: 'SCORE_E003',
  /** `npm view` failed for some packages (offline, auth); dependent checks are deferred or unverified. */
  npmUnavailable: 'SCORE_E004',
  /** A frozen tarball's package.json lacks a public metadata field. */
  frozenMetadata: 'SCORE_E005',
  /** A frozen tarball's package.json still has a `workspace:` / `catalog:` range. */
  frozenDependency: 'SCORE_E006',
  /** The package has no `test:docs` script, so its doc examples are unchecked. */
  docsScriptMissing: 'SCORE_E007',
  /** A frozen tarball cannot be read. */
  tarballUnreadable: 'SCORE_E008',
} as const;

/** The dimensions that read release inputs (changesets, git, npm, demos, candidate). */
const RELEASE_DIMENSIONS = ['docs-fresh', 'docs-impact', 'demo-impact', 'demo-lag', 'bench-fresh', 'readiness'] as const;
type ReleaseDimension = (typeof RELEASE_DIMENSIONS)[number];

/** Readiness gaps excused today; may only shrink. Relative to the workspace root. */
export const READINESS_BASELINE_PATH = path.join('tooling', 'arki-release', 'readiness-baseline.json');

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
  /** Injectable npm runner (`npm pack` and `npm view`) for tests. */
  readonly npmRunner?: NpmRunner;
  /** Injectable git runner (docs-impact base commit, changed files, bench provenance). */
  readonly gitRunner?: GitRunner;
  /**
   * Frozen candidate folder (`candidate --wave`). With it the scorecard
   * scores exactly the candidate's packages from the candidate's bytes:
   * packlist and metadata/dependencies from the tarballs, fixtures from
   * `checks.smoke`, doc examples from `checks["docs:<pkg>"]`, demo checks
   * from `checks["demo:<name>"]`. It never re-exports or re-packs.
   */
  readonly candidateDir?: string;
  /** `--allow-demo-lag "<reason>"`: a blocking demo lag becomes a warning. */
  readonly allowDemoLag?: string;
  /**
   * `arki-doc-examples --json` reports by package name. The scorecard never
   * runs `test:docs` itself; a package without a report fails docs-fresh
   * with FRESH_E002 until one is passed in.
   */
  readonly docExamples?: Readonly<Record<string, DocExamplesReport>>;
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

  // Candidate mode scores the frozen bytes of exactly the candidate's packages.
  let candidate: Candidate | null = null;
  if (opts.candidateDir !== undefined) {
    const read = await readCandidate(opts.candidateDir);
    if (!read.ok) return buildFailureEnvelope([...envelopeErrors, ...read.errors], opts.allowDeferred === true);
    candidate = read.candidate;
    const frozenNames = new Set(candidate.packages.map(p => p.name));
    candidates = candidates.filter(c => frozenNames.has(c.name));
  }
  const frozenOf = (name: string): CandidatePackage | undefined => candidate?.packages.find(p => p.name === name);

  // Public packages that are in no wave (and not in `notYet`), or in both,
  // are never scored below; they get one failing row so the gap is loud.
  const scoredNames = new Set(candidates.map(c => c.name));
  const admissionFailures = inventoryEnv.items.filter(
    item =>
      isAdmissionFailure(item.status) &&
      !scoredNames.has(item.name) &&
      candidate === null &&
      (opts.packageName === undefined || item.name === opts.packageName),
  );

  if (candidates.length === 0 && admissionFailures.length === 0) {
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
  const tarballs = new Map<string, TarballContents>();
  for (const item of candidates) {
    const dir = path.dirname(path.join(opts.cwd, item.manifestPath));
    const frozen = frozenOf(item.name);
    if (frozen !== undefined && opts.candidateDir !== undefined) {
      try {
        const contents = await readTarball(path.join(opts.candidateDir, frozen.tarball));
        tarballs.set(item.name, contents);
        packResultsByPackage.set(item.name, auditFrozenTarball(frozen, contents, dir));
      } catch (cause) {
        packErrorsByPackage.set(item.name, `${SCORECARD_ERROR_CODES.tarballUnreadable}: cannot read ${frozen.tarball}: ${messageOf(cause)}`);
      }
      continue;
    }
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
        ...(opts.npmRunner !== undefined ? { runner: opts.npmRunner } : {}),
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
  // Candidate mode skips it: the tarball manifests are the materialized ones.
  const exportEnv =
    candidate === null
      ? await exportPublicTree({
          rootCwd: opts.cwd,
          config: opts.config,
          leakScan: false, // leak gate is already covered by step 2 — avoid double-scanning
        })
      : null;
  // The exporter carries its own per-package errors which we need to
  // associate with the right package. Build an index by `target`.
  const exportErrorsByPackage = indexErrorsByTarget(exportEnv?.items.flatMap(i => i.errors) ?? []);

  // 5. Fixture matrix. Uses the materialized tree from step 4.
  const fixtureRunsByPackage = new Map<string, readonly FixtureRun[]>();
  const candidateNames = new Set(candidates.map(c => c.name));
  // Candidate mode: `smoke --candidate` already installed the frozen tarballs.
  try {
    if (candidate === null) {
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

  // 5.6. Release inputs, read once: changesets, demo registry, candidate,
  // npm versions, docs files, readiness baseline.
  const releaseInputs = await gatherReleaseInputs(opts, candidates, candidate, envelopeErrors);

  // 6. Per-package evaluation.
  const results: ScorecardPackageResult[] = [];
  for (const item of candidates) {
    const release = await evaluateReleaseDimensions(item, opts, releaseInputs);
    const result = await evaluatePackage({
      release,
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
      frozen: candidate === null ? undefined : frozenDimensions(item.name, tarballs.get(item.name), candidate),
    });
    results.push(result);
  }
  for (const item of admissionFailures) {
    results.push(admissionFailureRow(item));
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
 * Row for a public package outside the admission rules. Only `admission`
 * ran; every other dimension is deferred because nothing else is scored
 * for a package that is not in a wave.
 */
function admissionFailureRow(item: InventoryItem): ScorecardPackageResult {
  const skipped: ScorecardDimensionResult = {
    status: 'deferred',
    details: 'not scored: package is not admitted',
    evidence: [],
  };
  const dimensions: Record<ScorecardDimension, ScorecardDimensionResult> = {
    metadata: skipped,
    privacy: skipped,
    dependencies: skipped,
    'build-output': skipped,
    packlist: skipped,
    docs: skipped,
    fixtures: skipped,
    'dot-gates': skipped,
    'agent-native-gates': skipped,
    admission: evaluateAdmission(item.name, item.status),
    'docs-fresh': skipped,
    'docs-impact': skipped,
    'demo-impact': skipped,
    'demo-lag': skipped,
    'bench-fresh': skipped,
    readiness: skipped,
  };
  return {
    name: item.name,
    version: item.version,
    classification: item.classification,
    wave: item.wave,
    dimensions,
    overall: 'fail',
    blockers: computeBlockers(dimensions),
  };
}

/**
 * Evaluate every dimension for a single package and roll up the worst
 * status. Pure once the inputs have been gathered.
 */
async function evaluatePackage(input: {
  readonly release: ReleaseEvaluation;
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
  /** Candidate mode: dimensions judged from the frozen tarball instead of the source tree. */
  readonly frozen: FrozenDimensions | undefined;
}): Promise<ScorecardPackageResult> {
  const packageDir = path.dirname(path.join(input.cwd, input.item.manifestPath));

  const dimensions: Record<ScorecardDimension, ScorecardDimensionResult> = {
    metadata: input.frozen?.metadata ?? evaluateMetadata(input.item.name, input.materializationErrors),
    privacy: evaluatePrivacy(input.item.name, input.leakHits),
    dependencies: input.frozen?.dependencies ?? evaluateDependencies(input.item.name, input.materializationErrors),
    'build-output': await evaluateBuildOutput(input.item.name, packageDir, input.buildOutput),
    packlist: evaluatePacklist(input.item.name, input.packResult, input.packError),
    docs: await evaluateDocs(input.item.name, packageDir),
    fixtures: input.frozen?.fixtures ?? evaluateFixtures(input.item.name, input.fixtureRuns, input.fullFixtureMatrix),
    'dot-gates': evaluateDotGates(input.dotProbe),
    'agent-native-gates': evaluateAgentNativeGates(input.dotProbe),
    admission: evaluateAdmission(input.item.name, input.item.status),
    ...input.release.dimensions,
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
    readiness: input.release.readiness,
  };
}

/** Inputs the release dimensions share, read once per scorecard run. */
type ReleaseInputs = {
  readonly changesets: readonly Changeset[];
  /** Packages a pending changeset bumps. */
  readonly pending: ReadonlySet<string>;
  readonly registry: DemoRegistry;
  /** `null` when `--candidate` was not passed or the candidate is unusable. */
  readonly candidate: Candidate | null;
  /** Per-package mirror outcomes from `.release/sync-plan.json`; `null` without a plan. */
  readonly mirror: Awaited<ReturnType<typeof loadMirrorReadiness>>;
  /** Published versions per package name; `null` when `npm view` failed. */
  readonly npmVersions: ReadonlyMap<string, readonly string[] | null>;
  /** `name@version` on npm or in the candidate. */
  readonly knownVersions: ReadonlySet<string>;
  readonly docsFiles: ReadonlyMap<string, DocsFreshFiles>;
  readonly baseline: ReadinessBaseline;
  readonly git: GitRunner;
  /** IMPACT_E004 errors (major below 1.0) by package; they fail docs-impact. */
  readonly bumpErrors: readonly ReleaseError[];
  /** `sourceCommit` of the last shipped candidate per package; the docs-impact base. */
  readonly lastShipped: ReadonlyMap<string, string>;
};

type ReleaseEvaluation = {
  readonly dimensions: Readonly<Record<ReleaseDimension, ScorecardDimensionResult>>;
  readonly readiness: ScorecardReadiness;
};

function packageDirOf(cwd: string, item: InventoryItem): string {
  return path.dirname(path.join(cwd, item.manifestPath));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function gatherReleaseInputs(
  opts: ScorecardOptions,
  items: readonly InventoryItem[],
  candidate: Candidate | null,
  errors: ReleaseError[],
): Promise<ReleaseInputs> {
  const { changesets, errors: changesetErrors } = await loadChangesets(opts.cwd);
  errors.push(...changesetErrors);
  const bumpErrors = checkBumps(changesets, Object.fromEntries(items.map(i => [i.name, i.version])));
  // Scored packages carry their bump errors in docs-impact; the rest stay visible here.
  const scored = new Set(items.map(i => i.name));
  errors.push(...bumpErrors.filter(e => e.target === undefined || !scored.has(e.target)));

  const registry = await loadDemos(opts.cwd, opts.config);
  errors.push(...registry.errors);

  const docsFiles = new Map<string, DocsFreshFiles>();
  for (const item of items) docsFiles.set(item.name, await loadDocsFiles(packageDirOf(opts.cwd, item)));

  // One `npm view` per name: the scored packages plus every package a doc names.
  const names = new Set([...items.map(i => i.name), ...[...docsFiles.values()].flatMap(f => f.versionRefs.map(r => r.name))]);
  const lookup = npmVersionLookup(opts.npmRunner ?? defaultNpmRunner, opts.cwd);
  const npmVersions = new Map(
    await Promise.all(
      [...names].map(async name => {
        const found = await lookup(name);
        return [name, 'versions' in found ? found.versions : null] as const;
      }),
    ),
  );
  const unreachable = [...npmVersions].filter(([, versions]) => versions === null).map(([name]) => name);
  if (unreachable.length > 0) {
    debug('npm view failed for %d packages', unreachable.length);
    errors.push({
      code: SCORECARD_ERROR_CODES.npmUnavailable,
      severity: 'warning',
      message: `npm view failed for ${unreachable.length.toString()} package(s) (${unreachable.slice(0, 5).join(', ')}${unreachable.length > 5 ? ', ...' : ''}); docs-impact is deferred for them and their documented versions are unverified.`,
      remediation: 'Check the network and npm access (`npm view @arki/log versions`), then rerun the scorecard.',
    });
  }
  const knownVersions = new Set([
    ...[...npmVersions].flatMap(([name, versions]) => (versions ?? []).map(v => `${name}@${v}`)),
    ...(candidate?.packages.map(p => `${p.name}@${p.version}`) ?? []),
  ]);

  let baseline: ReadinessBaseline = {};
  try {
    baseline = loadReadinessBaseline(path.join(opts.cwd, READINESS_BASELINE_PATH));
  } catch (cause) {
    errors.push({
      code: READINESS_ERROR_CODES.baselineInvalid,
      severity: 'error',
      message: messageOf(cause),
      remediation: 'Regenerate the baseline with the one-off command in tooling/arki-release/src/readiness.ts.',
      target: READINESS_BASELINE_PATH,
    });
  }

  return {
    changesets,
    pending: bumpedPackages(changesets),
    registry,
    candidate,
    mirror: await loadMirrorReadiness(opts.cwd),
    npmVersions,
    knownVersions,
    docsFiles,
    baseline,
    git: opts.gitRunner ?? defaultGitRunner,
    bumpErrors,
    lastShipped: await lastShippedCommits(path.join(opts.cwd, CANDIDATES_DIR)),
  };
}

const scoredManifestSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    dependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    exports: z.unknown().optional(),
  })
  .loose();

/** The six release dimensions plus the readiness checklist for one package. */
async function evaluateReleaseDimensions(
  item: InventoryItem,
  opts: ScorecardOptions,
  inputs: ReleaseInputs,
): Promise<ReleaseEvaluation> {
  const packageDir = packageDirOf(opts.cwd, item);
  const dir = path.basename(packageDir);
  const parsed = scoredManifestSchema.safeParse(JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8')));
  const manifest = parsed.success ? parsed.data : { name: item.name, version: item.version };
  const uses = demosUsing(inputs.registry, item.name);
  const checks = inputs.candidate?.checks ?? {};
  const published = inputs.npmVersions.get(item.name) ?? null;
  // A package releases when a changeset bumps it or its version is not on npm.
  // Unknown npm state counts as releasing, so nothing passes on missing data.
  const releasing = inputs.pending.has(item.name) || published === null || !published.includes(item.version);
  const notReleasing: ScorecardDimensionResult = {
    status: 'pass',
    details: `nothing to release: ${item.version} is on npm and no changeset is pending`,
    evidence: [],
  };

  const docsCheck = inputs.candidate === null ? null : docsCheckOf(inputs.candidate, item.name);
  const docExamples = opts.docExamples?.[item.name] ?? (docsCheck?.kind === 'report' ? docsCheck.report : null);
  const docsFresh = await evaluateDocsFreshFor(item, packageDir, manifest, inputs, docExamples, docsCheck?.kind === 'no-script');
  const demoLag = evaluateDemoLag({
    pkg: item.name,
    candidateVersion: inputs.candidate?.packages.find(p => p.name === item.name)?.version ?? manifest.version,
    uses,
    blocking: opts.config.demoLagBlocking ?? false,
    ...(opts.allowDemoLag !== undefined ? { allowReason: opts.allowDemoLag } : {}),
  });
  const readme = await readFile(path.join(packageDir, 'README.md'), 'utf8').catch(() => '');
  const benchFresh = await evaluateBenchFresh({
    root: opts.cwd,
    pkg: item.name,
    dir,
    leaf: isLeafLibrary(opts.config, manifest),
    readme,
    git: inputs.git,
  });

  const readiness = evaluateReadiness({
    config: opts.config,
    dir: packageDir,
    external: readinessExternal(item.name, uses, docsFresh, docExamples === null, inputs.candidate, inputs.mirror),
    baseline: inputs.baseline[item.name] ?? [],
  });

  return {
    dimensions: {
      'docs-fresh': docsFresh,
      'docs-impact': withBumpErrors(
        releasing ? await evaluateDocsImpactFor(item.name, dir, published, opts.cwd, inputs) : notReleasing,
        inputs.bumpErrors.filter(e => e.target === item.name),
      ),
      'demo-impact': releasing ? evaluateDemoImpactFor(item.name, uses, checks, inputs) : notReleasing,
      'demo-lag': demoLag,
      'bench-fresh': benchFresh,
      readiness: readiness.dimension,
    },
    readiness: { tier: readiness.tier, items: readiness.items },
  };
}

async function evaluateDocsImpactFor(
  pkg: string,
  dir: string,
  published: readonly string[] | null,
  cwd: string,
  inputs: ReleaseInputs,
): Promise<ScorecardDimensionResult> {
  const lastShippedCommit = inputs.lastShipped.get(pkg) ?? null;
  if (published === null && lastShippedCommit === null) {
    return { status: 'deferred', details: 'npm view failed: no last release to diff the docs against', evidence: [] };
  }
  const npmVersion = published?.at(-1) ?? null;
  const base = await resolveBase({ root: cwd, dir, npmVersion, lastShippedCommit, git: inputs.git });
  if (npmVersion !== null && base === null) {
    return { status: 'deferred', details: `git found no commit that set version ${npmVersion}`, evidence: [] };
  }
  const changedFiles = base === null ? null : await changedSince(cwd, base, dir, inputs.git);
  return evaluateDocsImpact({ pkg, dir, changedFiles, changesets: inputs.changesets });
}

function evaluateDemoImpactFor(
  pkg: string,
  uses: readonly DemoUse[],
  checks: Candidate['checks'],
  inputs: ReleaseInputs,
): ScorecardDimensionResult {
  const demos = uses.map(u => u.demo);
  const result = evaluateDemoImpact({ pkg, demos, candidateChecks: checks, changesets: inputs.changesets });
  // Demo checks live in candidate.json; without one they are unknown, not failed.
  if (result.status === 'fail' && demos.length > 0 && inputs.candidate === null) {
    return { status: 'deferred', details: `demo checks unknown for ${demos.join(', ')}: pass --candidate <dir>`, evidence: [] };
  }
  return result;
}

async function evaluateDocsFreshFor(
  item: InventoryItem,
  packageDir: string,
  manifest: { readonly version: string; readonly exports?: unknown },
  inputs: ReleaseInputs,
  docExamples: DocExamplesReport | null,
  noDocsScript: boolean,
): Promise<ScorecardDimensionResult> {
  const files = inputs.docsFiles.get(item.name) ?? { changelogVersion: null, versionRefs: [], docsText: '' };
  // A version string can only be judged when npm answered for its package.
  const unverified = files.versionRefs.filter(
    ref => !inputs.knownVersions.has(`${ref.name}@${ref.version}`) && (inputs.npmVersions.get(ref.name) ?? null) === null,
  );
  const libraryErrors = libraryDocErrors(packageDir);
  const result = evaluateDocsFresh({
    pkg: item.name,
    packageVersion: manifest.version,
    libraryCheckErrors: libraryErrors ?? [],
    docExamples,
    changelogVersion: files.changelogVersion,
    versionRefs: files.versionRefs.filter(ref => !unverified.includes(ref)),
    knownVersions: inputs.knownVersions,
    undocumentedExports: unmentionedExports(await exportedNames(packageDir, manifest.exports), files.docsText),
  });
  const extra: ReleaseError[] = [];
  // No script is a known gap (T2.2 adds `test:docs` everywhere), not a run that
  // was skipped: say so instead of the generic "no doc-examples result".
  const fromScript = noDocsScript && docExamples === null;
  const base: ScorecardDimensionResult = fromScript
    ? { ...result, evidence: result.evidence.filter(e => e.code !== FRESH_ERROR_CODES.docExamples) }
    : result;
  if (fromScript) {
    extra.push({
      code: SCORECARD_ERROR_CODES.docsScriptMissing,
      severity: 'warning',
      message: `${item.name}: no \`test:docs\` script, so doc examples are not checked.`,
      remediation: `Add \`"test:docs": "arki-doc-examples"\` to packages/${path.basename(packageDir)}/package.json.`,
      target: item.name,
    });
  }
  if (libraryErrors === null) {
    extra.push({
      code: FRESH_ERROR_CODES.llmsImportPaths,
      severity: 'warning',
      message: `${item.name}: the library docs check could not run, so llms.txt import paths are unchecked.`,
      remediation: `Run \`arki-library-check\` in packages/${path.basename(packageDir)} and fix what it reports.`,
      target: item.name,
    });
  }
  if (unverified.length > 0) {
    extra.push({
      code: FRESH_ERROR_CODES.versionUnverified,
      severity: 'warning',
      message: `${item.name}: npm was unreachable, so ${unverified.map(r => `${r.name}@${r.version}`).join(', ')} could not be checked.`,
      remediation: 'Rerun the scorecard with network access to npm.',
      target: item.name,
    });
  }
  if (extra.length === 0) return base;
  const evidence = [...base.evidence, ...extra];
  return {
    status: evidence.some(e => e.severity === 'error') ? 'fail' : 'warn',
    details: `${evidence.length.toString()} finding(s)`,
    evidence,
  };
}

/** Error lines of the library docs rules (DOC_E0xx); `null` when the check cannot run. */
function libraryDocErrors(packageDir: string): readonly string[] | null {
  try {
    return checkDocs(packageDir, readManifest(packageDir)).errors;
  } catch (cause) {
    debug('library docs check threw for %s: %s', packageDir, cause);
    return null;
  }
}

/** Readiness items other modules produce. Absent = no result yet (READY_E002). */
function readinessExternal(
  pkg: string,
  uses: readonly DemoUse[],
  docsFresh: ScorecardDimensionResult,
  docExamplesMissing: boolean,
  candidate: Candidate | null,
  mirror: Awaited<ReturnType<typeof loadMirrorReadiness>>,
): ExternalResults {
  const external: ExternalResults = { ...mirror?.[pkg] };
  const smoke = candidate?.packages.some(p => p.name === pkg) === true ? candidate.checks['smoke'] : undefined;
  if (smoke?.status === 'success') external['install-smoke'] = 'pass';
  if (smoke?.status === 'failure') external['install-smoke'] = 'fail';
  // A docs-fresh fail caused only by the missing doc-examples report is a
  // missing input, not a readiness failure: leave the item without a result.
  const realErrors = docsFresh.evidence.filter(
    e => e.severity === 'error' && !(docExamplesMissing && e.code === FRESH_ERROR_CODES.docExamples),
  );
  if (realErrors.length > 0) external['docs-fresh'] = 'fail';
  else if (!docExamplesMissing && docsFresh.status !== 'deferred') external['docs-fresh'] = 'pass';
  const demoStatuses = uses.map(u => candidate?.checks[`demo:${u.demo}`]?.status);
  if (uses.length === 0 || demoStatuses.includes('failure')) external['demo-proof'] = 'fail';
  else if (demoStatuses.every(s => s === 'success')) external['demo-proof'] = 'pass';
  return external;
}

// ---------------------------------------------------------------------------
// Candidate mode: dimensions judged from the frozen tarball
// ---------------------------------------------------------------------------

/** The dimensions candidate mode reads from the candidate instead of the source tree. */
export type FrozenDimensions = Readonly<Record<'metadata' | 'dependencies' | 'fixtures', ScorecardDimensionResult>>;

const frozenManifestSchema = z
  .object({
    description: z.string().optional(),
    license: z.string().optional(),
    repository: z.unknown().optional(),
    homepage: z.string().optional(),
    bugs: z.unknown().optional(),
    files: z.unknown().optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
  })
  .loose();

const METADATA_FIELDS = ['description', 'license', 'repository', 'homepage', 'bugs'] as const;

/** Runs the pack-audit rules over the tarball's file list: the published bytes, not a fresh `npm pack`. */
export function auditFrozenTarball(frozen: CandidatePackage, contents: TarballContents, packageDir: string): PackAuditResult {
  const manifest = frozenManifestSchema.safeParse(contents.manifest);
  return auditPackEntry(
    {
      id: `${frozen.name}@${frozen.version}`,
      name: frozen.name,
      version: frozen.version,
      filename: path.basename(frozen.tarball),
      files: contents.files,
      entryCount: contents.files.length,
      bundled: [],
      size: contents.packedSize,
      unpackedSize: contents.files.reduce((sum, f) => sum + f.size, 0),
    },
    {
      packageDir,
      manifest: { name: frozen.name, version: frozen.version },
      isSourceDistributed: manifest.success && isSourceDistributedManifest(manifest.data),
    },
  );
}

const smokeCheckEnvelopeSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      checks: z.array(z.object({ id: z.string(), status: z.enum(SMOKE_CHECK_STATUSES), detail: z.string() })),
    }),
  ),
});

/** metadata, dependencies and fixtures for one package of a candidate. */
export function frozenDimensions(pkg: string, contents: TarballContents | undefined, candidate: Candidate): FrozenDimensions {
  const manifest = frozenManifestSchema.safeParse(contents?.manifest);
  const unreadable: ScorecardDimensionResult = {
    status: 'fail',
    details: 'The frozen tarball has no readable package.json.',
    evidence: [
      {
        code: SCORECARD_ERROR_CODES.tarballUnreadable,
        severity: 'error',
        message: `${pkg}: the candidate tarball has no readable package/package.json.`,
        remediation: 'Build a fresh candidate with `bun release:arki candidate --wave <id>`.',
        target: pkg,
      },
    ],
  };
  return {
    metadata: manifest.success ? frozenMetadata(pkg, manifest.data) : unreadable,
    dependencies: manifest.success ? frozenDependencies(pkg, manifest.data) : unreadable,
    fixtures: frozenFixtures(pkg, candidate),
  };
}

function frozenMetadata(pkg: string, manifest: z.infer<typeof frozenManifestSchema>): ScorecardDimensionResult {
  const missing = METADATA_FIELDS.filter(field => manifest[field] === undefined || manifest[field] === '');
  if (missing.length === 0) return { status: 'pass', details: 'The tarball manifest carries description, license, repository, homepage, bugs.', evidence: [] };
  return {
    status: 'warn',
    details: `The tarball manifest lacks ${missing.join(', ')}.`,
    evidence: [
      {
        code: SCORECARD_ERROR_CODES.frozenMetadata,
        severity: 'warning',
        message: `${pkg}: the tarball package.json lacks ${missing.join(', ')}.`,
        remediation: 'Set the fields in the package manifest or `publicMetadataDefaults`, then build a fresh candidate.',
        target: pkg,
      },
    ],
  };
}

function frozenDependencies(pkg: string, manifest: z.infer<typeof frozenManifestSchema>): ScorecardDimensionResult {
  const leaked = [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies]
    .flatMap(deps => Object.entries(deps ?? {}))
    .filter(([, range]) => range.startsWith('workspace:') || range.startsWith('catalog:'))
    .map(([name, range]) => `${name}@${range}`);
  if (leaked.length === 0) return { status: 'pass', details: 'Every dependency range in the tarball is resolved.', evidence: [] };
  return {
    status: 'fail',
    details: `${String(leaked.length)} unresolved range(s) in the tarball.`,
    evidence: [
      {
        code: SCORECARD_ERROR_CODES.frozenDependency,
        severity: 'error',
        message: `${pkg}: the tarball still depends on ${leaked.join(', ')}; npm consumers cannot install it.`,
        remediation: 'Fix the materializer rewrite for these ranges, then build a fresh candidate.',
        target: pkg,
      },
    ],
  };
}

/** `smoke --candidate` installed these exact tarballs in a clean consumer; that is the fixture run. */
function frozenFixtures(pkg: string, candidate: Candidate): ScorecardDimensionResult {
  const smoke = smokeCheckEnvelopeSchema.safeParse(candidate.checks['smoke']?.envelope);
  if (!smoke.success) {
    return { status: 'deferred', details: 'No smoke result in candidate.json: run `smoke --candidate <dir>` first.', evidence: [] };
  }
  const checks = smoke.data.items.filter(i => i.name === pkg || i.name === '(wave)').flatMap(i => i.checks);
  const failed = checks.filter(c => c.status === 'fail');
  if (failed.length === 0) {
    return { status: 'pass', details: `${String(checks.length)} smoke check(s) on the frozen tarballs, none failed.`, evidence: [] };
  }
  return {
    status: 'fail',
    details: `${String(failed.length)} smoke check(s) failed on the frozen tarballs.`,
    evidence: failed.map(c => ({
      code: FIXTURE_ERROR_CODES.installFailed,
      severity: 'error' as const,
      message: `${pkg}: smoke ${c.id} failed: ${c.detail}`,
      remediation: 'Run `bun release:arki smoke --candidate <dir> --keep` and inspect the consumer folder.',
      target: pkg,
    })),
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
    for (const dim of SCORECARD_DIMENSIONS) {
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
