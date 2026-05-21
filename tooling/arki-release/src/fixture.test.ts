/**
 * Unit tests for the external fixture matrix.
 *
 * Strategy: every test scaffolds a tiny public-tree fixture in a fresh
 * temp dir and drives {@link runFixtureMatrix} through an injected
 * {@link ProcessRunner}. We never spawn real npm/pnpm/bun — the runner
 * returns canned results matched on the (command, primary-arg) pair, so
 * tests stay deterministic and fast.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PACKAGE_MANAGERS,
  FIXTURE_ERROR_CODES,
  runFixtureMatrix,
  type ProcessResult,
  type ProcessRunner,
} from './fixture';

/**
 * Canned runner step. The matcher inspects `(command, args)` and returns
 * a fixed result OR a side-effect (e.g. write a file to simulate install).
 */
interface Step {
  readonly when: (command: string, args: readonly string[]) => boolean;
  readonly result: ProcessResult | ((cwd: string, args: readonly string[]) => Promise<ProcessResult>);
}

function makeRunner(steps: readonly Step[]): ProcessRunner {
  return {
    async run(command, args, opts) {
      const match = steps.find(step => step.when(command, args));
      if (match === undefined) {
        // Default: succeed silently. Individual tests opt into stricter
        // matchers by listing every command they expect.
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (typeof match.result === 'function') {
        return match.result(opts.cwd, args);
      }
      return match.result;
    },
  };
}

/** Build a minimal public-tree at `<root>/.release/arki-public`. */
function scaffoldPublicTree(
  root: string,
  packages: ReadonlyArray<{ readonly name: string; readonly dirName: string; readonly manifest?: Record<string, unknown> }>,
): string {
  const treeRoot = path.join(root, '.release', 'arki-public');
  mkdirSync(path.join(treeRoot, 'packages'), { recursive: true });
  for (const pkg of packages) {
    const dir = path.join(treeRoot, 'packages', pkg.dirName);
    mkdirSync(dir, { recursive: true });
    const manifest = pkg.manifest ?? {
      name: pkg.name,
      version: '0.1.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
    };
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return treeRoot;
}

/**
 * Create a fake tarball file at the destination the test expects npm
 * pack to produce. Many tests want pack to "succeed" — we synthesize a
 * tiny file so the leak-check pass can read its bytes.
 */
async function fakePack(cwd: string, args: readonly string[], tarballContent = 'fake-tar'): Promise<ProcessResult> {
  // args looks like ['pack', '--pack-destination', '<dir>', '--json']
  const destIdx = args.indexOf('--pack-destination');
  const destDir = args[destIdx + 1];
  if (destDir === undefined) {
    return { exitCode: 1, stdout: '', stderr: 'no --pack-destination' };
  }
  const manifestPath = path.join(cwd, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; version: string };
  const safeName = manifest.name.replace(/^@/, '').replace(/\//g, '-');
  const filename = `${safeName}-${manifest.version}.tgz`;
  mkdirSync(destDir, { recursive: true });
  writeFileSync(path.join(destDir, filename), tarballContent, 'utf8');
  return {
    exitCode: 0,
    stdout: JSON.stringify([{ name: manifest.name, version: manifest.version, filename }]),
    stderr: '',
  };
}

describe('runFixtureMatrix — happy path', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-fixture-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs the full pipeline successfully when every stage returns success', async () => {
    const treeRoot = scaffoldPublicTree(tmp, [{ name: '@arki/assert', dirName: 'assert' }]);
    const runner = makeRunner([
      { when: cmd => cmd === 'npm' && true, result: (cwd, args) => (args[0] === 'pack' ? fakePack(cwd, args) : Promise.resolve({ exitCode: 0, stdout: 'installed', stderr: '' })) },
      { when: cmd => cmd === 'node', result: { exitCode: 0, stdout: '["a","b","c"]', stderr: '' } },
      { when: cmd => cmd === 'npx', result: { exitCode: 0, stdout: '', stderr: '' } },
    ]);
    const envelope = await runFixtureMatrix({
      rootCwd: tmp,
      publicTreePath: treeRoot,
      packageManagers: ['npm'],
      tempRoot: path.join(tmp, 'fixture-temp'),
      runner,
    });
    expect(envelope.status).toBe('success');
    expect(envelope.items).toHaveLength(1);
    const run = envelope.items[0];
    expect(run?.status).toBe('success');
    expect(run?.stages.map(s => s.name)).toEqual([
      'pack',
      'workspace-leak-check',
      'install',
      'import-esm',
      'import-types',
    ]);
    expect(run?.stages.every(s => s.status === 'success')).toBe(true);
  });

  it('produces one run per (package, pm) — 4 packages × 3 PMs = 12 runs', async () => {
    const treeRoot = scaffoldPublicTree(tmp, [
      { name: '@arki/assert', dirName: 'assert' },
      { name: '@arki/date', dirName: 'date' },
      { name: '@arki/design-systems', dirName: 'design-systems' },
      { name: '@arki/theme', dirName: 'theme' },
    ]);
    const runner = makeRunner([
      { when: cmd => cmd === 'npm' && true, result: (cwd, args) => (args[0] === 'pack' ? fakePack(cwd, args) : Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })) },
      { when: cmd => cmd === 'pnpm', result: { exitCode: 0, stdout: '', stderr: '' } },
      { when: cmd => cmd === 'bun', result: { exitCode: 0, stdout: '', stderr: '' } },
      { when: cmd => cmd === 'node', result: { exitCode: 0, stdout: '["x"]', stderr: '' } },
      { when: cmd => cmd === 'npx' || cmd === 'bunx', result: { exitCode: 0, stdout: '', stderr: '' } },
    ]);
    const envelope = await runFixtureMatrix({
      rootCwd: tmp,
      publicTreePath: treeRoot,
      tempRoot: path.join(tmp, 'fixture-temp'),
      runner,
    });
    expect(envelope.summary.totalRuns).toBe(12);
    expect(envelope.items).toHaveLength(12);
    const pairs = envelope.items.map(r => `${r.packageName}:${r.packageManager}`);
    expect(new Set(pairs).size).toBe(12);
    for (const pm of DEFAULT_PACKAGE_MANAGERS) {
      expect(pairs.filter(p => p.endsWith(`:${pm}`))).toHaveLength(4);
    }
  });
});

describe('runFixtureMatrix — failure modes', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-fixture-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('marks downstream stages skipped when pack fails', async () => {
    const treeRoot = scaffoldPublicTree(tmp, [{ name: '@arki/assert', dirName: 'assert' }]);
    const runner = makeRunner([
      { when: (cmd, args) => cmd === 'npm' && args[0] === 'pack', result: { exitCode: 1, stdout: '', stderr: 'pack error' } },
    ]);
    const envelope = await runFixtureMatrix({
      rootCwd: tmp,
      publicTreePath: treeRoot,
      packageManagers: ['npm'],
      tempRoot: path.join(tmp, 'fixture-temp'),
      runner,
    });
    expect(envelope.status).toBe('failure');
    const run = envelope.items[0];
    expect(run?.status).toBe('failure');
    const packStage = run?.stages.find(s => s.name === 'pack');
    expect(packStage?.status).toBe('failure');
    const downstream = ['workspace-leak-check', 'install', 'import-esm', 'import-types'] as const;
    for (const name of downstream) {
      expect(run?.stages.find(s => s.name === name)?.status).toBe('skipped');
    }
    expect(envelope.errors.some(e => e.code === FIXTURE_ERROR_CODES.packFailed)).toBe(true);
  });

  it('marks install failed and downstream skipped when install exit ≠ 0', async () => {
    const treeRoot = scaffoldPublicTree(tmp, [{ name: '@arki/assert', dirName: 'assert' }]);
    const runner = makeRunner([
      { when: (cmd, args) => cmd === 'npm' && args[0] === 'pack', result: (cwd, args) => fakePack(cwd, args) },
      { when: (cmd, args) => cmd === 'npm' && args[0] === 'install', result: { exitCode: 1, stdout: '', stderr: 'EACCES' } },
    ]);
    const envelope = await runFixtureMatrix({
      rootCwd: tmp,
      publicTreePath: treeRoot,
      packageManagers: ['npm'],
      tempRoot: path.join(tmp, 'fixture-temp'),
      runner,
    });
    expect(envelope.status).toBe('failure');
    const run = envelope.items[0];
    expect(run?.stages.find(s => s.name === 'install')?.status).toBe('failure');
    expect(run?.stages.find(s => s.name === 'import-esm')?.status).toBe('skipped');
    expect(run?.stages.find(s => s.name === 'import-types')?.status).toBe('skipped');
    expect(envelope.errors.some(e => e.code === FIXTURE_ERROR_CODES.installFailed)).toBe(true);
  });

  it('fails the workspace-leak-check stage when manifest still contains workspace: tokens', async () => {
    const treeRoot = scaffoldPublicTree(tmp, [
      {
        name: '@arki/assert',
        dirName: 'assert',
        manifest: {
          name: '@arki/assert',
          version: '0.1.0',
          type: 'module',
          // Simulated materializer regression — workspace token survived.
          dependencies: { '@arki/contracts': 'workspace:*' },
        },
      },
    ]);
    const runner = makeRunner([
      { when: (cmd, args) => cmd === 'npm' && args[0] === 'pack', result: (cwd, args) => fakePack(cwd, args) },
    ]);
    const envelope = await runFixtureMatrix({
      rootCwd: tmp,
      publicTreePath: treeRoot,
      packageManagers: ['npm'],
      tempRoot: path.join(tmp, 'fixture-temp'),
      runner,
    });
    expect(envelope.status).toBe('failure');
    const run = envelope.items[0];
    expect(run?.stages.find(s => s.name === 'pack')?.status).toBe('success');
    expect(run?.stages.find(s => s.name === 'workspace-leak-check')?.status).toBe('failure');
    expect(run?.stages.find(s => s.name === 'install')?.status).toBe('skipped');
    expect(envelope.errors.some(e => e.code === FIXTURE_ERROR_CODES.workspaceLeak)).toBe(true);
  });

  it('fails ESM import stage when node output is invalid JSON', async () => {
    const treeRoot = scaffoldPublicTree(tmp, [{ name: '@arki/assert', dirName: 'assert' }]);
    const runner = makeRunner([
      { when: (cmd, args) => cmd === 'npm' && args[0] === 'pack', result: (cwd, args) => fakePack(cwd, args) },
      { when: cmd => cmd === 'npm', result: { exitCode: 0, stdout: '', stderr: '' } },
      { when: cmd => cmd === 'node', result: { exitCode: 0, stdout: 'this is not json', stderr: '' } },
    ]);
    const envelope = await runFixtureMatrix({
      rootCwd: tmp,
      publicTreePath: treeRoot,
      packageManagers: ['npm'],
      tempRoot: path.join(tmp, 'fixture-temp'),
      runner,
    });
    const run = envelope.items[0];
    expect(run?.stages.find(s => s.name === 'import-esm')?.status).toBe('failure');
    expect(run?.stages.find(s => s.name === 'import-types')?.status).toBe('skipped');
    expect(envelope.errors.some(e => e.code === FIXTURE_ERROR_CODES.importEsmFailed)).toBe(true);
  });

  it('fails TS declaration probe when tsc exits non-zero', async () => {
    const treeRoot = scaffoldPublicTree(tmp, [{ name: '@arki/assert', dirName: 'assert' }]);
    const runner = makeRunner([
      { when: (cmd, args) => cmd === 'npm' && args[0] === 'pack', result: (cwd, args) => fakePack(cwd, args) },
      { when: cmd => cmd === 'npm', result: { exitCode: 0, stdout: '', stderr: '' } },
      { when: cmd => cmd === 'node', result: { exitCode: 0, stdout: '["a"]', stderr: '' } },
      { when: cmd => cmd === 'npx', result: { exitCode: 2, stdout: '', stderr: 'TS2307: Cannot find module' } },
    ]);
    const envelope = await runFixtureMatrix({
      rootCwd: tmp,
      publicTreePath: treeRoot,
      packageManagers: ['npm'],
      tempRoot: path.join(tmp, 'fixture-temp'),
      runner,
    });
    const run = envelope.items[0];
    expect(run?.stages.find(s => s.name === 'import-types')?.status).toBe('failure');
    expect(envelope.errors.some(e => e.code === FIXTURE_ERROR_CODES.importTypesFailed)).toBe(true);
  });
});

describe('runFixtureMatrix — skipInstall mode', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-fixture-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs pack + leak-check but skips install onwards', async () => {
    const treeRoot = scaffoldPublicTree(tmp, [{ name: '@arki/assert', dirName: 'assert' }]);
    const installCalled: string[] = [];
    const runner: ProcessRunner = {
      async run(command, args, opts) {
        if (command === 'npm' && args[0] === 'pack') return fakePack(opts.cwd, args);
        installCalled.push(`${command} ${args.join(' ')}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const envelope = await runFixtureMatrix({
      rootCwd: tmp,
      publicTreePath: treeRoot,
      packageManagers: ['npm', 'pnpm', 'bun'],
      skipInstall: true,
      tempRoot: path.join(tmp, 'fixture-temp'),
      runner,
    });
    expect(envelope.summary.totalRuns).toBe(3);
    expect(envelope.status).toBe('success');
    expect(installCalled).toHaveLength(0);
    for (const run of envelope.items) {
      expect(run.stages.find(s => s.name === 'pack')?.status).toBe('success');
      expect(run.stages.find(s => s.name === 'workspace-leak-check')?.status).toBe('success');
      expect(run.stages.find(s => s.name === 'install')?.status).toBe('skipped');
      expect(run.stages.find(s => s.name === 'import-esm')?.status).toBe('skipped');
      expect(run.stages.find(s => s.name === 'import-types')?.status).toBe('skipped');
      // Run is treated as `success` (every executed stage succeeded).
      expect(run.status).toBe('success');
    }
  });
});

describe('runFixtureMatrix — workspace resolution guard', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-fixture-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('detects a symlink from node_modules/@arki/* back into the monorepo', async () => {
    const treeRoot = scaffoldPublicTree(tmp, [{ name: '@arki/assert', dirName: 'assert' }]);
    // Pre-create the monorepo's `packages/assert` and a symlink-target.
    const monorepoSource = path.join(tmp, 'packages', 'assert');
    mkdirSync(monorepoSource, { recursive: true });
    writeFileSync(path.join(monorepoSource, 'index.js'), '// leak', 'utf8');

    const fixtureTemp = path.join(tmp, 'fixture-temp');
    const runner: ProcessRunner = {
      async run(command, args, opts) {
        if (command === 'npm' && args[0] === 'pack') return fakePack(opts.cwd, args);
        if (command === 'npm' && args[0] === 'install') {
          // Simulate install creating a node_modules/@arki/assert symlink
          // that points back into the monorepo packages dir — the guard
          // should reject this.
          const arkiDir = path.join(opts.cwd, 'node_modules', '@arki');
          mkdirSync(arkiDir, { recursive: true });
          symlinkSync(monorepoSource, path.join(arkiDir, 'assert'), 'dir');
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '["x"]', stderr: '' };
      },
    };
    const envelope = await runFixtureMatrix({
      rootCwd: tmp,
      publicTreePath: treeRoot,
      packageManagers: ['npm'],
      tempRoot: fixtureTemp,
      runner,
    });
    expect(envelope.status).toBe('failure');
    expect(
      envelope.errors.some(e => e.code === FIXTURE_ERROR_CODES.workspaceResolutionLeak),
    ).toBe(true);
    const run = envelope.items[0];
    // Install succeeded — the guard fires AFTER install.
    expect(run?.stages.find(s => s.name === 'install')?.status).toBe('success');
    // Downstream still skipped.
    expect(run?.stages.find(s => s.name === 'import-esm')?.status).toBe('skipped');
  });
});

describe('runFixtureMatrix — public tree missing', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-fixture-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('emits a structured FIX_E001 error when the public tree does not exist', async () => {
    const envelope = await runFixtureMatrix({
      rootCwd: tmp,
      publicTreePath: path.join(tmp, 'does', 'not', 'exist'),
      tempRoot: path.join(tmp, 'fixture-temp'),
      runner: makeRunner([]),
    });
    expect(envelope.status).toBe('failure');
    expect(envelope.summary.totalRuns).toBe(0);
    expect(envelope.errors[0]?.code).toBe(FIXTURE_ERROR_CODES.publicTreeMissing);
  });

  it('flags unknown packages requested via packageNames with FIX_E009', async () => {
    const treeRoot = scaffoldPublicTree(tmp, [{ name: '@arki/assert', dirName: 'assert' }]);
    const envelope = await runFixtureMatrix({
      rootCwd: tmp,
      publicTreePath: treeRoot,
      packageNames: ['@arki/never-existed'],
      packageManagers: ['npm'],
      tempRoot: path.join(tmp, 'fixture-temp'),
      runner: makeRunner([]),
    });
    expect(envelope.status).toBe('failure');
    expect(envelope.summary.totalRuns).toBe(0);
    expect(envelope.errors[0]?.code).toBe(FIXTURE_ERROR_CODES.packageNotInTree);
  });
});

