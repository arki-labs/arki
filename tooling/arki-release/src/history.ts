/**
 * The `history` command — reconcile what's been released across the four
 * release surfaces: monorepo source, per-package `CHANGELOG.md`, the npm
 * registry, and the `arki-labs/arki` GitHub mirror tags.
 *
 * Why this exists: six places carry "what's released" state (npm, GitHub
 * tags, source `package.json#version`, `CHANGELOG.md`, `.changeset/`,
 * conversational memory). None is authoritative on its own; they drift.
 * This command does the reconciliation and emits structured drift entries
 * so a human (or CI) can see exactly which surface fell behind.
 *
 * Exit code:
 *   - 0 when every wave-listed package is `in-sync`, `source-ahead`, or
 *     `unpublished` (all expected states).
 *   - 1 when any package shows real drift: `npm-ahead` (impossible state),
 *     `changelog-drift`, or `tag-drift`.
 *
 * Network calls (`npm view`, `git ls-remote`) are routed through the
 * injectable {@link ProcessRunner} so tests can replay synthetic output
 * without hitting the network.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import debugFactory from 'debug';

import { defaultProcessRunner, type ProcessRunner } from './fixture';
import { runInventory, type InventoryItem } from './inventory';
import { createEnvelope } from './json-output';
import type {
  HistoryRepoStatus,
  ReleaseCommandEnvelope,
  ReleaseConfig,
  ReleaseError,
} from './types';

const debug = debugFactory('arki:release:history');

/** Stable error codes for the history command. */
export const HISTORY_ERROR_CODES = {
  /** `npm view <pkg>` returned non-zero for reasons other than 404. */
  npmQueryFailed: 'HIST_E001',
  /** `git ls-remote --tags <remote>` returned non-zero. */
  githubLsRemoteFailed: 'HIST_E002',
  /** Could not read or parse `CHANGELOG.md` for a wave-listed package. */
  changelogReadFailed: 'HIST_E003',
  /** A real drift was detected (npm-ahead / changelog-drift / tag-drift). */
  driftDetected: 'HIST_E004',
  /** `gh api repos/<org>/<name>` failed for a per-package mirror probe. */
  packageRepoProbeFailed: 'HIST_E005',
  /** Per-package mirror drift detected (missing / tag-drift / unarchived). */
  packageRepoDrift: 'HIST_E006',
} as const;

/**
 * Reconciliation verdict for a single wave-listed package.
 *
 * - `in-sync`         — source == npm == changelog == github tag exists
 * - `source-ahead`    — source > npm; expected (ship pending)
 * - `unpublished`     — wave-listed but never on npm (e.g. Wave 2 right now)
 * - `changelog-drift` — `CHANGELOG.md` heading != source version
 * - `tag-drift`       — no `v<source>` tag on `arki-labs/arki`
 * - `npm-ahead`       — npm has a version source does not (CRITICAL)
 * - `network-error`   — npm/git call failed; reconciliation incomplete
 */
export type HistoryStatus =
  | 'in-sync'
  | 'source-ahead'
  | 'unpublished'
  | 'changelog-drift'
  | 'tag-drift'
  | 'npm-ahead'
  | 'network-error';

/** One row in the history envelope's `items[]`. */
export interface HistoryItem {
  readonly name: string;
  readonly wave: string | null;
  readonly source: string;
  readonly npm: string | null;
  readonly changelog: string | null;
  readonly githubTag: string | null;
  readonly status: HistoryStatus;
  readonly notes: readonly string[];
  /**
   * Per-package repo reconciliation verdict — answers "does
   * `arki-labs/<short-name>` exist, archived, with the expected tags?"
   *
   * Optional for backwards compatibility with consumers that parsed
   * envelopes from before the per-package-repo dimension landed.
   */
  readonly repoStatus?: HistoryRepoStatus;
  /** Short repo name under the GitHub org, e.g. `assert` for `@arki/assert`. */
  readonly repoName?: string;
  /** Tags actually present on the per-package mirror (versions, no `v` prefix). */
  readonly repoTags?: readonly string[];
  /** Whether the per-package mirror is currently archived. `null` when unknown. */
  readonly repoArchived?: boolean | null;
}

/** Aggregate counts + the mirror tag list. */
export interface HistorySummary {
  readonly message: string;
  readonly totalPackages: number;
  readonly inSync: number;
  readonly sourceAhead: number;
  readonly unpublished: number;
  readonly driftErrors: number;
  readonly networkErrors: number;
  /** Every `v*` tag the GitHub mirror reports, sorted lexically. */
  readonly githubMirrorTags: readonly string[];
  /** Per-package mirror counts (second dimension; orthogonal to top-level status). */
  readonly packageRepos: {
    readonly inSync: number;
    readonly missing: number;
    readonly tagDrift: number;
    readonly unarchived: number;
    readonly unchecked: number;
  };
  /** GitHub org used for the per-package mirror probes (default `arki-labs`). */
  readonly packageReposOrg: string;
}

/** Public options for {@link runHistory}. */
export interface HistoryOptions {
  readonly cwd: string;
  readonly config: ReleaseConfig;
  /** Override the GitHub mirror URL. Defaults to `arki-labs/arki`. */
  readonly githubRemote?: string;
  /** Injectable process runner; defaults to {@link defaultProcessRunner}. */
  readonly runner?: ProcessRunner;
  /** Skip every network call. Used for offline diagnostics and tests. */
  readonly skipNetwork?: boolean;
  /**
   * GitHub org for per-package mirror probes. Defaults to `arki-labs`.
   * Each wave-listed `@arki/<name>` is checked against
   * `https://github.com/<org>/<name>` for existence + archive state +
   * matching `v<published-version>` tags.
   */
  readonly packageReposOrg?: string;
  /**
   * Set to `false` to skip the per-package mirror dimension entirely
   * (every item reports `repoStatus: 'unchecked'`). Defaults to `true`.
   */
  readonly checkPackageRepos?: boolean;
}

const DEFAULT_GITHUB_REMOTE = 'git@github.com:arki-labs/arki.git';
const DEFAULT_PACKAGE_REPOS_ORG = 'arki-labs';
const VERSION_HEADING_RE = /^## ([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)\s*$/m;
const TAG_REF_RE = /refs\/tags\/v([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)(\^\{\})?$/;

function shortRepoName(packageName: string): string {
  return packageName.startsWith('@arki/') ? packageName.slice('@arki/'.length) : packageName;
}

/**
 * Result of probing one per-package GitHub mirror. The probe is a single
 * `gh api repos/<org>/<name>` call + a `git ls-remote --tags` to learn
 * the archived flag and existing version tags. Returned shapes keep the
 * caller's reconciliation logic free of `try/catch`.
 */
type PackageRepoProbe =
  | {
      readonly status: 'present';
      readonly archived: boolean;
      readonly tags: ReadonlySet<string>;
    }
  | { readonly status: 'missing' }
  | { readonly status: 'error'; readonly reason: string };

async function probePackageRepo(
  org: string,
  packageName: string,
  runner: ProcessRunner,
  cwd: string,
): Promise<PackageRepoProbe> {
  const repoName = shortRepoName(packageName);
  const meta = await runner.run(
    'gh',
    ['api', `repos/${org}/${repoName}`, '--jq', '{archived}'],
    { cwd },
  );
  if (meta.exitCode !== 0) {
    if (
      meta.stderr.includes('404') ||
      meta.stderr.includes('Not Found') ||
      meta.stderr.includes('HTTP 404')
    ) {
      return { status: 'missing' };
    }
    return {
      status: 'error',
      reason: meta.stderr.trim() || `gh api exit ${meta.exitCode.toString()}`,
    };
  }
  let archived = false;
  try {
    const parsed: unknown = JSON.parse(meta.stdout);
    if (parsed !== null && typeof parsed === 'object') {
      const a = (parsed as Record<string, unknown>)['archived'];
      archived = a === true;
    }
  } catch {
    return { status: 'error', reason: `unexpected gh api payload: ${meta.stdout.slice(0, 120)}` };
  }

  const gitRemote = `git@github.com:${org}/${repoName}.git`;
  const ls = await runner.run('git', ['ls-remote', '--tags', gitRemote], { cwd });
  if (ls.exitCode !== 0) {
    return {
      status: 'error',
      reason: ls.stderr.trim() || `git ls-remote exit ${ls.exitCode.toString()}`,
    };
  }
  const tags = new Set<string>();
  for (const line of ls.stdout.split('\n')) {
    const match = TAG_REF_RE.exec(line);
    if (match !== null && match[1] !== undefined) {
      tags.add(match[1]);
    }
  }
  return { status: 'present', archived, tags };
}

/**
 * Combine the published-versions list (from npm) with a probe result to
 * derive the per-package-repo verdict. Pure — driven entirely by the
 * inputs.
 */
function classifyPackageRepo(
  publishedVersions: readonly string[],
  probe: PackageRepoProbe,
): { readonly status: HistoryRepoStatus; readonly tags: readonly string[]; readonly archived: boolean | null } {
  if (probe.status === 'error') {
    return { status: 'unchecked', tags: [], archived: null };
  }
  if (probe.status === 'missing') {
    return { status: 'missing', tags: [], archived: null };
  }
  const tagsSorted = [...probe.tags].sort();
  const missing = publishedVersions.filter(v => !probe.tags.has(v));
  if (missing.length > 0) {
    return { status: 'tag-drift', tags: tagsSorted, archived: probe.archived };
  }
  if (!probe.archived) {
    return { status: 'unarchived', tags: tagsSorted, archived: false };
  }
  return { status: 'in-sync', tags: tagsSorted, archived: true };
}

async function fetchNpmVersion(
  pkgName: string,
  runner: ProcessRunner,
  cwd: string,
): Promise<{ readonly version: string | null; readonly error: string | null }> {
  const result = await runner.run('npm', ['view', pkgName, 'version', '--json'], { cwd });
  if (result.exitCode !== 0) {
    if (result.stderr.includes('E404') || result.stderr.includes('404 Not Found')) {
      return { version: null, error: null };
    }
    return {
      version: null,
      error: result.stderr.trim() || `npm view returned ${result.exitCode.toString()}`,
    };
  }
  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    return { version: null, error: null };
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === 'string') {
      return { version: parsed, error: null };
    }
    return { version: null, error: `unexpected npm view payload: ${stdout.slice(0, 120)}` };
  } catch {
    return { version: stdout, error: null };
  }
}

/**
 * List every published version of a package. Used by the per-package
 * mirror reconciliation to check tag coverage. Returns an empty array
 * when the package has never been published.
 */
async function fetchNpmVersionList(
  pkgName: string,
  runner: ProcessRunner,
  cwd: string,
): Promise<{ readonly versions: readonly string[]; readonly error: string | null }> {
  const result = await runner.run('npm', ['view', pkgName, 'versions', '--json'], { cwd });
  if (result.exitCode !== 0) {
    if (result.stderr.includes('E404') || result.stderr.includes('404 Not Found')) {
      return { versions: [], error: null };
    }
    return {
      versions: [],
      error: result.stderr.trim() || `npm view versions returned ${result.exitCode.toString()}`,
    };
  }
  const stdout = result.stdout.trim();
  if (stdout.length === 0) return { versions: [], error: null };
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === 'string') return { versions: [parsed], error: null };
    if (Array.isArray(parsed) && parsed.every((v): v is string => typeof v === 'string')) {
      return { versions: parsed, error: null };
    }
    return { versions: [], error: `unexpected versions payload: ${stdout.slice(0, 120)}` };
  } catch (cause) {
    return {
      versions: [],
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

async function readChangelogVersion(
  packageDir: string,
): Promise<{ readonly version: string | null; readonly error: string | null }> {
  try {
    const text = await readFile(path.join(packageDir, 'CHANGELOG.md'), 'utf8');
    const match = VERSION_HEADING_RE.exec(text);
    return { version: match?.[1] ?? null, error: null };
  } catch (cause) {
    return {
      version: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

async function fetchGithubTags(
  remote: string,
  runner: ProcessRunner,
  cwd: string,
): Promise<{ readonly versions: ReadonlySet<string>; readonly error: string | null }> {
  const result = await runner.run('git', ['ls-remote', '--tags', remote], { cwd });
  if (result.exitCode !== 0) {
    return {
      versions: new Set<string>(),
      error: result.stderr.trim() || `git ls-remote returned ${result.exitCode.toString()}`,
    };
  }
  const versions = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const match = TAG_REF_RE.exec(line);
    if (match !== null && match[1] !== undefined) {
      versions.add(match[1]);
    }
  }
  return { versions, error: null };
}

function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map(s => Number.parseInt(s, 10));
  const partsB = b.split('.').map(s => Number.parseInt(s, 10));
  for (let i = 0; i < 3; i += 1) {
    const da = Number.isFinite(partsA[i]) ? (partsA[i] as number) : 0;
    const db = Number.isFinite(partsB[i]) ? (partsB[i] as number) : 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function classify(
  source: string,
  npm: string | null,
  changelog: string | null,
  tags: ReadonlySet<string>,
  networkErrorForPackage: boolean,
): { readonly status: HistoryStatus; readonly notes: readonly string[] } {
  if (networkErrorForPackage) {
    return {
      status: 'network-error',
      notes: ['npm view failed; reconciliation incomplete for this package'],
    };
  }

  if (npm === null) {
    return { status: 'unpublished', notes: ['not yet published to npm'] };
  }

  if (compareSemver(npm, source) > 0) {
    return {
      status: 'npm-ahead',
      notes: [`npm has ${npm} but source has ${source} — investigate immediately`],
    };
  }

  if (compareSemver(source, npm) > 0) {
    return {
      status: 'source-ahead',
      notes: [`source ${source} ahead of npm ${npm} — ship pending`],
    };
  }

  if (changelog !== null && changelog !== source) {
    return {
      status: 'changelog-drift',
      notes: [`CHANGELOG.md top heading is ${changelog} but source/npm is ${source}`],
    };
  }

  if (!tags.has(source)) {
    return {
      status: 'tag-drift',
      notes: [`no GitHub tag v${source} on arki-labs/arki`],
    };
  }

  return { status: 'in-sync', notes: [] };
}

/**
 * Drive the full reconciliation across every wave-allowlisted package.
 *
 * Wave membership is taken from `config.waves` — the same allowlist that
 * drives inventory classification. Packages not in any wave are not
 * tracked here (they're either private-only or unassigned).
 */
export async function runHistory(
  opts: HistoryOptions,
): Promise<ReleaseCommandEnvelope<HistoryItem, HistorySummary>> {
  const runner = opts.runner ?? defaultProcessRunner;
  const remote = opts.githubRemote ?? DEFAULT_GITHUB_REMOTE;
  const skipNetwork = opts.skipNetwork ?? false;
  const packageReposOrg = opts.packageReposOrg ?? DEFAULT_PACKAGE_REPOS_ORG;
  const checkPackageRepos = (opts.checkPackageRepos ?? true) && !skipNetwork;

  debug(
    'runHistory cwd=%s skipNetwork=%s checkPackageRepos=%s org=%s',
    opts.cwd,
    skipNetwork,
    checkPackageRepos,
    packageReposOrg,
  );

  const inventoryEnvelope = await runInventory({ cwd: opts.cwd, config: opts.config });
  const waveAllowlist = new Set<string>();
  for (const wave of opts.config.waves) {
    for (const name of wave.packages) {
      waveAllowlist.add(name);
    }
  }

  const candidates: readonly InventoryItem[] = inventoryEnvelope.items.filter(item =>
    waveAllowlist.has(item.name),
  );

  let tags: ReadonlySet<string> = new Set<string>();
  let githubError: string | null = null;
  if (!skipNetwork) {
    const tagResult = await fetchGithubTags(remote, runner, opts.cwd);
    tags = tagResult.versions;
    githubError = tagResult.error;
  }

  const items: HistoryItem[] = [];
  const errors: ReleaseError[] = [];
  const counts = { inSync: 0, sourceAhead: 0, unpublished: 0, driftErrors: 0, networkErrors: 0 };
  const repoCounts = { inSync: 0, missing: 0, tagDrift: 0, unarchived: 0, unchecked: 0 };

  for (const item of candidates) {
    const packageDir = path.dirname(path.join(opts.cwd, item.manifestPath));

    const npmResult = skipNetwork
      ? { version: null as string | null, error: null as string | null }
      : await fetchNpmVersion(item.name, runner, opts.cwd);
    const changelogResult = await readChangelogVersion(packageDir);

    if (npmResult.error !== null) {
      errors.push({
        code: HISTORY_ERROR_CODES.npmQueryFailed,
        severity: 'warning',
        message: `${item.name}: npm view failed — ${npmResult.error}`,
        target: item.name,
        remediation: 'Verify network connectivity and npm registry reachability.',
      });
    }

    if (changelogResult.error !== null) {
      errors.push({
        code: HISTORY_ERROR_CODES.changelogReadFailed,
        severity: 'warning',
        message: `${item.name}: cannot read CHANGELOG.md — ${changelogResult.error}`,
        target: item.name,
        remediation: 'Create or restore the CHANGELOG.md so reconciliation can read it.',
      });
    }

    const verdict = classify(
      item.version,
      npmResult.version,
      changelogResult.version,
      tags,
      npmResult.error !== null,
    );

    switch (verdict.status) {
      case 'in-sync':
        counts.inSync += 1;
        break;
      case 'source-ahead':
        counts.sourceAhead += 1;
        break;
      case 'unpublished':
        counts.unpublished += 1;
        break;
      case 'network-error':
        counts.networkErrors += 1;
        break;
      case 'npm-ahead':
      case 'changelog-drift':
      case 'tag-drift':
        counts.driftErrors += 1;
        errors.push({
          code: HISTORY_ERROR_CODES.driftDetected,
          severity: verdict.status === 'npm-ahead' ? 'error' : 'warning',
          message: `${item.name}: ${verdict.status} — ${verdict.notes.join('; ')}`,
          target: item.name,
          remediation:
            verdict.status === 'npm-ahead'
              ? 'Investigate immediately — npm has a version source does not. Bump source to match or yank the npm version.'
              : verdict.status === 'changelog-drift'
                ? 'Rewrite the CHANGELOG.md heading to match the package version, or bump the package.'
                : 'Push a v<version> tag to arki-labs/arki for the published version.',
        });
        break;
    }

    // Per-package mirror reconciliation. Skipped when offline or when
    // the package is wave-listed but never published (no point checking
    // a mirror for something that doesn't exist on npm yet).
    let repoVerdict: { status: HistoryRepoStatus; tags: readonly string[]; archived: boolean | null } = {
      status: 'unchecked',
      tags: [],
      archived: null,
    };
    if (checkPackageRepos && npmResult.version !== null) {
      const listResult = await fetchNpmVersionList(item.name, runner, opts.cwd);
      if (listResult.error !== null) {
        errors.push({
          code: HISTORY_ERROR_CODES.npmQueryFailed,
          severity: 'warning',
          message: `${item.name}: npm view versions failed — ${listResult.error}`,
          target: item.name,
        });
      }
      const probe = await probePackageRepo(packageReposOrg, item.name, runner, opts.cwd);
      if (probe.status === 'error') {
        errors.push({
          code: HISTORY_ERROR_CODES.packageRepoProbeFailed,
          severity: 'warning',
          message: `${item.name}: per-package repo probe failed — ${probe.reason}`,
          target: item.name,
          remediation: 'Verify gh auth + SSH access to the arki-labs org.',
        });
      }
      repoVerdict = classifyPackageRepo(listResult.versions, probe);

      switch (repoVerdict.status) {
        case 'in-sync':
          repoCounts.inSync += 1;
          break;
        case 'missing':
          repoCounts.missing += 1;
          errors.push({
            code: HISTORY_ERROR_CODES.packageRepoDrift,
            severity: 'warning',
            message: `${item.name}: per-package mirror at ${packageReposOrg}/${shortRepoName(item.name)} does not exist`,
            target: item.name,
            remediation: 'Run `bun release:arki sync-package-repos` to create it.',
          });
          break;
        case 'tag-drift':
          repoCounts.tagDrift += 1;
          errors.push({
            code: HISTORY_ERROR_CODES.packageRepoDrift,
            severity: 'warning',
            message: `${item.name}: per-package mirror missing tag(s) for published version(s)`,
            target: item.name,
            remediation: 'Run `bun release:arki sync-package-repos` to backfill the tags.',
          });
          break;
        case 'unarchived':
          repoCounts.unarchived += 1;
          errors.push({
            code: HISTORY_ERROR_CODES.packageRepoDrift,
            severity: 'warning',
            message: `${item.name}: per-package mirror is not archived`,
            target: item.name,
            remediation:
              'Run `bun release:arki sync-package-repos` (re-archives at end of run) or `gh repo archive arki-labs/<name>`.',
          });
          break;
        case 'unchecked':
          repoCounts.unchecked += 1;
          break;
      }
    } else {
      repoCounts.unchecked += 1;
    }

    items.push({
      name: item.name,
      wave: item.wave,
      source: item.version,
      npm: npmResult.version,
      changelog: changelogResult.version,
      githubTag: tags.has(item.version) ? `v${item.version}` : null,
      status: verdict.status,
      notes: verdict.notes,
      repoStatus: repoVerdict.status,
      repoName: shortRepoName(item.name),
      repoTags: repoVerdict.tags,
      repoArchived: repoVerdict.archived,
    });
  }

  if (githubError !== null) {
    errors.push({
      code: HISTORY_ERROR_CODES.githubLsRemoteFailed,
      severity: 'warning',
      message: `git ls-remote --tags ${remote} failed: ${githubError}`,
      remediation: 'Verify SSH credentials and network. Tag-drift detection is degraded until this is fixed.',
    });
  }

  const totalPackages = items.length;
  const hasNpmAhead = items.some(i => i.status === 'npm-ahead');
  const hasRepoDrift =
    repoCounts.missing > 0 || repoCounts.tagDrift > 0 || repoCounts.unarchived > 0;
  const status: 'success' | 'warning' | 'failure' =
    counts.driftErrors > 0 || hasNpmAhead
      ? 'failure'
      : counts.networkErrors > 0 || githubError !== null || hasRepoDrift
        ? 'warning'
        : 'success';

  const summary: HistorySummary = {
    message: buildSummaryMessage(counts, repoCounts, totalPackages),
    totalPackages,
    inSync: counts.inSync,
    sourceAhead: counts.sourceAhead,
    unpublished: counts.unpublished,
    driftErrors: counts.driftErrors,
    networkErrors: counts.networkErrors,
    githubMirrorTags: [...tags].sort(),
    packageRepos: {
      inSync: repoCounts.inSync,
      missing: repoCounts.missing,
      tagDrift: repoCounts.tagDrift,
      unarchived: repoCounts.unarchived,
      unchecked: repoCounts.unchecked,
    },
    packageReposOrg,
  };

  return createEnvelope<HistoryItem, HistorySummary>({
    command: 'history',
    status,
    summary,
    items,
    errors,
  });
}

function buildSummaryMessage(
  counts: {
    readonly inSync: number;
    readonly sourceAhead: number;
    readonly unpublished: number;
    readonly driftErrors: number;
    readonly networkErrors: number;
  },
  repoCounts: {
    readonly inSync: number;
    readonly missing: number;
    readonly tagDrift: number;
    readonly unarchived: number;
    readonly unchecked: number;
  },
  total: number,
): string {
  const parts: string[] = [];
  parts.push(`${total.toString()} wave-listed packages`);
  parts.push(`${counts.inSync.toString()} in-sync`);
  if (counts.sourceAhead > 0) parts.push(`${counts.sourceAhead.toString()} source-ahead`);
  if (counts.unpublished > 0) parts.push(`${counts.unpublished.toString()} unpublished`);
  if (counts.driftErrors > 0) parts.push(`${counts.driftErrors.toString()} drift errors`);
  if (counts.networkErrors > 0) parts.push(`${counts.networkErrors.toString()} network errors`);
  const repoParts: string[] = [];
  if (repoCounts.inSync > 0) repoParts.push(`${repoCounts.inSync.toString()} in-sync`);
  if (repoCounts.missing > 0) repoParts.push(`${repoCounts.missing.toString()} missing`);
  if (repoCounts.tagDrift > 0) repoParts.push(`${repoCounts.tagDrift.toString()} tag-drift`);
  if (repoCounts.unarchived > 0) repoParts.push(`${repoCounts.unarchived.toString()} unarchived`);
  if (repoCounts.unchecked > 0) repoParts.push(`${repoCounts.unchecked.toString()} unchecked`);
  if (repoParts.length > 0) {
    parts.push(`mirrors: ${repoParts.join(', ')}`);
  }
  return parts.join(' / ');
}

/** Render the history envelope as a human-readable table. */
export function renderHistoryText(
  envelope: ReleaseCommandEnvelope<HistoryItem, HistorySummary>,
): string {
  const lines: string[] = [];
  lines.push(`[${envelope.status}] history`);
  lines.push(`generated: ${envelope.generatedAt}`);
  lines.push('');
  lines.push(envelope.summary.message);
  lines.push('');

  if (envelope.items.length > 0) {
    const nameW = Math.max(...envelope.items.map(i => i.name.length), 20);
    const header = `${'Package'.padEnd(nameW)}  ${'source'.padEnd(10)} ${'npm'.padEnd(10)} ${'changelog'.padEnd(10)} ${'tag'.padEnd(10)} ${'status'.padEnd(16)} mirror`;
    lines.push(header);
    lines.push('─'.repeat(header.length));
    for (const item of envelope.items) {
      const tag = item.githubTag ?? '—';
      const npm = item.npm ?? '—';
      const cl = item.changelog ?? '—';
      const repo = item.repoStatus ?? 'unchecked';
      lines.push(
        `${item.name.padEnd(nameW)}  ${item.source.padEnd(10)} ${npm.padEnd(10)} ${cl.padEnd(10)} ${tag.padEnd(10)} ${item.status.padEnd(16)} ${repo}`,
      );
    }
    lines.push('');
  }

  if (envelope.summary.githubMirrorTags.length > 0) {
    lines.push(
      `GitHub mirror tags: ${envelope.summary.githubMirrorTags.map(t => `v${t}`).join(', ')}`,
    );
  }

  if (envelope.errors.length > 0) {
    lines.push('');
    lines.push(`Errors / warnings (${envelope.errors.length.toString()}):`);
    for (const err of envelope.errors) {
      lines.push(`  - [${err.severity}] ${err.code}: ${err.message}`);
      if (err.remediation !== undefined) {
        lines.push(`      fix: ${err.remediation}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}
