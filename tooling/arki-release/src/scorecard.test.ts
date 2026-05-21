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

import type { NpmPackRunner } from './pack';
import { renderScorecardText, runScorecard, SCORECARD_ERROR_CODES } from './scorecard';
import type { DotProbeOk, ReleaseConfig } from './types';
import type { ProcessResult, ProcessRunner } from './fixture';

/**
 * Synthetic passing DOT probe for tests that want to exercise the gate
 * evaluators. Returns the narrow `DotProbeOk` shape so tests can spread it
 * and override individual fields (`{ ...passingDotProbe(), pipCount: 2 }`)
 * without TypeScript losing the discriminant.
 */
function passingDotProbe(): DotProbeOk {
  return {
    status: 'pass',
    pipCount: 3,
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
    `${JSON.stringify({ name: 'arki', version: '0.0.0', private: true }, null, 2)}\n`,
  );
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
} = {}): NpmPackRunner {
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: runner,
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
      fixtureRunner: makeFixtureRunner(),
      fixtureTempRoot: path.join(tmp, 'fixture-temp'),
      dotProbe: { ...probe, pipCount: 2 },
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
      npmPackRunner: makeNpmPackRunner(),
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
