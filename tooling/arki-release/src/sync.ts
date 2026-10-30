/**
 * The `sync` command: one place that mirrors a release to GitHub.
 *
 * Two halves, split by who may run them:
 *
 *   - {@link runSyncPrepare} is agent-safe and local. It rebuilds a tree per
 *     package in `.release/package-mirrors/<name>` from the npm tarball,
 *     writes release notes, puts one annotated wave tag on the candidate's
 *     source commit in this repo (it never commits here: this repo is the
 *     real source of `arki-labs/arki`, not a mirror), and records everything
 *     in `.release/sync-plan.json`. It reads the network (fetch, npm) but
 *     never pushes and never runs a `gh` write.
 *   - {@link runSyncApply} is founder-only. It pushes, tags and creates the
 *     GitHub Releases from that plan. It pushes `main` only where prepare made
 *     a new commit, so it never pushes this repo's `main`. It refuses under
 *     an agent or without a terminal, and it skips whatever already exists,
 *     so a rerun is safe.
 *
 * It never force-pushes: a rejected push means someone else moved the
 * branch, and a human has to look (troubleshooting.md).
 *
 * Error codes (`MSYNC_E0xx`) never get renumbered.
 */

import { cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import debugFactory from 'debug';
import { z } from 'zod';

import { readCandidate } from './candidate';
import { discoverManifests } from './inventory';
import { createEnvelope } from './json-output';
import type { ExternalOutcome, ExternalResults } from './readiness';
import { defaultGitRunner, defaultNpmRunner, execRunner, type ExecRunner, type GitRunner, type NpmRunner } from './runners';
import type { ReleaseCommandEnvelope, ReleaseConfig, ReleaseError } from './types';

const debug = debugFactory('arki:release:sync');

export const SYNC_ERROR_CODES = {
  /** Apply refused: an agent session is running. */
  agentSession: 'MSYNC_E001',
  /** Apply refused: stdin is not a terminal. */
  notTerminal: 'MSYNC_E002',
  /** The sync plan is missing or does not match its schema. */
  planUnreadable: 'MSYNC_E003',
  /** The candidate is unusable. */
  candidateUnusable: 'MSYNC_E004',
  /** A git command failed. */
  gitFailed: 'MSYNC_E005',
  /** A mirror checkout has uncommitted changes, so a leftover run may hold work. */
  mirrorDirty: 'MSYNC_E006',
  /** The mirror directory is not its own git checkout (it would use the monorepo's `.git`). */
  mirrorNotCheckout: 'MSYNC_E007',
  /** A tarball could not be packed, verified or unpacked. */
  tarballFailed: 'MSYNC_E008',
  // MSYNC_E009 (public tree export failed) is retired with the generated arki mirror; never reuse it.
  /** A `gh` command failed. */
  ghFailed: 'MSYNC_E010',
  /** A push was rejected. */
  pushRejected: 'MSYNC_E011',
  /** A local wave tag already points at another commit; published tags never move. */
  tagMoved: 'MSYNC_E012',
} as const;

const COMMAND = 'sync' as const;
const ORG = 'arki-labs';
const ARKI_REPO = `${ORG}/arki`;
export const SYNC_PLAN_PATH = path.join('.release', 'sync-plan.json');
const PACKAGE_MIRRORS_DIR = path.join('.release', 'package-mirrors');
const STAGING_DIR = path.join('.release', 'sync');

const FOUNDER = { name: 'Alexandru Furculita', email: 'alex@furculita.net' } as const;
const RELEASE_BOT = { name: 'ARKI Release Bot', email: 'bot@arki-labs.org' } as const;

// Plan
// ---------------------------------------------------------------------------

const repoStateSchema = z.object({
  /** Repo path relative to the workspace root; `.` for the wave, which is this repo. */
  dir: z.string(),
  /** Commit prepared on top of the remote branch; null when nothing changed (always null for the wave). */
  commit: z.string().nullable(),
  tag: z.string(),
  /** True when the tag already exists on the remote at prepare time. */
  tagExists: z.boolean(),
  /** Release notes file, relative to the workspace root. */
  notesFile: z.string(),
  /** Files to attach to the GitHub Release, relative to the workspace root. */
  assets: z.array(z.string()),
});

export const syncPlanSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  wave: z.string(),
  date: z.string(),
  arki: repoStateSchema.extend({ repo: z.literal(ARKI_REPO) }),
  packages: z.array(
    repoStateSchema.extend({
      name: z.string(),
      repo: z.string(),
      version: z.string(),
      description: z.string(),
      /** True when the tarball hash matched the candidate or the npm registry. */
      integrityVerified: z.boolean(),
      /** The mirror tree carries SECURITY.md. */
      security: z.boolean(),
    }),
  ),
  /** What `--apply` finished, keyed by repo; written back after each step. */
  applied: z.record(z.string(), z.object({ pushed: z.boolean(), released: z.boolean() })).default({}),
});

export type SyncPlan = z.infer<typeof syncPlanSchema>;
export type SyncPlanPackage = SyncPlan['packages'][number];

// Envelope
// ---------------------------------------------------------------------------

export const SYNC_ACTIONS = ['prepared', 'unchanged', 'already-tagged', 'pushed', 'skipped', 'failed'] as const;
export type SyncAction = (typeof SYNC_ACTIONS)[number];

export type SyncItem = {
  /** `arki-labs/arki` or `arki-labs/<name>`. */
  readonly target: string;
  readonly kind: 'wave' | 'package';
  readonly action: SyncAction;
  readonly detail: string;
};

export type SyncSummary = { readonly message: string; readonly planPath: string | null };

export type SyncEnvelope = ReleaseCommandEnvelope<SyncItem, SyncSummary>;

function envelope(
  status: ReleaseCommandEnvelope['status'],
  summary: SyncSummary,
  items: SyncItem[],
  errors: ReleaseError[],
): SyncEnvelope {
  return createEnvelope<SyncItem, SyncSummary>({ command: COMMAND, status, summary, items, errors });
}

function fail(code: string, message: string, remediation: string, target?: string): ReleaseError {
  return { code, severity: 'error', message, remediation, target };
}

// Text helpers
// ---------------------------------------------------------------------------

/** First line of every package mirror README (plan #50). */
export function mirrorReadmeHeader(input: { readonly name: string; readonly version: string; readonly date: string }): string {
  const short = shortName(input.name);
  const provenance = `https://www.npmjs.com/package/${input.name}/v/${input.version}#provenance`;
  return `Read-only mirror of \`${input.name}\` v${input.version}. Source and issues: ${ARKI_REPO}. Docs: https://arki.dev/packages/${short}. Published ${input.date} with provenance ${provenance}.`;
}

export function shortName(packageName: string): string {
  if (!packageName.startsWith('@arki/')) throw new Error(`Expected @arki/<name>, got '${packageName}'`);
  return packageName.slice('@arki/'.length);
}

/** The CHANGELOG section of one version, without its heading; null when the version has none. */
export function extractChangelogEntry(changelog: string, version: string): string | null {
  const lines = changelog.split('\n');
  const escaped = version.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`);
  const start = lines.findIndex(line => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^##\s/.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body.length > 0 ? body : null;
}

// Git
// ---------------------------------------------------------------------------

type Identity = { readonly name: string; readonly email: string };

type RepoResult = { readonly commit: string | null; readonly tagExists: boolean };

type RepoRequest = {
  readonly git: GitRunner;
  readonly dir: string;
  readonly remote: string;
  readonly identity: Identity;
  readonly writeTree: (dir: string) => Promise<void>;
  readonly message: string;
  readonly tag: string;
  readonly tagMessage: string;
};

function gitIdentityArgs(identity: Identity): string[] {
  return ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

async function wipeExceptGit(dir: string): Promise<void> {
  for (const entry of await readdir(dir)) {
    if (entry !== '.git') await rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Brings `dir` to the remote's `main`, replaces its files, commits on top and
 * tags. Stops (without touching files) when the tag is already on the remote.
 */
async function prepareRepo(request: RepoRequest): Promise<{ readonly ok: true; readonly result: RepoResult } | { readonly ok: false; readonly error: ReleaseError }> {
  const { git, dir, remote, identity } = request;
  const run = (args: readonly string[]) => git(args, { cwd: dir });
  const gitFailure = (what: string, out: { stderr: string; stdout: string }): { ok: false; error: ReleaseError } => ({
    ok: false,
    error: fail(
      SYNC_ERROR_CODES.gitFailed,
      `${what} failed in ${dir}: ${(out.stderr.trim() || out.stdout.trim()).slice(0, 300)}`,
      `Fix the git problem, or delete ${dir} and run \`sync --prepare\` again (it is a disposable checkout).`,
      dir,
    ),
  });

  await mkdir(dir, { recursive: true });
  if (!(await exists(path.join(dir, '.git')))) {
    const init = await run(['init', '-q', '-b', 'main']);
    if (init.code !== 0) return gitFailure('git init', init);
    const add = await run(['remote', 'add', 'origin', remote]);
    if (add.code !== 0) return gitFailure('git remote add', add);
  }

  // Without its own .git, git would walk up to the monorepo and `add -A` would stage sibling work.
  const top = await run(['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || (await realpath(top.stdout.trim())) !== (await realpath(dir))) {
    return {
      ok: false,
      error: fail(
        SYNC_ERROR_CODES.mirrorNotCheckout,
        `${dir} is not its own git checkout (git says the top level is ${top.stdout.trim() || 'unknown'}).`,
        `Delete ${dir} and run \`sync --prepare\` again.`,
        dir,
      ),
    };
  }

  const status = await run(['status', '--porcelain']);
  if (status.code !== 0) return gitFailure('git status', status);
  if (status.stdout.trim().length > 0) {
    return {
      ok: false,
      error: fail(
        SYNC_ERROR_CODES.mirrorDirty,
        `${dir} has uncommitted changes from an earlier run.`,
        `Look at \`git -C ${dir} status\`. If nothing there matters, delete ${dir} and run \`sync --prepare\` again.`,
        dir,
      ),
    };
  }

  let remoteIsNew = false;
  const fetched = await run(['fetch', '-q', 'origin', '--tags']);
  if (fetched.code !== 0) {
    // A package mirror may not exist on GitHub yet.
    if (/not found|does not appear to be a git repository|does not exist/i.test(fetched.stderr)) {
      remoteIsNew = true;
    } else {
      return gitFailure('git fetch', fetched);
    }
  }

  if (!remoteIsNew) {
    const remoteTag = await run(['ls-remote', '--tags', 'origin', `refs/tags/${request.tag}`]);
    if (remoteTag.code !== 0) return gitFailure('git ls-remote', remoteTag);
    if (remoteTag.stdout.trim().length > 0) return { ok: true, result: { commit: null, tagExists: true } };
    const hasMain = await run(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
    if (hasMain.code === 0) {
      // -f: leftovers of an aborted run must not block; the checkout is disposable and rebuilt below.
      const checkout = await run(['checkout', '-q', '-f', '-B', 'main', 'origin/main']);
      if (checkout.code !== 0) return gitFailure('git checkout', checkout);
    }
  }

  await wipeExceptGit(dir);
  await request.writeTree(dir);
  const added = await run(['add', '-A']);
  if (added.code !== 0) return gitFailure('git add', added);
  const staged = await run(['diff', '--cached', '--quiet']);
  let commit: string | null = null;
  if (staged.code === 1) {
    const committed = await run([...gitIdentityArgs(identity), 'commit', '-q', '-m', request.message]);
    if (committed.code !== 0) return gitFailure('git commit', committed);
    const head = await run(['rev-parse', 'HEAD']);
    if (head.code !== 0) return gitFailure('git rev-parse', head);
    commit = head.stdout.trim();
  } else if (staged.code !== 0) {
    return gitFailure('git diff --cached', staged);
  }

  const hasHead = await run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (hasHead.code !== 0) {
    return { ok: false, error: fail(SYNC_ERROR_CODES.gitFailed, `${dir} has nothing to mirror (empty tree).`, 'Check that the package or public tree has files.', dir) };
  }
  // A leftover local tag from an earlier prepare would block `tag -a`; the remote does not have it.
  await run(['tag', '-d', request.tag]);
  const tagged = await run([...gitIdentityArgs(identity), 'tag', '-a', request.tag, '-m', request.tagMessage]);
  if (tagged.code !== 0) return gitFailure('git tag', tagged);
  return { ok: true, result: { commit, tagExists: false } };
}

/**
 * Puts the annotated wave tag on `commit` in the source repo (`cwd`). Never
 * commits and never moves a branch. Stops when the tag is already on the
 * remote. Fails when a local tag of that name points at another commit:
 * published tags never move.
 */
async function tagSourceRepo(request: {
  readonly git: GitRunner;
  readonly cwd: string;
  readonly commit: string;
  readonly tag: string;
  readonly tagMessage: string;
}): Promise<{ readonly ok: true; readonly tagExists: boolean } | { readonly ok: false; readonly error: ReleaseError }> {
  const { git, cwd, tag } = request;
  const run = (args: readonly string[]) => git(args, { cwd });
  const gitFailure = (what: string, out: { stderr: string; stdout: string }): { ok: false; error: ReleaseError } => ({
    ok: false,
    error: fail(SYNC_ERROR_CODES.gitFailed, `${what} failed in ${cwd}: ${(out.stderr.trim() || out.stdout.trim()).slice(0, 300)}`, 'Fix the git problem and run `sync --prepare` again.', ARKI_REPO),
  });

  const resolved = await run(['rev-parse', '--verify', '--quiet', `${request.commit}^{commit}`]);
  if (resolved.code !== 0) {
    return {
      ok: false,
      error: fail(SYNC_ERROR_CODES.gitFailed, `The source commit ${request.commit} is not in ${cwd}.`, 'Fetch it (`git fetch origin`), or freeze a new candidate from this repo.', ARKI_REPO),
    };
  }
  const commit = resolved.stdout.trim();

  const remoteTag = await run(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
  if (remoteTag.code !== 0) return gitFailure('git ls-remote', remoteTag);
  if (remoteTag.stdout.trim().length > 0) return { ok: true, tagExists: true };

  const localTag = await run(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  if (localTag.code === 0) {
    const tagged = localTag.stdout.trim();
    if (tagged === commit) return { ok: true, tagExists: false };
    return {
      ok: false,
      error: fail(
        SYNC_ERROR_CODES.tagMoved,
        `The local tag ${tag} points at ${tagged.slice(0, 12)}, not at the source commit ${commit.slice(0, 12)}.`,
        `Published tags never move. If ${tag} was never pushed and you know why it is there, delete it (\`git tag -d ${tag}\`) and prepare again. Otherwise stop and ask.`,
        ARKI_REPO,
      ),
    };
  }
  const created = await run([...gitIdentityArgs(FOUNDER), 'tag', '-a', tag, '-m', request.tagMessage, commit]);
  if (created.code !== 0) return gitFailure('git tag', created);
  return { ok: true, tagExists: false };
}

// Prepare
// ---------------------------------------------------------------------------

export interface RunSyncPrepareOptions {
  readonly cwd: string;
  readonly config: ReleaseConfig;
  /** A frozen candidate; without it the tarballs are `npm pack`ed from the published versions. */
  readonly candidateDir?: string;
  readonly gitRunner?: GitRunner;
  readonly npmRunner?: NpmRunner;
  /** Runs `tar`. */
  readonly exec?: ExecRunner;
  /** `git@github.com:<repo>.git` by default. */
  readonly remoteUrl?: (repo: string) => string;
  readonly now?: () => Date;
}

type Tarball = { readonly name: string; readonly version: string; readonly file: string; readonly integrityVerified: boolean };

const packJson = z.array(z.object({ filename: z.string(), integrity: z.string().optional() })).min(1);

function defaultRemote(repo: string): string {
  return `git@github.com:${repo}.git`;
}

/** Candidate tarballs, or the published versions of every admitted package packed from npm. */
async function collectTarballs(
  options: RunSyncPrepareOptions,
  stagingRoot: string,
): Promise<{ wave: string; sourceCommit: string | null; tarballs: Tarball[]; errors: ReleaseError[] }> {
  const { cwd, config } = options;
  const errors: ReleaseError[] = [];
  if (options.candidateDir !== undefined) {
    const read = await readCandidate(options.candidateDir);
    if (!read.ok) return { wave: 'unknown', sourceCommit: null, tarballs: [], errors: read.errors.map(e => ({ ...e, code: SYNC_ERROR_CODES.candidateUnusable })) };
    const tarballs = read.candidate.packages.map(pkg => ({
      name: pkg.name,
      version: pkg.version,
      file: path.resolve(read.dir, pkg.tarball),
      // readCandidate already compared every sha512.
      integrityVerified: true,
    }));
    return { wave: read.candidate.wave, sourceCommit: read.candidate.sourceCommit, tarballs, errors };
  }

  const npm = options.npmRunner ?? defaultNpmRunner;
  const { manifests } = await discoverManifests(cwd);
  const admitted = new Set(config.waves.flatMap(w => w.packages));
  const tarballs: Tarball[] = [];
  for (const manifest of manifests.filter(m => !m.private && admitted.has(m.name))) {
    const dest = path.join(stagingRoot, 'npm', shortName(manifest.name));
    await mkdir(dest, { recursive: true });
    const spec = `${manifest.name}@${manifest.version}`;
    const packed = await npm(['pack', spec, '--json', '--pack-destination', dest], { cwd });
    if (packed.code !== 0) {
      // Unpublished versions are normal before the first publish; there is nothing to mirror yet.
      debug('skip %s: %s', spec, packed.stderr.trim());
      continue;
    }
    let parsed: z.infer<typeof packJson> | null = null;
    try {
      const result = packJson.safeParse(JSON.parse(packed.stdout) as unknown);
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    const first = parsed?.[0];
    if (first === undefined) {
      errors.push(fail(SYNC_ERROR_CODES.tarballFailed, `npm pack ${spec} printed no usable JSON.`, 'Run `npm pack` by hand and check the registry.', manifest.name));
      continue;
    }
    const file = path.join(dest, path.basename(first.filename));
    const verified = await npmIntegrityMatches(npm, cwd, spec, file);
    if (verified === 'mismatch') {
      errors.push(fail(SYNC_ERROR_CODES.tarballFailed, `${spec}: the packed tarball does not match the registry's integrity.`, 'Do not mirror it. Check the registry and your network, then retry.', manifest.name));
      continue;
    }
    tarballs.push({ name: manifest.name, version: manifest.version, file, integrityVerified: verified === 'match' });
  }
  // No candidate names a commit; the wave tag goes on HEAD, the state these versions were published from.
  return { wave: 'all', sourceCommit: null, tarballs, errors };
}

async function npmIntegrityMatches(npm: NpmRunner, cwd: string, spec: string, file: string): Promise<'match' | 'mismatch' | 'unknown'> {
  const view = await npm(['view', spec, 'dist.integrity'], { cwd });
  const expected = view.stdout.trim();
  if (view.code !== 0 || !expected.startsWith('sha512-')) return 'unknown';
  const { createHash } = await import('node:crypto');
  const actual = `sha512-${createHash('sha512')
    .update(await readFile(file))
    .digest('base64')}`;
  return actual === expected ? 'match' : 'mismatch';
}

/** Local, agent-safe half of `sync`: everything is prepared on disk, nothing is pushed. */
export async function runSyncPrepare(options: RunSyncPrepareOptions): Promise<SyncEnvelope> {
  const { cwd } = options;
  const git = options.gitRunner ?? defaultGitRunner;
  const exec = options.exec ?? execRunner;
  const remoteUrl = options.remoteUrl ?? defaultRemote;
  const now = (options.now ?? (() => new Date()))();
  const date = now.toISOString().slice(0, 10);
  const stagingRoot = path.join(cwd, STAGING_DIR);
  const rel = (file: string) => path.relative(cwd, file);
  const items: SyncItem[] = [];
  const errors: ReleaseError[] = [];
  const stop = (message: string): SyncEnvelope => envelope('failure', { message, planPath: null }, items, errors);

  // 1. Tarballs.
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  const collected = await collectTarballs(options, stagingRoot);
  errors.push(...collected.errors);
  if (errors.length > 0) return stop('Could not collect the tarballs.');
  if (collected.tarballs.length === 0) {
    errors.push(fail(SYNC_ERROR_CODES.tarballFailed, 'No published package to mirror.', 'Publish a wave first, or pass `--candidate <dir>`.'));
    return stop('Nothing to mirror.');
  }
  const wave = collected.wave;

  // The text is written once, in the root SECURITY.md that the public tree also ships.
  const securityMd = await readFile(path.join(cwd, 'SECURITY.md'), 'utf8');

  // 2. Per-package trees and notes. Built before the wave tag so a bad tarball stops early.
  const packages: SyncPlanPackage[] = [];
  const noteSections: string[] = [];
  for (const tarball of collected.tarballs) {
    const short = shortName(tarball.name);
    const repo = `${ORG}/${short}`;
    const stage = path.join(stagingRoot, short);
    const tree = path.join(stage, 'tree');
    await mkdir(tree, { recursive: true });
    const unpacked = await exec('tar', ['-xzf', tarball.file, '--strip-components=1', '-C', tree], { cwd });
    if (unpacked.code !== 0) {
      errors.push(fail(SYNC_ERROR_CODES.tarballFailed, `${tarball.name}: tar failed: ${unpacked.stderr.trim()}`, 'Check that the tarball is a valid npm pack output.', tarball.name));
      items.push({ target: repo, kind: 'package', action: 'failed', detail: 'tarball did not unpack' });
      continue;
    }
    const readme = await readFile(path.join(tree, 'README.md'), 'utf8').catch(() => '');
    await writeFile(path.join(tree, 'README.md'), `${mirrorReadmeHeader({ name: tarball.name, version: tarball.version, date })}\n\n${readme}`);
    await writeFile(path.join(tree, 'SECURITY.md'), securityMd);

    const changelog = await readFile(path.join(tree, 'CHANGELOG.md'), 'utf8').catch(() => '');
    const entry = extractChangelogEntry(changelog, tarball.version) ?? `Release ${tarball.name} v${tarball.version}.`;
    const notesFile = path.join(stage, 'notes.md');
    await writeFile(notesFile, `${entry}\n`);
    noteSections.push(`## ${tarball.name} v${tarball.version}\n\n${entry}`);

    const assets: string[] = [];
    const tarballAsset = path.join(stage, path.basename(tarball.file));
    await cp(tarball.file, tarballAsset);
    assets.push(rel(tarballAsset));
    const apiJson = path.join(tree, 'api.json');
    if (await exists(apiJson)) {
      const apiAsset = path.join(stage, `${short}-api.json`);
      await cp(apiJson, apiAsset);
      assets.push(rel(apiAsset));
    }

    const manifest = JSON.parse(await readFile(path.join(tree, 'package.json'), 'utf8')) as { description?: unknown };
    const description = typeof manifest.description === 'string' ? manifest.description : '';

    const mirrorDir = path.join(cwd, PACKAGE_MIRRORS_DIR, short);
    const prepared = await prepareRepo({
      git,
      dir: mirrorDir,
      remote: remoteUrl(repo),
      identity: RELEASE_BOT,
      writeTree: dest => cp(tree, dest, { recursive: true }),
      message: `release: ${tarball.name} v${tarball.version}`,
      tag: `v${tarball.version}`,
      tagMessage: `${tarball.name} v${tarball.version}`,
    });
    if (!prepared.ok) {
      errors.push(prepared.error);
      items.push({ target: repo, kind: 'package', action: 'failed', detail: prepared.error.message });
      continue;
    }
    const { commit, tagExists } = prepared.result;
    items.push({
      target: repo,
      kind: 'package',
      action: tagExists ? 'already-tagged' : commit === null ? 'unchanged' : 'prepared',
      detail: `v${tarball.version}`,
    });
    packages.push({
      name: tarball.name,
      repo,
      version: tarball.version,
      description,
      integrityVerified: tarball.integrityVerified,
      security: true,
      dir: rel(mirrorDir),
      commit,
      tag: `v${tarball.version}`,
      tagExists,
      notesFile: rel(notesFile),
      assets,
    });
  }
  if (errors.length > 0) return stop(`${errors.length.toString()} package mirrors failed to prepare.`);

  // 3. The wave tag, on the source commit in this repo. No tree export, no commit: this repo is the source.
  const arkiTag = `v${wave}-${date}`;
  const summaryLine = packages.map(p => `${p.name}@${p.version}`).join(', ');
  const waveTagged = await tagSourceRepo({ git, cwd, commit: collected.sourceCommit ?? 'HEAD', tag: arkiTag, tagMessage: `${wave} ${date}\n\n${summaryLine}` });
  if (!waveTagged.ok) {
    errors.push(waveTagged.error);
    items.unshift({ target: ARKI_REPO, kind: 'wave', action: 'failed', detail: waveTagged.error.message });
    return stop('Tagging the wave failed.');
  }
  items.unshift({ target: ARKI_REPO, kind: 'wave', action: waveTagged.tagExists ? 'already-tagged' : 'prepared', detail: arkiTag });
  const waveNotes = path.join(stagingRoot, 'wave-notes.md');
  await writeFile(waveNotes, `# ${wave} (${date})\n\n${noteSections.join('\n\n')}\n`);

  // 4. The plan.
  const plan: SyncPlan = {
    version: 1,
    createdAt: now.toISOString(),
    wave,
    date,
    arki: {
      repo: ARKI_REPO,
      dir: '.',
      commit: null,
      tag: arkiTag,
      tagExists: waveTagged.tagExists,
      notesFile: rel(waveNotes),
      assets: [],
    },
    packages,
    applied: {},
  };
  const planPath = path.join(cwd, SYNC_PLAN_PATH);
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  debug('prepared %d package mirrors, plan at %s', packages.length, planPath);
  return envelope('success', { message: `Prepared ${wave}: ${packages.length.toString()} package mirrors and ${arkiTag}. Plan: ${SYNC_PLAN_PATH}.`, planPath }, items, errors);
}

// Apply
// ---------------------------------------------------------------------------

export interface RunSyncApplyOptions {
  readonly cwd: string;
  /** Default `<cwd>/.release/sync-plan.json`. */
  readonly planPath?: string;
  readonly gitRunner?: GitRunner;
  /** Runs `gh`. */
  readonly exec?: ExecRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTty?: () => boolean;
}

export async function readSyncPlan(planPath: string): Promise<{ readonly plan: SyncPlan } | { readonly error: ReleaseError }> {
  const unreadable = (why: string) => ({
    error: fail(SYNC_ERROR_CODES.planUnreadable, `Sync plan ${planPath} is unusable: ${why}.`, 'Run `sync --prepare` to write a fresh plan.', planPath),
  });
  let raw: string;
  try {
    raw = await readFile(planPath, 'utf8');
  } catch {
    return unreadable('it is missing');
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return unreadable('it is not valid JSON');
  }
  const parsed = syncPlanSchema.safeParse(json);
  return parsed.success ? { plan: parsed.data } : unreadable(`it does not match the schema (${parsed.error.message})`);
}

type Target = {
  readonly repo: string;
  readonly kind: SyncItem['kind'];
  readonly dir: string;
  readonly commit: string | null;
  readonly tag: string;
  readonly tagExists: boolean;
  readonly notesFile: string;
  readonly assets: readonly string[];
  readonly description: string | null;
  readonly title: string;
};

function targetsOf(plan: SyncPlan): Target[] {
  const packages = plan.packages.map<Target>(p => ({
    repo: p.repo,
    kind: 'package',
    dir: p.dir,
    commit: p.commit,
    tag: p.tag,
    tagExists: p.tagExists,
    notesFile: p.notesFile,
    assets: p.assets,
    description: p.description,
    title: `${p.name} v${p.version}`,
  }));
  const wave: Target = {
    repo: plan.arki.repo,
    kind: 'wave',
    dir: plan.arki.dir,
    commit: plan.arki.commit,
    tag: plan.arki.tag,
    tagExists: plan.arki.tagExists,
    notesFile: plan.arki.notesFile,
    assets: plan.arki.assets,
    description: null,
    title: `${plan.wave} ${plan.date}`,
  };
  // Packages first: the wave release announces what they already published.
  return [...packages, wave];
}

/** Founder-only half of `sync`: pushes and creates GitHub Releases from the plan. Skips whatever exists. */
export async function runSyncApply(options: RunSyncApplyOptions): Promise<SyncEnvelope> {
  const env = options.env ?? process.env;
  const isTty = options.isTty ?? (() => process.stdin.isTTY === true);
  const items: SyncItem[] = [];
  const refuse = (error: ReleaseError): SyncEnvelope => envelope('failure', { message: error.message, planPath: null }, items, [error]);
  if (env.CLAUDECODE !== undefined && env.CLAUDECODE !== '') {
    return refuse(fail(SYNC_ERROR_CODES.agentSession, '`sync --apply` pushes to GitHub, and agents never push.', 'Run `bun release:arki sync --apply` yourself in a terminal. Agents run `sync --prepare` only.'));
  }
  if (!isTty()) {
    return refuse(fail(SYNC_ERROR_CODES.notTerminal, '`sync --apply` needs a terminal; stdin is not one.', 'Run it from an interactive shell.'));
  }

  const { cwd } = options;
  const planPath = options.planPath ?? path.join(cwd, SYNC_PLAN_PATH);
  const read = await readSyncPlan(planPath);
  if ('error' in read) return refuse(read.error);
  const { plan } = read;
  const git = options.gitRunner ?? defaultGitRunner;
  const exec = options.exec ?? execRunner;
  const errors: ReleaseError[] = [];

  const save = () => writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const markApplied = async (repo: string, patch: Partial<{ pushed: boolean; released: boolean }>) => {
    plan.applied[repo] = { pushed: false, released: false, ...plan.applied[repo], ...patch };
    await save();
  };

  for (const target of targetsOf(plan)) {
    const dir = path.resolve(cwd, target.dir);
    const state = plan.applied[target.repo] ?? { pushed: false, released: false };
    const done: string[] = [];
    const failed = (error: ReleaseError): void => {
      errors.push(error);
      items.push({ target: target.repo, kind: target.kind, action: 'failed', detail: error.message });
    };

    // Push main (only when prepare made a new commit) and the tag. A plain push: a rejection means the branch moved and a human decides.
    if (target.tagExists || state.pushed) {
      done.push('tag already pushed');
    } else {
      if (target.kind === 'package') {
        const view = await exec('gh', ['repo', 'view', target.repo], { cwd });
        if (view.code !== 0) {
          const description = `[Read-only mirror] ${target.description ?? ''}`.trim().slice(0, 350);
          const created = await exec('gh', ['repo', 'create', target.repo, '--public', '--disable-issues', '--disable-wiki', '--description', description], { cwd });
          if (created.code !== 0) {
            failed(fail(SYNC_ERROR_CODES.ghFailed, `gh repo create ${target.repo} failed: ${created.stderr.trim()}`, 'Check `gh auth status` and your org permissions.', target.repo));
            continue;
          }
        }
      }
      // The wave never has a commit, so a release never pushes this repo's main as a side effect.
      if (target.commit !== null) {
        const pushMain = await git(['push', 'origin', 'main'], { cwd: dir });
        if (pushMain.code !== 0) {
          failed(fail(SYNC_ERROR_CODES.pushRejected, `git push origin main for ${target.repo} failed: ${pushMain.stderr.trim().slice(0, 300)}`, `Never force-push. Run \`git -C ${target.dir} fetch\`, read \`git log main..origin/main\`, and if you do not recognize what landed, stop. Otherwise rerun \`sync --prepare\` then \`--apply\`.`, target.repo));
          continue;
        }
      }
      const pushTag = await git(['push', 'origin', target.tag], { cwd: dir });
      if (pushTag.code !== 0) {
        failed(fail(SYNC_ERROR_CODES.pushRejected, `git push origin ${target.tag} for ${target.repo} failed: ${pushTag.stderr.trim().slice(0, 300)}`, 'Published tags never move. If the tag exists with other content, stop and ask.', target.repo));
        continue;
      }
      await markApplied(target.repo, { pushed: true });
      done.push('pushed');
    }

    // The Release: skip when one exists for the tag.
    if (state.released) {
      done.push('release already created');
    } else {
      const existing = await exec('gh', ['release', 'view', target.tag, '--repo', target.repo], { cwd });
      if (existing.code === 0) {
        await markApplied(target.repo, { released: true });
        done.push('release already exists');
      } else {
        const created = await exec(
          'gh',
          ['release', 'create', target.tag, '--repo', target.repo, '--title', target.title, '--notes-file', path.resolve(cwd, target.notesFile), ...target.assets.map(a => path.resolve(cwd, a))],
          { cwd },
        );
        if (created.code !== 0) {
          failed(fail(SYNC_ERROR_CODES.ghFailed, `gh release create ${target.tag} for ${target.repo} failed: ${created.stderr.trim()}`, 'Check `gh auth status`; rerun `sync --apply` (finished steps are skipped).', target.repo));
          continue;
        }
        await markApplied(target.repo, { released: true });
        done.push('release created');
      }
    }
    items.push({ target: target.repo, kind: target.kind, action: done.every(d => d.includes('already')) ? 'skipped' : 'pushed', detail: done.join(', ') });
  }

  const status = errors.length > 0 ? 'failure' : 'success';
  return envelope(status, { message: errors.length > 0 ? `${errors.length.toString()} mirror steps failed. Rerun to continue.` : `Applied ${plan.wave}: ${items.length.toString()} repos.`, planPath }, items, errors);
}

// Readiness
// ---------------------------------------------------------------------------

/**
 * What the readiness gate needs per package, from the sync plan. A mirror
 * counts as done only once its tag is on the remote (seen at prepare time or
 * pushed by apply); a Release is done only once apply created or found it.
 */
export function mirrorReadiness(plan: SyncPlan): Readonly<Record<string, Pick<ExternalResults, 'mirror-tag' | 'mirror-release' | 'mirror-security' | 'mirror-integrity'>>> {
  const outcome = (ok: boolean): ExternalOutcome => (ok ? 'pass' : 'fail');
  const entries = plan.packages.map(pkg => {
    const state = plan.applied[pkg.repo];
    const tagged = pkg.tagExists || state?.pushed === true;
    return [
      pkg.name,
      {
        'mirror-tag': outcome(tagged),
        'mirror-release': outcome(state?.released === true),
        'mirror-security': outcome(tagged && pkg.security),
        'mirror-integrity': outcome(pkg.integrityVerified),
      },
    ] as const;
  });
  return Object.fromEntries(entries);
}

/** Reads `.release/sync-plan.json` and returns {@link mirrorReadiness}; null when there is no usable plan. */
export async function loadMirrorReadiness(cwd: string): Promise<ReturnType<typeof mirrorReadiness> | null> {
  const read = await readSyncPlan(path.join(cwd, SYNC_PLAN_PATH));
  return 'plan' in read ? mirrorReadiness(read.plan) : null;
}
