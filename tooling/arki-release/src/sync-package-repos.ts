/**
 * The `sync-package-repos` command — ensure every wave-listed
 * `@arki/<name>` package has an archived read-only mirror at
 * `https://github.com/arki-labs/<name>`, with one git commit per
 * published npm version and a matching `v<version>` tag.
 *
 * Why this exists:
 *
 *   - npm tarballs are the only durable artifact for old releases (we
 *     don't snapshot `.release/arki-public/` between ships), so the
 *     mirrors are reconstructed from npm — making the procedure
 *     reproducible from any machine with `gh`, `git`, `npm`, and `curl`.
 *   - Each repo is archived so the source-of-truth signal stays clear:
 *     the monorepo at `arki-labs/arki` is canonical; per-package repos
 *     are mirrors. The archive banner discourages PR submissions.
 *   - `git ls-remote --tags <repo>` is the cheap reconciliation that
 *     `history` uses afterwards to detect drift.
 *
 * Architecture:
 *
 *   - {@link runSyncPackageRepos} is the orchestrator. Pure over an
 *     injected {@link ProcessRunner} so tests replay synthetic output
 *     without touching the GitHub API or the npm registry.
 *   - One {@link SyncRepoItem} per wave-listed package. Items document
 *     every external side effect that was performed (or, when
 *     `--dry-run`, what WOULD have been performed).
 *
 * Stable error codes (envelope `errors[]`):
 *   - `SYNC_E001` — gh API query failed (lookup, create, archive flip).
 *   - `SYNC_E002` — npm view / npm-tarball fetch failed.
 *   - `SYNC_E003` — git op failed (init, commit, tag, push).
 *   - `SYNC_E004` — tarball extraction or workspace setup failed.
 *   - `SYNC_E005` — sync skipped (dry-run, missing materialized manifest).
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import debugFactory from 'debug';

import { defaultProcessRunner, type ProcessResult, type ProcessRunner } from './fixture';
import { createEnvelope } from './json-output';
import type {
  ReleaseCommandEnvelope,
  ReleaseError,
  SyncRepoItem,
  SyncRepoOptions,
  SyncRepoStatus,
  SyncRepoSummary,
} from './types';

const debug = debugFactory('arki:release:sync-package-repos');

/** Stable error codes for the sync-package-repos command. */
export const SYNC_REPO_ERROR_CODES = {
  /** `gh` API call failed (lookup / create / archive flip). */
  ghApiFailed: 'SYNC_E001',
  /** `npm view` or tarball fetch failed. */
  npmFetchFailed: 'SYNC_E002',
  /** Local git operation failed (init / commit / tag / push). */
  gitOpFailed: 'SYNC_E003',
  /** Tarball extraction or temp-dir setup failed. */
  tarballSetupFailed: 'SYNC_E004',
  /** Sync skipped for a non-fatal reason (dry-run, missing manifest). */
  syncSkipped: 'SYNC_E005',
} as const;

const DEFAULT_GITHUB_ORG = 'arki-labs';

/**
 * Match `refs/tags/v1.2.3` (and the `^{}` annotated-tag variant) on a
 * single line of `git ls-remote --tags` output. Returns the captured
 * version string or null.
 */
function extractTagVersion(line: string): string | null {
  const match = line.match(/refs\/tags\/v([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)(\^\{\})?$/);
  return match !== null && match[1] !== undefined ? match[1] : null;
}

/**
 * Strip the `@arki/` prefix so `@arki/assert` → `assert`. The mirror
 * naming convention uses the short form per founder decision.
 */
function shortRepoName(packageName: string): string {
  if (packageName.startsWith('@arki/')) {
    return packageName.slice('@arki/'.length);
  }
  // Defence-in-depth: never propagate a bad name into a gh repo create call.
  throw new Error(`Expected @arki/<name>, got '${packageName}'`);
}

/**
 * Probe `gh api repos/<org>/<repo>`. Distinguishes three outcomes:
 *   1. Repo exists → return its archived flag + description.
 *   2. Repo does not exist (404) → return `{ exists: false }`.
 *   3. Any other gh failure → return `{ error }` so the caller can
 *      attach a stable error code without crashing the whole batch.
 */
async function probeGithubRepo(
  org: string,
  repoName: string,
  runner: ProcessRunner,
  cwd: string,
): Promise<
  | { readonly exists: true; readonly archived: boolean; readonly description: string }
  | { readonly exists: false; readonly archived?: undefined; readonly description?: undefined }
  | { readonly error: string }
> {
  const result = await runner.run(
    'gh',
    ['api', `repos/${org}/${repoName}`, '--jq', '{archived,description}'],
    { cwd },
  );
  if (result.exitCode !== 0) {
    if (
      result.stderr.includes('404') ||
      result.stderr.includes('Not Found') ||
      result.stderr.includes('HTTP 404')
    ) {
      return { exists: false };
    }
    return { error: result.stderr.trim() || `gh api exit ${result.exitCode.toString()}` };
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed === null || typeof parsed !== 'object') {
      return { error: `unexpected gh api payload: ${result.stdout.slice(0, 120)}` };
    }
    const obj = parsed as Record<string, unknown>;
    const archivedRaw = obj['archived'];
    const descRaw = obj['description'];
    return {
      exists: true,
      archived: archivedRaw === true,
      description: typeof descRaw === 'string' ? descRaw : '',
    };
  } catch (cause) {
    return {
      error: `failed to parse gh api output: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/**
 * Look up every published version of a package on npm. Returns the
 * sorted (chronological by publish time) list.
 *
 * The shape returned by `npm view <pkg> versions --json` is either:
 *   - `"0.0.1"` (single-version packages, npm collapses the array)
 *   - `["0.0.1", "0.0.2", ...]` (multi-version)
 *
 * Chronological ordering is achieved by querying `time` separately and
 * sorting on the publish timestamps — purely lexical version sort can
 * misorder pre-release tags.
 */
async function fetchPublishedVersions(
  packageName: string,
  runner: ProcessRunner,
  cwd: string,
): Promise<
  | { readonly versions: readonly { readonly version: string; readonly publishedAt: string }[] }
  | { readonly error: string }
> {
  const versionsResult = await runner.run('npm', ['view', packageName, 'versions', '--json'], {
    cwd,
  });
  if (versionsResult.exitCode !== 0) {
    if (versionsResult.stderr.includes('E404')) {
      return { versions: [] };
    }
    return {
      error:
        versionsResult.stderr.trim() ||
        `npm view versions exit ${versionsResult.exitCode.toString()}`,
    };
  }
  const versionsRaw = versionsResult.stdout.trim();
  if (versionsRaw.length === 0) {
    return { versions: [] };
  }
  let versions: string[];
  try {
    const parsed: unknown = JSON.parse(versionsRaw);
    if (typeof parsed === 'string') {
      versions = [parsed];
    } else if (Array.isArray(parsed) && parsed.every((v): v is string => typeof v === 'string')) {
      versions = parsed;
    } else {
      return { error: `unexpected versions payload: ${versionsRaw.slice(0, 120)}` };
    }
  } catch (cause) {
    return {
      error: `failed to parse npm versions: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const timeResult = await runner.run('npm', ['view', packageName, 'time', '--json'], { cwd });
  const timeMap = new Map<string, string>();
  if (timeResult.exitCode === 0) {
    try {
      const parsed: unknown = JSON.parse(timeResult.stdout);
      if (parsed !== null && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') timeMap.set(k, v);
        }
      }
    } catch {
      // Ignore — we fall back to lexical version ordering.
    }
  }

  const enriched = versions.map(v => ({
    version: v,
    publishedAt: timeMap.get(v) ?? '',
  }));
  enriched.sort((a, b) => {
    if (a.publishedAt !== '' && b.publishedAt !== '') {
      return a.publishedAt.localeCompare(b.publishedAt);
    }
    return a.version.localeCompare(b.version);
  });
  return { versions: enriched };
}

/**
 * Fetch the `dist.tarball` URL for a specific package version.
 */
async function fetchTarballUrl(
  packageName: string,
  version: string,
  runner: ProcessRunner,
  cwd: string,
): Promise<{ readonly url: string } | { readonly error: string }> {
  const result = await runner.run('npm', ['view', `${packageName}@${version}`, 'dist.tarball'], {
    cwd,
  });
  if (result.exitCode !== 0) {
    return {
      error: result.stderr.trim() || `npm view dist.tarball exit ${result.exitCode.toString()}`,
    };
  }
  const url = result.stdout.trim();
  if (url.length === 0 || !url.startsWith('http')) {
    return { error: `unexpected dist.tarball: '${url.slice(0, 60)}'` };
  }
  return { url };
}

/**
 * Fetch the published `description` field for a specific version. Used
 * to seed the GitHub repo description when first creating it (and to
 * keep the description in sync on every later run).
 */
async function fetchPublishedDescription(
  packageName: string,
  version: string,
  runner: ProcessRunner,
  cwd: string,
): Promise<string> {
  const result = await runner.run('npm', ['view', `${packageName}@${version}`, 'description'], {
    cwd,
  });
  if (result.exitCode !== 0) return '';
  return result.stdout.trim();
}

/** Prefix every mirror description with this banner — the only "read-only" signal we ship. */
const READ_ONLY_PREFIX = '[Read-only mirror]';

/**
 * Compose the canonical mirror description: the read-only banner first,
 * then the package's npm description. Capped at GitHub's 350-character
 * limit so we never push a description that GitHub rejects.
 */
function buildMirrorDescription(npmDescription: string): string {
  const base = npmDescription.trim();
  const composed = base.length > 0 ? `${READ_ONLY_PREFIX} ${base}` : READ_ONLY_PREFIX;
  return composed.length <= 350 ? composed : `${composed.slice(0, 347)}...`;
}

/**
 * Probe the current repo description; return `null` when the repo
 * cannot be queried (caller already surfaced the probe failure).
 */
async function fetchCurrentRepoDescription(
  org: string,
  repoName: string,
  runner: ProcessRunner,
  cwd: string,
): Promise<string | null> {
  const result = await runner.run(
    'gh',
    ['api', `repos/${org}/${repoName}`, '--jq', '.description'],
    { cwd },
  );
  if (result.exitCode !== 0) return null;
  const desc = result.stdout.trim();
  // `gh api --jq .description` prints `null` (literal) when unset.
  return desc === 'null' || desc.length === 0 ? '' : desc;
}

/**
 * Stamp the repo description via `gh repo edit`. No-op when the
 * description already matches `desired`. Returns whether the call was
 * needed (used to populate the per-item `reason` text on in-sync paths).
 */
async function ensureRepoDescription(args: {
  readonly org: string;
  readonly repoName: string;
  readonly desired: string;
  readonly runner: ProcessRunner;
  readonly cwd: string;
}): Promise<
  | { readonly status: 'updated' }
  | { readonly status: 'unchanged' }
  | { readonly status: 'failed'; readonly reason: string }
> {
  const current = await fetchCurrentRepoDescription(args.org, args.repoName, args.runner, args.cwd);
  if (current === args.desired) return { status: 'unchanged' };
  const result = await args.runner.run(
    'gh',
    ['repo', 'edit', `${args.org}/${args.repoName}`, '--description', args.desired],
    { cwd: args.cwd },
  );
  if (result.exitCode !== 0) {
    return {
      status: 'failed',
      reason: result.stderr.trim() || `gh repo edit exit ${result.exitCode.toString()}`,
    };
  }
  return { status: 'updated' };
}

/**
 * Download a tarball and extract it under `destDir`. npm tarballs ship
 * with a `package/` root, which is stripped via `--strip-components 1`.
 */
async function downloadAndExtractTarball(
  tarballUrl: string,
  destDir: string,
  runner: ProcessRunner,
  cwd: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const tarballPath = path.join(destDir, '.tarball.tgz');
  const curl = await runner.run('curl', ['-sSL', '-o', tarballPath, tarballUrl], { cwd });
  if (curl.exitCode !== 0) {
    return { ok: false, reason: curl.stderr.trim() || `curl exit ${curl.exitCode.toString()}` };
  }
  const tar = await runner.run(
    'tar',
    ['-xzf', tarballPath, '--strip-components=1', '-C', destDir],
    { cwd },
  );
  if (tar.exitCode !== 0) {
    return { ok: false, reason: tar.stderr.trim() || `tar exit ${tar.exitCode.toString()}` };
  }
  await rm(tarballPath, { force: true });
  return { ok: true };
}

/**
 * Run a sequence of git commands inside a working directory. Each entry
 * is `(args, optionalEnvOverrides)`. Stops on the first failure and
 * returns the failing command + its stderr.
 *
 * Env overrides are applied via `process.env` mutation/restoration —
 * the default Bun runner reads `process.env` at spawn time, so this is
 * the cheapest way to inject `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`
 * without expanding the {@link ProcessRunner} contract.
 */
async function runGitSequence(
  workDir: string,
  steps: ReadonlyArray<{
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  }>,
  runner: ProcessRunner,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly step: string; readonly reason: string }> {
  for (const step of steps) {
    const previous: Record<string, string | undefined> = {};
    if (step.env !== undefined) {
      for (const [k, v] of Object.entries(step.env)) {
        previous[k] = process.env[k];
        process.env[k] = v;
      }
    }
    let result: ProcessResult;
    try {
      result = await runner.run('git', step.args, { cwd: workDir });
    } finally {
      if (step.env !== undefined) {
        for (const k of Object.keys(step.env)) {
          if (previous[k] === undefined) {
            delete process.env[k];
          } else {
            process.env[k] = previous[k];
          }
        }
      }
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        step: step.args.join(' '),
        reason:
          result.stderr.trim() ||
          result.stdout.trim() ||
          `git exit ${result.exitCode.toString()}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Wipe everything inside `dir` except the `.git/` subdirectory. Used to
 * clean the working tree between version replays so each commit
 * contains ONLY the bytes from that version's tarball.
 */
async function wipeExceptGit(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    await rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

/**
 * One package's sync pipeline. Encapsulated so the orchestrator stays a
 * simple loop and the per-package recovery doesn't smear across the
 * batch.
 */
async function syncOnePackage(args: {
  readonly packageName: string;
  readonly org: string;
  readonly runner: ProcessRunner;
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly force: boolean;
}): Promise<SyncRepoItem> {
  const { packageName, org, runner, cwd, dryRun, force } = args;
  const repoName = shortRepoName(packageName);
  const repoUrl = `https://github.com/${org}/${repoName}`;
  const gitRemote = `git@github.com:${org}/${repoName}.git`;
  const errors: ReleaseError[] = [];

  debug('syncing %s → %s/%s (dryRun=%s force=%s)', packageName, org, repoName, dryRun, force);

  const publishedResult = await fetchPublishedVersions(packageName, runner, cwd);
  if ('error' in publishedResult) {
    errors.push({
      code: SYNC_REPO_ERROR_CODES.npmFetchFailed,
      severity: 'error',
      message: `${packageName}: npm view versions failed — ${publishedResult.error}`,
      target: packageName,
      remediation: 'Verify the package is published on npm and the registry is reachable.',
    });
    return {
      packageName,
      repoName,
      repoUrl,
      gitRemote,
      status: 'failed',
      publishedVersions: [],
      pushedVersions: [],
      skippedVersions: [],
      archived: false,
      reason: 'npm view versions failed',
      errors,
    };
  }
  const publishedVersions = publishedResult.versions;
  if (publishedVersions.length === 0) {
    return {
      packageName,
      repoName,
      repoUrl,
      gitRemote,
      status: 'skipped',
      publishedVersions: [],
      pushedVersions: [],
      skippedVersions: [],
      archived: false,
      reason: 'package not yet published to npm',
      errors,
    };
  }

  const probe = await probeGithubRepo(org, repoName, runner, cwd);
  let repoExists = false;
  let repoArchived = false;
  if ('error' in probe) {
    errors.push({
      code: SYNC_REPO_ERROR_CODES.ghApiFailed,
      severity: 'error',
      message: `${packageName}: gh api repos/${org}/${repoName} failed — ${probe.error}`,
      target: packageName,
      remediation: 'Verify `gh auth status` and that you have access to the arki-labs org.',
    });
    return {
      packageName,
      repoName,
      repoUrl,
      gitRemote,
      status: 'failed',
      publishedVersions: publishedVersions.map(v => v.version),
      pushedVersions: [],
      skippedVersions: [],
      archived: false,
      reason: 'gh api probe failed',
      errors,
    };
  }
  repoExists = probe.exists;
  if (probe.exists) {
    repoArchived = probe.archived;
  }

  const existingTags = new Set<string>();
  if (repoExists) {
    const lsRemote = await runner.run('git', ['ls-remote', '--tags', gitRemote], { cwd });
    if (lsRemote.exitCode === 0) {
      for (const line of lsRemote.stdout.split('\n')) {
        const v = extractTagVersion(line);
        if (v !== null) existingTags.add(v);
      }
    } else {
      errors.push({
        code: SYNC_REPO_ERROR_CODES.gitOpFailed,
        severity: 'warning',
        message: `${packageName}: git ls-remote ${gitRemote} failed — ${lsRemote.stderr.trim()}`,
        target: packageName,
        remediation: 'Verify SSH access to arki-labs. Sync will assume no existing tags.',
      });
    }
  }

  const versionsToPush = force
    ? publishedVersions
    : publishedVersions.filter(v => !existingTags.has(v.version));
  const skippedVersions = force ? [] : publishedVersions.filter(v => existingTags.has(v.version));

  // Compute the desired description up-front so every code path
  // (in-sync, dry-run, create, update) sees the same target string.
  const latestVersion =
    publishedVersions[publishedVersions.length - 1]?.version ?? publishedVersions[0]?.version ?? '';
  const npmDescription =
    latestVersion.length > 0
      ? await fetchPublishedDescription(packageName, latestVersion, runner, cwd)
      : '';
  const desiredDescription = buildMirrorDescription(npmDescription);

  if (versionsToPush.length === 0 && repoExists && !repoArchived) {
    // Repo is "almost in-sync" — content + tags + archive state all right.
    // The only thing left to verify is the description banner, which we
    // stamp idempotently. In dry-run we skip the side effect.
    let descriptionNote = '';
    if (!dryRun) {
      const descResult = await ensureRepoDescription({
        org,
        repoName,
        desired: desiredDescription,
        runner,
        cwd,
      });
      if (descResult.status === 'failed') {
        errors.push({
          code: SYNC_REPO_ERROR_CODES.ghApiFailed,
          severity: 'warning',
          message: `${packageName}: gh repo edit (description) failed — ${descResult.reason}`,
          target: packageName,
          remediation: 'Run `gh repo edit arki-labs/<name> --description "<desc>"` manually.',
        });
      } else if (descResult.status === 'updated') {
        descriptionNote = '; description stamped';
      }
    }
    return {
      packageName,
      repoName,
      repoUrl,
      gitRemote,
      status: 'in-sync',
      publishedVersions: publishedVersions.map(v => v.version),
      pushedVersions: [],
      skippedVersions: skippedVersions.map(v => v.version),
      archived: false,
      reason: `all published versions already mirrored${descriptionNote}`,
      errors,
    };
  }

  if (dryRun) {
    const wouldUnarchive = repoExists && repoArchived;
    const planParts: string[] = [];
    if (!repoExists) planParts.push('would CREATE repo');
    if (wouldUnarchive) planParts.push('would UNARCHIVE');
    planParts.push(`would push ${versionsToPush.length.toString()} version(s)`);
    planParts.push('would stamp description');
    return {
      packageName,
      repoName,
      repoUrl,
      gitRemote,
      status: 'skipped',
      publishedVersions: publishedVersions.map(v => v.version),
      pushedVersions: versionsToPush.map(v => v.version),
      skippedVersions: skippedVersions.map(v => v.version),
      archived: repoArchived,
      reason: `dry-run: ${planParts.join('; ')}`,
      errors,
    };
  }

  if (!repoExists) {
    const createArgs: string[] = [
      'repo',
      'create',
      `${org}/${repoName}`,
      '--public',
      '--disable-issues',
      '--disable-wiki',
      '--description',
      desiredDescription,
    ];
    const create = await runner.run('gh', createArgs, { cwd });
    if (create.exitCode !== 0) {
      errors.push({
        code: SYNC_REPO_ERROR_CODES.ghApiFailed,
        severity: 'error',
        message: `${packageName}: gh repo create failed — ${create.stderr.trim()}`,
        target: packageName,
        remediation: 'Verify gh auth and that you can create repos in the arki-labs org.',
      });
      return {
        packageName,
        repoName,
        repoUrl,
        gitRemote,
        status: 'failed',
        publishedVersions: publishedVersions.map(v => v.version),
        pushedVersions: [],
        skippedVersions: skippedVersions.map(v => v.version),
        archived: false,
        reason: 'gh repo create failed',
        errors,
      };
    }
  }

  if (repoExists && repoArchived) {
    const unarchive = await runner.run(
      'gh',
      ['api', `repos/${org}/${repoName}`, '-X', 'PATCH', '-F', 'archived=false'],
      { cwd },
    );
    if (unarchive.exitCode !== 0) {
      errors.push({
        code: SYNC_REPO_ERROR_CODES.ghApiFailed,
        severity: 'error',
        message: `${packageName}: gh unarchive failed — ${unarchive.stderr.trim()}`,
        target: packageName,
        remediation:
          'Verify gh auth has repo admin scope; archived repos require unarchiving before push.',
      });
      return {
        packageName,
        repoName,
        repoUrl,
        gitRemote,
        status: 'failed',
        publishedVersions: publishedVersions.map(v => v.version),
        pushedVersions: [],
        skippedVersions: skippedVersions.map(v => v.version),
        archived: true,
        reason: 'gh unarchive failed',
        errors,
      };
    }
  }

  let workDir: string;
  try {
    workDir = await mkdtemp(path.join(os.tmpdir(), `arki-mirror-${repoName}-`));
  } catch (cause) {
    errors.push({
      code: SYNC_REPO_ERROR_CODES.tarballSetupFailed,
      severity: 'error',
      message: `${packageName}: failed to create temp dir — ${cause instanceof Error ? cause.message : String(cause)}`,
      target: packageName,
    });
    return {
      packageName,
      repoName,
      repoUrl,
      gitRemote,
      status: 'failed',
      publishedVersions: publishedVersions.map(v => v.version),
      pushedVersions: [],
      skippedVersions: skippedVersions.map(v => v.version),
      archived: false,
      reason: 'temp dir creation failed',
      errors,
    };
  }

  const initResult = await runGitSequence(
    workDir,
    [
      { args: ['init', '-b', 'main', '-q'] },
      { args: ['config', 'commit.gpgsign', 'false'] },
      { args: ['config', 'user.name', 'ARKI Release Bot'] },
      { args: ['config', 'user.email', 'bot@arki-labs.org'] },
    ],
    runner,
  );
  if (!initResult.ok) {
    errors.push({
      code: SYNC_REPO_ERROR_CODES.gitOpFailed,
      severity: 'error',
      message: `${packageName}: git init failed at '${initResult.step}' — ${initResult.reason}`,
      target: packageName,
    });
    await rm(workDir, { recursive: true, force: true });
    return {
      packageName,
      repoName,
      repoUrl,
      gitRemote,
      status: 'failed',
      publishedVersions: publishedVersions.map(v => v.version),
      pushedVersions: [],
      skippedVersions: skippedVersions.map(v => v.version),
      archived: false,
      reason: 'git init failed',
      errors,
    };
  }

  // Full-history replay: rebuild from every published version into a
  // fresh tree, force-push main + tags. Tarballs are immutable, so the
  // resulting tree is byte-identical across runs; only new commits/tags
  // actually transit the network (git negotiates).
  const pushedVersions: string[] = [];
  for (const { version, publishedAt } of publishedVersions) {
    await wipeExceptGit(workDir);
    const tarballResult = await fetchTarballUrl(packageName, version, runner, cwd);
    if ('error' in tarballResult) {
      errors.push({
        code: SYNC_REPO_ERROR_CODES.npmFetchFailed,
        severity: 'error',
        message: `${packageName}@${version}: npm view dist.tarball failed — ${tarballResult.error}`,
        target: packageName,
      });
      await rm(workDir, { recursive: true, force: true });
      return {
        packageName,
        repoName,
        repoUrl,
        gitRemote,
        status: 'failed',
        publishedVersions: publishedVersions.map(v => v.version),
        pushedVersions,
        skippedVersions: skippedVersions.map(v => v.version),
        archived: false,
        reason: `tarball lookup failed for v${version}`,
        errors,
      };
    }
    const extract = await downloadAndExtractTarball(tarballResult.url, workDir, runner, cwd);
    if (!extract.ok) {
      errors.push({
        code: SYNC_REPO_ERROR_CODES.tarballSetupFailed,
        severity: 'error',
        message: `${packageName}@${version}: tarball extract failed — ${extract.reason}`,
        target: packageName,
      });
      await rm(workDir, { recursive: true, force: true });
      return {
        packageName,
        repoName,
        repoUrl,
        gitRemote,
        status: 'failed',
        publishedVersions: publishedVersions.map(v => v.version),
        pushedVersions,
        skippedVersions: skippedVersions.map(v => v.version),
        archived: false,
        reason: `extract failed for v${version}`,
        errors,
      };
    }

    const noticeBody =
      [
        `# ${packageName}`,
        '',
        `Published version: **${version}**`,
        '',
        `This repository is a **read-only mirror** of the [${packageName}](https://www.npmjs.com/package/${packageName}) npm package.`,
        '',
        '- **Canonical source**: <https://github.com/arki-labs/arki>',
        '- **Issues / PRs**: open them against `arki-labs/arki`, not this mirror.',
        '- **Each commit here corresponds to a published npm version. Tags are `v<version>`.**',
        '',
        'Generated by `bun release:arki sync-package-repos`.',
        '',
      ].join('\n');
    await writeFile(path.join(workDir, 'MIRROR.md'), noticeBody, 'utf8');

    const commitDate = publishedAt.length > 0 ? publishedAt : new Date().toISOString();
    const commit = await runGitSequence(
      workDir,
      [
        { args: ['add', '-A'] },
        {
          args: ['commit', '-m', `release: ${packageName}@${version}`, '--allow-empty'],
          env: {
            GIT_AUTHOR_DATE: commitDate,
            GIT_COMMITTER_DATE: commitDate,
          },
        },
        { args: ['tag', `v${version}`] },
      ],
      runner,
    );
    if (!commit.ok) {
      errors.push({
        code: SYNC_REPO_ERROR_CODES.gitOpFailed,
        severity: 'error',
        message: `${packageName}@${version}: git commit/tag failed at '${commit.step}' — ${commit.reason}`,
        target: packageName,
      });
      await rm(workDir, { recursive: true, force: true });
      return {
        packageName,
        repoName,
        repoUrl,
        gitRemote,
        status: 'failed',
        publishedVersions: publishedVersions.map(v => v.version),
        pushedVersions,
        skippedVersions: skippedVersions.map(v => v.version),
        archived: false,
        reason: `git commit/tag failed for v${version}`,
        errors,
      };
    }
    pushedVersions.push(version);
  }

  const push = await runGitSequence(
    workDir,
    [
      { args: ['remote', 'add', 'origin', gitRemote] },
      { args: ['push', '--force', 'origin', 'main'] },
      { args: ['push', '--force', 'origin', '--tags'] },
    ],
    runner,
  );
  if (!push.ok) {
    errors.push({
      code: SYNC_REPO_ERROR_CODES.gitOpFailed,
      severity: 'error',
      message: `${packageName}: git push failed at '${push.step}' — ${push.reason}`,
      target: packageName,
      remediation: 'Verify SSH access to arki-labs and that the remote exists.',
    });
    await rm(workDir, { recursive: true, force: true });
    return {
      packageName,
      repoName,
      repoUrl,
      gitRemote,
      status: 'failed',
      publishedVersions: publishedVersions.map(v => v.version),
      pushedVersions,
      skippedVersions: skippedVersions.map(v => v.version),
      archived: false,
      reason: 'git push failed',
      errors,
    };
  }

  // Re-stamp the description on every run. For freshly-created repos the
  // description was passed at `gh repo create` time so this is usually a
  // no-op; for existing repos this is the only way to keep the
  // `[Read-only mirror]` banner aligned when the npm description
  // changes.
  const descResult = await ensureRepoDescription({
    org,
    repoName,
    desired: desiredDescription,
    runner,
    cwd,
  });
  if (descResult.status === 'failed') {
    errors.push({
      code: SYNC_REPO_ERROR_CODES.ghApiFailed,
      severity: 'warning',
      message: `${packageName}: gh repo edit (description) failed — ${descResult.reason}`,
      target: packageName,
      remediation: 'Run `gh repo edit arki-labs/<name> --description "<desc>"` manually.',
    });
  }

  await rm(workDir, { recursive: true, force: true });

  const finalStatus: SyncRepoStatus = repoExists ? 'updated' : 'created';
  return {
    packageName,
    repoName,
    repoUrl,
    gitRemote,
    status: finalStatus,
    publishedVersions: publishedVersions.map(v => v.version),
    pushedVersions,
    skippedVersions: skippedVersions.map(v => v.version),
    archived: false,
    errors,
  };
}

/**
 * Drive the sync across every wave-listed package (or the explicit
 * subset passed via `opts.packages`).
 *
 * The function NEVER throws; every per-package failure lands in a
 * `failed` item with a stable error code. Top-level envelope status:
 *   - `success`  — every package returned `created`, `updated`, `in-sync`, or `skipped`.
 *   - `warning`  — at least one warning-severity error, no failures.
 *   - `failure`  — at least one `failed` item OR error-severity envelope error.
 *
 * For testing, accepts an optional injected {@link ProcessRunner} via
 * the `runner` parameter (kept off the {@link SyncRepoOptions} public
 * surface so the operator-facing CLI shape stays clean).
 */
export async function runSyncPackageRepos(
  opts: SyncRepoOptions & { readonly runner?: ProcessRunner },
): Promise<ReleaseCommandEnvelope<SyncRepoItem, SyncRepoSummary>> {
  const runner = opts.runner ?? defaultProcessRunner;
  const org = opts.githubOrg ?? DEFAULT_GITHUB_ORG;
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;

  const waveAllowlist: string[] = [];
  for (const wave of opts.config.waves) {
    for (const name of wave.packages) {
      waveAllowlist.push(name);
    }
  }

  const filterSet =
    opts.packages !== undefined && opts.packages.length > 0
      ? new Set<string>(opts.packages)
      : null;
  const targets = filterSet !== null
    ? waveAllowlist.filter(name => filterSet.has(name))
    : waveAllowlist;

  debug(
    'runSyncPackageRepos org=%s targets=%d dryRun=%s force=%s',
    org,
    targets.length,
    dryRun,
    force,
  );

  try {
    await mkdir(os.tmpdir(), { recursive: true });
  } catch {
    // Non-fatal.
  }

  const items: SyncRepoItem[] = [];
  const errors: ReleaseError[] = [];
  const counts = { created: 0, updated: 0, inSync: 0, failed: 0, skipped: 0 };

  for (const name of targets) {
    const item = await syncOnePackage({
      packageName: name,
      org,
      runner,
      cwd: opts.cwd,
      dryRun,
      force,
    });
    items.push(item);
    switch (item.status) {
      case 'created':
        counts.created += 1;
        break;
      case 'updated':
        counts.updated += 1;
        break;
      case 'in-sync':
        counts.inSync += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      case 'skipped':
        counts.skipped += 1;
        break;
    }
    for (const err of item.errors) {
      errors.push(err);
    }
  }

  if (filterSet !== null) {
    const unknown = [...filterSet].filter(name => !waveAllowlist.includes(name));
    for (const u of unknown) {
      errors.push({
        code: SYNC_REPO_ERROR_CODES.syncSkipped,
        severity: 'warning',
        message: `--package ${u} did not match any wave-listed package; skipped.`,
        target: u,
        remediation: 'Run `bun release:arki inventory --json` to see wave membership.',
      });
    }
  }

  const totalPackages = items.length;
  const status: 'success' | 'warning' | 'failure' =
    counts.failed > 0
      ? 'failure'
      : errors.some(e => e.severity === 'error')
        ? 'failure'
        : errors.some(e => e.severity === 'warning')
          ? 'warning'
          : 'success';

  const messageParts: string[] = [];
  messageParts.push(`${totalPackages.toString()} packages`);
  if (counts.created > 0) messageParts.push(`${counts.created.toString()} created`);
  if (counts.updated > 0) messageParts.push(`${counts.updated.toString()} updated`);
  if (counts.inSync > 0) messageParts.push(`${counts.inSync.toString()} in-sync`);
  if (counts.failed > 0) messageParts.push(`${counts.failed.toString()} failed`);
  if (counts.skipped > 0) messageParts.push(`${counts.skipped.toString()} skipped`);

  const summary: SyncRepoSummary = {
    message: dryRun ? `(dry-run) ${messageParts.join(' / ')}` : messageParts.join(' / '),
    totalPackages,
    created: counts.created,
    updated: counts.updated,
    inSync: counts.inSync,
    failed: counts.failed,
    skipped: counts.skipped,
    githubOrg: org,
    dryRun,
  };

  return createEnvelope<SyncRepoItem, SyncRepoSummary>({
    command: 'sync-package-repos',
    status,
    summary,
    items,
    errors,
  });
}

/** Render the sync-package-repos envelope as a human-readable table. */
export function renderSyncPackageReposText(
  envelope: ReleaseCommandEnvelope<SyncRepoItem, SyncRepoSummary>,
): string {
  const lines: string[] = [];
  lines.push(
    `[${envelope.status}] sync-package-repos${envelope.summary.dryRun ? ' (dry-run)' : ''}`,
  );
  lines.push(`generated: ${envelope.generatedAt}`);
  lines.push(`org: ${envelope.summary.githubOrg}`);
  lines.push('');
  lines.push(envelope.summary.message);
  lines.push('');

  if (envelope.items.length > 0) {
    const nameW = Math.max(...envelope.items.map(i => i.packageName.length), 20);
    const header = `${'Package'.padEnd(nameW)}  ${'status'.padEnd(10)} ${'pushed'.padEnd(8)} ${'skipped'.padEnd(8)} ${'archived'.padEnd(8)} mirror`;
    lines.push(header);
    lines.push('─'.repeat(header.length));
    for (const item of envelope.items) {
      lines.push(
        `${item.packageName.padEnd(nameW)}  ${item.status.padEnd(10)} ${item.pushedVersions.length.toString().padEnd(8)} ${item.skippedVersions.length.toString().padEnd(8)} ${(item.archived ? 'yes' : 'no').padEnd(8)} ${item.repoUrl}`,
      );
      if (item.reason !== undefined && item.reason.length > 0) {
        lines.push(`  ↳ ${item.reason}`);
      }
    }
    lines.push('');
  }

  if (envelope.errors.length > 0) {
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
