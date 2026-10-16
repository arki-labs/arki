import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkLibrary } from './library-check';
import { readManifest } from './manifest';
import { checkPublicTypes } from './public-types';

/** A package folder with `package.json` and the given files (path relative to the package). */
function packageDir(manifest: object, files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'arki-public-types-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const entry = (name: string) => ({ types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` });

const demo = { name: '@arki/demo', exports: { '.': entry('index') } };

function check(manifest: object, files: Readonly<Record<string, string>>) {
  const dir = packageDir(manifest, files);
  return checkPublicTypes(dir, readManifest(dir));
}

describe('checkPublicTypes', () => {
  it('flags a Zod type reached through a re-export, because consumers see the whole re-exported surface', () => {
    const result = check(demo, {
      'dist/index.d.ts': "export * from './schemas.js';\n",
      'dist/schemas.d.ts': "import type { ZodObject } from 'zod';\nexport declare const user: ZodObject;\n",
    });
    expect(result.errors).toEqual(['TYPES_E001 export "." exposes Zod types: ZodObject']);
  });

  it('checks nested `types` conditions and .d.mts/.d.cts files, because dual packages ship types that way', () => {
    const dual = {
      name: '@arki/demo',
      exports: { '.': { types: { import: './dist/index.d.mts', require: './dist/index.d.cts' } } },
    };
    const result = check(dual, {
      'dist/index.d.mts': 'export declare const a: ZodString;\n',
      'dist/index.d.cts': 'export declare const b: ZodNumber;\n',
    });
    expect(result.errors).toEqual(['TYPES_E001 export "." exposes Zod types: ZodNumber, ZodString']);
  });

  it('flags zod/v4 core `$Zod` names and `import()` types, because both leak Zod as surely as a named import', () => {
    const result = check(demo, {
      'dist/index.d.ts': "export declare const a: $ZodType;\nexport declare const b: import('./x.js').Shape;\n",
      'dist/x.d.ts': 'export type Shape = ZodString;\n',
    });
    expect(result.errors).toEqual(['TYPES_E001 export "." exposes Zod types: $ZodType, ZodString']);
  });

  it('passes a `./zod` entry, because that subpath is the one place a library may offer Zod helpers', () => {
    const manifest = { ...demo, exports: { '.': entry('index'), './zod': entry('zod') } };
    const result = check(manifest, {
      'dist/index.d.ts': 'export declare const ok: string;\n',
      'dist/zod.d.ts': 'export declare const schema: ZodObject;\n',
    });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it('ignores Zod in a comment, because a doc mention does not tie consumers to Zod', () => {
    const result = check(demo, {
      'dist/index.d.ts': '/** Works with a ZodObject or any Standard Schema. */\nexport declare const ok: string;\n',
    });
    expect(result.errors).toEqual([]);
  });

  it('exempts @arki/contracts, because it is the shared Zod contract layer by design', () => {
    const result = check(
      { ...demo, name: '@arki/contracts' },
      { 'dist/index.d.ts': 'export declare const user: ZodObject;\n' },
    );
    expect(result.errors).toEqual([]);
  });

  it('exempts only the named zod-layer entries of a package, because its other entries must stay zod-free', () => {
    const manifest = { name: '@arki/db', exports: { '.': entry('index'), './id': entry('id') } };
    const result = check(manifest, {
      'dist/index.d.ts': 'export declare const leak: ZodObject;\n',
      'dist/id.d.ts': 'export declare const id: ZodType;\n',
    });
    expect(result.errors).toEqual(['TYPES_E001 export "." exposes Zod types: ZodObject']);
  });

  it('does not carry an entry exemption to another package, because ./id means a zod layer only in @arki/db', () => {
    const manifest = { name: '@arki/other', exports: { './id': entry('id') } };
    const result = check(manifest, { 'dist/id.d.ts': 'export declare const id: ZodType;\n' });
    expect(result.errors).toEqual(['TYPES_E001 export "./id" exposes Zod types: ZodType']);
  });

  it('only warns when the types file is missing, because library-check runs before build', () => {
    const result = check(demo, {});
    expect(result).toEqual({
      errors: [],
      warnings: ['TYPES_W001 export "." types not built (./dist/index.d.ts): Zod check skipped'],
    });
  });

  it('checks private packages too, because wave-1 Zod targets such as ai, queue and testing are private', () => {
    const root = packageDir({ name: 'root' }, {});
    const dir = path.join(root, 'demo');
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...demo, private: true, sideEffects: false }));
    writeFileSync(path.join(dir, 'turbo.json'), JSON.stringify({ tags: ['foundation'] }));
    writeFileSync(path.join(dir, 'dist/index.d.ts'), 'export declare const user: ZodObject;\n');
    expect(checkLibrary(dir).errors).toEqual(['TYPES_E001 export "." exposes Zod types: ZodObject']);
  });
});
