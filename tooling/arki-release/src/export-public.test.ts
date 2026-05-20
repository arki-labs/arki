/**
 * Unit tests for the public-tree exporter.
 *
 * Strategy: build minimal fixture workspaces in fresh temp dirs, drive
 * the exporter via {@link exportPublicTree}, then assert against the
 * returned envelope and the materialized output on disk. We intentionally
 * do NOT spawn the CLI subprocess — that's an integration test surface
 * owned by Task 7.
 *
 * Each test isolates its own temp dir so they can run in parallel.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exportPublicTree } from './export-public';
import type { ReleaseConfig } from './types';

/** Shared metadata defaults used by every fixture. */
const defaults: ReleaseConfig['publicMetadataDefaults'] = {
  license: 'MIT',
  repository: { type: 'git', url: 'https://example.com/repo.git' },
  bugs: { url: 'https://example.com/issues' },
  homepage: 'https://example.com',
  publishConfig: { access: 'public' },
  keywords: ['arki'],
};

const baseConfig: ReleaseConfig = {
  publicTreePath: '.release/arki-public',
  publicMetadataDefaults: defaults,
  waves: [
    {
      id: 'foundation',
      label: 'Wave 1',
      packages: ['@arki/assert', '@arki/contracts'],
    },
  ],
};

/** Write a file under a temp workspace, creating parents on demand. */
function writeFixtureFile(root: string, relPath: string, contents: string): void {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

/** Convenience: write a `package.json` under `packages/<dir>/`. */
function writePkg(root: string, dir: string, manifest: Record<string, unknown>): void {
  writeFixtureFile(root, `packages/${dir}/package.json`, JSON.stringify(manifest, null, 2));
}

/** Write a minimal root `package.json` so loadCatalogs can run. */
function writeRoot(root: string, catalog: Record<string, string> = {}): void {
  writeFixtureFile(
    root,
    'package.json',
    JSON.stringify({ name: 'arki', version: '0.0.0', private: true, catalog }, null, 2),
  );
}

/** Recursively list every relative file path under a directory, sorted. */
function listTreeRelative(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  walk(root);
  return out;
}

/** Read a JSON file from the materialized tree. */
function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

describe('exportPublicTree', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-export-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns a success envelope with no items when there are no candidates', async () => {
    writeRoot(tmp);
    const config: ReleaseConfig = { ...baseConfig, waves: [] };
    const envelope = await exportPublicTree({ rootCwd: tmp, config });
    expect(envelope.status).toBe('success');
    expect(envelope.items).toHaveLength(0);
    expect(envelope.summary.exported).toBe(0);
    // Even with no candidates, the root scaffolding gets written.
    const outDir = path.join(tmp, baseConfig.publicTreePath);
    expect(statSync(outDir).isDirectory()).toBe(true);
    const files = listTreeRelative(outDir);
    expect(files).toContain('package.json');
    expect(files).toContain('.gitignore');
    expect(files).toContain('README.md');
  });

  it('exports a single public-candidate package and writes a materialized manifest', async () => {
    writeRoot(tmp);
    writePkg(tmp, 'assert', {
      name: '@arki/assert',
      version: '1.0.0',
      description: 'Test assertions.',
      type: 'module',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      files: ['dist'],
    });
    writeFixtureFile(tmp, 'packages/assert/README.md', '# @arki/assert\n');
    writeFixtureFile(tmp, 'packages/assert/dist/index.js', "export const ok = true;\n");
    writeFixtureFile(tmp, 'packages/assert/dist/index.d.ts', 'export declare const ok: boolean;\n');

    const envelope = await exportPublicTree({ rootCwd: tmp, config: baseConfig });

    expect(envelope.status).toBe('success');
    expect(envelope.summary.exported).toBe(1);

    const destDir = path.join(tmp, baseConfig.publicTreePath, 'packages/assert');
    const tree = listTreeRelative(destDir);
    expect(tree).toContain('package.json');
    expect(tree).toContain('README.md');
    expect(tree).toContain('dist/index.js');
    expect(tree).toContain('dist/index.d.ts');

    const written = readJson(path.join(destDir, 'package.json')) as Record<string, unknown>;
    expect(written['name']).toBe('@arki/assert');
    expect(written['version']).toBe('1.0.0');
    expect(written['description']).toBe('Test assertions.');
    expect(written['license']).toBe('MIT');
    // The materialized manifest must omit devDependencies / private / scripts.
    expect(written['devDependencies']).toBeUndefined();
    expect(written['private']).toBeUndefined();
    expect(written['scripts']).toBeUndefined();
    // publishConfig.access stamped from defaults.
    expect(written['publishConfig']).toEqual({ access: 'public' });
  });

  it('produces byte-identical output on consecutive runs (determinism)', async () => {
    writeRoot(tmp);
    writePkg(tmp, 'assert', {
      name: '@arki/assert',
      version: '1.0.0',
      description: 'Test assertions.',
      type: 'module',
      main: 'dist/index.js',
      files: ['dist'],
    });
    writeFixtureFile(tmp, 'packages/assert/README.md', '# @arki/assert\n');
    writeFixtureFile(tmp, 'packages/assert/dist/index.js', 'export const ok = true;\n');
    writeFixtureFile(tmp, 'packages/assert/dist/index.d.ts', 'export declare const ok: boolean;\n');

    await exportPublicTree({ rootCwd: tmp, config: baseConfig });
    const outDir = path.join(tmp, baseConfig.publicTreePath);
    const firstTree = listTreeRelative(outDir);
    const firstContents = firstTree.map(p => readFileSync(path.join(outDir, p), 'utf8'));

    await exportPublicTree({ rootCwd: tmp, config: baseConfig });
    const secondTree = listTreeRelative(outDir);
    const secondContents = secondTree.map(p => readFileSync(path.join(outDir, p), 'utf8'));

    expect(secondTree).toEqual(firstTree);
    expect(secondContents).toEqual(firstContents);
  });

  it('refuses a package whose source contains a leak (pre-output leak gate)', async () => {
    writeRoot(tmp);
    writePkg(tmp, 'assert', {
      name: '@arki/assert',
      version: '1.0.0',
      description: 'Test assertions.',
      files: ['dist'],
    });
    writeFixtureFile(tmp, 'packages/assert/README.md', 'Author: dev@furculita.net\n');
    writeFixtureFile(tmp, 'packages/assert/dist/index.js', 'export const ok = true;\n');

    const envelope = await exportPublicTree({ rootCwd: tmp, config: baseConfig });

    expect(envelope.summary.skipped).toBe(1);
    expect(envelope.summary.exported).toBe(0);
    const item = envelope.items.find(i => i.name === '@arki/assert');
    expect(item).toBeDefined();
    expect(item!.status).toBe('skipped');
    expect(item!.reason).toBe('leak hits in source');
    const leakError = envelope.errors.find(e => e.code === 'EXPORT_E002');
    expect(leakError).toBeDefined();
    expect(leakError!.severity).toBe('error');

    // Skipped package must not have a destination dir written.
    const destDir = path.join(tmp, baseConfig.publicTreePath, 'packages/assert');
    expect(() => statSync(destDir)).toThrow();
  });

  it('cascades materialization failures: skips packages with unresolved catalog refs', async () => {
    writeRoot(tmp);
    // Package references a catalog that doesn't exist anywhere.
    writePkg(tmp, 'assert', {
      name: '@arki/assert',
      version: '1.0.0',
      description: 'Test assertions.',
      dependencies: { 'mystery-dep': 'catalog:' },
    });
    writeFixtureFile(tmp, 'packages/assert/dist/index.js', 'export const ok = true;\n');

    const envelope = await exportPublicTree({ rootCwd: tmp, config: baseConfig });

    expect(envelope.status).toBe('failure');
    const item = envelope.items.find(i => i.name === '@arki/assert');
    expect(item).toBeDefined();
    expect(item!.status).toBe('failed');
    const failureSummary = envelope.errors.find(e => e.code === 'EXPORT_E003');
    expect(failureSummary).toBeDefined();
    const catalogError = envelope.errors.find(e => e.code === 'RELEASE_E005');
    expect(catalogError).toBeDefined();
  });

  it('--no-leak-scan overrides the gate and exports despite a leaked source', async () => {
    writeRoot(tmp);
    writePkg(tmp, 'assert', {
      name: '@arki/assert',
      version: '1.0.0',
      description: 'Test assertions.',
      files: ['dist'],
    });
    writeFixtureFile(tmp, 'packages/assert/README.md', 'Author: dev@furculita.net\n');
    writeFixtureFile(tmp, 'packages/assert/dist/index.js', 'export const ok = true;\n');

    const envelope = await exportPublicTree({
      rootCwd: tmp,
      config: baseConfig,
      leakScan: false,
    });
    expect(envelope.summary.exported).toBe(1);
    const warning = envelope.errors.find(e => e.code === 'EXPORT_E004');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
  });

  it('excludes node_modules, .env, and test files from the destination', async () => {
    writeRoot(tmp);
    writePkg(tmp, 'assert', {
      name: '@arki/assert',
      version: '1.0.0',
      description: 'Test assertions.',
      files: ['dist', 'src'],
    });
    writeFixtureFile(tmp, 'packages/assert/dist/index.js', 'export const ok = true;\n');
    writeFixtureFile(tmp, 'packages/assert/src/index.ts', 'export const ok = true;\n');
    writeFixtureFile(tmp, 'packages/assert/src/foo.test.ts', 'import { test } from "vitest";\n');
    writeFixtureFile(tmp, 'packages/assert/.env', 'SECRET=42\n');
    writeFixtureFile(
      tmp,
      'packages/assert/node_modules/dep/index.js',
      "module.exports = 'no';\n",
    );

    const envelope = await exportPublicTree({ rootCwd: tmp, config: baseConfig });
    expect(envelope.summary.exported).toBe(1);

    const destDir = path.join(tmp, baseConfig.publicTreePath, 'packages/assert');
    const tree = listTreeRelative(destDir);
    expect(tree).not.toContain('.env');
    expect(tree).not.toContain('src/foo.test.ts');
    expect(tree.some(p => p.startsWith('node_modules/'))).toBe(false);
    expect(tree).toContain('dist/index.js');
  });

  it('writes the root package.json, .gitignore, and README in the generated tree', async () => {
    writeRoot(tmp);
    writePkg(tmp, 'assert', {
      name: '@arki/assert',
      version: '1.0.0',
      description: 'Test assertions.',
    });

    await exportPublicTree({ rootCwd: tmp, config: baseConfig });
    const outDir = path.join(tmp, baseConfig.publicTreePath);
    const rootPkg = readJson(path.join(outDir, 'package.json')) as Record<string, unknown>;
    expect(rootPkg['name']).toBe('arki-public');
    expect(rootPkg['private']).toBe(true);
    expect(rootPkg['workspaces']).toEqual(['packages/*']);

    const gitignore = readFileSync(path.join(outDir, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/node_modules\//);

    const readme = readFileSync(path.join(outDir, 'README.md'), 'utf8');
    expect(readme).toMatch(/generated/i);
  });

  it('the destination manifest is the materialized one (devDeps absent, catalog refs resolved)', async () => {
    writeRoot(tmp, { zod: '^4.0.0' });
    writePkg(tmp, 'assert', {
      name: '@arki/assert',
      version: '1.0.0',
      description: 'Test assertions.',
      dependencies: { zod: 'catalog:' },
      devDependencies: { vitest: '^1.0.0' },
      scripts: { test: 'vitest' },
    });
    writeFixtureFile(tmp, 'packages/assert/dist/index.js', 'export const ok = true;\n');

    const envelope = await exportPublicTree({ rootCwd: tmp, config: baseConfig });
    expect(envelope.status).toBe('success');

    const destManifest = readJson(
      path.join(tmp, baseConfig.publicTreePath, 'packages/assert/package.json'),
    ) as Record<string, unknown>;
    const deps = destManifest['dependencies'] as Record<string, string>;
    expect(deps['zod']).toBe('^4.0.0');
    expect(destManifest['devDependencies']).toBeUndefined();
    expect(destManifest['scripts']).toBeUndefined();
  });

  it('refuses to export to a path outside the workspace root', async () => {
    writeRoot(tmp);
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'arki-elsewhere-'));
    try {
      const envelope = await exportPublicTree({
        rootCwd: tmp,
        config: baseConfig,
        outputPath: elsewhere,
      });
      expect(envelope.status).toBe('failure');
      const guard = envelope.errors.find(e => e.code === 'EXPORT_E001');
      expect(guard).toBeDefined();
      expect(guard!.severity).toBe('error');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
