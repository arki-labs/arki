import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultGitRunner, execRunner, type ExecRunner, type GitRunner } from './runners';
import {
  extractChangelogEntry,
  loadMirrorReadiness,
  mirrorReadiness,
  mirrorReadmeHeader,
  runSyncApply,
  runSyncPrepare,
  SYNC_ERROR_CODES,
  SYNC_PLAN_PATH,
  syncPlanSchema,
  type SyncPlan,
} from './sync';
import type { ReleaseConfig } from './types';

const config: ReleaseConfig = {
  publicTreePath: '.release/arki-public',
  publicMetadataDefaults: {
    license: 'MIT',
    repository: { type: 'git', url: 'https://github.com/arki-labs/arki.git' },
    bugs: { url: 'https://github.com/arki-labs/arki/issues' },
    homepage: 'https://arki.dev',
    publishConfig: { access: 'public' },
    keywords: ['arki'],
  },
  waves: [{ id: 'foundation', label: 'Wave 1', packages: ['@arki/assert'] }],
};

// Real git processes: under load several of them exceed vitest's 5s default.
vi.setConfig({ testTimeout: 60_000 });

const now = () => new Date('2026-10-17T10:00:00Z');

let root: string;
let remotes: string;

async function ok(command: string, args: readonly string[], cwd: string): Promise<string> {
  const out = await execRunner(command, args, { cwd });
  if (out.code !== 0) throw new Error(`${command} ${args.join(' ')}: ${out.stderr}`);
  return out.stdout;
}

/** A bare "GitHub" repo with one commit on main. */
async function seedRemote(name: string): Promise<string> {
  const bare = path.join(remotes, `${name}.git`);
  const seed = path.join(remotes, `${name}-seed`);
  await mkdir(seed, { recursive: true });
  await ok('git', ['init', '-q', '-b', 'main', seed], root);
  await writeFile(path.join(seed, 'old.txt'), 'old\n');
  await ok('git', ['add', '-A'], seed);
  await ok('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed'], seed);
  await ok('git', ['clone', '-q', '--bare', seed, bare], root);
  return bare;
}

/** A candidate with one tarball for @arki/assert@1.2.0. */
async function makeCandidate(): Promise<string> {
  const stage = path.join(root, 'stage');
  const pkg = path.join(stage, 'package');
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@arki/assert', version: '1.2.0', description: 'Assertions.' }));
  await writeFile(path.join(pkg, 'README.md'), '# assert\n');
  await writeFile(path.join(pkg, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0\n\n- Added `ensure`.\n\n## 1.1.0\n\n- Old.\n');
  await writeFile(path.join(pkg, 'api.json'), '{}');
  const dir = path.join(root, 'candidate');
  await mkdir(path.join(dir, 'tarballs'), { recursive: true });
  const tarball = path.join(dir, 'tarballs', 'arki-assert-1.2.0.tgz');
  await ok('tar', ['-czf', tarball, '-C', stage, 'package'], root);
  const sha512 = createHash('sha512')
    .update(await readFile(tarball))
    .digest('hex');
  await writeFile(
    path.join(dir, 'candidate.json'),
    JSON.stringify({
      wave: 'foundation',
      sourceCommit: (await ok('git', ['rev-parse', 'HEAD'], root)).trim(),
      createdAt: now().toISOString(),
      packages: [{ name: '@arki/assert', version: '1.2.0', tarball: 'tarballs/arki-assert-1.2.0.tgz', sha512, publishOrder: 1 }],
      checks: {},
    }),
  );
  return dir;
}

type Call = { readonly command: string; readonly args: readonly string[]; readonly cwd?: string };

function recordingGit(calls: Call[]): GitRunner {
  return (args, options) => {
    calls.push({ command: 'git', args, cwd: options.cwd });
    return defaultGitRunner(args, options);
  };
}

function prepareOptions(candidateDir: string, git: GitRunner = defaultGitRunner, exec: ExecRunner = execRunner) {
  return {
    cwd: root,
    config,
    candidateDir,
    gitRunner: git,
    exec,
    now,
    remoteUrl: (repo: string) => path.join(remotes, `${repo.split('/')[1] ?? ''}.git`),
  };
}

// Why: sync copies the root SECURITY.md into each mirror; the test pins that it does not invent its own text.
const SECURITY_TEXT = '# Security policy\n\nReport privately.\n';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sync-'));
  remotes = path.join(root, 'remotes');
  await mkdir(remotes, { recursive: true });
  await writeFile(path.join(root, 'SECURITY.md'), SECURITY_TEXT);
  // The workspace is this repo: a clone of arki-labs/arki with one local source commit on top.
  await ok('git', ['init', '-q', '-b', 'main'], root);
  await ok('git', ['remote', 'add', 'origin', await seedRemote('arki')], root);
  await ok('git', ['fetch', '-q', 'origin'], root);
  await ok('git', ['checkout', '-q', '-B', 'main', 'origin/main'], root);
  await commitInRoot('SECURITY.md', 'source work');
});

/** Commits one path in the source repo, the way the founder works on main. */
async function commitInRoot(file: string, message: string): Promise<string> {
  await ok('git', ['add', file], root);
  await ok('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], root);
  return (await ok('git', ['rev-parse', 'HEAD'], root)).trim();
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('helpers', () => {
  it('extracts one version of a changelog', () => {
    // Why: the GitHub Release body must be that version's notes, not the whole file.
    const log = '# Changelog\n\n## 1.2.0\n\n- New.\n\n### Fixes\n\n- Fix.\n\n## 1.1.0\n\n- Old.\n';
    expect(extractChangelogEntry(log, '1.2.0')).toBe('- New.\n\n### Fixes\n\n- Fix.');
    expect(extractChangelogEntry(log, '9.9.9')).toBeNull();
  });

  it('writes the mirror header from plan #50', () => {
    // Why: cloners landing on a mirror must be told it is read-only and where issues go.
    const header = mirrorReadmeHeader({ name: '@arki/assert', version: '1.2.0', date: '2026-10-17' });
    expect(header).toContain('Read-only mirror of `@arki/assert` v1.2.0.');
    expect(header).toContain('Source and issues: arki-labs/arki.');
    expect(header).toContain('https://arki.dev/packages/assert');
    expect(header).toContain('https://www.npmjs.com/package/@arki/assert/v/1.2.0#provenance');
  });
});

describe('runSyncPrepare', () => {
  it('prepares package commits, tags, trees, notes and a plan without any push or gh write', async () => {
    // Why: agents run --prepare; if it ever pushed or wrote through gh, an agent could publish.
    const candidate = await makeCandidate();
    const calls: Call[] = [];
    const ghCalls: Call[] = [];
    const exec: ExecRunner = (command, args, options) => {
      if (command === 'gh') ghCalls.push({ command, args });
      return execRunner(command, args, options);
    };
    const result = await runSyncPrepare(prepareOptions(candidate, recordingGit(calls), exec));
    expect(result.errors).toEqual([]);
    expect(result.status).toBe('success');
    expect(calls.some(c => c.args[0] === 'push')).toBe(false);
    expect(ghCalls).toEqual([]);

    const plan = syncPlanSchema.parse(JSON.parse(await readFile(path.join(root, SYNC_PLAN_PATH), 'utf8')));
    expect(plan.arki.tag).toBe('vfoundation-2026-10-17');
    expect(plan.arki.dir).toBe('.');
    expect(plan.arki.commit).toBeNull();
    const pkg = plan.packages[0];
    expect(pkg?.tag).toBe('v1.2.0');
    expect(pkg?.assets.map(a => path.basename(a))).toEqual(['arki-assert-1.2.0.tgz', 'assert-api.json']);

    const readme = await readFile(path.join(root, '.release/package-mirrors/assert/README.md'), 'utf8');
    expect(readme.startsWith('Read-only mirror of `@arki/assert` v1.2.0.')).toBe(true);
    expect(await readFile(path.join(root, '.release/package-mirrors/assert/SECURITY.md'), 'utf8')).toBe(SECURITY_TEXT);
    expect(await readFile(path.join(root, pkg?.notesFile ?? ''), 'utf8')).toBe('- Added `ensure`.\n');
    // The wave tag is annotated, local, and sits on the candidate's source commit; the remote has none.
    expect(await ok('git', ['cat-file', '-t', 'vfoundation-2026-10-17'], root)).toBe('tag\n');
    expect(await ok('git', ['rev-parse', 'vfoundation-2026-10-17^{commit}'], root)).toBe(await ok('git', ['rev-parse', 'HEAD'], root));
    expect(await ok('git', ['tag'], path.join(remotes, 'arki.git'))).toBe('');
  });

  it('never writes a commit or moves a branch in the source repo', async () => {
    // Why: this repo is the real source of arki-labs/arki; a generated commit on main would clobber the founder's work.
    const candidate = await makeCandidate();
    const refsBefore = await ok('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes'], root);
    const headBefore = await ok('git', ['rev-parse', 'HEAD'], root);
    const calls: Call[] = [];
    const result = await runSyncPrepare(prepareOptions(candidate, recordingGit(calls)));
    expect(result.status).toBe('success');
    expect(await ok('git', ['rev-parse', 'HEAD'], root)).toBe(headBefore);
    expect(await ok('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes'], root)).toBe(refsBefore);
    expect(calls.filter(c => c.cwd === root).some(c => c.args.includes('commit') || c.args.includes('checkout') || c.args.includes('add'))).toBe(false);
    expect(await ok('git', ['tag'], root)).toBe('vfoundation-2026-10-17\n');
  });

  it('fails when a local wave tag already points at another commit', async () => {
    // Why: published tags never move; a stale local tag must stop the release, not be silently retargeted.
    const candidate = await makeCandidate();
    await ok('git', ['tag', 'vfoundation-2026-10-17', 'origin/main'], root);
    const result = await runSyncPrepare(prepareOptions(candidate));
    expect(result.status).toBe('failure');
    expect(result.errors[0]?.code).toBe(SYNC_ERROR_CODES.tagMoved);
    expect(await ok('git', ['rev-parse', 'vfoundation-2026-10-17'], root)).toBe(await ok('git', ['rev-parse', 'origin/main'], root));
  });

  it('fails loudly when a mirror checkout is dirty', async () => {
    // Why: a dirty mirror may hold an interrupted run's work; rebuilding over it would hide that.
    const candidate = await makeCandidate();
    const first = await runSyncPrepare(prepareOptions(candidate));
    expect(first.status).toBe('success');
    await writeFile(path.join(root, '.release/package-mirrors/assert/stray.txt'), 'x');
    const second = await runSyncPrepare(prepareOptions(candidate));
    expect(second.status).toBe('failure');
    expect(second.errors[0]?.code).toBe(SYNC_ERROR_CODES.mirrorDirty);
  });

  it('is repeatable: a second prepare finds nothing new to commit', async () => {
    // Why: a rerun after an aborted --apply must not invent a second commit.
    const candidate = await makeCandidate();
    await runSyncPrepare(prepareOptions(candidate));
    const second = await runSyncPrepare(prepareOptions(candidate));
    expect(second.status).toBe('success');
    expect(second.items.every(i => i.action === 'prepared' || i.action === 'unchanged')).toBe(true);
    expect(await ok('git', ['tag'], root)).toBe('vfoundation-2026-10-17\n');
  });

  it('rejects an unusable candidate with MSYNC_E004', async () => {
    // Why: a tampered or missing candidate must never reach a public mirror.
    const result = await runSyncPrepare(prepareOptions(path.join(root, 'nope')));
    expect(result.status).toBe('failure');
    expect(result.errors[0]?.code).toBe(SYNC_ERROR_CODES.candidateUnusable);
  });
});

describe('runSyncApply', () => {
  async function prepared(): Promise<SyncPlan> {
    await runSyncPrepare(prepareOptions(await makeCandidate()));
    return syncPlanSchema.parse(JSON.parse(await readFile(path.join(root, SYNC_PLAN_PATH), 'utf8')));
  }

  function ghFake(calls: Call[], existing: { releases?: readonly string[]; repos?: readonly string[] } = {}): ExecRunner {
    return async (command, args) => {
      calls.push({ command, args });
      const done = { code: 0, stdout: '', stderr: '' };
      const missing = { code: 1, stdout: '', stderr: 'not found' };
      if (args[0] === 'repo' && args[1] === 'view') return existing.repos?.includes(args[2] ?? '') === false ? missing : done;
      if (args[0] === 'release' && args[1] === 'view') return existing.releases?.includes(args[2] ?? '') === true ? done : missing;
      return done;
    };
  }

  it('refuses under CLAUDECODE before touching anything', async () => {
    // Why: remote writes are founder-only; an agent session must not be able to run them.
    await prepared();
    const calls: Call[] = [];
    const result = await runSyncApply({ cwd: root, env: { CLAUDECODE: '1' }, isTty: () => true, gitRunner: recordingGit(calls), exec: ghFake(calls) });
    expect(result.status).toBe('failure');
    expect(result.errors[0]?.code).toBe(SYNC_ERROR_CODES.agentSession);
    expect(calls).toEqual([]);
  });

  it('refuses without a terminal', async () => {
    // Why: a piped or CI run has no human to confirm a public push.
    const result = await runSyncApply({ cwd: root, env: {}, isTty: () => false });
    expect(result.errors[0]?.code).toBe(SYNC_ERROR_CODES.notTerminal);
  });

  it('pushes, tags and creates releases, then skips them on a rerun', async () => {
    // Why: apply may be interrupted; a rerun must finish the job without duplicate tags or releases.
    // The package repo does not exist yet, so its remote is created by gh and the push target is made here.
    const plan = await prepared();
    const pkgRemote = path.join(remotes, 'assert.git');
    await ok('git', ['init', '-q', '--bare', '-b', 'main', pkgRemote], root);
    const calls: Call[] = [];
    const exec = ghFake(calls, { repos: ['arki-labs/assert', 'arki-labs/arki'] });
    const first = await runSyncApply({ cwd: root, env: {}, isTty: () => true, gitRunner: recordingGit(calls), exec });
    expect(first.errors).toEqual([]);
    const created = calls.filter(c => c.command === 'gh' && c.args[0] === 'release' && c.args[1] === 'create');
    expect(created.map(c => c.args[1 + 1])).toEqual(['v1.2.0', plan.arki.tag]);
    expect(created[0]?.args).toContain('--notes-file');
    expect(created[0]?.args.some(a => a.endsWith('.tgz'))).toBe(true);
    expect(await ok('git', ['tag'], pkgRemote)).toBe('v1.2.0\n');
    expect(await ok('git', ['tag'], path.join(remotes, 'arki.git'))).toBe(`${plan.arki.tag}\n`);
    expect(calls.some(c => c.args.includes('--force') || c.args.includes('-f'))).toBe(false);

    const again: Call[] = [];
    const second = await runSyncApply({ cwd: root, env: {}, isTty: () => true, gitRunner: recordingGit(again), exec: ghFake(again, { releases: ['v1.2.0', plan.arki.tag], repos: ['arki-labs/assert', 'arki-labs/arki'] }) });
    expect(second.errors).toEqual([]);
    expect(second.items.every(i => i.action === 'skipped')).toBe(true);
    expect(again.some(c => c.args[0] === 'push')).toBe(false);
    expect(again.some(c => c.command === 'gh' && c.args[1] === 'create')).toBe(false);
  });

  it('never pushes the source repo main, only the wave tag', async () => {
    // Why: the founder's local main may hold unreviewed work; a release must not publish it as a side effect.
    const plan = await prepared();
    expect(plan.arki.commit).toBeNull();
    await ok('git', ['init', '-q', '--bare', '-b', 'main', path.join(remotes, 'assert.git')], root);
    const remoteMain = await ok('git', ['rev-parse', 'main'], path.join(remotes, 'arki.git'));
    await writeFile(path.join(root, 'later.txt'), 'unreleased\n');
    await commitInRoot('later.txt', 'later work');
    const calls: Call[] = [];
    const result = await runSyncApply({ cwd: root, env: {}, isTty: () => true, gitRunner: recordingGit(calls), exec: ghFake(calls, { repos: ['arki-labs/assert', 'arki-labs/arki'] }) });
    expect(result.errors).toEqual([]);
    const rootPushes = calls.filter(c => c.cwd === root && c.args[0] === 'push');
    expect(rootPushes.map(c => c.args)).toEqual([['push', 'origin', plan.arki.tag]]);
    expect(await ok('git', ['rev-parse', 'main'], path.join(remotes, 'arki.git'))).toBe(remoteMain);
    expect(await ok('git', ['tag'], path.join(remotes, 'arki.git'))).toBe(`${plan.arki.tag}\n`);
  });

  it('skips a tag that already exists on the remote and an existing release', async () => {
    // Why: published tags never move; a mirror that already has v1.2.0 must not be pushed again.
    const pkgRemote = path.join(remotes, 'assert.git');
    await ok('git', ['init', '-q', '--bare', '-b', 'main', pkgRemote], root);
    const candidate = await makeCandidate();
    // First pass publishes v1.2.0 to the package remote by hand, as an earlier release would have.
    await runSyncPrepare(prepareOptions(candidate));
    const mirror = path.join(root, '.release/package-mirrors/assert');
    await ok('git', ['push', '-q', 'origin', 'main', 'v1.2.0'], mirror);
    const again = await runSyncPrepare(prepareOptions(candidate));
    expect(again.items.find(i => i.target === 'arki-labs/assert')?.action).toBe('already-tagged');
    const calls: Call[] = [];
    const exec = ghFake(calls, { releases: ['v1.2.0'], repos: ['arki-labs/assert', 'arki-labs/arki'] });
    const result = await runSyncApply({ cwd: root, env: {}, isTty: () => true, gitRunner: recordingGit(calls), exec });
    expect(result.errors).toEqual([]);
    const pushes = calls.filter(c => c.args[0] === 'push');
    expect(pushes.every(c => c.args.includes('main') || c.args.some(a => a.startsWith('vfoundation')))).toBe(true);
    expect(calls.filter(c => c.command === 'gh' && c.args[1] === 'create').map(c => c.args[2])).toEqual(['vfoundation-2026-10-17']);
  });
});

describe('mirrorReadiness', () => {
  it('turns plan state into the four external readiness items', async () => {
    // Why: readiness must say "not mirrored" until the tag and Release really exist.
    await runSyncPrepare(prepareOptions(await makeCandidate()));
    const loaded = await loadMirrorReadiness(root);
    expect(loaded?.['@arki/assert']).toEqual({ 'mirror-tag': 'fail', 'mirror-release': 'fail', 'mirror-security': 'fail', 'mirror-integrity': 'pass' });
    const plan = syncPlanSchema.parse(JSON.parse(await readFile(path.join(root, SYNC_PLAN_PATH), 'utf8')));
    const applied = mirrorReadiness({ ...plan, applied: { 'arki-labs/assert': { pushed: true, released: true } } });
    expect(applied['@arki/assert']).toEqual({ 'mirror-tag': 'pass', 'mirror-release': 'pass', 'mirror-security': 'pass', 'mirror-integrity': 'pass' });
  });

  it('returns null without a plan', async () => {
    // Why: no plan means readiness reports the items missing, not failed.
    expect(await loadMirrorReadiness(root)).toBeNull();
  });
});
