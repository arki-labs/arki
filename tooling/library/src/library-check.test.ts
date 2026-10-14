import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkLibrary } from './library-check';

function packageDir(folder: string, manifest: object, turbo: object | null): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'arki-library-check-')), folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  if (turbo) writeFileSync(path.join(dir, 'turbo.json'), JSON.stringify(turbo));
  return dir;
}

const good = {
  name: '@arki/demo',
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

  it('fails when the folder name differs from the package name, because the public mirror is named after the package', () => {
    expect(checkLibrary(packageDir('other', good, { tags: ['web'] })).errors).toEqual([
      'folder "other" should be "demo" (folder = name)',
    ]);
  });

  it('exempts workspaces still nested under converters, domains and text/operations until the next wave moves them', () => {
    for (const nested of ['packages/converters/other', 'packages/domains/other', 'packages/text/operations']) {
      expect(checkLibrary(packageDir(nested, good, { tags: ['web'] })).errors).toEqual([]);
    }
  });
});
