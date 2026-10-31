import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { exportSpecs, judgeTree, parseSmokeOutput, runSmoke } from './smoke';
import type { ExecRunner } from './runners';
import type { ReleaseConfig } from './types';

type Fixture = { manifest: Record<string, unknown>; files: Record<string, string> };

const config = (buildOutput?: 'source'): ReleaseConfig => ({
  publicTreePath: '.release/arki-public',
  publicMetadataDefaults: {
    license: 'MIT',
    repository: { type: 'git', url: 'https://example.com/repo.git' },
    bugs: { url: 'https://example.com/issues' },
    homepage: 'https://example.com',
    publishConfig: { access: 'public' },
    keywords: ['arki'],
  },
  waves: [{ id: 'foundation', label: 'Wave 1', packages: ['@arki/journal'], ...(buildOutput ? { buildOutput } : {}) }],
});

const pkg = (name: string, version: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  version,
  type: 'module',
  exports: { '.': './index.js' },
  ...extra,
});

function makeCandidate(names: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-cand-'));
  mkdirSync(path.join(dir, 'tarballs'));
  // Real files with real hashes: smoke reads the candidate through readCandidate, which verifies each sha512.
  const packages = names.map((name, index) => {
    const tarball = `tarballs/${name.split('/')[1]}.tgz`;
    writeFileSync(path.join(dir, tarball), name);
    const sha512 = createHash('sha512').update(name).digest('hex');
    return { name, version: '1.0.0', tarball, sha512, publishOrder: index + 1 };
  });
  const candidate = { wave: 'foundation', sourceCommit: 'abc1234', createdAt: '2026-10-17T00:00:00.000Z', packages, checks: {} };
  writeFileSync(path.join(dir, 'candidate.json'), JSON.stringify(candidate));
  return dir;
}

type FakeOptions = {
  /** Packed manifests by tarball basename. */
  packed: Record<string, Record<string, unknown>>;
  /** What `npm install` lays down in node_modules, by cwd suffix. */
  installed: Record<string, Fixture>;
  lsJson?: string;
  failCommand?: string;
};

/** Real node for the import step, fakes for everything that needs a network. */
function fakeRunner(options: FakeOptions): { runner: ExecRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: ExecRunner = (command, args, { cwd }) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (options.failCommand === command) return Promise.resolve({ code: 1, stdout: '', stderr: `${command} exploded` });
    if (command === 'tar') {
      const base = path.basename(args[1] ?? '', '.tgz');
      return Promise.resolve({ code: 0, stdout: JSON.stringify(options.packed[base]), stderr: '' });
    }
    if (command === 'npm' && args[0] === 'install') {
      for (const [name, fixture] of Object.entries(options.installed)) {
        const dir = path.join(cwd, 'node_modules', name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'package.json'), JSON.stringify(fixture.manifest));
        for (const [file, text] of Object.entries(fixture.files)) writeFileSync(path.join(dir, file), text);
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    }
    if (command === 'npm' && args[0] === 'ls') {
      return Promise.resolve({ code: 0, stdout: options.lsJson ?? '{"dependencies":{}}', stderr: '' });
    }
    if (command === 'node') {
      return new Promise(resolve => {
        execFile(process.execPath, [...args], { cwd }, (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : 1, stdout, stderr });
        });
      });
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  return { runner, calls };
}

const logOld: Fixture = {
  manifest: pkg('@arki/log', '0.0.3'),
  files: { 'index.js': 'export const log = () => {};\n' },
};
const logNew: Fixture = {
  manifest: pkg('@arki/log', '0.0.4'),
  files: { 'index.js': 'export const log = () => {};\nexport const getLogger = () => ({});\n' },
};
const journal: Fixture = {
  manifest: pkg('@arki/journal', '1.0.0', { dependencies: { '@arki/log': '0.0.3' } }),
  files: { 'index.js': "import { getLogger } from '@arki/log';\nexport const j = getLogger;\n" },
};

const base = (candidateDir: string, runner: ExecRunner) => ({
  candidateDir,
  repoRoot: '/nonexistent/repo',
  config: config(),
  runner,
  tmpRoot: mkdtempSync(path.join(tmpdir(), 'smoke-tmp-')),
});

describe('runSmoke', () => {
  it('fails when a tarball imports an export its published dependency lacks', async () => {
    // Why: @arki/journal@0.1.0 shipped pinned to a @arki/log without getLogger; the in-repo scorecard was green and every outside install broke.
    const dir = makeCandidate(['@arki/journal']);
    const { runner } = fakeRunner({
      packed: { journal: journal.manifest },
      installed: { '@arki/journal': journal, '@arki/log': logOld },
    });
    const envelope = await runSmoke(base(dir, runner));
    expect(envelope.status).toBe('failure');
    expect(envelope.errors.map(e => e.code)).toContain('SMOKE_E002');
    const item = envelope.items.find(i => i.name === '@arki/journal');
    expect(item?.checks.find(c => c.id === 'import:node')?.status).toBe('fail');
    expect(item?.checks.find(c => c.id === 'import:node')?.detail).toContain('getLogger');
  });

  it('passes when the dependency pin carries the export, and records checks.smoke', async () => {
    // Why: the green path must stay green, and later gates read the verdict from candidate.json instead of re-running.
    const dir = makeCandidate(['@arki/journal']);
    const { runner, calls } = fakeRunner({
      packed: { journal: journal.manifest },
      installed: { '@arki/journal': journal, '@arki/log': logNew },
    });
    const envelope = await runSmoke(base(dir, runner));
    expect(envelope.errors).toEqual([]);
    expect(envelope.status).toBe('success');
    expect(calls.some(c => c.startsWith('bun consumer-smoke.mjs'))).toBe(true);
    const saved = JSON.parse(readFileSync(path.join(dir, 'candidate.json'), 'utf8')) as { checks: { smoke: { status: string } } };
    expect(saved.checks.smoke.status).toBe('success');
  });

  it('adds exact published @arki deps to the consumer install', async () => {
    // Why: the outside install must use the npm versions the tarball pins, or it tests something users never get.
    const dir = makeCandidate(['@arki/journal']);
    let written = '';
    const inner = fakeRunner({ packed: { journal: journal.manifest }, installed: { '@arki/journal': journal, '@arki/log': logNew } });
    const runner: ExecRunner = (command, args, opts) => {
      if (command === 'npm' && args[0] === 'install' && written === '') written = readFileSync(path.join(opts.cwd, 'package.json'), 'utf8');
      return inner.runner(command, args, opts);
    };
    await runSmoke(base(dir, runner));
    const parsed = JSON.parse(written) as { dependencies: Record<string, string>; overrides: Record<string, string> };
    expect(parsed.dependencies['@arki/log']).toBe('0.0.3');
    expect(parsed.overrides['@arki/journal']).toMatch(/^file:.*journal\.tgz$/);
  });

  it('fails with SMOKE_E001 when npm install fails', async () => {
    // Why: an unresolvable dependency range is the most common outside-install break.
    const dir = makeCandidate(['@arki/journal']);
    const { runner } = fakeRunner({ packed: { journal: journal.manifest }, installed: {}, failCommand: 'npm' });
    const envelope = await runSmoke(base(dir, runner));
    expect(envelope.errors.map(e => e.code)).toEqual(['SMOKE_E001']);
  });

  it('fails with SMOKE_E006 and SMOKE_E007 for duplicate copies and paths inside the repo', async () => {
    // Why: two copies of a package break singletons; a path inside the repo means the test was not really outside.
    const dir = makeCandidate(['@arki/journal']);
    const ls = JSON.stringify({
      dependencies: {
        '@arki/journal': { version: '1.0.0', path: '/nonexistent/repo/packages/journal', dependencies: { '@arki/log': { version: '0.0.3', path: '/c/node_modules/@arki/journal/node_modules/@arki/log' } } },
        '@arki/log': { version: '0.0.4', path: '/c/node_modules/@arki/log' },
      },
    });
    const { runner } = fakeRunner({ packed: { journal: journal.manifest }, installed: { '@arki/journal': journal, '@arki/log': logNew }, lsJson: ls });
    const envelope = await runSmoke(base(dir, runner));
    const codes = envelope.errors.map(e => e.code);
    expect(codes).toContain('SMOKE_E006');
    expect(codes).toContain('SMOKE_E007');
  });

  it('checks an optional peer both without and with it installed', async () => {
    // Why: a package must fail with a clear message when its optional peer is absent and work once the peer is there.
    const dir = makeCandidate(['@arki/journal']);
    const peerManifest = pkg('@arki/journal', '1.0.0', { peerDependencies: { zod: '^4' }, peerDependenciesMeta: { zod: { optional: true } } });
    const needsZod: Fixture = {
      manifest: peerManifest,
      files: { 'index.js': "import 'zod-not-here-yet';\n" },
    };
    // First install lacks the peer ("Cannot find package 'zod'"); the with-peers install provides it.
    const withPeer: Fixture = { manifest: peerManifest, files: { 'index.js': 'export const ok = 1;\n' } };
    const inner = fakeRunner({ packed: { journal: peerManifest }, installed: { '@arki/journal': needsZod } });
    needsZod.files['index.js'] = "import 'zod';\n";
    const runner: ExecRunner = (command, args, opts) => {
      if (command === 'npm' && args[0] === 'install' && opts.cwd.endsWith('with-peers')) {
        const target = path.join(opts.cwd, 'node_modules', '@arki', 'journal');
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, 'package.json'), JSON.stringify(withPeer.manifest));
        writeFileSync(path.join(target, 'index.js'), withPeer.files['index.js'] ?? '');
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
      return inner.runner(command, args, opts);
    };
    const envelope = await runSmoke(base(dir, runner));
    const item = envelope.items.find(i => i.name === '@arki/journal');
    expect(item?.checks.find(c => c.id === 'optional-peer')?.status).toBe('pass');
    expect(envelope.status).toBe('success');
  });

  it('passes the with-peers run when a Bun-only entry still skips under node', async () => {
    // Why: @arki/db/bun imports 'bun', so node skips it in both runs. The with-peers check
    // counted that SKIP as a failure and failed @arki/db although it imports with its peers.
    const dir = makeCandidate(['@arki/journal']);
    const peerManifest = pkg('@arki/journal', '1.0.0', {
      exports: { '.': './index.js', './bun': './bun.js' },
      peerDependencies: { zod: '^4' },
      peerDependenciesMeta: { zod: { optional: true } },
    });
    const files = { 'index.js': "import 'zod';\n", 'bun.js': "import 'bun';\n" };
    const inner = fakeRunner({ packed: { journal: peerManifest }, installed: { '@arki/journal': { manifest: peerManifest, files } } });
    const runner: ExecRunner = (command, args, opts) => {
      if (command === 'npm' && args[0] === 'install' && opts.cwd.endsWith('with-peers')) {
        const target = path.join(opts.cwd, 'node_modules', '@arki', 'journal');
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, 'package.json'), JSON.stringify(peerManifest));
        writeFileSync(path.join(target, 'index.js'), 'export const ok = 1;\n');
        writeFileSync(path.join(target, 'bun.js'), files['bun.js']);
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
      return inner.runner(command, args, opts);
    };
    const envelope = await runSmoke(base(dir, runner));
    const item = envelope.items.find(i => i.name === '@arki/journal');
    expect(item?.checks.find(c => c.id === 'optional-peer')?.status).toBe('pass');
    expect(envelope.status).toBe('success');
  });

  it('installs a second optional peer that only shows once the first one is there', async () => {
    // Why: an entry names only the first peer it misses. @arki/db/eslint needs
    // @typescript-eslint/utils and then typescript; installing only the first failed
    // a package that works with both, and blocked the infra wave.
    const dir = makeCandidate(['@arki/journal']);
    const peerManifest = pkg('@arki/journal', '1.0.0', {
      peerDependencies: { zod: '^4', valibot: '^1' },
      peerDependenciesMeta: { zod: { optional: true }, valibot: { optional: true } },
    });
    const needsZod: Fixture = { manifest: peerManifest, files: { 'index.js': "import 'zod';\n" } };
    const inner = fakeRunner({ packed: { journal: peerManifest }, installed: { '@arki/journal': needsZod } });
    const runner: ExecRunner = (command, args, opts) => {
      if (command === 'npm' && args[0] === 'install' && opts.cwd.endsWith('with-peers')) {
        const deps = (JSON.parse(readFileSync(path.join(opts.cwd, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies;
        const target = path.join(opts.cwd, 'node_modules', '@arki', 'journal');
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, 'package.json'), JSON.stringify(peerManifest));
        writeFileSync(path.join(target, 'index.js'), 'valibot' in deps ? 'export const ok = 1;\n' : "import 'valibot';\n");
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
      return inner.runner(command, args, opts);
    };
    const envelope = await runSmoke(base(dir, runner));
    const item = envelope.items.find(i => i.name === '@arki/journal');
    expect(item?.checks.find(c => c.id === 'optional-peer')).toMatchObject({ status: 'pass', detail: expect.stringContaining('zod, valibot') });
    expect(envelope.status).toBe('success');
  });

  it('installs an optional peer that is in the candidate from its tarball, not its peer range', async () => {
    // Why: @arki/journal peers on @arki/admin (^0.3.0) and both are in the candidate.
    // The with-peers step listed admin as a dependency with the range while
    // `overrides` mapped it to the tarball, and npm stopped with EOVERRIDE.
    const dir = makeCandidate(['@arki/journal', '@arki/admin']);
    const peerManifest = pkg('@arki/journal', '1.0.0', {
      peerDependencies: { '@arki/admin': '^0.3.0' },
      peerDependenciesMeta: { '@arki/admin': { optional: true } },
    });
    const needsAdmin: Fixture = { manifest: peerManifest, files: { 'index.js': "import '@arki/admin';\n" } };
    const inner = fakeRunner({ packed: { journal: peerManifest, admin: pkg('@arki/admin', '0.3.0') }, installed: { '@arki/journal': needsAdmin } });
    const runner: ExecRunner = async (command, args, opts) => {
      if (command === 'npm' && args[0] === 'install' && opts.cwd.endsWith('with-peers')) {
        // npm's rule: an override for a direct dependency must equal its spec.
        const consumerPkg = JSON.parse(readFileSync(path.join(opts.cwd, 'package.json'), 'utf8')) as {
          dependencies: Record<string, string>;
          overrides: Record<string, string>;
        };
        for (const [name, spec] of Object.entries(consumerPkg.overrides)) {
          const direct = consumerPkg.dependencies[name];
          if (direct !== undefined && direct !== spec) {
            return { code: 1, stdout: '', stderr: `npm error code EOVERRIDE\nOverride for ${name}@${direct} conflicts with direct dependency` };
          }
        }
        const target = path.join(opts.cwd, 'node_modules', '@arki', 'journal');
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, 'package.json'), JSON.stringify(peerManifest));
        writeFileSync(path.join(target, 'index.js'), 'export const ok = 1;\n');
        return { code: 0, stdout: '', stderr: '' };
      }
      return inner.runner(command, args, opts);
    };
    const envelope = await runSmoke(base(dir, runner));
    const peerCheck = envelope.items.find(i => i.name === '@arki/journal')?.checks.find(c => c.id === 'optional-peer');
    expect(peerCheck?.detail).not.toContain('EOVERRIDE');
    expect(peerCheck?.status).toBe('pass');
    expect(envelope.status).toBe('success');
  });

  it('runs a Vite build for source-distributed waves', async () => {
    // Why: source-shipped packages only prove themselves under a bundler, not under bare node.
    const dir = makeCandidate(['@arki/journal']);
    const { runner, calls } = fakeRunner({ packed: { journal: journal.manifest }, installed: { '@arki/journal': journal, '@arki/log': logNew } });
    const envelope = await runSmoke({ ...base(dir, runner), config: config('source') });
    expect(calls).toContain('npx --no-install vite build');
    expect(envelope.items[0]?.checks.find(c => c.id === 'vite-build')?.status).toBe('pass');
  });

  it('bundles only the source-distributed packages, not compiled ones in the same candidate', async () => {
    // Why: compiled deps (@arki/failure's eslint entry, @arki/date's router
    // entry) carry optional-peer subpaths that cannot bundle without the peer;
    // node and bun already import them.
    const dir = makeCandidate(['@arki/journal', '@arki/log']);
    const { runner } = fakeRunner({ packed: { journal: journal.manifest, log: logNew.manifest }, installed: { '@arki/journal': journal, '@arki/log': logNew } });
    let bundled = '';
    const spy: ExecRunner = (command, args, opts) => {
      if (command === 'npx' && args.includes('vite')) bundled = readFileSync(path.join(opts.cwd, 'src', 'main.ts'), 'utf8');
      return runner(command, args, opts);
    };
    await runSmoke({ ...base(dir, spy), config: config('source') });
    expect(bundled).toContain("from '@arki/journal'");
    expect(bundled).not.toContain('@arki/log');
  });

  it('does not fail a source-distributed package that bare node cannot import', async () => {
    // Why: @arki/ui and friends ship .ts and .css for a bundler; node's
    // "Unknown file extension" is expected there, and blocked every frontend candidate.
    const cssJournal: Fixture = { manifest: journal.manifest, files: { 'index.js': "import './tokens.css';\n", 'tokens.css': ':root{}\n' } };
    const dir = makeCandidate(['@arki/journal']);
    const { runner } = fakeRunner({ packed: { journal: journal.manifest }, installed: { '@arki/journal': cssJournal, '@arki/log': logNew } });
    const envelope = await runSmoke({ ...base(dir, runner), config: config('source') });
    expect(envelope.errors.filter(e => e.code === 'SMOKE_E002')).toEqual([]);
    expect(envelope.items.find(i => i.name === '@arki/journal')?.checks.find(c => c.id === 'import:node')?.status).toBe('skip');
  });

  // A compiled package whose `./react` entry pulls CSS, the way @arki/auth/react
  // renders @arki/ui source: bare node throws "Unknown file extension".
  const reactJournal: Fixture = {
    manifest: pkg('@arki/journal', '1.0.0', { exports: { '.': './index.js', './react': './react.js' }, arki: { bundlerOnly: ['./react'] } }),
    files: { 'index.js': 'export const j = 1;\n', 'react.js': "import './tokens.css';\n", 'tokens.css': ':root{}\n' },
  };

  it('skips an arki.bundlerOnly entry under node instead of failing the package', async () => {
    // Why: @arki/auth/react and @arki/tanstack-start/pwa/sw only load inside a bundler or a worker; importing them under node blocked compiled waves.
    const dir = makeCandidate(['@arki/journal']);
    const { runner } = fakeRunner({ packed: { journal: reactJournal.manifest }, installed: { '@arki/journal': reactJournal } });
    const envelope = await runSmoke(base(dir, runner));
    expect(envelope.errors).toEqual([]);
    const importNode = envelope.items.find(i => i.name === '@arki/journal')?.checks.find(c => c.id === 'import:node');
    expect(importNode?.status).toBe('pass');
    expect(importNode?.detail).toBe('1 subpath(s) imported; 1 bundler-only left to the Vite build');
  });

  it('bundles the arki.bundlerOnly entries of a compiled wave with Vite', async () => {
    // Why: a skipped entry must still be proven somewhere; the Vite build is that proof, and it must not pull the node-imported entries in.
    const dir = makeCandidate(['@arki/journal']);
    const { runner, calls } = fakeRunner({ packed: { journal: reactJournal.manifest }, installed: { '@arki/journal': reactJournal } });
    let bundled = '';
    const spy: ExecRunner = (command, args, opts) => {
      if (command === 'npx' && args.includes('vite')) bundled = readFileSync(path.join(opts.cwd, 'src', 'main.ts'), 'utf8');
      return runner(command, args, opts);
    };
    const envelope = await runSmoke(base(dir, spy));
    expect(calls).toContain('npx --no-install vite build');
    expect(bundled).toContain("from '@arki/journal/react'");
    expect(bundled).not.toContain("from '@arki/journal'");
    expect(envelope.items[0]?.checks.find(c => c.id === 'vite-build')).toEqual({ id: 'vite-build', status: 'pass', detail: '1 subpath(s) bundled' });
  });

  it('runs no Vite build for a compiled wave without bundler-only entries', async () => {
    // Why: compiled packages are proven by node and bun; a needless Vite install only slows every wave down.
    const dir = makeCandidate(['@arki/journal']);
    const { runner, calls } = fakeRunner({ packed: { journal: journal.manifest }, installed: { '@arki/journal': journal, '@arki/log': logNew } });
    const envelope = await runSmoke(base(dir, runner));
    expect(calls).not.toContain('npx --no-install vite build');
    expect(envelope.items[0]?.checks.find(c => c.id === 'vite-build')).toBeUndefined();
  });

  it('fails with SMOKE_E010 when arki.bundlerOnly names a key that is not in exports', async () => {
    // Why: a typo ("react" for "./react") would silently leave the real entry under node and prove nothing in Vite.
    const typo: Fixture = { manifest: { ...reactJournal.manifest, arki: { bundlerOnly: ['./react', 'react'] } }, files: reactJournal.files };
    const dir = makeCandidate(['@arki/journal']);
    const { runner } = fakeRunner({ packed: { journal: typo.manifest }, installed: { '@arki/journal': typo } });
    const envelope = await runSmoke(base(dir, runner));
    expect(envelope.status).toBe('failure');
    expect(envelope.errors.map(e => [e.code, e.target])).toEqual([['SMOKE_E010', '@arki/journal']]);
    expect(envelope.errors[0]?.message).toContain('react in arki.bundlerOnly');
    expect(envelope.items.find(i => i.name === '@arki/journal')?.checks.find(c => c.id === 'bundler-only')?.status).toBe('fail');
  });

  it('fails with SMOKE_E008 when candidate.json is missing', async () => {
    // Why: smoke must never guess a wave; a missing candidate means the freeze step was skipped.
    const dir = mkdtempSync(path.join(tmpdir(), 'smoke-empty-'));
    const envelope = await runSmoke(base(dir, fakeRunner({ packed: {}, installed: {} }).runner));
    expect(envelope.errors[0]?.code).toBe('SMOKE_E008');
  });
});

describe('helpers', () => {
  it('parseSmokeOutput reads PASS, SKIP and FAIL lines', () => {
    // Why: the per-package verdicts come only from this text, so its shape must not drift.
    const lines = parseSmokeOutput(
      "PASS node v26.0.0 @arki/log\nFAIL bun 1.4.2 @arki/journal/x: The requested module 'a' does not provide an export named 'b'\nSKIP node v26.0.0 @arki/z (optional peer zod not installed)\nnoise",
    );
    expect(lines.map(l => [l.verdict, l.runtime, l.spec])).toEqual([
      ['PASS', 'node', '@arki/log'],
      ['FAIL', 'bun', '@arki/journal/x'],
      ['SKIP', 'node', '@arki/z'],
    ]);
  });

  it('exportSpecs skips package.json and wildcard entries', () => {
    // Why: wildcard and package.json entries are not importable names.
    expect(exportSpecs({ name: '@arki/x', version: '1', exports: { '.': './a', './b': './b', './*': './*', './package.json': './package.json' } })).toEqual(['@arki/x', '@arki/x/b']);
  });

  it('judgeTree flags two paths for one package', () => {
    // Why: one physical copy per @arki package is a release rule.
    const tree = JSON.stringify({ dependencies: { '@arki/a': { version: '1', path: '/c/a', dependencies: { '@arki/a': { version: '1', path: '/c/x/a' } } } } });
    expect(judgeTree(tree, '/repo').duplicates).toHaveLength(1);
  });
});
