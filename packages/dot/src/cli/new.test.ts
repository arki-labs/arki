/**
 * Tests for `dot new`.
 *
 * Covers planning (dry-run JSON envelope shape), exact file-list contract,
 * deterministic content hashes, writing to disk, refusal-to-overwrite,
 * `--force` semantics, app-name validation, and a smoke test that the
 * generated `app.ts` parses + imports.
 *
 * No `npm install` is ever executed; integration with adapter packages
 * is exercised through the existing in-repo `@arki/dot/env` adapter.
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Failure } from '@arki/failure';
import { isFailure } from '@arki/failure';

import type { DotNewResult } from './json.js';
import type { NewPlan, RunNewOptions } from './new.js';
import { sha256 } from './files.js';
import { program } from './index.js';
import {
  DEFAULT_TEMPLATE,
  planOperations,
  resolveTargetDir,
  resolveTemplateName,
  runNew,
  validateAppName,
} from './new.js';
import { readDotVersion, TEMPLATE_VERSIONS, ZOD_VERSION } from './versions.js';

const join = (...segments: string[]): string => path.join(...segments);
const resolve = (...segments: string[]): string => path.resolve(...segments);

const TEMPLATE_ROOT = resolve(__dirname, '..', '..', 'templates', 'app-minimal');

const EXPECTED_FILES = [
  '.gitignore',
  'AGENTS.md',
  'README.md',
  'package.json',
  'src/app.ts',
  'src/env.ts',
  'tests/boot.test.ts',
  'tsconfig.json',
] as const;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dot-new-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** The plan, for cases that expect one: a failure throws with its code. */
async function plan(opts: RunNewOptions): Promise<NewPlan> {
  const planned = await planOperations(opts);
  if (isFailure(planned)) throw unexpected(planned);
  return planned;
}

function unexpected(failure: Failure): Error {
  return new Error(`expected success, got ${failure.code}: ${failure.message}`);
}

/** The scaffold result, for cases that expect one: a failure throws with its code. */
async function scaffold(opts: RunNewOptions): Promise<DotNewResult> {
  const result = await runNew(opts);
  if (isFailure(result)) throw unexpected(result);
  return result;
}

/** Run `dot` through `program.main`, as the bin would with stdout piped. */
async function dot(argv: string[], options: { tty?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  const code = await program.main(argv, {
    stdout: text => {
      stdout += text;
    },
    stderr: text => {
      stderr += text;
    },
    tty: options.tty ?? false,
  });
  return { code, stdout, stderr };
}

describe('validateAppName', () => {
  it('accepts simple lower-case names', () => {
    expect(validateAppName('my-app')).toBeUndefined();
    expect(validateAppName('app123')).toBeUndefined();
    expect(validateAppName('a.b.c')).toBeUndefined();
  });

  it('rejects names with spaces, capitals, or leading punctuation', () => {
    expect(validateAppName('My App')).toMatch(/invalid/i);
    expect(validateAppName('MyApp')).toMatch(/invalid/i);
    expect(validateAppName('-leading-hyphen')).toMatch(/invalid/i);
    expect(validateAppName('@scope/name')).toMatch(/invalid/i);
  });

  it('rejects empty name', () => {
    expect(validateAppName('')).toMatch(/required/i);
  });
});

describe('resolveTargetDir', () => {
  it('defaults target dir to <name> under cwd', () => {
    expect(resolveTargetDir({ name: 'my-app', cwd: '/tmp/work' })).toBe('/tmp/work/my-app');
  });

  it('respects explicit --target', () => {
    expect(resolveTargetDir({ name: 'my-app', cwd: '/tmp/work', target: 'subdir' })).toBe('/tmp/work/subdir');
  });

  it('resolves absolute --target as-is', () => {
    expect(resolveTargetDir({ name: 'my-app', cwd: '/tmp/work', target: '/other/place' })).toBe('/other/place');
  });
});

describe('planOperations', () => {
  it('plans exactly the expected file set', async () => {
    const { operations, target } = await plan({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    expect(target).toBe(join(workDir, 'fixture'));
    expect(operations.map(op => op.path)).toEqual([...EXPECTED_FILES]);
  });

  it('marks all files as `create` when target dir is empty', async () => {
    const { operations } = await plan({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    for (const op of operations) {
      expect(op.action).toBe('create');
    }
  });

  it('produces deterministic content hashes for the same input', async () => {
    const planA = await plan({ name: 'fixture', cwd: workDir, templateRoot: TEMPLATE_ROOT });
    const planB = await plan({ name: 'fixture', cwd: workDir, templateRoot: TEMPLATE_ROOT });

    for (let i = 0; i < planA.operations.length; i++) {
      expect(planA.operations[i]!.contentHash).toBe(planB.operations[i]!.contentHash);
      expect(planA.operations[i]!.contentBytes).toBe(planB.operations[i]!.contentBytes);
    }
  });

  it('changes content hash when name changes', async () => {
    const planA = await plan({ name: 'alpha', cwd: workDir, templateRoot: TEMPLATE_ROOT });
    const planB = await plan({ name: 'beta', cwd: workDir, templateRoot: TEMPLATE_ROOT });

    const pkgA = planA.operations.find(op => op.path === 'package.json')!;
    const pkgB = planB.operations.find(op => op.path === 'package.json')!;
    expect(pkgA.contentHash).not.toBe(pkgB.contentHash);
  });

  it('attaches a human-readable reason to every operation', async () => {
    const { operations } = await plan({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    for (const op of operations) {
      expect(op.reason.length).toBeGreaterThan(0);
    }
    const agents = operations.find(op => op.path === 'AGENTS.md')!;
    expect(agents.reason.toLowerCase()).toContain('agent');
  });

  it('marks pre-existing files as `skip` without --force', async () => {
    const target = join(workDir, 'fixture');
    await writeFile(join(workDir, 'fixture-stub'), 'placeholder');
    // Create target dir with a conflicting file.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'package.json'), '{}');

    const { operations } = await plan({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    const pkg = operations.find(op => op.path === 'package.json')!;
    expect(pkg.action).toBe('skip');
  });

  it('marks pre-existing files as `overwrite` with --force', async () => {
    const target = join(workDir, 'fixture');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'package.json'), '{}');

    const { operations } = await plan({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      force: true,
    });

    const pkg = operations.find(op => op.path === 'package.json')!;
    expect(pkg.action).toBe('overwrite');
  });
});

describe('runNew (dry-run JSON)', () => {
  it('emits a well-formed envelope with all required fields', async () => {
    const envelope = await scaffold({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      template: 'minimal',
      dryRun: true,
    });

    expect(envelope.app).toEqual({ name: 'fixture', target: join(workDir, 'fixture') });
    expect(envelope.operations).toHaveLength(EXPECTED_FILES.length);
    expect(envelope.nextSteps).toEqual(['cd fixture', 'bun install', 'bun run test']);
  });

  it('does not write any files in dry-run', async () => {
    await scaffold({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      dryRun: true,
    });

    const target = join(workDir, 'fixture');
    await expect(stat(target)).rejects.toThrow();
  });

  it('matches the exact file-list snapshot', async () => {
    const envelope = await scaffold({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      dryRun: true,
    });

    const paths = envelope.operations.map(op => op.path);
    expect(paths).toMatchInlineSnapshot(`
      [
        ".gitignore",
        "AGENTS.md",
        "README.md",
        "package.json",
        "src/app.ts",
        "src/env.ts",
        "tests/boot.test.ts",
        "tsconfig.json",
      ]
    `);
  });

  it('prints one arki.cli/1 envelope on stdout when piped, with no --json', async () => {
    const { code, stdout } = await dot(['new', 'fixture', '--template', 'minimal', '--dry-run', '--cwd', workDir]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; command: string[]; meta: { schema: string; dryRun: boolean } };
    expect(parsed).toMatchObject({ ok: true, command: ['new'], meta: { schema: 'arki.cli/1', dryRun: true } });
  });
});

describe('runNew (real run)', () => {
  it('writes every planned file to disk', async () => {
    await scaffold({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    const target = join(workDir, 'fixture');
    const entries = await readdir(target, { recursive: true });
    // Filter to relative paths only; readdir(recursive) returns nested files
    // relative to target.
    const files = entries.filter(e => !e.startsWith('.cache')); // defensive
    // We expect at least the EXPECTED_FILES set to be present.
    for (const expected of EXPECTED_FILES) {
      // Normalise platform separators for the test assertion.
      const candidate = expected.replaceAll('/', path.sep);
      expect(files).toContain(candidate);
    }
  });

  it('written file contents match the planned contentHash', async () => {
    const envelope = await scaffold({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    const target = join(workDir, 'fixture');
    for (const op of envelope.operations) {
      const actual = await readFile(join(target, op.path), 'utf-8');
      expect(sha256(actual)).toBe(op.contentHash);
    }
  });

  it('refuses to overwrite an existing file without --force', async () => {
    const target = join(workDir, 'fixture');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'package.json'), '{"existing": true}');
    const result = await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    expect(result).toMatchObject({
      code: 'dot.target_not_empty',
      data: { target, conflicting: ['package.json'] },
    });

    // The existing file should be untouched.
    const after = await readFile(join(target, 'package.json'), 'utf-8');
    expect(after).toBe('{"existing": true}');
  });

  it('returns dot.template_missing when the template folder has no files', async () => {
    const { mkdir } = await import('node:fs/promises');
    const emptyTemplate = join(workDir, 'empty-template');
    await mkdir(emptyTemplate, { recursive: true });
    const result = await runNew({ name: 'fixture', cwd: workDir, templateRoot: emptyTemplate });

    expect(result).toMatchObject({ code: 'dot.template_missing', data: { templateRoot: emptyTemplate } });
    await expect(stat(join(workDir, 'fixture'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns dot.write_failed, listing what failed and what was written, when a path is blocked', async () => {
    const target = join(workDir, 'fixture');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target, { recursive: true });
    // A file named `src` blocks the directory `src/` the template needs.
    await writeFile(join(target, 'src'), 'in the way');
    const result = await runNew({ name: 'fixture', cwd: workDir, templateRoot: TEMPLATE_ROOT, force: true });

    expect(result).toMatchObject({ code: 'dot.write_failed', data: { target } });
    if (!isFailure(result)) throw new Error('expected dot.write_failed');
    const failedPaths = (result.data as { failed: { path: string }[] }).failed.map(entry => entry.path);
    expect(failedPaths).toContain('src/app.ts');
    expect(failedPaths).not.toContain('package.json');
    expect(await readFile(join(target, 'package.json'), 'utf-8')).toContain('"name": "fixture"');
  });

  it('overwrites existing files with --force', async () => {
    const target = join(workDir, 'fixture');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'package.json'), '{"existing": true}');
    await scaffold({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      force: true,
    });

    const after = await readFile(join(target, 'package.json'), 'utf-8');
    expect(after).not.toBe('{"existing": true}');
    expect(after).toContain('"name": "fixture"');
  });

  it('rejects invalid app names with cli.invalid_input, the code the CLI gives', async () => {
    const result = await runNew({
      name: 'Invalid Name With Spaces',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    expect(result).toMatchObject({ code: 'cli.invalid_input', data: { issues: [{ path: ['name'] }] } });
  });

  it('prints text progress on a terminal', async () => {
    const { code, stdout, stderr } = await dot(['new', 'fixture', '--template', 'minimal', '--cwd', workDir], {
      tty: true,
    });

    expect(code).toBe(0);
    expect(stderr).toContain('Scaffolded');
    expect(stdout).toContain('Next steps:');
    expect(stdout).toContain('bun install');
  });
});

describe('generated app content', () => {
  it('package.json declares the chosen name and required deps', async () => {
    await scaffold({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    const pkgRaw = await readFile(join(workDir, 'fixture', 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    expect(pkg.name).toBe('fixture');
    expect(pkg.dependencies['@arki/dot']).toBeDefined();
    expect(pkg.dependencies['@arki/env']).toBeDefined();
    expect(pkg.dependencies.zod).toBeDefined();
    expect(pkg.scripts.typecheck).toBeDefined();
    expect(pkg.scripts.test).toBeDefined();
  });

  it('AGENTS.md documents verification commands and boundaries', async () => {
    await scaffold({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    const agents = await readFile(join(workDir, 'fixture', 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# Agent Guidance — fixture');
    expect(agents.toLowerCase()).toContain('verification commands');
    expect(agents.toLowerCase()).toContain('public / private boundaries');
    expect(agents.toLowerCase()).toContain('dot artifact locations');
    expect(agents).toContain('bunx dot explain --json');
    expect(agents).toContain('bunx dot doctor --json');
    expect(agents).not.toContain('TODO');
  });

  it('src/app.ts uses defineApp and boots without TODOs', async () => {
    await scaffold({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    const appTs = await readFile(join(workDir, 'fixture', 'src', 'app.ts'), 'utf-8');
    expect(appTs).toContain("defineApp('fixture')");
    expect(appTs).toContain('@arki/dot');
    expect(appTs).toContain('@arki/dot/env');
    expect(appTs).not.toContain('TODO');
  });

  it('package manager flag flows into the README and AGENTS.md', async () => {
    await scaffold({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      pm: 'pnpm',
    });

    const readme = await readFile(join(workDir, 'fixture', 'README.md'), 'utf-8');
    expect(readme).toContain('pnpm install');
    expect(readme).toContain('pnpm run test');
    const agents = await readFile(join(workDir, 'fixture', 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('pnpm run typecheck');
  });
});

describe('generated app boots', () => {
  it('the generated app.ts boots via bun and reports a `booted` manifest', async () => {
    // Use a scratch dir UNDER the workspace so the generated `app.ts`
    // can resolve `@arki/dot` and `@arki/dot/env` via the workspace's
    // node_modules. A tmpdir() outside the workspace has no module
    // resolution path back to the installed adapters.
    const workspaceRoot = resolve(__dirname, '..', '..', '..', '..');
    const bootRoot = join(workspaceRoot, 'packages', 'dot', '.cache', `boot-${Date.now()}`);
    const { mkdir: mkdirBoot } = await import('node:fs/promises');
    await mkdirBoot(bootRoot, { recursive: true });
    await scaffold({
      name: 'fixture',
      cwd: bootRoot,
      templateRoot: TEMPLATE_ROOT,
    });

    const appDir = join(bootRoot, 'fixture');
    // Patch the generated app.ts to point at `./env.ts` instead of
    // `./env.js` so the bun loader resolves it without a build step.
    const appSource = await readFile(join(appDir, 'src', 'app.ts'), 'utf-8');
    await writeFile(
      join(appDir, 'src', 'app.ts'),
      appSource.replaceAll("from './env.js'", "from './env.ts'").replaceAll('from "./env.js"', 'from "./env.ts"'),
      'utf-8',
    );

    // Harness lives next to the generated app (also under the
    // workspace) so its imports resolve through workspace node_modules.
    const harnessPath = join(bootRoot, 'harness.mjs');
    const harness = `
      const mod = await import(${JSON.stringify(join(appDir, 'src', 'app.ts'))});
      const booted = await mod.app.boot();
      const out = {
        state: booted.state,
        services: Object.keys(booted.services),
        manifestServices: booted.manifest.services.map((s) => s.name),
      };
      process.stdout.write(JSON.stringify(out));
    `;
    await writeFile(harnessPath, harness, 'utf-8');

    const { spawn } = await import('node:child_process');
    const child = spawn('bun', ['run', harnessPath], {
      cwd: workspaceRoot,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    const code: number = await new Promise(resolveDone => {
      child.on('close', c => resolveDone(c ?? 0));
    });
    expect(code, `bun exited ${code}; stderr=${stderr}`).toBe(0);

    const parsed = JSON.parse(stdout) as {
      state: string;
      services: string[];
      manifestServices: string[];
    };
    expect(parsed.state).toBe('booted');
    expect(parsed.services).toContain('env');
    expect(parsed.manifestServices).toContain('env');

    await rm(bootRoot, { recursive: true, force: true });
  }, 30_000);
});

describe('generated stack app explain', () => {
  it('`dot explain` succeeds without a required env key', async () => {
    // WHY: explain only configures, so it must never need secrets. The stack template's own key has
    // a default, so a required key is added here; the test fails if validation moves to configure.
    const workspaceRoot = resolve(__dirname, '..', '..', '..', '..');
    const cacheRoot = join(workspaceRoot, 'packages', 'dot', '.cache', `explain-${Date.now()}`);
    const { mkdir: mkdirCache } = await import('node:fs/promises');
    await mkdirCache(cacheRoot, { recursive: true });
    try {
      await scaffold({
        name: 'fixture',
        cwd: cacheRoot,
        templateRoot: resolve(__dirname, '..', '..', 'templates', 'app-stack'),
      });
      const appDir = join(cacheRoot, 'fixture');
      const envPath = join(appDir, 'src', 'env.ts');
      const envSource = await readFile(envPath, 'utf-8');
      const withRequired = envSource.replace(
        'export const envSchema = {',
        'export const envSchema = {\n  EXPLAIN_TEST_REQUIRED_KEY: z.string().min(1),',
      );
      expect(withRequired).not.toBe(envSource);
      await writeFile(envPath, withRequired, 'utf-8');

      const { spawn } = await import('node:child_process');
      const cliPath = join(workspaceRoot, 'packages', 'dot', 'src', 'cli', 'index.ts');
      const child = spawn(
        'bun',
        ['--no-env-file', cliPath, 'explain', '--json', '--cwd', appDir, '--app', 'src/app.ts'],
        { cwd: appDir, env: { PATH: process.env['PATH'] ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b: Buffer) => {
        stdout += b.toString();
      });
      child.stderr.on('data', (b: Buffer) => {
        stderr += b.toString();
      });
      const code: number = await new Promise((resolveDone, reject) => {
        child.on('error', reject);
        child.on('close', c => resolveDone(c ?? 0));
      });
      expect(code, `explain exited ${code}; stderr=${stderr}`).toBe(0);
      const envelope = JSON.parse(stdout) as {
        ok: boolean;
        command: string[];
        error: unknown;
        data: { services: { name: string }[] };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toEqual(['explain']);
      expect(envelope.error).toBeNull();
      expect(envelope.data.services.map(service => service.name)).toEqual(
        expect.arrayContaining(['env', 'db', 'journal']),
      );
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Templates: `stack` (default) and `minimal`.
// ---------------------------------------------------------------------------

/**
 * Files a stranger needs for the stack app to install, test, build and
 * deploy. Losing any of them breaks one of those steps, so the plan must
 * always contain them.
 */
const STACK_KEY_FILES = [
  '.dockerignore',
  '.env.example',
  '.gitignore',
  'AGENTS.md',
  'Dockerfile',
  'README.md',
  'docker-compose.yml',
  'drizzle.config.ts',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'src/app.ts',
  'src/entry-server.ts',
  'src/env.ts',
  'src/router.tsx',
  'src/routeTree.gen.ts',
  'src/server/db.ts',
  'src/server/journal.ts',
  'src/server/journal-tables.ts',
  'src/server/orpc.ts',
  'src/server/router.ts',
  'src/server/runtime.ts',
  'src/features/notes/tables.ts',
  'src/features/notes/note.ts',
  'src/features/notes/repository.ts',
  'src/features/notes/procedures.ts',
  'src/features/notes/notes.test.ts',
  'src/routes/__root.tsx',
  'src/routes/index.tsx',
  'src/routes/api/health.ts',
  'src/routes/api/rpc.$.ts',
] as const;

describe('templates', () => {
  it('uses the stack template when --template is omitted', async () => {
    expect(DEFAULT_TEMPLATE).toBe('stack');
    const { operations } = await plan({ name: 'fixture', cwd: workDir });
    const paths = operations.map(op => op.path);
    expect(paths).toEqual(expect.arrayContaining([...STACK_KEY_FILES]));
  });

  it('the stack plan ships an initial migration for the notes and journal tables', async () => {
    const { operations } = await plan({ name: 'fixture', cwd: workDir, template: 'stack' });
    const migration = operations.find(op => /^drizzle\/\d{14}_init\/migration\.sql$/.test(op.path));
    expect(migration, 'drizzle/<timestamp>_init/migration.sql').toBeDefined();
    expect(migration!.content).toContain('CREATE TABLE "notes"');
    expect(migration!.content).toContain('CREATE TABLE "journal_events"');
    expect(operations.some(op => /^drizzle\/\d{14}_init\/snapshot\.json$/.test(op.path))).toBe(true);
  });

  // The release packlist forbids `.env*` files in the tarball, so the
  // template stores `env.example` and the scaffold writes `.env.example`.
  it('writes .env.example although the template stores it as env.example', async () => {
    const { operations } = await plan({ name: 'fixture', cwd: workDir });
    expect(operations.map(op => op.path)).toContain('.env.example');
    expect(operations.map(op => op.path)).not.toContain('env.example');
    const { readdir: readTemplateDir } = await import('node:fs/promises');
    const templateFiles = await readTemplateDir(resolve(__dirname, '..', '..', 'templates', 'app-stack'));
    expect(templateFiles.filter(f => /^\.env/.test(f))).toEqual([]);
  });

  it('--template minimal still produces the 8-file skeleton', async () => {
    const { operations } = await plan({ name: 'fixture', cwd: workDir, template: 'minimal' });
    expect(operations.map(op => op.path)).toEqual([...EXPECTED_FILES]);
  });

  it('rejects an unknown template with cli.invalid_input', async () => {
    expect(resolveTemplateName('fullstack')).toBeUndefined();
    const result = await runNew({
      name: 'fixture',
      cwd: workDir,
      template: 'fullstack',
      dryRun: true,
    });
    expect(result).toMatchObject({ code: 'cli.invalid_input', message: expect.stringContaining('fullstack') });
  });

  it('the CLI passes --template through and fails on an unknown name with exit 2', async () => {
    const ok = await dot(['new', 'fixture', '--template', 'minimal', '--dry-run', '--json', '--cwd', workDir]);
    expect(ok.code).toBe(0);
    const envelope = JSON.parse(ok.stdout) as { data: { operations: { path: string }[] } };
    expect(envelope.data.operations.map(op => op.path)).toEqual([...EXPECTED_FILES]);

    const bad = await dot(['new', 'fixture', '--template', 'nope', '--dry-run', '--cwd', workDir]);
    expect(bad.code).toBe(2);
    const failure = JSON.parse(bad.stdout) as { ok: boolean; error: { code: string; issues: { flag: string }[] } };
    expect(failure.ok).toBe(false);
    expect(failure.error.code).toBe('cli.invalid_input');
    expect(failure.error.issues[0]?.flag).toBe('--template');
  });

  // A stranger installs from npm, outside this monorepo. Anything that only
  // resolves inside the workspace, or an unfinished marker, breaks that.
  it.each(['stack', 'minimal'] as const)(
    '%s: no generated file contains workspace-only specifiers, parent escapes, TODOs or unfilled placeholders',
    async template => {
      const { operations } = await plan({ name: 'fixture', cwd: workDir, template });
      for (const op of operations) {
        expect(op.content, op.path).not.toContain('workspace:');
        expect(op.content, op.path).not.toContain('catalog:');
        expect(op.content, op.path).not.toContain('../../');
        expect(op.content, op.path).not.toContain('TODO');
        expect(op.content, op.path).not.toMatch(/\{\{\w+\}\}/);
      }
    },
  );

  it('stack package.json pins every @arki dependency to a published version', async () => {
    const { operations } = await plan({ name: 'fixture', cwd: workDir });
    const manifest = JSON.parse(operations.find(op => op.path === 'package.json')!.content) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(manifest.name).toBe('fixture');
    expect(manifest.dependencies).toMatchObject({
      '@arki/dot': `^${readDotVersion()}`,
      '@arki/env': `^${TEMPLATE_VERSIONS.env}`,
      '@arki/log': `^${TEMPLATE_VERSIONS.log}`,
      '@arki/db': `^${TEMPLATE_VERSIONS.db}`,
      '@arki/journal': `^${TEMPLATE_VERSIONS.journal}`,
      '@arki/failure': `^${TEMPLATE_VERSIONS.failure}`,
      '@arki/ui': `^${TEMPLATE_VERSIONS.ui}`,
      zod: ZOD_VERSION,
    });
    // Only the packages above: every other @arki package is unpublished.
    const arkiDeps = Object.keys(manifest.dependencies).filter(dep => dep.startsWith('@arki/'));
    expect(arkiDeps.sort()).toEqual(
      [
        '@arki/db',
        '@arki/dot',
        '@arki/env',
        '@arki/failure',
        '@arki/journal',
        '@arki/log',
        '@arki/ui',
      ].sort(),
    );
  });
});

describe('template versions', () => {
  // The scaffold must never ask npm for an @arki version older than the one
  // in this monorepo: the generated code is written against today's API.
  it('TEMPLATE_VERSIONS are not behind the workspace packages', async () => {
    const packagesDir = resolve(__dirname, '..', '..', '..');
    const parse = (v: string) => v.split('.').map(part => Number.parseInt(part, 10));
    const atLeast = (have: string, want: string) => {
      const [a, b] = [parse(have), parse(want)];
      for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
      }
      return true;
    };
    for (const [pkg, pinned] of Object.entries(TEMPLATE_VERSIONS)) {
      const manifest = JSON.parse(await readFile(join(packagesDir, pkg, 'package.json'), 'utf-8')) as {
        name: string;
        version: string;
      };
      expect(manifest.name).toBe(`@arki/${pkg}`);
      expect(
        atLeast(pinned, manifest.version),
        `@arki/${pkg}: template ${pinned} < workspace ${manifest.version}`,
      ).toBe(true);
    }
  });

  it('dot --version prints the package.json version', async () => {
    const manifest = JSON.parse(await readFile(resolve(__dirname, '..', '..', 'package.json'), 'utf-8')) as {
      version: string;
    };
    const { code, stdout } = await dot(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(manifest.version);
  });
});
