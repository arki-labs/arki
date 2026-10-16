import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkAll, checkLibrary, updateBaseline } from './library-check';
import { leaves, readManifest } from './manifest';

function packageDir(folder: string, manifest: object, turbo: object | null): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'arki-library-check-')), folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  if (turbo) writeFileSync(path.join(dir, 'turbo.json'), JSON.stringify(turbo));
  // Fixtures model built packages: every declared `types` file exists (empty), so TYPES_W001 stays quiet.
  for (const target of Object.values(readManifest(dir).exports)) {
    for (const leaf of leaves(target)) {
      if (leaf.conditions.at(-1) !== 'types' && !leaf.value.endsWith('.d.ts')) continue;
      mkdirSync(path.dirname(path.join(dir, leaf.value)), { recursive: true });
      writeFileSync(path.join(dir, leaf.value), '');
    }
  }
  return dir;
}

// Private, so the agent-docs rules stay out of these tests; `docs.test.ts` covers them.
const good = {
  name: '@arki/demo',
  private: true,
  sideEffects: false,
  exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' } },
};

describe('checkLibrary', () => {
  it('passes a well-formed package', () => {
    expect(checkLibrary(packageDir('demo', good, { tags: ['foundation'] }))).toEqual({ errors: [], warnings: [] });
  });

  it('fails a release when an export has no types, because consumers lose their typings', () => {
    const manifest = { ...good, exports: { '.': { import: './dist/index.js', default: './dist/index.js' } } };
    expect(checkLibrary(packageDir('demo', manifest, { tags: ['foundation'] })).errors).toEqual([
      'export "." has no "types"',
    ]);
  });

  it('fails when no Boundaries tag is set, because the layer rules would skip the package', () => {
    expect(checkLibrary(packageDir('demo', good, null)).errors).toHaveLength(1);
  });

  it('only warns about wildcard exports and sideEffects', () => {
    const manifest = { ...good, sideEffects: undefined, exports: { ...good.exports, './*': './dist/*.js' } };
    const result = checkLibrary(packageDir('demo', manifest, { tags: ['web'] }));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it('does not ask a CSS export for types, because a stylesheet has no typings', () => {
    const manifest = {
      ...good,
      sideEffects: ['**/*.css'],
      exports: { ...good.exports, './styles.css': './src/styles.css', './theme.css': { default: './src/theme.css' } },
    };
    expect(checkLibrary(packageDir('demo', manifest, { tags: ['web'] }))).toEqual({ errors: [], warnings: [] });
  });

  it('still asks a code export without a "types" even when a CSS export sits next to it', () => {
    const manifest = { ...good, exports: { './x': { import: './dist/x.js' }, './a.css': './src/a.css' } };
    expect(checkLibrary(packageDir('demo', manifest, { tags: ['web'] })).errors).toEqual([
      'export "./x" has no "types"',
    ]);
  });

  it('accepts an exact sideEffects list but warns when it is missing', () => {
    const listed = { ...good, sideEffects: ['./dist/register.js'] };
    expect(checkLibrary(packageDir('demo', listed, { tags: ['web'] })).warnings).toEqual([]);
    const missing = { ...good, sideEffects: undefined };
    expect(checkLibrary(packageDir('demo', missing, { tags: ['web'] })).warnings).toHaveLength(1);
  });

  it('fails when the folder name differs from the package name, because the public mirror is named after the package', () => {
    expect(checkLibrary(packageDir('other', good, { tags: ['web'] })).errors).toEqual([
      'folder "other" should be "demo" (folder = name)',
    ]);
  });
});

describe('checkAll', () => {
  function repo(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'arki-library-check-all-'));
    for (const [group, folder, manifest, turbo] of [
      ['packages', 'demo', good, { tags: ['web'] }],
      [
        'packages',
        'broken',
        { ...good, name: '@arki/broken', exports: { '.': { import: './dist/i.js' } } },
        { tags: ['web'] },
      ],
      ['tooling', 'cfg', { name: '@arki/cfg', exports: { '.': './x.js' } }, { tags: ['tooling'] }],
    ] as const) {
      const dir = path.join(root, group, folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
      writeFileSync(path.join(dir, 'turbo.json'), JSON.stringify(turbo));
    }
    return root;
  }

  it('walks packages and tooling and reports each error with its package', () => {
    const result = checkAll(repo(), []);
    expect(result.errors).toEqual([{ package: '@arki/broken', error: 'export "." has no "types"' }]);
  });

  it('lets a baselined error pass', () => {
    const entry = { package: '@arki/broken', error: 'export "." has no "types"', reason: 'being rebuilt' };
    const result = checkAll(repo(), [entry]);
    expect(result.errors).toEqual([]);
    expect(result.baselined).toBe(1);
    expect(result.stale).toEqual([]);
  });

  it('flags a baseline entry that no longer matches an error, so the file cannot rot', () => {
    const entry = { package: '@arki/demo', error: 'export "." has no "types"', reason: 'fixed long ago' };
    expect(checkAll(repo(), [entry]).stale).toEqual([entry]);
  });
});

describe('updateBaseline', () => {
  it('drops stale entries, keeps known reasons and adds new errors with the given reason', () => {
    const kept = { package: '@arki/b', error: 'E1', reason: 'old reason' };
    const stale = { package: '@arki/a', error: 'E0', reason: 'fixed' };
    const entries = updateBaseline(
      [kept, stale],
      { errors: [{ package: '@arki/a', error: 'E2' }], stale: [stale] },
      'new',
    );
    expect(entries).toEqual([{ package: '@arki/a', error: 'E2', reason: 'new' }, kept]);
  });
});
