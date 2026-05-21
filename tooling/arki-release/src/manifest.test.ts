/**
 * Unit tests for the manifest materializer + catalog loader.
 *
 * Tests are public-seam: every test calls `materializeManifest` (and
 * `loadCatalogs` / `resolveCatalogRef` for the catalog-specific cases)
 * against in-memory fixtures. No disk I/O.
 */

import { describe, expect, it } from 'vitest';

import { CatalogLoadError, loadCatalogs, resolveCatalogRef } from './catalogs';
import type { ParsedManifest } from './inventory';
import { materializeManifest } from './manifest';
import type {
  CatalogTables,
  MaterializationContext,
  PublicMetadataDefaults,
} from './types';

/** Shared metadata defaults reused by every test. */
const defaults: PublicMetadataDefaults = {
  license: 'MIT',
  repository: { type: 'git', url: 'https://github.com/arki-labs/arki.git' },
  bugs: { url: 'https://github.com/arki-labs/arki/issues' },
  homepage: 'https://arki.dev',
  publishConfig: { access: 'public' },
  keywords: ['arki', 'typescript'],
};

/** Empty catalog tables — the materializer treats both as "no entries". */
const emptyCatalogs: CatalogTables = { default: {}, named: {} };

/** Helper: build a minimal materialization context with overrides. */
function ctx(overrides: Partial<MaterializationContext> = {}): MaterializationContext {
  return {
    catalogs: emptyCatalogs,
    workspaceVersions: new Map(),
    privateArkiPackages: new Set(),
    metadataDefaults: defaults,
    ...overrides,
  };
}

/** Helper: build a ParsedManifest fixture; extra publish fields ride along. */
type ManifestFixture = ParsedManifest & {
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly repository?: { readonly type: string; readonly url: string };
  readonly bugs?: { readonly url: string };
  readonly homepage?: string;
  readonly license?: string;
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly type?: 'module' | 'commonjs';
  readonly sideEffects?: boolean | readonly string[];
  readonly main?: string;
  readonly module?: string;
  readonly types?: string;
  readonly files?: readonly string[];
  readonly publishConfig?: Readonly<Record<string, unknown>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  readonly bundleDependencies?: readonly string[];
  readonly engines?: Readonly<Record<string, string>>;
};

function fixture(overrides: Partial<ManifestFixture> = {}): ManifestFixture {
  return {
    manifestPath: 'packages/example/package.json',
    name: '@arki/example',
    version: '0.1.0',
    private: false,
    description: 'Example package.',
    ...overrides,
  };
}

describe('loadCatalogs', () => {
  it('returns empty tables when neither `catalog` nor `catalogs` is present', () => {
    const tables = loadCatalogs({});
    expect(tables.default).toEqual({});
    expect(tables.named).toEqual({});
  });

  it('extracts the default catalog from `catalog`', () => {
    const tables = loadCatalogs({
      catalog: { zod: '^4.0.0', typescript: '5.9.3' },
    });
    expect(tables.default).toEqual({ zod: '^4.0.0', typescript: '5.9.3' });
  });

  it('extracts named catalogs from `catalogs`', () => {
    const tables = loadCatalogs({
      catalogs: {
        env: { '@t3-oss/env-core': '^0.13.10' },
        drizzle: { 'drizzle-orm': '1.0.0-rc.1' },
      },
    });
    expect(tables.named['env']).toEqual({ '@t3-oss/env-core': '^0.13.10' });
    expect(tables.named['drizzle']).toEqual({ 'drizzle-orm': '1.0.0-rc.1' });
  });

  it('throws CatalogLoadError when root is not an object', () => {
    expect(() => loadCatalogs(null)).toThrowError(CatalogLoadError);
    expect(() => loadCatalogs('not-an-object')).toThrowError(CatalogLoadError);
  });

  it('throws on non-string default-catalog entries', () => {
    expect(() => loadCatalogs({ catalog: { zod: 123 } })).toThrowError(CatalogLoadError);
  });

  it('throws on malformed named catalog', () => {
    expect(() =>
      loadCatalogs({ catalogs: { drizzle: 'not-an-object' } }),
    ).toThrowError(CatalogLoadError);
  });
});

describe('resolveCatalogRef', () => {
  const catalogs: CatalogTables = {
    default: { zod: '^4.0.0' },
    named: { env: { '@t3-oss/env-core': '^0.13.10' } },
  };

  it('resolves default catalog refs', () => {
    const out = resolveCatalogRef('catalog:', 'zod', catalogs);
    expect('resolved' in out && out.resolved).toBe('^4.0.0');
  });

  it('resolves named catalog refs', () => {
    const out = resolveCatalogRef('catalog:env', '@t3-oss/env-core', catalogs);
    expect('resolved' in out && out.resolved).toBe('^0.13.10');
  });

  it('returns RELEASE_E005 when the named catalog does not exist', () => {
    const out = resolveCatalogRef('catalog:ghost', 'whatever', catalogs);
    expect('error' in out).toBe(true);
    if ('error' in out) {
      expect(out.error.code).toBe('RELEASE_E005');
      expect(out.error.target).toBe('whatever');
    }
  });

  it('returns RELEASE_E005 when the catalog entry is missing', () => {
    const out = resolveCatalogRef('catalog:', 'missing-pkg', catalogs);
    expect('error' in out).toBe(true);
    if ('error' in out) {
      expect(out.error.code).toBe('RELEASE_E005');
      expect(out.error.target).toBe('missing-pkg');
    }
  });
});

describe('materializeManifest — boundary cases', () => {
  it('resolves plain catalog: refs from the default catalog', () => {
    const result = materializeManifest(
      fixture({ dependencies: { zod: 'catalog:' } }),
      ctx({
        catalogs: { default: { zod: '^4.0.0' }, named: {} },
      }),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.manifest.dependencies).toEqual({ zod: '^4.0.0' });
  });

  it('resolves catalog:<name> refs from a named catalog', () => {
    const result = materializeManifest(
      fixture({ dependencies: { '@t3-oss/env-core': 'catalog:env' } }),
      ctx({
        catalogs: {
          default: {},
          named: { env: { '@t3-oss/env-core': '^0.13.10' } },
        },
      }),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.manifest.dependencies).toEqual({ '@t3-oss/env-core': '^0.13.10' });
  });

  it('resolves workspace:* ARKI deps to exact versions in `dependencies`', () => {
    const result = materializeManifest(
      fixture({ dependencies: { '@arki/clock': 'workspace:*' } }),
      ctx({
        workspaceVersions: new Map([['@arki/clock', '0.2.1']]),
      }),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.manifest.dependencies).toEqual({ '@arki/clock': '0.2.1' });
  });

  it('resolves workspace:* ARKI deps to ^X.Y.Z in `peerDependencies`', () => {
    const result = materializeManifest(
      fixture({ peerDependencies: { '@arki/clock': 'workspace:*' } }),
      ctx({
        workspaceVersions: new Map([['@arki/clock', '0.2.1']]),
      }),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.manifest.peerDependencies).toEqual({ '@arki/clock': '^0.2.1' });
  });

  it('also accepts workspace:^ / workspace:~ forms', () => {
    const result = materializeManifest(
      fixture({
        dependencies: {
          '@arki/a': 'workspace:^',
          '@arki/b': 'workspace:~',
        },
      }),
      ctx({
        workspaceVersions: new Map([
          ['@arki/a', '1.0.0'],
          ['@arki/b', '2.0.0'],
        ]),
      }),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.manifest.dependencies).toEqual({
      '@arki/a': '1.0.0',
      '@arki/b': '2.0.0',
    });
  });

  it('emits RELEASE_E005 for an unresolved default-catalog reference', () => {
    const result = materializeManifest(
      fixture({ dependencies: { 'unknown-pkg': 'catalog:' } }),
      ctx(),
    );
    const fatal = result.errors.find(e => e.code === 'RELEASE_E005');
    expect(fatal).toBeDefined();
    expect(fatal!.severity).toBe('error');
    expect(fatal!.target).toBe('unknown-pkg');
    expect(result.manifest.dependencies).toBeUndefined();
  });

  it('emits RELEASE_E003 for a private ARKI dependency', () => {
    const result = materializeManifest(
      fixture({ dependencies: { '@arki/contracts': 'workspace:*' } }),
      ctx({
        workspaceVersions: new Map([['@arki/contracts', '0.1.0']]),
        privateArkiPackages: new Set(['@arki/contracts']),
      }),
    );
    const fatal = result.errors.find(e => e.code === 'RELEASE_E003');
    expect(fatal).toBeDefined();
    expect(fatal!.severity).toBe('error');
    expect(fatal!.target).toBe('@arki/contracts');
    expect(result.manifest.dependencies).toBeUndefined();
  });

  it('emits RELEASE_E004 for an unresolvable workspace dep (not in graph)', () => {
    const result = materializeManifest(
      fixture({ dependencies: { '@arki/ghost': 'workspace:*' } }),
      ctx(),
    );
    const fatal = result.errors.find(e => e.code === 'RELEASE_E004');
    expect(fatal).toBeDefined();
    expect(fatal!.severity).toBe('error');
    expect(fatal!.target).toBe('@arki/ghost');
  });

  it('emits RELEASE_E007 when the input manifest is `private: true`', () => {
    const result = materializeManifest(fixture({ private: true }), ctx());
    const fatal = result.errors.find(e => e.code === 'RELEASE_E007');
    expect(fatal).toBeDefined();
    expect(fatal!.severity).toBe('error');
    expect(fatal!.target).toBe('@arki/example');
  });

  it('does not emit `devDependencies` or `private` in the published manifest', () => {
    const input = fixture({
      dependencies: {},
    });
    // Smuggle a devDependencies field through — the materializer should not consume it.
    const tampered = { ...input, devDependencies: { typescript: 'catalog:' } } as ParsedManifest;
    const result = materializeManifest(tampered, ctx());
    expect(result.manifest).not.toHaveProperty('devDependencies');
    expect(result.manifest).not.toHaveProperty('private');
    expect(result.manifest).not.toHaveProperty('scripts');
  });

  it('uses input metadata when present, falls back to defaults otherwise', () => {
    const result = materializeManifest(
      fixture({
        description: 'My great library.',
        license: 'Apache-2.0',
        homepage: 'https://my.own/url',
      }),
      ctx(),
    );
    expect(result.manifest.description).toBe('My great library.');
    expect(result.manifest.license).toBe('Apache-2.0');
    expect(result.manifest.homepage).toBe('https://my.own/url');
    // No description warning since input has one.
    expect(result.errors.find(e => e.code === 'RELEASE_E006')).toBeUndefined();
    // Repository / bugs come from defaults since input didn't supply them.
    expect(result.manifest.repository).toEqual({
      type: 'git',
      url: 'https://github.com/arki-labs/arki.git',
    });
    expect(result.manifest.bugs).toEqual({
      url: 'https://github.com/arki-labs/arki/issues',
    });
  });

  it('stubs a missing description and emits RELEASE_E006 warning (not error)', () => {
    const result = materializeManifest(fixture({ description: undefined }), ctx());
    expect(result.manifest.description).toBe('ARKI library: @arki/example');
    const warn = result.errors.find(e => e.code === 'RELEASE_E006');
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe('warning');
    // Warnings must NOT promote into errors. The package is still publishable per Task 3's rule.
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('merges keywords: input first, defaults after, deduplicated', () => {
    const result = materializeManifest(
      fixture({ keywords: ['custom', 'arki'] }),
      ctx(),
    );
    // 'arki' is already in input so the duplicate from defaults is dropped.
    expect(result.manifest.keywords).toEqual(['custom', 'arki', 'typescript']);
  });

  it('preserves the input `exports` map verbatim', () => {
    const exportsField = {
      '.': { import: './dist/index.js', types: './dist/index.d.ts' },
      './core': { import: './dist/core/index.js' },
    };
    const result = materializeManifest(
      fixture({ exports: exportsField }),
      ctx(),
    );
    expect(result.manifest.exports).toEqual(exportsField);
  });

  it('passes through `peerDependenciesMeta` and `bundleDependencies` unchanged', () => {
    const result = materializeManifest(
      fixture({
        peerDependenciesMeta: { react: { optional: true } },
        bundleDependencies: ['some-bundled-thing'],
      }),
      ctx(),
    );
    expect(result.manifest.peerDependenciesMeta).toEqual({ react: { optional: true } });
    expect(result.manifest.bundleDependencies).toEqual(['some-bundled-thing']);
  });

  it('passes through plain semver/git/file/tag versions unchanged', () => {
    const result = materializeManifest(
      fixture({
        dependencies: {
          react: '^19.0.0',
          'some-tag': 'next',
          fork: 'github:user/repo#abc',
        },
      }),
      ctx(),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.manifest.dependencies).toEqual({
      react: '^19.0.0',
      'some-tag': 'next',
      fork: 'github:user/repo#abc',
    });
  });

  it('omits dep buckets entirely when input has empty objects', () => {
    const result = materializeManifest(
      fixture({
        dependencies: {},
        peerDependencies: {},
        optionalDependencies: {},
      }),
      ctx(),
    );
    expect(result.manifest.dependencies).toBeUndefined();
    expect(result.manifest.peerDependencies).toBeUndefined();
    expect(result.manifest.optionalDependencies).toBeUndefined();
  });

  it('merges publishConfig: defaults floor + input overrides', () => {
    const result = materializeManifest(
      fixture({
        publishConfig: { tag: 'beta' },
      }),
      ctx(),
    );
    expect(result.manifest.publishConfig).toEqual({ access: 'public', tag: 'beta' });
  });

  it('handles the full @arki/env scenario: workspace + named-catalog + default-catalog', () => {
    const result = materializeManifest(
      fixture({
        name: '@arki/env',
        version: '0.1.0',
        description: 'Environment-variable contracts.',
        dependencies: {
          '@arki/contracts': 'workspace:*',
          '@t3-oss/env-core': 'catalog:env',
          zod: 'catalog:',
        },
      }),
      ctx({
        catalogs: {
          default: { zod: '^4.0.0' },
          named: { env: { '@t3-oss/env-core': '^0.13.10' } },
        },
        workspaceVersions: new Map([['@arki/contracts', '0.2.0']]),
        privateArkiPackages: new Set(), // contracts is public in this scenario
      }),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.manifest.dependencies).toEqual({
      '@arki/contracts': '0.2.0',
      '@t3-oss/env-core': '^0.13.10',
      zod: '^4.0.0',
    });
  });

  it('collects multiple errors in one pass (does not short-circuit)', () => {
    const result = materializeManifest(
      fixture({
        dependencies: {
          '@arki/ghost': 'workspace:*', // E004
          '@arki/contracts': 'workspace:*', // E003
          'unknown-pkg': 'catalog:', // E005
          'unknown-named': 'catalog:nope', // E005
        },
      }),
      ctx({
        privateArkiPackages: new Set(['@arki/contracts']),
      }),
    );
    const codes = result.errors.map(e => e.code).sort();
    // Two RELEASE_E005s (one for missing default-catalog entry, one for missing named catalog).
    expect(codes).toEqual(['RELEASE_E003', 'RELEASE_E004', 'RELEASE_E005', 'RELEASE_E005']);
  });
});
