/**
 * External fixture matrix — pack each package in the materialized public
 * tree and install it with npm / pnpm / Bun into a throwaway directory
 * OUTSIDE the monorepo, then verify the resulting consumer can import
 * the package both as ESM and via its TypeScript declarations.
 *
 * The goal is to catch publication-shape regressions BEFORE we publish to
 * npm — workspace links that leaked through `workspace:*`, missing
 * compiled artifacts, broken `exports` maps, declaration-resolution
 * issues. Every consumer-shaped check we can run pre-publish lives here.
 *
 * Architecture:
 *
 *   - {@link runFixtureMatrix} is the orchestrator. Pure over an injected
 *     {@link ProcessRunner} so tests can replay synthetic process output
 *     without spawning npm/pnpm/bun.
 *   - {@link defaultProcessRunner} is the production runner; it shells
 *     out to `Bun.spawn`.
 *   - The matrix iterates over (package x packageManager) pairs and
 *     produces one {@link FixtureRun} per pair. Each run executes a
 *     stage pipeline (`pack` -> `workspace-leak-check` -> `install` ->
 *     `import-esm` -> `import-types`). Downstream stages skip when an
 *     upstream stage fails so failures stay local.
 *
 * Stable error codes for envelope use:
 *   - `FIX_E001` — public tree directory not found.
 *   - `FIX_E002` — pack stage failed.
 *   - `FIX_E003` — workspace leak detected in materialized tarball/manifest.
 *   - `FIX_E004` — install stage failed.
 *   - `FIX_E005` — ESM import probe failed.
 *   - `FIX_E006` — TypeScript declaration probe failed.
 *   - `FIX_E007` — fixture's `node_modules/@arki/*` resolves back into the
 *     monorepo (workspace-resolution leak).
 *   - `FIX_E009` — requested package not present in the public tree.
 *   - `FIX_E010` — invalid CLI argument (e.g. unrecognized `--pm` value).
 */

import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import debugFactory from 'debug';

import { createEnvelope } from './json-output';
import type {
  FixtureMatrixSummary,
  FixtureRun,
  FixtureStage,
  FixtureStageName,
  PackageManagerId,
  ReleaseCommandEnvelope,
  ReleaseError,
} from './types';

const debug = debugFactory('arki:release:fixture');

/** Stable error codes emitted by the fixture matrix. */
export const FIXTURE_ERROR_CODES = {
  publicTreeMissing: 'FIX_E001',
  packFailed: 'FIX_E002',
  workspaceLeak: 'FIX_E003',
  installFailed: 'FIX_E004',
  importEsmFailed: 'FIX_E005',
  importTypesFailed: 'FIX_E006',
  workspaceResolutionLeak: 'FIX_E007',
  packageNotInTree: 'FIX_E009',
  invalidCliArgument: 'FIX_E010',
} as const;

/** All package managers the matrix supports, in declaration order. */
export const DEFAULT_PACKAGE_MANAGERS: readonly PackageManagerId[] = ['npm', 'pnpm', 'bun'];

/**
 * Output of a single process invocation. The runner contract returns
 * stdout / stderr as already-decoded strings.
 */
export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Injectable process abstraction. Production uses
 * {@link defaultProcessRunner}; tests pass a fake that returns canned
 * results indexed on `(command, args)`.
 */
export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    opts: { readonly cwd: string },
  ): Promise<ProcessResult>;
}

/**
 * Public options for {@link runFixtureMatrix}.
 */
export interface FixtureOptions {
  /** Workspace root — used by the leak guard to detect parent-tree resolution. */
  readonly rootCwd: string;
  /** Absolute path to the materialized public tree (Task 5 output). */
  readonly publicTreePath: string;
  /** Package manager set to exercise; defaults to all three. */
  readonly packageManagers?: readonly PackageManagerId[];
  /** Limit the matrix to specific package names; defaults to every package in the tree. */
  readonly packageNames?: readonly string[];
  /**
   * When true, the matrix runs pack + workspace-leak-check but skips
   * install onwards (which is slow + flaky on CI). Stages after `pack`
   * and `workspace-leak-check` are marked `skipped`, not `success`.
   */
  readonly skipInstall?: boolean;
  /** Override the temp-dir root (defaults to `os.tmpdir()`). Used by tests. */
  readonly tempRoot?: string;
  /** Injectable process runner; defaults to {@link defaultProcessRunner}. */
  readonly runner?: ProcessRunner;
}

/**
 * Default production runner. Uses `Bun.spawn` so we stay inside the
 * existing runtime contract (the rest of the tool calls `Bun.spawn`).
 */
export const defaultProcessRunner: ProcessRunner = {
  async run(command, args, { cwd }) {
    const proc = Bun.spawn([command, ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
      },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  },
};

/** Truncate stdout/stderr for envelope display — keeps payloads small. */
const STREAM_PREVIEW_LIMIT = 500;

function truncateStream(text: string): string {
  if (text.length <= STREAM_PREVIEW_LIMIT) return text;
  return `${text.slice(0, STREAM_PREVIEW_LIMIT)}\n…[truncated]`;
}

/**
 * Discover every package in the materialized public tree. Returns
 * `{ name, dir }` pairs. Throws if the tree doesn't exist; the caller
 * converts the error into a structured envelope.
 */
async function discoverPublicPackages(
  publicTreePath: string,
): Promise<ReadonlyArray<{ readonly name: string; readonly dir: string }>> {
  const packagesDir = path.join(publicTreePath, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const result: Array<{ readonly name: string; readonly dir: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    const manifestPath = path.join(dir, 'package.json');
    let manifestText: string;
    try {
      manifestText = await readFile(manifestPath, 'utf8');
    } catch (cause) {
      debug('skipping %s — no package.json (%s)', dir, cause);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText) as unknown;
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const name = (parsed as Record<string, unknown>)['name'];
    if (typeof name !== 'string') continue;
    result.push({ name, dir });
  }
  return [...result].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pack a package into a tarball using `npm pack --pack-destination <dir>`.
 * Returns the absolute tarball path on success, or a failure reason.
 */
async function packPackage(
  packageDir: string,
  packDestination: string,
  runner: ProcessRunner,
): Promise<
  | { readonly ok: true; readonly tarballPath: string; readonly stdout: string }
  | { readonly ok: false; readonly reason: string; readonly stdout: string; readonly stderr: string }
> {
  const result = await runner.run(
    'npm',
    ['pack', '--pack-destination', packDestination, '--json'],
    { cwd: packageDir },
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `npm pack exited with code ${result.exitCode.toString()}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  let filename: string | null = null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0];
      if (first !== null && typeof first === 'object') {
        const f = (first as Record<string, unknown>)['filename'];
        if (typeof f === 'string') filename = f;
      }
    }
  } catch {
    // fall through
  }
  if (filename === null) {
    return {
      ok: false,
      reason: 'npm pack --json did not emit a parseable filename',
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return {
    ok: true,
    tarballPath: path.join(packDestination, filename),
    stdout: result.stdout,
  };
}

/**
 * Scan the manifest text + raw bytes of a tarball for unresolved
 * `workspace:` / `catalog:` references. If npm pack already resolved
 * them, the tarball's manifest will be clean. If the materializer failed
 * to resolve, those tokens still appear — fail loudly.
 */
async function workspaceLeakCheck(
  packageDir: string,
  tarballPath: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  try {
    const manifestText = await readFile(path.join(packageDir, 'package.json'), 'utf8');
    const sourceHit = findWorkspaceToken(manifestText);
    if (sourceHit !== null) {
      return {
        ok: false,
        reason: `public-tree package.json still contains "${sourceHit}" — materializer regression`,
      };
    }
  } catch (cause) {
    return {
      ok: false,
      reason: `failed to read public-tree package.json: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  /**
   * Defence-in-depth: scan raw tarball bytes for workspace/catalog tokens.
   *
   * Note: `npm pack` produces gzipped `.tgz` files, so this scan rarely
   * fires in practice — the literal substring `"workspace:"` won't appear
   * in compressed bytes. The PRIMARY verifier is the source-manifest check
   * above (~line 252); this is a belt-and-braces backstop for the
   * uncompressed-tarball edge case (e.g. custom registries that ship raw
   * `.tar`, or a future pack flow that skips compression).
   *
   * If we ever switch to a real tar reader (parsing entries instead of
   * raw bytes), this scan should become an entry-level "did the
   * materializer fail to rewrite this manifest" check on each
   * `package.json` inside the archive.
   */
  try {
    const tarballBytes = await readFile(tarballPath);
    const text = tarballBytes.toString('binary');
    const hit = findWorkspaceToken(text);
    if (hit !== null) {
      return {
        ok: false,
        reason: `tarball bytes contain "${hit}" — unexpected workspace token in packed output`,
      };
    }
  } catch (cause) {
    return {
      ok: false,
      reason: `failed to read tarball bytes: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  return { ok: true };
}

const WORKSPACE_TOKEN_REGEX = /"(workspace:[^"]*|catalog:[^"]*)"/;

function findWorkspaceToken(text: string): string | null {
  const match = WORKSPACE_TOKEN_REGEX.exec(text);
  return match ? match[1] ?? null : null;
}

/**
 * Build the per-package fixture directory: a tiny consumer manifest plus
 * the probe files used by `import-esm` and `import-types`.
 */
async function scaffoldFixtureDir(
  fixtureDir: string,
  packageName: string,
  pm: PackageManagerId,
): Promise<void> {
  await mkdir(fixtureDir, { recursive: true });
  const manifest = {
    name: `fixture-${sanitizeForName(packageName)}-${pm}`,
    version: '0.0.0',
    private: true,
    type: 'module' as const,
  };
  await writeFile(
    path.join(fixtureDir, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const esmProbe = [
    `import * as pkg from ${JSON.stringify(packageName)};`,
    'process.stdout.write(JSON.stringify(Object.keys(pkg)));',
    '',
  ].join('\n');
  await writeFile(path.join(fixtureDir, 'import-check.mjs'), esmProbe, 'utf8');

  const tsProbe = [
    `import * as pkg from ${JSON.stringify(packageName)};`,
    'const _: unknown = pkg;',
    'void _;',
    '',
  ].join('\n');
  await writeFile(path.join(fixtureDir, 'tsc-check.ts'), tsProbe, 'utf8');

  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['tsc-check.ts'],
  };
  await writeFile(
    path.join(fixtureDir, 'tsconfig.json'),
    `${JSON.stringify(tsconfig, null, 2)}\n`,
    'utf8',
  );
}

/** Filesystem-safe slug for use in a fixture dir name. */
function sanitizeForName(packageName: string): string {
  return packageName.replace(/[@/]/g, '_');
}

/**
 * Install the tarball into the fixture dir using the requested PM.
 */
async function installTarball(
  fixtureDir: string,
  tarballPath: string,
  pm: PackageManagerId,
  runner: ProcessRunner,
): Promise<ProcessResult> {
  if (pm === 'npm') {
    return runner.run('npm', ['install', '--no-audit', '--no-fund', tarballPath], {
      cwd: fixtureDir,
    });
  }
  if (pm === 'pnpm') {
    return runner.run('pnpm', ['add', tarballPath], { cwd: fixtureDir });
  }
  return runner.run('bun', ['add', tarballPath], { cwd: fixtureDir });
}

/**
 * Run the ESM import probe. Success = exit 0 AND stdout parses as a
 * JSON string[] (the `Object.keys(pkg)` output).
 */
async function probeEsmImport(
  fixtureDir: string,
  runner: ProcessRunner,
): Promise<
  | { readonly ok: true; readonly exportCount: number; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly reason: string; readonly stdout: string; readonly stderr: string }
> {
  const result = await runner.run('node', ['import-check.mjs'], { cwd: fixtureDir });
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `node import-check.mjs exited with code ${result.exitCode.toString()}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim()) as unknown;
  } catch (cause) {
    return {
      ok: false,
      reason: `import probe stdout is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  if (!Array.isArray(parsed) || !parsed.every((v): v is string => typeof v === 'string')) {
    return {
      ok: false,
      reason: 'import probe stdout is not a string[] (Object.keys output)',
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return {
    ok: true,
    exportCount: parsed.length,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Run the TypeScript declaration probe.
 */
async function probeTypeScriptDeclarations(
  fixtureDir: string,
  pm: PackageManagerId,
  runner: ProcessRunner,
): Promise<
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly reason: string; readonly stdout: string; readonly stderr: string }
> {
  const command = pm === 'bun' ? 'bunx' : 'npx';
  const result = await runner.run(command, ['tsc', '--noEmit', '-p', 'tsconfig.json'], {
    cwd: fixtureDir,
  });
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `tsc exited with code ${result.exitCode.toString()}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return { ok: true, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Post-install guard: verify no symlink under
 * `<fixtureDir>/node_modules/@arki/*` points back into the monorepo's
 * `packages/*` directory. If it does, the package manager resolved the
 * tarball via workspace linking and the fixture is corrupted.
 */
async function workspaceResolutionGuard(
  fixtureDir: string,
  rootCwd: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const arkiDir = path.join(fixtureDir, 'node_modules', '@arki');
  let entries;
  try {
    entries = await readdir(arkiDir, { withFileTypes: true });
  } catch {
    return { ok: true };
  }
  // Resolve rootCwd through any symlinks (macOS `/tmp` → `/private/tmp`).
  // The guard needs to compare canonical paths or it returns false negatives
  // when both the fixture and the monorepo sit under a symlinked tmpdir.
  let rootReal: string;
  try {
    rootReal = await realpath(rootCwd);
  } catch {
    rootReal = rootCwd;
  }
  // Also resolve the monorepo's `packages/` dir specifically — that's the
  // surface a workspace link would point at. We compare against `<root>/packages`
  // (canonicalized) because legitimate fixture installs live inside the
  // tmpdir tree, which may be a sibling of the monorepo root on disk.
  const rootPackagesReal = path.join(rootReal, 'packages');
  for (const entry of entries) {
    const childPath = path.join(arkiDir, entry.name);
    let resolved: string;
    try {
      resolved = await realpath(childPath);
    } catch {
      continue;
    }
    // A workspace leak is specifically: realpath resolves into the
    // monorepo's `packages/` tree. We don't compare against rootCwd as
    // a whole because the test fixture itself lives under the same
    // tmpdir root in unit tests.
    const relativeToPackages = path.relative(rootPackagesReal, resolved);
    if (
      !relativeToPackages.startsWith('..') &&
      !path.isAbsolute(relativeToPackages)
    ) {
      return {
        ok: false,
        reason: `node_modules/@arki/${entry.name} resolves into the monorepo at ${resolved}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Execute the full pipeline for a single (package, packageManager) pair.
 */
async function runSingleFixture(opts: {
  readonly packageName: string;
  readonly packageDir: string;
  readonly packageManager: PackageManagerId;
  readonly tempRoot: string;
  readonly rootCwd: string;
  readonly skipInstall: boolean;
  readonly runner: ProcessRunner;
}): Promise<FixtureRun> {
  const stages: FixtureStage[] = [];
  const errors: ReleaseError[] = [];
  const slug = sanitizeForName(opts.packageName);
  const packDestination = path.join(opts.tempRoot, `pack-${slug}-${opts.packageManager}`);
  await mkdir(packDestination, { recursive: true });
  const fixtureDir = path.join(opts.tempRoot, `fixture-${slug}-${opts.packageManager}`);

  // Stage 1: pack
  const packStart = Date.now();
  const packResult = await packPackage(opts.packageDir, packDestination, opts.runner);
  const packDuration = Date.now() - packStart;
  let tarballPath = '';

  if (!packResult.ok) {
    stages.push({
      name: 'pack',
      status: 'failure',
      durationMs: packDuration,
      reason: packResult.reason,
      stdout: truncateStream(packResult.stdout),
      stderr: truncateStream(packResult.stderr),
    });
    errors.push({
      code: FIXTURE_ERROR_CODES.packFailed,
      severity: 'error',
      message: `${opts.packageName} (${opts.packageManager}): pack failed — ${packResult.reason}`,
      target: opts.packageName,
      remediation: 'Inspect the public tree manifest and re-run `bun release:arki export-public`.',
    });
    return buildRun({
      packageName: opts.packageName,
      packageManager: opts.packageManager,
      tarballPath,
      fixtureDir,
      stages: appendSkipped(stages, ['workspace-leak-check', 'install', 'import-esm', 'import-types']),
      errors,
    });
  }
  tarballPath = packResult.tarballPath;
  stages.push({
    name: 'pack',
    status: 'success',
    durationMs: packDuration,
    stdout: truncateStream(packResult.stdout),
  });

  // Stage 2: workspace leak check
  const leakStart = Date.now();
  const leakResult = await workspaceLeakCheck(opts.packageDir, tarballPath);
  const leakDuration = Date.now() - leakStart;
  if (!leakResult.ok) {
    stages.push({
      name: 'workspace-leak-check',
      status: 'failure',
      durationMs: leakDuration,
      reason: leakResult.reason,
    });
    errors.push({
      code: FIXTURE_ERROR_CODES.workspaceLeak,
      severity: 'error',
      message: `${opts.packageName} (${opts.packageManager}): workspace leak — ${leakResult.reason}`,
      target: opts.packageName,
      remediation: 'The materializer must resolve every workspace:/catalog: token before export.',
    });
    return buildRun({
      packageName: opts.packageName,
      packageManager: opts.packageManager,
      tarballPath,
      fixtureDir,
      stages: appendSkipped(stages, ['install', 'import-esm', 'import-types']),
      errors,
    });
  }
  stages.push({
    name: 'workspace-leak-check',
    status: 'success',
    durationMs: leakDuration,
  });

  // Stage 3: install (skippable via --skip-install)
  if (opts.skipInstall) {
    stages.push(
      { name: 'install', status: 'skipped', durationMs: 0, reason: '--skip-install requested' },
      { name: 'import-esm', status: 'skipped', durationMs: 0, reason: 'install skipped' },
      { name: 'import-types', status: 'skipped', durationMs: 0, reason: 'install skipped' },
    );
    return buildRun({
      packageName: opts.packageName,
      packageManager: opts.packageManager,
      tarballPath,
      fixtureDir,
      stages,
      errors,
    });
  }

  await scaffoldFixtureDir(fixtureDir, opts.packageName, opts.packageManager);
  const installStart = Date.now();
  const installResult = await installTarball(
    fixtureDir,
    tarballPath,
    opts.packageManager,
    opts.runner,
  );
  const installDuration = Date.now() - installStart;
  if (installResult.exitCode !== 0) {
    stages.push({
      name: 'install',
      status: 'failure',
      durationMs: installDuration,
      reason: `${opts.packageManager} install exited with code ${installResult.exitCode.toString()}`,
      stdout: truncateStream(installResult.stdout),
      stderr: truncateStream(installResult.stderr),
    });
    errors.push({
      code: FIXTURE_ERROR_CODES.installFailed,
      severity: 'error',
      message: `${opts.packageName} (${opts.packageManager}): install failed (exit ${installResult.exitCode.toString()})`,
      target: opts.packageName,
      remediation: `Run the corresponding ${opts.packageManager} install in a scratch dir to reproduce.`,
    });
    return buildRun({
      packageName: opts.packageName,
      packageManager: opts.packageManager,
      tarballPath,
      fixtureDir,
      stages: appendSkipped(stages, ['import-esm', 'import-types']),
      errors,
    });
  }
  stages.push({
    name: 'install',
    status: 'success',
    durationMs: installDuration,
    stdout: truncateStream(installResult.stdout),
  });

  const guard = await workspaceResolutionGuard(fixtureDir, opts.rootCwd);
  if (!guard.ok) {
    errors.push({
      code: FIXTURE_ERROR_CODES.workspaceResolutionLeak,
      severity: 'error',
      message: `${opts.packageName} (${opts.packageManager}): workspace resolution leak — ${guard.reason}`,
      target: opts.packageName,
      remediation:
        'The fixture is resolving the tarball via parent monorepo links. Confirm the fixture dir lives outside the workspace root.',
    });
    return buildRun({
      packageName: opts.packageName,
      packageManager: opts.packageManager,
      tarballPath,
      fixtureDir,
      stages: appendSkipped(stages, ['import-esm', 'import-types']),
      errors,
    });
  }

  // Stage 4: ESM import probe
  const esmStart = Date.now();
  const esmResult = await probeEsmImport(fixtureDir, opts.runner);
  const esmDuration = Date.now() - esmStart;
  if (!esmResult.ok) {
    stages.push({
      name: 'import-esm',
      status: 'failure',
      durationMs: esmDuration,
      reason: esmResult.reason,
      stdout: truncateStream(esmResult.stdout),
      stderr: truncateStream(esmResult.stderr),
    });
    errors.push({
      code: FIXTURE_ERROR_CODES.importEsmFailed,
      severity: 'error',
      message: `${opts.packageName} (${opts.packageManager}): ESM import probe failed — ${esmResult.reason}`,
      target: opts.packageName,
      remediation: 'Verify the package `exports` map and that compiled ESM artifacts ship.',
    });
    return buildRun({
      packageName: opts.packageName,
      packageManager: opts.packageManager,
      tarballPath,
      fixtureDir,
      stages: appendSkipped(stages, ['import-types']),
      errors,
    });
  }
  stages.push({
    name: 'import-esm',
    status: 'success',
    durationMs: esmDuration,
    stdout: truncateStream(esmResult.stdout),
    reason: `${esmResult.exportCount.toString()} exports`,
  });

  // Stage 5: TS declaration probe
  const tsStart = Date.now();
  const tsResult = await probeTypeScriptDeclarations(fixtureDir, opts.packageManager, opts.runner);
  const tsDuration = Date.now() - tsStart;
  if (!tsResult.ok) {
    stages.push({
      name: 'import-types',
      status: 'failure',
      durationMs: tsDuration,
      reason: tsResult.reason,
      stdout: truncateStream(tsResult.stdout),
      stderr: truncateStream(tsResult.stderr),
    });
    errors.push({
      code: FIXTURE_ERROR_CODES.importTypesFailed,
      severity: 'error',
      message: `${opts.packageName} (${opts.packageManager}): TS declaration probe failed — ${tsResult.reason}`,
      target: opts.packageName,
      remediation: 'Verify the package ships `.d.ts` and the `types` / `exports.types` map points at it.',
    });
    return buildRun({
      packageName: opts.packageName,
      packageManager: opts.packageManager,
      tarballPath,
      fixtureDir,
      stages,
      errors,
    });
  }
  stages.push({
    name: 'import-types',
    status: 'success',
    durationMs: tsDuration,
  });

  return buildRun({
    packageName: opts.packageName,
    packageManager: opts.packageManager,
    tarballPath,
    fixtureDir,
    stages,
    errors,
  });
}

/** Append `skipped` stages so the envelope shows every pipeline slot. */
function appendSkipped(
  stages: readonly FixtureStage[],
  names: readonly FixtureStageName[],
): readonly FixtureStage[] {
  const additions: FixtureStage[] = names.map(name => ({
    name,
    status: 'skipped',
    durationMs: 0,
    reason: 'upstream stage failed',
  }));
  return [...stages, ...additions];
}

/** Compose a {@link FixtureRun} from collected stage + error data. */
function buildRun(opts: {
  readonly packageName: string;
  readonly packageManager: PackageManagerId;
  readonly tarballPath: string;
  readonly fixtureDir: string;
  readonly stages: readonly FixtureStage[];
  readonly errors: readonly ReleaseError[];
  readonly skipReason?: string;
}): FixtureRun {
  const hasFailure = opts.stages.some(s => s.status === 'failure');
  const allSkipped = opts.stages.every(s => s.status === 'skipped');
  const status = hasFailure ? 'failure' : allSkipped ? 'skipped' : 'success';
  return {
    packageName: opts.packageName,
    packageManager: opts.packageManager,
    tarballPath: opts.tarballPath,
    fixtureDir: opts.fixtureDir,
    status,
    stages: opts.stages,
    errors: opts.errors,
    ...(opts.skipReason !== undefined ? { skipReason: opts.skipReason } : {}),
  };
}

/**
 * Main entrypoint — run the full fixture matrix.
 */
export async function runFixtureMatrix(
  options: FixtureOptions,
): Promise<ReleaseCommandEnvelope<FixtureRun, FixtureMatrixSummary>> {
  const pms = options.packageManagers ?? DEFAULT_PACKAGE_MANAGERS;
  const runner = options.runner ?? defaultProcessRunner;
  const skipInstall = options.skipInstall === true;
  const callerOwnsTempRoot = options.tempRoot !== undefined;
  const tempRoot =
    options.tempRoot ?? path.join(os.tmpdir(), `arki-fixture-${Date.now().toString()}`);

  debug(
    'runFixtureMatrix: publicTreePath=%s pms=%o skipInstall=%s',
    options.publicTreePath,
    pms,
    skipInstall,
  );

  if (!callerOwnsTempRoot) {
    await mkdir(tempRoot, { recursive: true });
  }

  let discovered: ReadonlyArray<{ readonly name: string; readonly dir: string }>;
  try {
    discovered = await discoverPublicPackages(options.publicTreePath);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return createEnvelope<FixtureRun, FixtureMatrixSummary>({
      command: 'fixture',
      status: 'failure',
      summary: {
        message: `Public tree not found at ${options.publicTreePath}: ${message}`,
        totalRuns: 0,
        successCount: 0,
        failureCount: 0,
        skippedCount: 0,
        publicTreePath: options.publicTreePath,
      },
      items: [],
      errors: [
        {
          code: FIXTURE_ERROR_CODES.publicTreeMissing,
          severity: 'error',
          message: `Public tree directory not found at ${options.publicTreePath}.`,
          target: options.publicTreePath,
          remediation: 'Run `bun release:arki export-public` first to materialize the tree.',
        },
      ],
    });
  }

  const requested = options.packageNames;
  const errors: ReleaseError[] = [];
  let selected: ReadonlyArray<{ readonly name: string; readonly dir: string }>;
  if (requested !== undefined && requested.length > 0) {
    const found = new Map(discovered.map(p => [p.name, p]));
    const matches: Array<{ readonly name: string; readonly dir: string }> = [];
    for (const requestedName of requested) {
      const hit = found.get(requestedName);
      if (hit !== undefined) {
        matches.push(hit);
      } else {
        errors.push({
          code: FIXTURE_ERROR_CODES.packageNotInTree,
          severity: 'error',
          message: `Requested package "${requestedName}" is not present in the public tree.`,
          target: requestedName,
          remediation: 'Run `bun release:arki inventory --json` to see published packages.',
        });
      }
    }
    selected = matches;
  } else {
    selected = discovered;
  }

  const runs: FixtureRun[] = [];
  for (const pkg of selected) {
    for (const pm of pms) {
      const run = await runSingleFixture({
        packageName: pkg.name,
        packageDir: pkg.dir,
        packageManager: pm,
        tempRoot,
        rootCwd: options.rootCwd,
        skipInstall,
        runner,
      });
      runs.push(run);
      for (const err of run.errors) {
        errors.push(err);
      }
    }
  }

  if (!callerOwnsTempRoot) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch (cause) {
      debug('failed to clean tempRoot %s: %s', tempRoot, cause);
    }
  }

  const successCount = runs.filter(r => r.status === 'success').length;
  const failureCount = runs.filter(r => r.status === 'failure').length;
  const skippedCount = runs.filter(r => r.status === 'skipped').length;
  const status: 'success' | 'failure' =
    errors.some(e => e.severity === 'error') || failureCount > 0 ? 'failure' : 'success';

  const summary: FixtureMatrixSummary = {
    message:
      failureCount === 0 && !errors.some(e => e.severity === 'error')
        ? `Fixture matrix: ${successCount.toString()} successful runs, ${skippedCount.toString()} skipped.`
        : `Fixture matrix: ${failureCount.toString()} failures across ${runs.length.toString()} runs.`,
    totalRuns: runs.length,
    successCount,
    failureCount,
    skippedCount,
    publicTreePath: options.publicTreePath,
  };

  return createEnvelope<FixtureRun, FixtureMatrixSummary>({
    command: 'fixture',
    status,
    summary,
    items: runs,
    errors,
  });
}

