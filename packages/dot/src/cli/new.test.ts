/**
 * Tests for `dot new`.
 *
 * Covers planning (dry-run JSON envelope shape), exact file-list contract,
 * deterministic content hashes, writing to disk, refusal-to-overwrite,
 * `--force` semantics, app-name validation, and a smoke test that the
 * generated `app.ts` parses + imports.
 *
 * No `npm install` is ever executed; integration with adapter packages
 * is exercised through the existing in-repo `@arki/env/dot` adapter.
 */

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const join = (...segments: string[]): string => path.join(...segments);
const resolve = (...segments: string[]): string => path.resolve(...segments);

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  planOperations,
  resolveTargetDir,
  runNew,
  validateAppName,
} from './new.js';
import { sha256 } from './files.js';
import { DotCliErrorCode } from './error-codes.js';

const FROZEN_NOW = () => new Date('2026-05-21T00:00:00.000Z');
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

function captureSink() {
  const lines: string[] = [];
  return {
    out: (line: string) => {
      lines.push(line);
    },
    lines,
  };
}

describe('validateAppName', () => {
  it('accepts simple lower-case names', () => {
    expect(() => validateAppName('my-app')).not.toThrow();
    expect(() => validateAppName('app123')).not.toThrow();
    expect(() => validateAppName('a.b.c')).not.toThrow();
  });

  it('rejects names with spaces, capitals, or leading punctuation', () => {
    expect(() => validateAppName('My App')).toThrowError(/invalid/i);
    expect(() => validateAppName('MyApp')).toThrowError(/invalid/i);
    expect(() => validateAppName('-leading-hyphen')).toThrowError(/invalid/i);
    expect(() => validateAppName('@scope/name')).toThrowError(/invalid/i);
  });

  it('rejects empty name', () => {
    expect(() => validateAppName('')).toThrowError(/required/i);
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
    const { operations, target } = await planOperations({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    expect(target).toBe(join(workDir, 'fixture'));
    expect(operations.map(op => op.path)).toEqual([...EXPECTED_FILES]);
  });

  it('marks all files as `create` when target dir is empty', async () => {
    const { operations } = await planOperations({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
    });

    for (const op of operations) {
      expect(op.action).toBe('create');
    }
  });

  it('produces deterministic content hashes for the same input', async () => {
    const planA = await planOperations({ name: 'fixture', cwd: workDir, templateRoot: TEMPLATE_ROOT });
    const planB = await planOperations({ name: 'fixture', cwd: workDir, templateRoot: TEMPLATE_ROOT });

    for (let i = 0; i < planA.operations.length; i++) {
      expect(planA.operations[i]!.contentHash).toBe(planB.operations[i]!.contentHash);
      expect(planA.operations[i]!.contentBytes).toBe(planB.operations[i]!.contentBytes);
    }
  });

  it('changes content hash when name changes', async () => {
    const planA = await planOperations({ name: 'alpha', cwd: workDir, templateRoot: TEMPLATE_ROOT });
    const planB = await planOperations({ name: 'beta', cwd: workDir, templateRoot: TEMPLATE_ROOT });

    const pkgA = planA.operations.find(op => op.path === 'package.json')!;
    const pkgB = planB.operations.find(op => op.path === 'package.json')!;
    expect(pkgA.contentHash).not.toBe(pkgB.contentHash);
  });

  it('attaches a human-readable reason to every operation', async () => {
    const { operations } = await planOperations({
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

    const { operations } = await planOperations({
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

    const { operations } = await planOperations({
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
    const sink = captureSink();
    const envelope = await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      dryRun: true,
      json: true,
      out: sink.out,
      now: FROZEN_NOW,
    });

    expect(envelope.status).toBe('success');
    expect(envelope.command).toBe('new');
    expect(envelope.generatedAt).toBe('2026-05-21T00:00:00.000Z');
    expect(envelope.app).toEqual({ name: 'fixture', target: join(workDir, 'fixture') });
    expect(envelope.errors).toEqual([]);
    expect(envelope.operations).toHaveLength(EXPECTED_FILES.length);
  });

  it('does not write any files in dry-run', async () => {
    const sink = captureSink();
    await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      dryRun: true,
      json: true,
      out: sink.out,
      now: FROZEN_NOW,
    });

    const target = join(workDir, 'fixture');
    await expect(stat(target)).rejects.toThrow();
  });

  it('matches the exact file-list snapshot', async () => {
    const sink = captureSink();
    const envelope = await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      dryRun: true,
      json: true,
      out: sink.out,
      now: FROZEN_NOW,
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

  it('emits JSON envelope onto the out sink as a single block', async () => {
    const sink = captureSink();
    await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      dryRun: true,
      json: true,
      out: sink.out,
      now: FROZEN_NOW,
    });

    // Should be a single newline-terminated JSON document.
    expect(sink.lines).toHaveLength(1);
    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed.command).toBe('new');
    expect(parsed.status).toBe('success');
  });
});

describe('runNew (real run)', () => {
  it('writes every planned file to disk', async () => {
    const sink = captureSink();
    const envelope = await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      json: true,
      out: sink.out,
      now: FROZEN_NOW,
    });

    expect(envelope.status).toBe('success');
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
    const sink = captureSink();
    const envelope = await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      json: true,
      out: sink.out,
      now: FROZEN_NOW,
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

    const sink = captureSink();
    const errSink = captureSink();
    const envelope = await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      json: true,
      out: sink.out,
      err: errSink.out,
      now: FROZEN_NOW,
    });

    expect(envelope.status).toBe('failure');
    expect(envelope.errors.length).toBeGreaterThan(0);
    expect(envelope.errors[0]!.code).toBe(DotCliErrorCode.InvalidArgs);

    // The existing file should be untouched.
    const after = await readFile(join(target, 'package.json'), 'utf-8');
    expect(after).toBe('{"existing": true}');
  });

  it('overwrites existing files with --force', async () => {
    const target = join(workDir, 'fixture');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'package.json'), '{"existing": true}');

    const sink = captureSink();
    const envelope = await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      json: true,
      force: true,
      out: sink.out,
      now: FROZEN_NOW,
    });

    expect(envelope.status).toBe('success');
    const after = await readFile(join(target, 'package.json'), 'utf-8');
    expect(after).not.toBe('{"existing": true}');
    expect(after).toContain('"name": "fixture"');
  });

  it('rejects invalid app names with a structured failure envelope', async () => {
    const sink = captureSink();
    const errSink = captureSink();
    const envelope = await runNew({
      name: 'Invalid Name With Spaces',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      json: true,
      out: sink.out,
      err: errSink.out,
      now: FROZEN_NOW,
    });

    expect(envelope.status).toBe('failure');
    expect(envelope.errors[0]!.code).toBe(DotCliErrorCode.InvalidArgs);
  });

  it('emits non-JSON progress output when --json is omitted', async () => {
    const sink = captureSink();
    const envelope = await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      out: sink.out,
      now: FROZEN_NOW,
    });

    expect(envelope.status).toBe('success');
    const joined = sink.lines.join('');
    expect(joined).toContain('Scaffolded');
    expect(joined).toContain('Next steps:');
    expect(joined).toContain('install');
  });
});

describe('generated app content', () => {
  it('package.json declares the chosen name and required deps', async () => {
    const sink = captureSink();
    await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      json: true,
      out: sink.out,
      now: FROZEN_NOW,
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
    const sink = captureSink();
    await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      json: true,
      out: sink.out,
      now: FROZEN_NOW,
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
    const sink = captureSink();
    await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      json: true,
      out: sink.out,
      now: FROZEN_NOW,
    });

    const appTs = await readFile(join(workDir, 'fixture', 'src', 'app.ts'), 'utf-8');
    expect(appTs).toContain("defineApp('fixture')");
    expect(appTs).toContain('@arki/dot');
    expect(appTs).toContain('@arki/env/dot');
    expect(appTs).not.toContain('TODO');
  });

  it('package manager flag flows into the README and AGENTS.md', async () => {
    const sink = captureSink();
    await runNew({
      name: 'fixture',
      cwd: workDir,
      templateRoot: TEMPLATE_ROOT,
      pm: 'pnpm',
      json: true,
      out: sink.out,
      now: FROZEN_NOW,
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
    // can resolve `@arki/dot` and `@arki/env/dot` via the workspace's
    // node_modules. A tmpdir() outside the workspace has no module
    // resolution path back to the installed adapters.
    const workspaceRoot = resolve(__dirname, '..', '..', '..', '..');
    const bootRoot = join(workspaceRoot, 'packages', 'dot', '.cache', `boot-${Date.now()}`);
    const { mkdir: mkdirBoot } = await import('node:fs/promises');
    await mkdirBoot(bootRoot, { recursive: true });

    const sink = captureSink();
    await runNew({
      name: 'fixture',
      cwd: bootRoot,
      templateRoot: TEMPLATE_ROOT,
      json: true,
      out: sink.out,
      now: FROZEN_NOW,
    });

    const appDir = join(bootRoot, 'fixture');
    // Patch the generated app.ts to point at `./env.ts` instead of
    // `./env.js` so the bun loader resolves it without a build step.
    const appSource = await readFile(join(appDir, 'src', 'app.ts'), 'utf-8');
    await writeFile(
      join(appDir, 'src', 'app.ts'),
      appSource
        .replaceAll("from './env.js'", "from './env.ts'")
        .replaceAll('from "./env.js"', 'from "./env.ts"'),
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
