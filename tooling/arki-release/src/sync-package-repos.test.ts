/**
 * Unit tests for `runSyncPackageRepos`.
 *
 * Strategy: drive the orchestrator through a canned {@link ProcessRunner}
 * that matches on `(command, args)` and returns synthetic results. No
 * actual gh/git/npm calls. Filesystem side effects (mkdtemp, tarball
 * extraction, writeFile) DO happen in temp dirs — the runner's tar
 * matcher acts as a real-ish stand-in by creating dummy files when the
 * orchestrator asks tar to extract.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProcessResult, ProcessRunner } from './fixture';
import { runSyncPackageRepos, SYNC_REPO_ERROR_CODES } from './sync-package-repos';
import type { ReleaseConfig } from './types';

interface Step {
  readonly when: (command: string, args: readonly string[]) => boolean;
  readonly result:
    | ProcessResult
    | ((cwd: string, args: readonly string[]) => Promise<ProcessResult> | ProcessResult);
}

function makeRunner(steps: readonly Step[]): ProcessRunner {
  return {
    async run(command, args, opts) {
      const match = steps.find(step => step.when(command, args));
      if (match === undefined) {
        // Catch-all: succeed silently. Tests that want strict mocking
        // exhaustively enumerate; tests that don't care about a given
        // step (e.g. archive flip) let it default to success.
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      const result =
        typeof match.result === 'function' ? await match.result(opts.cwd, args) : match.result;
      return result;
    },
  };
}

/**
 * Synthesize a minimal release config with one wave containing a single
 * package. Avoids loading the real `arki.release.config.ts`.
 */
function singlePackageConfig(packageName: string): ReleaseConfig {
  return {
    publicTreePath: '.release/arki-public',
    publicMetadataDefaults: {
      license: 'MIT',
      repository: { type: 'git', url: 'https://github.com/arki-labs/arki.git' },
      bugs: { url: 'https://github.com/arki-labs/arki/issues' },
      homepage: 'https://arki.dev',
      publishConfig: { access: 'public' },
      keywords: ['arki'],
    },
    waves: [
      {
        id: 'foundation',
        label: 'Wave 1',
        packages: [packageName],
      },
    ],
  };
}

describe('runSyncPackageRepos — dry-run', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'sync-repos-dry-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reports planned creation when repo does not exist (no side effects)', async () => {
    const runner = makeRunner([
      // npm view versions → one version
      {
        when: (c, a) => c === 'npm' && a[0] === 'view' && a[2] === 'versions',
        result: { exitCode: 0, stdout: '"0.0.1"', stderr: '' },
      },
      {
        when: (c, a) => c === 'npm' && a[0] === 'view' && a[2] === 'time',
        result: { exitCode: 0, stdout: JSON.stringify({ '0.0.1': '2026-05-21T00:00:00Z' }), stderr: '' },
      },
      // gh api → 404 (repo missing)
      {
        when: (c, a) => c === 'gh' && a[0] === 'api',
        result: { exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' },
      },
    ]);

    const envelope = await runSyncPackageRepos({
      cwd: tmp,
      config: singlePackageConfig('@arki/assert'),
      runner,
      dryRun: true,
    });

    expect(envelope.status).toBe('success');
    expect(envelope.items).toHaveLength(1);
    const item = envelope.items[0]!;
    expect(item.packageName).toBe('@arki/assert');
    expect(item.repoName).toBe('assert');
    expect(item.repoUrl).toBe('https://github.com/arki-labs/assert');
    expect(item.gitRemote).toBe('git@github.com:arki-labs/assert.git');
    expect(item.status).toBe('skipped');
    expect(item.publishedVersions).toEqual(['0.0.1']);
    expect(item.pushedVersions).toEqual(['0.0.1']);
    expect(item.reason).toContain('would CREATE');
    expect(envelope.summary.dryRun).toBe(true);
  });

  it('reports in-sync when repo exists, archived, and all tags present', async () => {
    const runner = makeRunner([
      {
        when: (c, a) => c === 'npm' && a[0] === 'view' && a[2] === 'versions',
        result: { exitCode: 0, stdout: '"0.0.1"', stderr: '' },
      },
      {
        when: (c, a) => c === 'npm' && a[0] === 'view' && a[2] === 'time',
        result: { exitCode: 0, stdout: JSON.stringify({ '0.0.1': '2026-05-21T00:00:00Z' }), stderr: '' },
      },
      {
        when: (c, a) => c === 'gh' && a[0] === 'api',
        result: {
          exitCode: 0,
          stdout: JSON.stringify({ archived: true, description: 'Test' }),
          stderr: '',
        },
      },
      {
        when: (c, a) => c === 'git' && a[0] === 'ls-remote',
        result: {
          exitCode: 0,
          stdout: 'abc123\trefs/tags/v0.0.1\n',
          stderr: '',
        },
      },
    ]);

    const envelope = await runSyncPackageRepos({
      cwd: tmp,
      config: singlePackageConfig('@arki/assert'),
      runner,
      dryRun: true,
    });

    expect(envelope.items[0]!.status).toBe('in-sync');
    expect(envelope.items[0]!.archived).toBe(true);
    expect(envelope.items[0]!.skippedVersions).toEqual(['0.0.1']);
  });

  it('skips unpublished packages (npm 404 on the versions probe)', async () => {
    const runner = makeRunner([
      {
        when: (c, a) => c === 'npm' && a[0] === 'view' && a[2] === 'versions',
        result: { exitCode: 1, stdout: '', stderr: 'npm ERR! code E404' },
      },
    ]);

    const envelope = await runSyncPackageRepos({
      cwd: tmp,
      config: singlePackageConfig('@arki/unpublished'),
      runner,
      dryRun: true,
    });

    expect(envelope.items[0]!.status).toBe('skipped');
    expect(envelope.items[0]!.reason).toContain('not yet published');
  });
});

describe('runSyncPackageRepos — errors', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'sync-repos-err-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('emits SYNC_E002 + failed status when npm versions query fails (non-404)', async () => {
    const runner = makeRunner([
      {
        when: (c, a) => c === 'npm' && a[0] === 'view' && a[2] === 'versions',
        result: { exitCode: 1, stdout: '', stderr: 'ECONNREFUSED' },
      },
    ]);

    const envelope = await runSyncPackageRepos({
      cwd: tmp,
      config: singlePackageConfig('@arki/assert'),
      runner,
      dryRun: true,
    });

    expect(envelope.status).toBe('failure');
    expect(envelope.items[0]!.status).toBe('failed');
    expect(envelope.errors[0]!.code).toBe(SYNC_REPO_ERROR_CODES.npmFetchFailed);
  });

  it('emits SYNC_E001 when gh api probe fails with a non-404 error', async () => {
    const runner = makeRunner([
      {
        when: (c, a) => c === 'npm' && a[0] === 'view' && a[2] === 'versions',
        result: { exitCode: 0, stdout: '"0.0.1"', stderr: '' },
      },
      {
        when: (c, a) => c === 'npm' && a[0] === 'view' && a[2] === 'time',
        result: { exitCode: 0, stdout: '{}', stderr: '' },
      },
      {
        when: (c, a) => c === 'gh' && a[0] === 'api',
        result: { exitCode: 1, stdout: '', stderr: 'HTTP 403: insufficient scopes' },
      },
    ]);

    const envelope = await runSyncPackageRepos({
      cwd: tmp,
      config: singlePackageConfig('@arki/assert'),
      runner,
      dryRun: true,
    });

    expect(envelope.status).toBe('failure');
    expect(envelope.items[0]!.status).toBe('failed');
    expect(envelope.errors[0]!.code).toBe(SYNC_REPO_ERROR_CODES.ghApiFailed);
    expect(envelope.errors[0]!.message).toContain('403');
  });
});

describe('runSyncPackageRepos — filter', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'sync-repos-filter-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('warns when --package matches no wave-listed package', async () => {
    const envelope = await runSyncPackageRepos({
      cwd: tmp,
      config: singlePackageConfig('@arki/assert'),
      runner: makeRunner([]),
      dryRun: true,
      packages: ['@arki/nope'],
    });

    expect(envelope.items).toHaveLength(0);
    expect(envelope.errors).toHaveLength(1);
    expect(envelope.errors[0]!.code).toBe(SYNC_REPO_ERROR_CODES.syncSkipped);
    expect(envelope.errors[0]!.message).toContain('@arki/nope');
    expect(envelope.status).toBe('warning');
  });

  it('restricts the run to packages in the --package filter', async () => {
    const config: ReleaseConfig = {
      ...singlePackageConfig('@arki/assert'),
      waves: [
        {
          id: 'foundation',
          label: 'Wave 1',
          packages: ['@arki/assert', '@arki/clock'],
        },
      ],
    };

    const runner = makeRunner([
      {
        when: (c, a) => c === 'npm' && a[0] === 'view' && a[2] === 'versions',
        result: { exitCode: 1, stdout: '', stderr: 'npm ERR! code E404' },
      },
    ]);

    const envelope = await runSyncPackageRepos({
      cwd: tmp,
      config,
      runner,
      dryRun: true,
      packages: ['@arki/clock'],
    });

    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0]!.packageName).toBe('@arki/clock');
  });
});

describe('runSyncPackageRepos — live mode (with side effects)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'sync-repos-live-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('creates the repo, replays versions, pushes, and archives end-to-end', async () => {
    // Track which side effects fired so we can assert on the sequence.
    const callLog: string[] = [];

    const runner: ProcessRunner = {
      async run(command, args, _opts) {
        const sig = `${command} ${args.slice(0, 3).join(' ')}`;
        callLog.push(sig);

        // npm view versions
        if (command === 'npm' && args[0] === 'view' && args[2] === 'versions') {
          return { exitCode: 0, stdout: '"0.0.1"', stderr: '' };
        }
        // npm view time
        if (command === 'npm' && args[0] === 'view' && args[2] === 'time') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ '0.0.1': '2026-05-21T00:00:00Z' }),
            stderr: '',
          };
        }
        // npm view dist.tarball
        if (command === 'npm' && args[0] === 'view' && args[2] === 'dist.tarball') {
          return { exitCode: 0, stdout: 'https://registry.npmjs.org/fake.tgz', stderr: '' };
        }
        // npm view description
        if (command === 'npm' && args[0] === 'view' && args[2] === 'description') {
          return { exitCode: 0, stdout: 'A test package.', stderr: '' };
        }
        // gh api probe → 404 (so we exercise the create branch)
        if (command === 'gh' && args[0] === 'api' && args[1]?.startsWith('repos/') === true && !args.includes('-X')) {
          return { exitCode: 1, stdout: '', stderr: 'HTTP 404' };
        }
        // gh repo create
        if (command === 'gh' && args[0] === 'repo' && args[1] === 'create') {
          return { exitCode: 0, stdout: 'Created.', stderr: '' };
        }
        // gh archive (PATCH archived=true)
        if (command === 'gh' && args[0] === 'api' && args.includes('-X')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // curl tarball: synthesize a minimal real tarball so `tar` can extract.
        if (command === 'curl') {
          const destIdx = args.indexOf('-o');
          const dest = args[destIdx + 1];
          if (dest !== undefined) {
            // Create a fake .tgz: not actually valid, but our `tar` fake
            // below ignores the file contents.
            writeFileSync(dest, 'fake', 'utf8');
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // tar extract: drop a dummy file into destDir so the commit has content.
        if (command === 'tar' && args[0] === '-xzf') {
          const cIdx = args.indexOf('-C');
          const dest = args[cIdx + 1];
          if (dest !== undefined) {
            mkdirSync(path.join(dest, 'dist'), { recursive: true });
            writeFileSync(
              path.join(dest, 'package.json'),
              JSON.stringify({ name: '@arki/assert', version: '0.0.1' }),
              'utf8',
            );
            writeFileSync(path.join(dest, 'dist', 'index.js'), 'export const x = 1;\n', 'utf8');
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // Every git command succeeds.
        if (command === 'git') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    const envelope = await runSyncPackageRepos({
      cwd: tmp,
      config: singlePackageConfig('@arki/assert'),
      runner,
      dryRun: false,
    });

    expect(envelope.status).toBe('success');
    const item = envelope.items[0]!;
    expect(item.status).toBe('created');
    expect(item.archived).toBe(true);
    expect(item.pushedVersions).toEqual(['0.0.1']);
    // Confirm the expected sequence fired.
    expect(callLog.some(c => c.startsWith('gh repo create'))).toBe(true);
    expect(callLog.some(c => c.startsWith('git init'))).toBe(true);
    expect(callLog.some(c => c.startsWith('git tag'))).toBe(true);
    expect(callLog.some(c => c.startsWith('git push'))).toBe(true);
    expect(callLog.some(c => c.startsWith('gh api repos'))).toBe(true);
  });
});
