import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkLibrary } from './library-check';

function packageDir(folder: string, manifest: object, turbo: object | null): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'arki-library-check-')), folder);
  mkdirSync(dir);
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

  it('only warns about folder name, wildcard exports and sideEffects', () => {
    const manifest = { ...good, sideEffects: undefined, exports: { ...good.exports, './*': './dist/*.js' } };
    const result = checkLibrary(packageDir('other', manifest, { tags: ['web'] }));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(3);
  });
});
