import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDependencyGraph } from './dependency-graph';
import type { ParsedManifest } from './inventory';
import { computeOrder, ORDER_ERROR_CODES, runOrder, satisfiesRange } from './order';
import type { VersionLookup } from './order';
import type { NpmRunner } from './runners';
import type { ReleaseConfig } from './types';

function manifest(
  name: string,
  version: string,
  deps: Record<string, string> = {},
  extra: Partial<ParsedManifest> = {},
): ParsedManifest {
  return {
    manifestPath: `packages/${name.replace('@arki/', '')}/package.json`,
    name,
    version,
    private: false,
    dependencies: deps,
    ...extra,
  };
}

const wsDeps = (...names: string[]): Record<string, string> => Object.fromEntries(names.map(n => [n, 'workspace:*']));

function lookupOf(published: Record<string, string[]>): VersionLookup {
  return async name => ({ versions: published[name] ?? [] });
}

describe('satisfiesRange', () => {
  // Why: a wrong match would skip publishing a dependency the consumer cannot install.
  it('matches exact only on the same version', () => {
    expect(satisfiesRange('1.2.3', { kind: 'exact', version: '1.2.3' })).toBe(true);
    expect(satisfiesRange('1.2.4', { kind: 'exact', version: '1.2.3' })).toBe(false);
  });

  // Why: 0.x caret ranges are narrow; treating them like 1.x would hide a missing dependency.
  it('follows caret rules for 0.x and 1.x+', () => {
    expect(satisfiesRange('0.3.9', { kind: 'caret', version: '0.3.1' })).toBe(true);
    expect(satisfiesRange('0.4.0', { kind: 'caret', version: '0.3.1' })).toBe(false);
    expect(satisfiesRange('0.0.5', { kind: 'caret', version: '0.0.4' })).toBe(false);
    expect(satisfiesRange('1.9.0', { kind: 'caret', version: '1.2.0' })).toBe(true);
    expect(satisfiesRange('2.0.0', { kind: 'caret', version: '1.2.0' })).toBe(false);
    expect(satisfiesRange('1.1.0', { kind: 'caret', version: '1.2.0' })).toBe(false);
  });

  // Why: npm never lets ^ pick a pre-release, so we must not count one as satisfying.
  it('ignores pre-releases for caret', () => {
    expect(satisfiesRange('1.3.0-beta.1', { kind: 'caret', version: '1.2.0' })).toBe(false);
  });
});

describe('computeOrder', () => {
  const admitted = new Set(['@arki/a', '@arki/b', '@arki/c']);

  // Why: publishing a consumer before its dependency breaks installs for the minutes in between.
  it('puts dependencies first and adds a dependency npm lacks', async () => {
    const graph = buildDependencyGraph([
      manifest('@arki/a', '1.0.0', wsDeps('@arki/b')),
      manifest('@arki/b', '0.2.0', wsDeps('@arki/c')),
      manifest('@arki/c', '0.1.0'),
    ]);
    const { items, errors } = await computeOrder({
      graph,
      seeds: ['@arki/a'],
      admitted,
      lookup: lookupOf({ '@arki/b': [] }),
    });
    expect(errors).toEqual([]);
    expect(items.map(i => [i.name, i.kind, i.publishOrder])).toEqual([
      ['@arki/c', 'published-dep', 1],
      ['@arki/b', 'published-dep', 2],
      ['@arki/a', 'candidate', 3],
    ]);
  });

  // Why: a dependency already on npm must not be republished; npm rejects duplicate versions.
  it('leaves out a dependency whose exact version is on npm', async () => {
    const graph = buildDependencyGraph([
      manifest('@arki/a', '1.0.0', wsDeps('@arki/b')),
      manifest('@arki/b', '0.2.0'),
    ]);
    const { items } = await computeOrder({
      graph,
      seeds: ['@arki/a'],
      admitted,
      lookup: lookupOf({ '@arki/b': ['0.1.0', '0.2.0'] }),
    });
    expect(items.map(i => i.name)).toEqual(['@arki/a']);
  });

  // Why: a peer range is a caret, so a newer compatible version on npm is enough.
  it('uses a caret range for peer dependencies', async () => {
    const graph = buildDependencyGraph([
      manifest('@arki/a', '1.0.0', {}, { peerDependencies: wsDeps('@arki/b') }),
      manifest('@arki/b', '0.2.0'),
    ]);
    const { items } = await computeOrder({
      graph,
      seeds: ['@arki/a'],
      admitted,
      lookup: lookupOf({ '@arki/b': ['0.2.5'] }),
    });
    expect(items.map(i => i.name)).toEqual(['@arki/a']);
  });

  // Why: a private or unadmitted dependency can never be published, so the wave must stop (ORDER_E001).
  it('fails with ORDER_E001 for a private dependency', async () => {
    const graph = buildDependencyGraph([
      manifest('@arki/a', '1.0.0', wsDeps('@arki/b')),
      manifest('@arki/b', '0.2.0', {}, { private: true }),
    ]);
    const { errors } = await computeOrder({ graph, seeds: ['@arki/a'], admitted, lookup: lookupOf({}) });
    expect(errors.map(e => e.code)).toEqual([ORDER_ERROR_CODES.dependencyNotAdmitted]);
  });

  it('fails with ORDER_E001 for a public dependency outside every wave', async () => {
    const graph = buildDependencyGraph([
      manifest('@arki/a', '1.0.0', wsDeps('@arki/z')),
      manifest('@arki/z', '0.2.0'),
    ]);
    const { errors } = await computeOrder({ graph, seeds: ['@arki/a'], admitted, lookup: lookupOf({}) });
    expect(errors[0]?.code).toBe(ORDER_ERROR_CODES.dependencyNotAdmitted);
  });

  // Why: with a cycle no order is safe; saying so beats printing a wrong one.
  it('fails with ORDER_E003 on a cycle', async () => {
    const graph = buildDependencyGraph([
      manifest('@arki/a', '1.0.0', wsDeps('@arki/b')),
      manifest('@arki/b', '1.0.0', wsDeps('@arki/a')),
    ]);
    const { items, errors } = await computeOrder({ graph, seeds: ['@arki/a', '@arki/b'], admitted, lookup: lookupOf({}) });
    expect(items).toEqual([]);
    expect(errors[0]?.code).toBe(ORDER_ERROR_CODES.cycle);
  });

  // Why: a flaky registry must fail loudly, not look like "package not published".
  it('reports ORDER_E002 when npm view fails', async () => {
    const graph = buildDependencyGraph([
      manifest('@arki/a', '1.0.0', wsDeps('@arki/b')),
      manifest('@arki/b', '0.2.0'),
    ]);
    const { errors } = await computeOrder({
      graph,
      seeds: ['@arki/a'],
      admitted,
      lookup: async () => ({ error: 'npm view @arki/b exited with code 1: ENETDOWN' }),
    });
    expect(errors[0]?.code).toBe(ORDER_ERROR_CODES.npmViewFailed);
  });
});

describe('runOrder', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'arki-order-'));
    for (const [name, deps] of [['a', { '@arki/b': 'workspace:*' }], ['b', {}]] as const) {
      mkdirSync(path.join(root, 'packages', name), { recursive: true });
      writeFileSync(
        path.join(root, 'packages', name, 'package.json'),
        JSON.stringify({ name: `@arki/${name}`, version: '1.0.0', dependencies: deps }),
      );
    }
    mkdirSync(path.join(root, '.changeset'));
    writeFileSync(path.join(root, '.changeset', 'README.md'), '# not a changeset\n');
    writeFileSync(path.join(root, '.changeset', 'fix.md'), "---\n'@arki/a': patch\n---\n\nFixed it.\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const config: ReleaseConfig = {
    publicTreePath: '.release/public',
    publicMetadataDefaults: {
      license: 'MIT',
      repository: { type: 'git', url: 'https://example.com/r.git' },
      bugs: { url: 'https://example.com/i' },
      homepage: 'https://example.com',
      keywords: [],
    publishConfig: { access: 'public' },
    },
    waves: [{ id: 'foundation', label: 'Foundation', packages: ['@arki/a', '@arki/b'] }],
  };

  // Why: npm answers 404 for a never-published package; that means "publish it", not "error".
  it('treats an npm 404 as unpublished and parses npm view output with Zod', async () => {
    const npm: NpmRunner = async args => {
      expect(args.slice(0, 2)).toEqual(['view', '@arki/b']);
      return { stdout: '{"error":{"code":"E404"}}', stderr: 'npm error code E404', code: 1 };
    };
    const env = await runOrder({ cwd: root, config, wave: 'foundation', npmRunner: npm });
    expect(env.status).toBe('success');
    expect(env.items.map(i => `${i.publishOrder}:${i.name}:${i.kind}`)).toEqual([
      '1:@arki/b:published-dep',
      '2:@arki/a:candidate',
    ]);
  });

  // Why: npm prints a bare string, not an array, when only one version exists.
  it('accepts a single-version string from npm view', async () => {
    const env = await runOrder({
      cwd: root,
      config,
      wave: 'foundation',
      npmRunner: async () => ({ stdout: '"1.0.0"', stderr: '', code: 0 }),
    });
    expect(env.items.map(i => i.name)).toEqual(['@arki/a']);
  });

  it('fails with ORDER_E005 for an unknown wave', async () => {
    const env = await runOrder({ cwd: root, config, wave: 'nope' });
    expect(env.errors[0]?.code).toBe(ORDER_ERROR_CODES.unknownWave);
  });

  it('fails with ORDER_E002 on malformed npm output', async () => {
    const env = await runOrder({
      cwd: root,
      config,
      wave: 'foundation',
      npmRunner: async () => ({ stdout: '{"nope":1}', stderr: '', code: 0 }),
    });
    expect(env.errors[0]?.code).toBe(ORDER_ERROR_CODES.npmViewFailed);
  });
});
