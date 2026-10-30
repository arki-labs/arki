/**
 * Unit tests for the release scorecard.
 *
 * Strategy: every test builds a tiny workspace fixture in a fresh temp
 * dir (root `package.json` + one or two packages under `packages/`),
 * drives {@link runScorecard} with injected runners for npm pack +
 * the fixture matrix, and asserts on the returned envelope's
 * per-dimension status. We never spawn real subprocesses — the runners
 * return canned data that mimics what each underlying command would
 * produce.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitRunner, NpmRunner } from './runners';
import type { Candidate } from './candidate';
import {
  auditFrozenTarball,
  frozenDimensions,
  readinessExternal,
  renderScorecardText,
  runScorecard,
  SCORECARD_ERROR_CODES,
  type ScorecardOptions,
} from './scorecard';
import { seedRootFiles } from './seed-root-files';
import type { DotProbeOk, ReleaseConfig } from './types';
import type { ProcessResult, ProcessRunner } from './fixture';

/**
 * Synthetic passing DOT probe for tests that want to exercise the gate
 * evaluators. Returns the narrow `DotProbeOk` shape so tests can spread it
 * and override individual fields (`{ ...passingDotProbe(), pluginCount: 2 }`)
 * without TypeScript losing the discriminant.
 */
function passingDotProbe(): DotProbeOk {
  return {
    status: 'pass',
    pluginCount: 3,
    manifestArrays: 5,
    diagnosticsArrays: 5,
    explainEnvelopeOk: true,
    doctorEnvelopeOk: true,
    newEnvelopeOk: true,
    newOperationCount: 7,
    newRequiredFilesPresent: ['package.json', 'tsconfig.json', 'README.md', 'AGENTS.md', '.gitignore'],
    appState: 'booted',
  };
}

/** Shared metadata defaults used by every fixture. */
const defaults: ReleaseConfig['publicMetadataDefaults'] = {
  license: 'MIT',
  repository: { type: 'git', url: 'https://example.com/repo.git' },
  bugs: { url: 'https://example.com/issues' },
  homepage: 'https://example.com',
  publishConfig: { access: 'public' },
  keywords: ['arki'],
};

/** Single-package config with `@arki/assert` in the foundation wave. */
function makeConfig(packages: readonly string[] = ['@arki/assert']): ReleaseConfig {
  return {
    publicTreePath: '.release/arki-public',
    publicMetadataDefaults: defaults,
    waves: [{ id: 'foundation', label: 'Foundation', packages }],
  };
}

function writeFile(root: string, relPath: string, contents: string): void {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

function writePkg(root: string, dir: string, manifest: Record<string, unknown>): void {
  writeFile(root, `packages/${dir}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeRoot(root: string): void {
  writeFile(
    root,
    'package.json',
    `${JSON.stringify({ name: 'arki', version: '0.0.0', private: true, packageManager: 'bun@1.4.2' }, null, 2)}\n`,
  );
  seedRootFiles(root);
}

/**
 * Build an `@arki/assert` package with the requested completeness. Defaults
 * to a fully clean package that should PASS every dimension.
 */
function writeAssertPackage(
  root: string,
  opts: {
    readonly description?: string | null;
    readonly withReadme?: boolean;
    readonly withLicense?: boolean;
    readonly withDistJs?: boolean;
    readonly withDistDts?: boolean;
    readonly leakInReadme?: boolean;
    readonly dependencies?: Readonly<Record<string, string>>;
  } = {},
): void {
  const description = opts.description === undefined ? 'Test assertions.' : opts.description;
  const manifest: Record<string, unknown> = {
    name: '@arki/assert',
    version: '1.0.0',
    type: 'module',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    files: ['dist'],
  };
  if (description !== null) manifest['description'] = description;
  if (opts.dependencies !== undefined) manifest['dependencies'] = opts.dependencies;

  writePkg(root, 'assert', manifest);

  if (opts.withReadme !== false) {
    const readmeBody = opts.leakInReadme === true
      ? '# @arki/assert\n\nAuthor: dev@furculita.net\n'
      : '# @arki/assert\n\nAssertion helpers.\n';
    writeFile(root, 'packages/assert/README.md', readmeBody);
  }
  if (opts.withLicense !== false) {
    writeFile(root, 'packages/assert/LICENSE', 'MIT License\n');
  }
  if (opts.withDistJs !== false) {
    writeFile(root, 'packages/assert/dist/index.js', 'export const ok = true;\n');
  }
  if (opts.withDistDts !== false) {
    writeFile(root, 'packages/assert/dist/index.d.ts', 'export declare const ok: boolean;\n');
  }
}

/**
 * Synthetic npm-pack runner: returns an entry whose files mirror what
 * the fixture currently has on disk in `dist/`. Production npm would do
 * the same — this mimics the behaviour without spawning the CLI.
 */
function makeNpmPackRunner(opts: {
  readonly extraFiles?: ReadonlyArray<{ readonly path: string; readonly size: number }>;
  readonly fail?: boolean;
} = {}): NpmRunner {
  return async (args, { cwd }) => {
    if (opts.fail === true) {
      return { stdout: '', stderr: 'simulated pack failure', code: 1 };
    }
    if (args[0] !== 'pack') {
      return { stdout: '', stderr: 'unexpected npm subcommand', code: 1 };
    }
    // Read the package manifest to get the name + version.
    const manifestPath = path.join(cwd, 'package.json');
    const fs = await import('node:fs/promises');
    const text = await fs.readFile(manifestPath, 'utf8');
    const m = JSON.parse(text) as { name: string; version: string };

    // Default file list: every actual file in dist/ plus README + LICENSE
    // when present in the package root. Mirrors npm's behaviour of including
    // top-level docs even when `files` doesn't list them.
    const baseFiles: Array<{ path: string; size: number; mode: number }> = [];
    const distDir = path.join(cwd, 'dist');
    try {
      const entries = await fs.readdir(distDir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(entry.parentPath, entry.name);
        const rel = path.relative(cwd, full);
        const stat = await fs.stat(full);
        baseFiles.push({ path: rel, size: stat.size, mode: 0o644 });
      }
    } catch {
      // dist/ missing — that's the build-output failure case, which the
      // scorecard catches via the dist scan; the pack-audit will fail
      // independently via the `requires-compiled` / `requires-declarations`
      // rules. Add a placeholder file so npm doesn't refuse to emit JSON.
      baseFiles.push({ path: 'package.json', size: text.length, mode: 0o644 });
    }
    for (const docName of ['README.md', 'LICENSE', 'LICENSE.md']) {
      try {
        const stat = await fs.stat(path.join(cwd, docName));
        baseFiles.push({ path: docName, size: stat.size, mode: 0o644 });
      } catch {
        // Missing — skip; the docs dimension reports this separately.
      }
    }
    // Add the synthetic extra files (used to inject "test file in output"
    // failures).
    for (const extra of opts.extraFiles ?? []) {
      baseFiles.push({ ...extra, mode: 0o644 });
    }
    const entry = {
      id: `${m.name}@${m.version}`,
      name: m.name,
      version: m.version,
      filename: `${m.name.replace(/^@/, '').replace(/\//g, '-')}-${m.version}.tgz`,
      files: baseFiles,
      entryCount: baseFiles.length,
      bundled: [],
      size: 1024,
      unpackedSize: baseFiles.reduce((sum, f) => sum + f.size, 0),
    };
    return { stdout: JSON.stringify([entry]), stderr: '', code: 0 };
  };
}

/**
 * Every release input a clean `@arki/assert` 1.0.0 needs to pass the release
 * dimensions: npm has 0.9.0 (so 1.0.0 is a release), git shows the README
 * changed since 0.9.0, a changeset records why no demo is affected, the
 * CHANGELOG tops at 1.0.0, docs mention the `ok` export, and the doc
 * examples report is clean. Returns the scorecard options that inject them.
 */
function releaseReady(root: string): Pick<ScorecardOptions, 'npmRunner' | 'gitRunner' | 'docExamples'> {
  writeFile(root, 'packages/assert/CHANGELOG.md', '# @arki/assert\n\n## 1.0.0\n\n- First stable.\n');
  writeFile(root, 'packages/assert/docs/usage.md', 'Check with `ok`.\n');
  writeFile(root, '.changeset/assert.md', "---\n'@arki/assert': minor\n---\n\nno demo impact: assertions are not used by any registered demo\n");
  const pack = makeNpmPackRunner();
  const npmRunner: NpmRunner = async (args, options) =>
    args[0] === 'view' ? { stdout: '["0.9.0"]', stderr: '', code: 0 } : pack(args, options);
  const gitRunner: GitRunner = async args => {
    if (args[0] === 'log') return { stdout: 'abc123\n', stderr: '', code: 0 };
    if (args[0] === 'show') return { stdout: '{ "version": "0.9.0" }', stderr: '', code: 0 };
    if (args[0] === 'diff') return { stdout: 'packages/assert/README.md\n', stderr: '', code: 0 };
    return { stdout: '', stderr: 'unexpected git call', code: 1 };
  };
  return { npmRunner, gitRunner, docExamples: { '@arki/assert': { examples: 1, modules: 1, compiled: 1, ran: 1, skipped: 0, skippedBlocks: [], failures: [] } } };
}

/**
 * Synthetic fixture-matrix runner: every subprocess returns success.
 * The fixture matrix's own logic decides whether to consider the run
 * `success` or `failure` based on stage outcomes; this runner makes
 * sure every stage's underlying process succeeds.
 */
function makeFixtureRunner(opts: { readonly packFail?: boolean } = {}): ProcessRunner {
  return {
    async run(command, args, { cwd }) {
      if (command === 'npm' && args[0] === 'pack') {
        if (opts.packFail === true) {
          return { exitCode: 1, stdout: '', stderr: 'simulated pack failure' };
        }
        return fakePack(cwd, args);
      }
      // Install / node / npx / pnpm / bun / bunx — every other call
      // succeeds silently. The fixture matrix only checks exit codes.
      if (command === 'node') {
        return { exitCode: 0, stdout: '["ok"]', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

/**
 * Replicate npm pack's tarball-writing behaviour for the fixture matrix:
 * write a fake `.tgz` to the requested pack-destination + emit the JSON
 * filename list. (Copy of the helper in `fixture.test.ts`.)
 */
async function fakePack(cwd: string, args: readonly string[]): Promise<ProcessResult> {
  const destIdx = args.indexOf('--pack-destination');
  const destDir = args[destIdx + 1];
  if (destDir === undefined) {
    return { exitCode: 1, stdout: '', stderr: 'no --pack-destination' };
  }
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
  const manifest = JSON.parse(text) as { name: string; version: string };
  const safeName = manifest.name.replace(/^@/, '').replace(/\//g, '-');
  const filename = `${safeName}-${manifest.version}.tgz`;
  await fs.mkdir(destDir, { recursive: true });
  await fs.writeFile(path.join(destDir, filename), 'fake-tar', 'utf8');
  return {
    exitCode: 0,
    stdout: JSON.stringify([{ name: manifest.name, version: manifest.version, filename }]),
    stderr: '',
  };
}

describe('runScorecard — happy path', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-scorecard-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('all dimensions pass for a clean package', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      ...releaseReady(tmp),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    expect(envelope.items).toHaveLength(1);
    const pkg = envelope.items[0];
    expect(pkg?.dimensions.metadata.status).toBe('pass');
    expect(pkg?.dimensions.privacy.status).toBe('pass');
    expect(pkg?.dimensions.dependencies.status).toBe('pass');
    expect(pkg?.dimensions['build-output'].status).toBe('pass');
    expect(pkg?.dimensions.packlist.status).toBe('pass');
    expect(pkg?.dimensions.docs.status).toBe('pass');
    expect(pkg?.dimensions.fixtures.status).toBe('pass');
    // Release dimensions pass only because releaseReady() supplied every input.
    for (const dim of ['docs-fresh', 'docs-impact', 'demo-impact', 'demo-lag', 'bench-fresh', 'readiness'] as const) {
      expect(pkg?.dimensions[dim].status, dim).toBe('pass');
    }
    // DOT + agent-native stay deferred until Tasks 9/10/11.5 ship.
    expect(pkg?.dimensions['dot-gates'].status).toBe('deferred');
    expect(pkg?.dimensions['agent-native-gates'].status).toBe('deferred');
    // Overall = worst-of, so deferred wins until --allow-deferred is set.
    expect(pkg?.overall).toBe('deferred');
    // Stable gate blocked by the deferred dimensions (default policy).
    expect(envelope.summary.stableReleaseGate).toBe('blocked');
  });

  it('opens the stable gate when allow-deferred is true and every non-deferred dimension passes', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      allowDeferred: true,
      npmRunner: makeNpmPackRunner(),
      ...releaseReady(tmp),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    expect(envelope.summary.stableReleaseGate).toBe('open');
    expect(envelope.summary.allowDeferred).toBe(true);
    expect(envelope.status).toBe('success');
  });
});

describe('runScorecard — dimension failures', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-scorecard-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('metadata: warns when description is missing (RELEASE_E006)', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp, { description: null });
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions.metadata.status).toBe('warn');
    expect(pkg?.dimensions.metadata.evidence.some(e => e.code === 'RELEASE_E006')).toBe(true);
  });

  it('privacy: fails when README contains an error-severity leak', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp, { leakInReadme: true });
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions.privacy.status).toBe('fail');
    expect(pkg?.dimensions.privacy.evidence.length).toBeGreaterThan(0);
    expect(pkg?.dimensions.privacy.evidence[0]?.code).toBe('LEAK_E001');
  });

  it('dependencies: fails when manifest depends on a private ARKI package', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp, {
      dependencies: { '@arki/private-thing': 'workspace:*' },
    });
    // Mark @arki/private-thing as private in inventory.
    writePkg(tmp, 'private-thing', {
      name: '@arki/private-thing',
      version: '0.1.0',
      private: true,
    });
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(['@arki/assert']),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    // The inventory will classify @arki/assert as blocked-by-private-dependency,
    // not public-candidate, so it is NOT a candidate for the scorecard.
    // We expect zero items + a no-public-candidates warning OR a downgrade
    // somewhere. Either way the gate must be blocked.
    expect(envelope.summary.stableReleaseGate).toBe('blocked');
  });

  it('build-output: fails when dist/ is missing', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp, { withDistJs: false, withDistDts: false });
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions['build-output'].status).toBe('fail');
    expect(pkg?.overall).toBe('fail');
  });

  it('build-output: fails when dist/ has .d.ts but no .js', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp, { withDistJs: false });
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions['build-output'].status).toBe('fail');
  });

  it('packlist: fails when npm pack reports a no-tests rule violation', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    // Inject a test file via the npm-pack runner — the package on disk
    // doesn't have one, but the runner pretends pack saw it.
    const runner = makeNpmPackRunner({
      extraFiles: [{ path: 'dist/foo.test.js', size: 100 }],
    });
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: runner,
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions.packlist.status).toBe('fail');
    expect(pkg?.dimensions.packlist.evidence.some(e => e.message.includes('no-tests'))).toBe(true);
  });

  it('docs: fails when README is missing', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp, { withReadme: false });
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions.docs.status).toBe('fail');
  });

  it('docs: warns when LICENSE is missing but README is present', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp, { withLicense: false });
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions.docs.status).toBe('warn');
  });

  it('fixtures: fails when the fixture matrix pack stage fails', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner({ packFail: true }),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions.fixtures.status).toBe('fail');
    expect(pkg?.dimensions.fixtures.evidence.length).toBeGreaterThan(0);
  });
});

describe('runScorecard — DOT + agent-native gate evaluation', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-scorecard-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports both gates as `deferred` when the probe is skipped (legacy fallback)', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions['dot-gates'].status).toBe('deferred');
    expect(pkg?.dimensions['dot-gates'].details).toMatch(/skip-dot-probe/);
    expect(pkg?.dimensions['agent-native-gates'].status).toBe('deferred');
    expect(pkg?.dimensions['agent-native-gates'].details).toMatch(/skip-dot-probe/);
  });

  it('passes both gates when the injected probe satisfies every contract check', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      ...releaseReady(tmp),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      dotProbe: passingDotProbe(),
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions['dot-gates'].status).toBe('pass');
    expect(pkg?.dimensions['dot-gates'].details).toMatch(/3 adapters booted/);
    expect(pkg?.dimensions['agent-native-gates'].status).toBe('pass');
    expect(pkg?.dimensions['agent-native-gates'].details).toMatch(/dot new --dry-run/);
    expect(pkg?.overall).toBe('pass');
    expect(envelope.summary.stableReleaseGate).toBe('open');
  });

  it('fails dot-gates when the manifest is missing a contract array', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    const probe = passingDotProbe();
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      dotProbe: { ...probe, manifestArrays: 4 },
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions['dot-gates'].status).toBe('fail');
    expect(pkg?.dimensions['dot-gates'].evidence.some(e => e.code === 'SCORE_DOT_E001')).toBe(true);
  });

  it('fails dot-gates when fewer than three adapters boot', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    const probe = passingDotProbe();
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      dotProbe: { ...probe, pluginCount: 2 },
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions['dot-gates'].status).toBe('fail');
    expect(pkg?.dimensions['dot-gates'].evidence.some(e => e.code === 'SCORE_DOT_E003')).toBe(true);
  });

  it('fails agent-native-gates when `dot new --dry-run --json` is missing required files', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    const probe = passingDotProbe();
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      dotProbe: { ...probe, newRequiredFilesPresent: ['package.json'] },
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions['dot-gates'].status).toBe('pass');
    expect(pkg?.dimensions['agent-native-gates'].status).toBe('fail');
    expect(pkg?.dimensions['agent-native-gates'].evidence.some(e => e.code === 'SCORE_AGENT_E002')).toBe(true);
  });

  it('fails both gates when the probe itself reports a failure', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      dotProbe: { status: 'fail', reason: 'kv adapter could not boot' },
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions['dot-gates'].status).toBe('fail');
    expect(pkg?.dimensions['dot-gates'].details).toMatch(/kv adapter could not boot/);
    expect(pkg?.dimensions['agent-native-gates'].status).toBe('fail');
  });
});

describe('runScorecard — stable release gate', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-scorecard-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('blocks the gate when any package fails', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp); // clean
    writePkg(tmp, 'date', {
      name: '@arki/date',
      version: '1.0.0',
      type: 'module',
      // No description, no README, no LICENSE, no dist — many dimensions fail.
    });
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(['@arki/assert', '@arki/date']),
      allowDeferred: true, // remove DOT noise to isolate the dimension fails
      npmRunner: makeNpmPackRunner(),
      ...releaseReady(tmp),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    expect(envelope.items).toHaveLength(2);
    expect(envelope.summary.stableReleaseGate).toBe('blocked');
    expect(envelope.summary.stableReleaseBlockers.some(b => b.includes('@arki/date'))).toBe(true);
    expect(envelope.summary.stableReleaseBlockers.some(b => b.includes('@arki/assert'))).toBe(false);
  });

  it('keeps the gate blocked when allow-deferred is false even on otherwise-clean packages', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      allowDeferred: false, // explicit
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    expect(envelope.summary.stableReleaseGate).toBe('blocked');
    // The blocker reason should mention dot-gates / agent-native-gates.
    expect(
      envelope.summary.stableReleaseBlockers.some(
        b => b.includes('dot-gates') || b.includes('agent-native-gates'),
      ),
    ).toBe(true);
  });

  // Why: a public package left out of every wave is never published, and before
  // the admission dimension nothing reported it. It must block the gate by name.
  it('blocks the gate when a public package is in no wave and not in notYet (ADMIT_E001)', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    writePkg(tmp, 'lock', { name: '@arki/lock', version: '0.0.0', private: false });
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(['@arki/assert']),
      allowDeferred: true,
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    const lock = envelope.items.find(i => i.name === '@arki/lock');
    expect(lock?.dimensions.admission.status).toBe('fail');
    expect(lock?.dimensions.admission.evidence.map(e => e.code)).toEqual(['ADMIT_E001']);
    expect(envelope.summary.stableReleaseGate).toBe('blocked');
    expect(envelope.summary.stableReleaseBlockers.some(b => b.includes('@arki/lock'))).toBe(true);
  });

  // Why: `notYet` is the explicit, reasoned way to keep a public package out of
  // a release. Listing it must clear the block without scoring the package.
  it('does not block the gate for a public package listed in notYet', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    writePkg(tmp, 'lock', { name: '@arki/lock', version: '0.0.0', private: false });
    const envelope = await runScorecard({
      cwd: tmp,
      config: { ...makeConfig(['@arki/assert']), notYet: [{ name: '@arki/lock', reason: 'awaiting docs batch' }] },
      allowDeferred: true,
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    expect(envelope.items.map(i => i.name)).toEqual(['@arki/assert']);
    expect(envelope.items[0]?.dimensions.admission.status).toBe('pass');
    expect(envelope.summary.stableReleaseBlockers.some(b => b.includes('@arki/lock'))).toBe(false);
  });
});

describe('runScorecard — edge cases', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-scorecard-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an empty envelope when no public-candidates exist', async () => {
    writeRoot(tmp);
    // Package not in any wave.
    writePkg(tmp, 'private-thing', {
      name: '@arki/private-thing',
      version: '0.1.0',
      private: true,
    });
    const envelope = await runScorecard({
      cwd: tmp,
      config: { ...makeConfig(['@arki/assert']) },
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    expect(envelope.items).toHaveLength(0);
    expect(envelope.errors.some(e => e.code === SCORECARD_ERROR_CODES.noPublicCandidates)).toBe(true);
  });

  it('returns an error when --package matches no inventory item', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      packageName: '@arki/does-not-exist',
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    expect(envelope.status).toBe('failure');
    expect(
      envelope.errors.some(e => e.code === SCORECARD_ERROR_CODES.packageNotInInventory),
    ).toBe(true);
  });
});

describe('renderScorecardText', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-scorecard-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('renders one block per package with explicit PASS/FAIL lines per dimension', async () => {
    writeRoot(tmp);
    writeAssertPackage(tmp);
    const envelope = await runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      skipDotProbe: true,
    });
    const text = renderScorecardText(envelope);
    expect(text).toContain('@arki/assert');
    expect(text).toContain('metadata');
    expect(text).toContain('privacy');
    expect(text).toContain('dependencies');
    expect(text).toContain('build-output');
    expect(text).toContain('packlist');
    expect(text).toContain('docs');
    expect(text).toContain('fixtures');
    expect(text).toContain('dot-gates');
    expect(text).toContain('agent-native-gates');
  });
});

describe('runScorecard — release dimensions', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-scorecard-'));
    writeRoot(tmp);
    writeAssertPackage(tmp);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const run = (overrides: Partial<ScorecardOptions> = {}) =>
    runScorecard({
      cwd: tmp,
      config: makeConfig(),
      npmRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      dotProbe: passingDotProbe(),
      ...overrides,
    });

  it('never passes a release dimension whose input is missing', async () => {
    // Why: offline npm or a missing doc-examples report must block or warn; a silent pass would ship stale docs.
    const envelope = await run();
    const pkg = envelope.items[0];
    expect(pkg?.dimensions['docs-impact'].status).toBe('deferred');
    expect(pkg?.dimensions['docs-fresh'].status).toBe('fail');
    expect(pkg?.dimensions['docs-fresh'].evidence.some(e => e.code === 'FRESH_E002')).toBe(true);
    expect(envelope.errors.some(e => e.code === SCORECARD_ERROR_CODES.npmUnavailable && e.severity === 'warning')).toBe(true);
    expect(envelope.summary.stableReleaseGate).toBe('blocked');
  });

  it('passes docs-impact and demo-impact when the package has nothing to release', async () => {
    // Why: a package already on npm with no pending changeset is not being released, so impact gates must not block it.
    const ready = releaseReady(tmp);
    rmSync(path.join(tmp, '.changeset'), { recursive: true });
    const pack = makeNpmPackRunner();
    const envelope = await run({
      ...ready,
      npmRunner: async (args, options) => (args[0] === 'view' ? { stdout: '["1.0.0"]', stderr: '', code: 0 } : pack(args, options)),
    });
    const pkg = envelope.items[0];
    expect(pkg?.dimensions['docs-impact'].details).toMatch(/nothing to release/);
    expect(pkg?.dimensions['demo-impact'].status).toBe('pass');
  });

  it('surfaces demo registry problems in the envelope errors', async () => {
    // Why: a demo folder that is missing (CI clone) must be visible, not silently treated as "no demo uses this".
    const config: ReleaseConfig = { ...makeConfig(), demos: [{ name: 'shop', repo: 'acme/shop', path: 'demos/shop' }] };
    const envelope = await run({ ...releaseReady(tmp), config });
    expect(envelope.errors.some(e => e.code === 'DEMO_E002')).toBe(true);
  });

  it('reads tiers from config: a Tier 2 leaf gets readiness items and needs bench provenance', async () => {
    // Why: tiers live once in arki.release.config.ts; readiness and bench-fresh must both follow them.
    const config: ReleaseConfig = { ...makeConfig(), tiers: { stack: [], libraries: ['@arki/assert'] } };
    const envelope = await run({ ...releaseReady(tmp), config });
    const pkg = envelope.items[0];
    expect(pkg?.readiness?.tier).toBe(2);
    expect(pkg?.readiness?.items.length).toBeGreaterThan(0);
    expect(pkg?.dimensions['bench-fresh'].evidence[0]?.code).toBe('FRESH_E011');
  });
});

describe('candidate mode: dimensions from the frozen tarball', () => {
  const frozenCandidate = (checks: Candidate['checks']): Candidate => ({
    wave: 'foundation',
    sourceCommit: 'abc',
    createdAt: '2026-10-17T00:00:00.000Z',
    packages: [{ name: '@arki/a', version: '1.0.0', tarball: 'tarballs/a.tgz', sha512: 'x', publishOrder: 1 }],
    checks,
  });
  const complete = {
    name: '@arki/a',
    version: '1.0.0',
    description: 'A.',
    license: 'MIT',
    repository: { url: 'r' },
    homepage: 'h',
    bugs: { url: 'b' },
  };

  it('treats mirror items as n/a for a version the candidate has not published yet', () => {
    // Why: a tag and GitHub Release for the candidate version can only exist after npm publish and sync, so
    // counting them as missing would keep the pre-publish gate closed for every release.
    const passing = { status: 'pass', details: '', evidence: [] } as const;
    const previousSync = { '@arki/a': { 'mirror-tag': 'fail', 'mirror-release': 'fail', 'mirror-security': 'fail', 'mirror-integrity': 'fail' } } as const;
    const gated = readinessExternal('@arki/a', [], passing, false, frozenCandidate({}), previousSync);
    expect([gated['mirror-tag'], gated['mirror-release'], gated['mirror-security'], gated['mirror-integrity']]).toEqual(['n/a', 'n/a', 'n/a', 'n/a']);
    // Outside a candidate the sync plan still decides: a published version without its tag is a real gap.
    const published = readinessExternal('@arki/a', [], passing, false, null, previousSync);
    expect(published['mirror-tag']).toBe('fail');
  });

  it('reads the runtimes item from the run ship recorded on the candidate', () => {
    // Why: nothing else produces `runtimes`, so without this a leaf library could never pass readiness, and a
    // broken runtime smoke (a moved export) would go unnoticed until users hit it.
    const passing = { status: 'pass', details: '', evidence: [] } as const;
    const recorded = (status: 'success' | 'failure') =>
      frozenCandidate({ 'runtimes:@arki/a': { status, at: '2026-10-30T00:00:00.000Z', envelope: { code: status === 'success' ? 0 : 1 } } });
    expect(readinessExternal('@arki/a', [], passing, false, recorded('success'), null)['runtimes']).toBe('pass');
    expect(readinessExternal('@arki/a', [], passing, false, recorded('failure'), null)['runtimes']).toBe('fail');
    expect(readinessExternal('@arki/a', [], passing, false, frozenCandidate({}), null)['runtimes']).toBeUndefined();
  });

  it('fails dependencies when the tarball still carries workspace: or catalog: ranges', () => {
    // Why: npm consumers cannot resolve workspace:/catalog:, so those bytes are uninstallable even if the source tree looks fine.
    const dims = frozenDimensions(
      '@arki/a',
      { files: [], packedSize: 1, manifest: { ...complete, dependencies: { '@arki/b': 'workspace:*', zod: 'catalog:' } } },
      frozenCandidate({}),
    );
    expect(dims.dependencies.status).toBe('fail');
    expect(dims.dependencies.evidence[0]?.code).toBe(SCORECARD_ERROR_CODES.frozenDependency);
    expect(dims.metadata.status).toBe('pass');
  });

  it('warns on metadata the tarball manifest lacks', () => {
    // Why: the npm page is built from the published manifest, not from source.
    const dims = frozenDimensions('@arki/a', { files: [], packedSize: 1, manifest: { name: '@arki/a', version: '1.0.0' } }, frozenCandidate({}));
    expect(dims.metadata.status).toBe('warn');
    expect(dims.metadata.details).toContain('description');
  });

  it('judges fixtures from the smoke run on the frozen tarballs, deferred when smoke never ran', () => {
    // Why: candidate mode must not re-pack; smoke already installed these exact bytes in a clean consumer.
    const manifest = { files: [], packedSize: 1, manifest: complete };
    expect(frozenDimensions('@arki/a', manifest, frozenCandidate({})).fixtures.status).toBe('deferred');
    const smoke = (status: 'pass' | 'fail') => ({
      status: status === 'pass' ? ('success' as const) : ('failure' as const),
      at: 'now',
      envelope: { items: [{ name: '@arki/a', kind: 'library', checks: [{ id: 'node-import', status, detail: 'd' }] }] },
    });
    expect(frozenDimensions('@arki/a', manifest, frozenCandidate({ smoke: smoke('pass') })).fixtures.status).toBe('pass');
    expect(frozenDimensions('@arki/a', manifest, frozenCandidate({ smoke: smoke('fail') })).fixtures.status).toBe('fail');
  });

  it('audits the packlist from the tarball file list', () => {
    // Why: the packlist gate must see what the founder publishes, not a fresh npm pack of the working tree.
    const result = auditFrozenTarball(
      { name: '@arki/a', version: '1.0.0', tarball: 'tarballs/a.tgz', sha512: 'x', publishOrder: 1 },
      { files: [{ path: 'package.json', size: 10, mode: 420 }, { path: 'dist/index.js', size: 20, mode: 420 }], packedSize: 5, manifest: complete },
      '/repo/packages/a',
    );
    expect(result.totals).toEqual({ fileCount: 2, unpackedSize: 30, packedSize: 5 });
  });
});
