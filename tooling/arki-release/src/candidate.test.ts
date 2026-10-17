import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendCandidateCheck, CANDIDATE_ERROR_CODES, readCandidate, runCandidate } from './candidate';
import type { TreeExporter } from './candidate';
import type { GitRunner, NpmRunner } from './runners';
import type { ReleaseConfig } from './types';

const config: ReleaseConfig = {
  publicTreePath: '.release/public',
  publicMetadataDefaults: {
    license: 'MIT',
    repository: { type: 'git', url: 'https://example.com/r.git' },
    bugs: { url: 'https://example.com/i' },
    homepage: 'https://example.com',
    keywords: [],
    publishConfig: { access: 'public' },
  },
  waves: [{ id: 'foundation', label: 'Foundation', packages: ['@arki/a', '@arki/b'] }],
};

const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12';

let root: string;
let dirty: string[];
let exportedWithDist: boolean;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'arki-cand-'));
  dirty = [];
  exportedWithDist = true;
  for (const [name, deps] of [['a', { '@arki/b': 'workspace:*' }], ['b', {}]] as const) {
    mkdirSync(path.join(root, 'packages', name), { recursive: true });
    writeFileSync(
      path.join(root, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@arki/${name}`, version: '1.0.0', dependencies: deps }),
    );
  }
  mkdirSync(path.join(root, '.changeset'));
  writeFileSync(path.join(root, '.changeset', 'x.md'), "---\n'@arki/a': patch\n---\n\nx\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const git: GitRunner = async args => {
  if (args[0] === 'rev-parse') return { stdout: `${COMMIT}\n`, stderr: '', code: 0 };
  if (args[0] === 'status') {
    const hit = dirty.some(d => args.includes(d));
    return { stdout: hit ? ' M file\n' : '', stderr: '', code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
};

// Writes the package tree the real exporter would, so no git or build is needed.
const exportTree: TreeExporter = async options => {
  for (const name of ['a', 'b']) {
    const folder = path.join(options.outputPath ?? '', 'packages', name);
    mkdirSync(exportedWithDist ? path.join(folder, 'dist') : folder, { recursive: true });
  }
  return {
    packages: [
      { name: '@arki/a', status: 'exported' },
      { name: '@arki/b', status: 'exported' },
    ],
    dirtyPackages: [],
    errors: [],
  };
};

// npm view says nothing is published; npm pack writes a tarball whose bytes depend on the package.
const npm: NpmRunner = async (args, { cwd }) => {
  if (args[0] === 'view') return { stdout: '', stderr: 'E404', code: 1 };
  const dest = args[args.indexOf('--pack-destination') + 1] ?? '';
  const file = `arki-${path.basename(cwd)}-1.0.0.tgz`;
  writeFileSync(path.join(dest, file), `tarball of ${path.basename(cwd)}`);
  return { stdout: JSON.stringify([{ filename: file }]), stderr: '', code: 0 };
};

const build = (): ReturnType<typeof runCandidate> =>
  runCandidate({
    cwd: root,
    config,
    target: { kind: 'wave', id: 'foundation' },
    gitRunner: git,
    npmRunner: npm,
    exportTree,
    now: () => new Date('2026-10-17T00:00:00Z'),
  });

describe('runCandidate', () => {
  // Why: the candidate is the single frozen artifact later steps trust; its layout and order are the contract.
  it('writes candidate.json and tarballs in dependency order', async () => {
    const env = await build();
    expect(env.status).toBe('success');
    const dir = path.join(root, '.release', 'candidates', 'foundation-abcdef1');
    expect(env.summary.directory).toBe(dir);
    const read = await readCandidate(dir);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.candidate.sourceCommit).toBe(COMMIT);
    expect(read.candidate.packages.map(p => [p.name, p.publishOrder, p.tarball])).toEqual([
      ['@arki/b', 1, path.join('tarballs', 'arki-b-1.0.0.tgz')],
      ['@arki/a', 2, path.join('tarballs', 'arki-a-1.0.0.tgz')],
    ]);
    expect(existsSync(path.join(dir, 'tree'))).toBe(false);
  });

  // Why: a candidate built from uncommitted edits could never be reproduced from the commit it names.
  it('refuses a dirty package with CAND_E001', async () => {
    dirty = ['packages/a'];
    const env = await build();
    expect(env.status).toBe('failure');
    expect(env.errors.map(e => e.code)).toEqual([CANDIDATE_ERROR_CODES.dirtyPackage]);
  });

  // Why: shipping a package with no build output publishes an empty library.
  it('refuses a missing dist with CAND_E002', async () => {
    exportedWithDist = false;
    const env = await build();
    expect(env.errors.map(e => e.code)).toEqual([CANDIDATE_ERROR_CODES.missingDist, CANDIDATE_ERROR_CODES.missingDist]);
  });

  // Why: CI candidates cover only what changed; a package with no change must not be packed.
  it('--affected picks public packages changed since the ref', async () => {
    const affectedGit: GitRunner = async (args, opts) =>
      args[0] === 'diff'
        ? { stdout: 'packages/b/src/index.ts\nREADME.md\n', stderr: '', code: 0 }
        : git(args, opts);
    const env = await runCandidate({
      cwd: root,
      config,
      target: { kind: 'affected', ref: 'origin/master' },
      gitRunner: affectedGit,
      npmRunner: npm,
      exportTree,
    });
    expect(env.items.map(i => i.name)).toEqual(['@arki/b']);
    expect(env.summary.wave).toBe('affected');
  });

  // Why: an empty candidate would pass every later gate and publish nothing.
  it('fails when no package has a pending changeset', async () => {
    rmSync(path.join(root, '.changeset', 'x.md'));
    const env = await build();
    expect(env.errors[0]?.code).toBe(CANDIDATE_ERROR_CODES.nothingToRelease);
  });
});

describe('readCandidate and appendCandidateCheck', () => {
  // Why: if a tarball changes after the checks ran, the checks no longer describe what would be published.
  it('rejects a tampered tarball with CAND_E003', async () => {
    const env = await build();
    const dir = env.summary.directory ?? '';
    writeFileSync(path.join(dir, 'tarballs', 'arki-a-1.0.0.tgz'), 'tampered');
    const read = await readCandidate(dir);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors.map(e => e.code)).toEqual([CANDIDATE_ERROR_CODES.checksumMismatch]);
  });

  // Why: later steps record results in place; they must never rebuild or lose earlier results.
  it('appends checks and keeps earlier ones', async () => {
    const env = await build();
    const dir = env.summary.directory ?? '';
    await appendCandidateCheck(dir, 'smoke', { status: 'success', envelope: { items: [] } }, () => new Date('2026-10-18T00:00:00Z'));
    const second = await appendCandidateCheck(dir, 'demos', { status: 'failure', at: '2026-10-19T00:00:00Z', envelope: null });
    expect(second.ok).toBe(true);
    const saved = JSON.parse(readFileSync(path.join(dir, 'candidate.json'), 'utf8')) as { checks: Record<string, { status: string; at: string }> };
    expect(Object.keys(saved.checks)).toEqual(['smoke', 'demos']);
    expect(saved.checks['smoke']?.at).toBe('2026-10-18T00:00:00.000Z');
  });

  // Why: recording a result against a modified candidate would make a false claim.
  it('does not append to a tampered candidate', async () => {
    const env = await build();
    const dir = env.summary.directory ?? '';
    writeFileSync(path.join(dir, 'tarballs', 'arki-b-1.0.0.tgz'), 'tampered');
    const result = await appendCandidateCheck(dir, 'smoke', { status: 'success', envelope: {} });
    expect(result.ok).toBe(false);
    expect(readFileSync(path.join(dir, 'candidate.json'), 'utf8')).not.toContain('smoke');
  });

  it('reports CAND_E004 when candidate.json is missing', async () => {
    const read = await readCandidate(root);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors[0]?.code).toBe(CANDIDATE_ERROR_CODES.unreadable);
  });
});
