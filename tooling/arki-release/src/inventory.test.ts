/**
 * Unit tests for the inventory command.
 *
 * Strategy: write fixture `package.json` manifests into a fresh temp dir,
 * call the public seam (`runInventory`), and assert on the envelope. We
 * intentionally do NOT spawn the CLI subprocess — that's an integration
 * test owned by Task 7.
 *
 * Each test isolates its own temp dir so they can run in parallel.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDependencyGraph, collectReachableArkiDeps } from './dependency-graph';
import { classifyManifests, discoverManifests, runInventory } from './inventory';
import type { ReleaseConfig } from './types';

/** Minimal config used by most tests. Customised per-test where needed. */
const baseConfig: ReleaseConfig = {
  publicTreePath: '.release/arki-public',
  publicMetadataDefaults: {
    license: 'MIT',
    repository: { type: 'git', url: 'https://example.com/repo.git' },
    bugs: { url: 'https://example.com/issues' },
    homepage: 'https://example.com',
    publishConfig: { access: 'public' },
    keywords: ['arki'],
  },
  waves: [
    { id: 'foundation', label: 'Wave 1', packages: ['@arki/assert', '@arki/contracts', '@arki/log'] },
    { id: 'dot-kernel', label: 'Wave 2', packages: ['@arki/dot'] },
  ],
};

function writeManifest(root: string, dir: string, manifest: Record<string, unknown>): void {
  const target = path.join(root, dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2));
}

describe('discoverManifests across release roots', () => {
  it('finds a package under tooling/ whose folder differs from its npm name', async () => {
    // Why: @arki/tsconfig lives in tooling/typescript; the folder, not the name, is where it is released from.
    const root = mkdtempSync(path.join(tmpdir(), 'arki-inventory-roots-'));
    try {
      writeManifest(root, 'packages/log', { name: '@arki/log', version: '1.0.0' });
      writeManifest(root, 'tooling/typescript', { name: '@arki/tsconfig', version: '1.0.0' });
      writeManifest(root, 'fleet/shared', { name: '@arki/fleet-leak', version: '1.0.0' });
      const { manifests } = await discoverManifests(root);
      expect(manifests.map(m => [m.name, m.manifestPath])).toEqual([
        ['@arki/log', path.join('packages/log', 'package.json')],
        ['@arki/tsconfig', path.join('tooling/typescript', 'package.json')],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runInventory', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-release-inv-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an empty envelope when packages/ is empty', async () => {
    mkdirSync(path.join(tmp, 'packages'), { recursive: true });
    const env = await runInventory({ cwd: tmp, config: baseConfig });
    expect(env.command).toBe('inventory');
    expect(env.status).toBe('success');
    expect(env.items).toHaveLength(0);
    expect(env.summary.totalDiscovered).toBe(0);
  });

  it('classifies a public wave-allowlisted package as public-candidate', async () => {
    writeManifest(tmp, 'packages/assert', { name: '@arki/assert', version: '1.0.0' });
    const env = await runInventory({ cwd: tmp, config: baseConfig });
    expect(env.status).toBe('success');
    expect(env.items).toHaveLength(1);
    const item = env.items[0]!;
    expect(item.name).toBe('@arki/assert');
    expect(item.classification).toBe('public-candidate');
    expect(item.wave).toBe('foundation');
    expect(item.blockers).toHaveLength(0);
    // The fixture wave lists other packages we haven't written — those produce
    // INV_E005 warnings. We assert specifically that no blocker-grade errors fire.
    expect(env.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(env.errors.find(e => e.code === 'INV_E004')).toBeUndefined();
  });

  it('classifies a private wave-allowlisted package as blocked-by-private-flag and fails', async () => {
    writeManifest(tmp, 'packages/contracts', { name: '@arki/contracts', version: '1.0.0', private: true });
    const env = await runInventory({ cwd: tmp, config: baseConfig });
    expect(env.status).toBe('failure');
    expect(env.items).toHaveLength(1);
    const item = env.items[0]!;
    expect(item.classification).toBe('blocked-by-private-flag');
    expect(item.blockers).toHaveLength(1);
    expect(item.blockers[0]!.code).toBe('INV_E002');
    const blockerError = env.errors.find(e => e.code === 'INV_E002');
    expect(blockerError).toBeDefined();
    expect(blockerError!.target).toBe('@arki/contracts');
  });

  it('flags a public wave-allowlisted package that depends on a private package', async () => {
    writeManifest(tmp, 'packages/assert', {
      name: '@arki/assert',
      version: '1.0.0',
      dependencies: { '@arki/log': 'workspace:*' },
    });
    writeManifest(tmp, 'packages/log', {
      name: '@arki/log',
      version: '1.0.0',
      private: true,
    });

    const env = await runInventory({ cwd: tmp, config: baseConfig });
    expect(env.status).toBe('failure');
    const assertItem = env.items.find(i => i.name === '@arki/assert');
    const loggerItem = env.items.find(i => i.name === '@arki/log');
    expect(assertItem).toBeDefined();
    expect(loggerItem).toBeDefined();
    expect(assertItem!.classification).toBe('blocked-by-private-dependency');
    expect(loggerItem!.classification).toBe('blocked-by-private-flag');
    expect(assertItem!.blockers[0]!.code).toBe('INV_E003');
    expect(assertItem!.blockers[0]!.target).toBe('@arki/log');
  });

  it('skips manifests without an @arki/* name and records an info diagnostic', async () => {
    writeManifest(tmp, 'packages/weird', { name: 'weird-thing', version: '1.0.0' });
    writeManifest(tmp, 'packages/no-name', { version: '1.0.0' });
    writeManifest(tmp, 'packages/assert', { name: '@arki/assert', version: '1.0.0' });

    const env = await runInventory({ cwd: tmp, config: baseConfig });
    expect(env.items).toHaveLength(1);
    expect(env.items[0]!.name).toBe('@arki/assert');
    const diagnostics = env.errors.filter(e => e.code === 'INV_E001');
    expect(diagnostics).toHaveLength(2);
    for (const d of diagnostics) {
      expect(d.severity).toBe('info');
    }
  });

  it('excludes packages/**/dist/package.json build artifacts from discovery', async () => {
    writeManifest(tmp, 'packages/assert', { name: '@arki/assert', version: '1.0.0' });
    writeManifest(tmp, 'packages/assert/dist', { name: 'dist', version: '1.0.0' });
    writeManifest(tmp, 'packages/some-pkg/node_modules/somedep', { name: '@arki/garbage', version: '1.0.0' });

    const env = await runInventory({ cwd: tmp, config: baseConfig });
    expect(env.items).toHaveLength(1);
    expect(env.items[0]!.name).toBe('@arki/assert');
  });

  it('emits an unclassified-public-manifest warning and labels the package `unassigned`', async () => {
    writeManifest(tmp, 'packages/orphan', { name: '@arki/orphan', version: '1.0.0' });
    const env = await runInventory({ cwd: tmp, config: baseConfig });
    expect(env.status).toBe('success');
    expect(env.items).toHaveLength(1);
    const item = env.items[0]!;
    expect(item.wave).toBeNull();
    expect(item.private).toBe(false);
    expect(item.classification).toBe('unassigned');
    const warn = env.errors.find(e => e.code === 'INV_E004');
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe('warning');
  });

  it('treats an explicitly private package not in any wave as private-only with no errors', async () => {
    writeManifest(tmp, 'packages/internal', { name: '@arki/internal', version: '1.0.0', private: true });
    const env = await runInventory({ cwd: tmp, config: baseConfig });
    expect(env.status).toBe('success');
    expect(env.items[0]!.classification).toBe('private-only');
    expect(env.errors.filter(e => e.code === 'INV_E004')).toHaveLength(0);
  });

  it('emits INV_E005 (warning) when a wave references a workspace package that does not exist', async () => {
    // Only @arki/assert is on disk; the wave also lists @arki/contracts and @arki/log.
    writeManifest(tmp, 'packages/assert', { name: '@arki/assert', version: '1.0.0' });
    const env = await runInventory({ cwd: tmp, config: baseConfig });
    expect(env.status).toBe('success'); // warnings don't fail the gate
    const missing = env.errors.filter(e => e.code === 'INV_E005');
    expect(missing.map(e => e.target).sort()).toEqual(['@arki/contracts', '@arki/dot', '@arki/log']);
    for (const m of missing) {
      expect(m.severity).toBe('warning');
    }
  });

  it('does not emit INV_E005 when every wave package is present in the workspace', async () => {
    writeManifest(tmp, 'packages/assert', { name: '@arki/assert', version: '1.0.0' });
    writeManifest(tmp, 'packages/contracts', { name: '@arki/contracts', version: '1.0.0' });
    writeManifest(tmp, 'packages/log', { name: '@arki/log', version: '1.0.0' });
    writeManifest(tmp, 'packages/dot', { name: '@arki/dot', version: '1.0.0' });
    const env = await runInventory({ cwd: tmp, config: baseConfig });
    expect(env.errors.filter(e => e.code === 'INV_E005')).toHaveLength(0);
  });
});

// `fleet/<name>` = `@fleet/<name>`: shared across our apps, never released. Arki may not depend on it.
describe('runInventory and fleet/', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-release-inv-fleet-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('never inventories a fleet/ package, even one misnamed @arki/*, so release tooling cannot see it', async () => {
    writeManifest(tmp, 'packages/assert', { name: '@arki/assert', version: '1.0.0' });
    writeManifest(tmp, 'fleet/shared', { name: '@fleet/shared', version: '1.0.0', private: true });
    writeManifest(tmp, 'fleet/misnamed', { name: '@arki/misnamed', version: '1.0.0' });
    const env = await runInventory({ cwd: tmp, config: baseConfig });
    expect(env.items.map(item => item.name)).toEqual(['@arki/assert']);
    expect(env.errors.filter(error => String(error.target).startsWith('fleet'))).toEqual([]);
  });

  it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])(
    'fails with INV_E006 when an @arki/* manifest lists @fleet/* in %s',
    async bucket => {
      writeManifest(tmp, 'packages/log', {
        name: '@arki/log',
        version: '1.0.0',
        private: true,
        [bucket]: { '@fleet/shared': 'workspace:*' },
        // An optional peer is still a dependency on fleet: no exemption.
        peerDependenciesMeta: { '@fleet/shared': { optional: true } },
      });
      const env = await runInventory({ cwd: tmp, config: baseConfig });
      expect(env.status).toBe('failure');
      expect(env.errors.filter(error => error.code === 'INV_E006')).toEqual([
        expect.objectContaining({ severity: 'error', target: path.join('packages', 'log', 'package.json') }),
      ]);
    },
  );

  it('does not emit INV_E006 for @arki/* dependencies', async () => {
    writeManifest(tmp, 'packages/assert', { name: '@arki/assert', version: '1.0.0' });
    writeManifest(tmp, 'packages/log', {
      name: '@arki/log',
      version: '1.0.0',
      dependencies: { '@arki/assert': 'workspace:*' },
    });
    const env = await runInventory({ cwd: tmp, config: baseConfig });
    expect(env.errors.map(error => error.code)).not.toContain('INV_E006');
  });
});

describe('classifyManifests (pure)', () => {
  it('aggregates byClassification and byWave counts correctly', () => {
    const env = classifyManifests({
      config: baseConfig,
      diagnostics: [],
      manifests: [
        { manifestPath: 'packages/a/package.json', name: '@arki/assert', version: '1.0.0', private: false },
        { manifestPath: 'packages/b/package.json', name: '@arki/contracts', version: '1.0.0', private: true },
        { manifestPath: 'packages/c/package.json', name: '@arki/dot', version: '1.0.0', private: false },
        { manifestPath: 'packages/d/package.json', name: '@arki/internal', version: '1.0.0', private: true },
        { manifestPath: 'packages/e/package.json', name: '@arki/orphan', version: '1.0.0', private: false },
      ],
    });
    expect(env.summary.byClassification['public-candidate']).toBe(2);
    expect(env.summary.byClassification['blocked-by-private-flag']).toBe(1);
    expect(env.summary.byClassification['private-only']).toBe(1);
    expect(env.summary.byClassification['unassigned']).toBe(1);
    expect(env.summary.byWave['foundation']).toBe(2);
    expect(env.summary.byWave['dot-kernel']).toBe(1);
    expect(env.summary.byWave['unassigned']).toBe(2);
  });
});

describe('buildDependencyGraph', () => {
  it('records edges only for @arki/* workspace deps', () => {
    const graph = buildDependencyGraph([
      {
        manifestPath: 'a/package.json',
        name: '@arki/a',
        version: '1.0.0',
        private: false,
        dependencies: {
          '@arki/b': 'workspace:*',
          'react': '^19.0.0',
          '@arki/c': '^1.0.0', // NOT workspace:, should be ignored
        },
      },
      { manifestPath: 'b/package.json', name: '@arki/b', version: '1.0.0', private: true },
      { manifestPath: 'c/package.json', name: '@arki/c', version: '1.0.0', private: false },
    ]);
    const a = graph.byName.get('@arki/a');
    expect(a).toBeDefined();
    expect(a!.dependsOn).toEqual(['@arki/b']);
  });

  it('ignores deps that do not exist in the workspace (defensive)', () => {
    const graph = buildDependencyGraph([
      {
        manifestPath: 'a/package.json',
        name: '@arki/a',
        version: '1.0.0',
        private: false,
        dependencies: { '@arki/ghost': 'workspace:*' },
      },
    ]);
    expect(graph.byName.get('@arki/a')!.dependsOn).toEqual([]);
  });

  it('collectReachableArkiDeps follows the chain', () => {
    const graph = buildDependencyGraph([
      { manifestPath: 'a/package.json', name: '@arki/a', version: '1.0.0', private: false, dependencies: { '@arki/b': 'workspace:*' } },
      { manifestPath: 'b/package.json', name: '@arki/b', version: '1.0.0', private: false, dependencies: { '@arki/c': 'workspace:*' } },
      { manifestPath: 'c/package.json', name: '@arki/c', version: '1.0.0', private: true },
    ]);
    const deps = collectReachableArkiDeps(graph, '@arki/a');
    expect(deps).toContain('@arki/b');
    expect(deps).toContain('@arki/c');
    // `root` itself is never included.
    expect(deps).not.toContain('@arki/a');
  });

  it('tolerates cycles without infinite looping and excludes `root` from the result', () => {
    const graph = buildDependencyGraph([
      { manifestPath: 'a/package.json', name: '@arki/a', version: '1.0.0', private: false, dependencies: { '@arki/b': 'workspace:*' } },
      { manifestPath: 'b/package.json', name: '@arki/b', version: '1.0.0', private: false, dependencies: { '@arki/a': 'workspace:*' } },
    ]);
    const deps = collectReachableArkiDeps(graph, '@arki/a');
    // Cycle is tolerated; `root` (@arki/a) is never included even though it is reachable via @arki/b.
    expect([...deps].sort()).toEqual(['@arki/b']);
    expect(deps).not.toContain('@arki/a');
  });
});
