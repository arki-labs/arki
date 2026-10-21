import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { GROUP_THRESHOLD, apiIndexSchema, buildApiIndex, namesReaderFor, writeApiIndex } from './api-index';

function builtPackage(files: Readonly<Record<string, string>>, exports: object): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'arki-api-index-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@arki/demo', version: '1.2.3', exports }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const entry = (name: string) => ({ types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` });

describe('buildApiIndex', () => {
  it('lists each export with kind, signature and first JSDoc paragraph', () => {
    // Why: the docs site and the diff both trust this list as the public surface.
    const dir = builtPackage(
      {
        'dist/index.d.ts': [
          '/** Adds numbers.\n *\n * Second paragraph. */',
          'export declare function add(a: number, b: number): number;',
          'export interface Options { retries: number }',
          'export type Id = string;',
          'export declare const limit: 3;',
          'export declare class Box { value: number }',
        ].join('\n'),
      },
      { '.': entry('index') },
    );
    const { index } = buildApiIndex(dir);
    expect(apiIndexSchema.parse(index)).toEqual(index);
    expect(index).toMatchObject({ package: '@arki/demo', version: '1.2.3', errorCodes: [] });
    const byName = Object.fromEntries(index.entries.map(e => [e.name, e]));
    expect(byName.add).toMatchObject({
      kind: 'function',
      signature: 'export declare function add(a: number, b: number): number;',
      jsdocSummary: 'Adds numbers.',
    });
    expect(byName.Options?.kind).toBe('interface');
    expect(byName.Id?.kind).toBe('type');
    expect(byName.limit?.kind).toBe('variable');
    expect(byName.limit?.signature).toBe('export declare const limit: 3;');
    expect(byName.Box?.kind).toBe('class');
  });

  it('fills errorCodes from the error index of the same package', () => {
    // Why: api.json and errors.json must list the same codes; one source (buildErrorIndex) keeps them equal.
    const dir = builtPackage(
      {
        'dist/index.d.ts': 'export declare const x: 1;',
        'src/errors.ts':
          "export const DEMO_ERROR_CODES = {\n  /** Bad. @fix Fix it. @verify bun run test */\n  bad: 'ARKI_DEMO_E001',\n} as const;\n",
      },
      { '.': entry('index') },
    );
    expect(buildApiIndex(dir).index.errorCodes).toEqual(['ARKI_DEMO_E001']);
  });

  it('follows re-exports into other files and keeps the subpath', () => {
    // Why: most packages expose a barrel; the index must name what consumers can import, per subpath.
    const dir = builtPackage(
      {
        'dist/index.d.ts': "export { helper } from './helper';",
        'dist/helper.d.ts': '/** Helps. */\nexport declare function helper(): void;',
        'dist/extra.d.ts': 'export declare const extra: string;',
      },
      { '.': entry('index'), './extra': entry('extra'), './package.json': './package.json' },
    );
    const { index } = buildApiIndex(dir);
    expect(index.entries.map(e => `${e.subpath}:${e.name}`)).toEqual(['.:helper', './extra:extra']);
    expect(index.entries[0]?.jsdocSummary).toBe('Helps.');
  });

  it('skips subpaths whose types are not built and wildcard subpaths', () => {
    // Why: running before build must not crash or invent names; the caller is told what was skipped.
    const dir = builtPackage(
      { 'dist/index.d.ts': 'export declare const a: 1;' },
      {
        '.': entry('index'),
        './missing': entry('missing'),
        './*': './dist/*.js',
      },
    );
    const { index, skipped } = buildApiIndex(dir);
    expect(index.entries.map(e => e.name)).toEqual(['a']);
    expect(skipped).toEqual(['./missing']);
  });

  it('groups same-type variables at the threshold and writes their names to a sibling file', () => {
    // Why: an icon set is 22,000 `declare const X: Icon` lines; one row plus a names file keeps api.json small without losing a name.
    const icons = Array.from({ length: GROUP_THRESHOLD }, (_, i) => `export declare const Icon${String(i).padStart(3, '0')}: Icon;`);
    const dir = builtPackage(
      {
        'dist/index.d.ts': [
          'export interface Icon { path: string }',
          ...icons,
          'export declare const other: string;',
          '/** Documented, so it stays a row. */',
          'export declare const Documented: Icon;',
        ].join('\n'),
      },
      { '.': entry('index') },
    );
    const built = buildApiIndex(dir);
    expect(built.index.entries.map(e => e.name)).toEqual(['Documented', 'Icon', 'other']);
    expect(built.index.groups).toEqual([
      { subpath: '.', kind: 'variable', signature: 'Icon', count: GROUP_THRESHOLD, namesFile: 'api-names/_root-1.json' },
    ]);
    writeApiIndex(built, path.join(dir, 'dist', 'api.json'));
    const [group] = built.index.groups;
    expect(group && namesReaderFor(path.join(dir, 'dist', 'api.json'))(group)).toEqual(icons.map(line => /const (\w+)/.exec(line)?.[1]));
  });

  it('keeps one row per export below the threshold', () => {
    // Why: for a handful of names the extra file costs more than the rows it saves.
    const lines = Array.from({ length: GROUP_THRESHOLD - 1 }, (_, i) => `export declare const v${String(i)}: string;`);
    const dir = builtPackage({ 'dist/index.d.ts': lines.join('\n') }, { '.': entry('index') });
    const { index } = buildApiIndex(dir);
    expect(index.groups).toEqual([]);
    expect(index.entries).toHaveLength(GROUP_THRESHOLD - 1);
  });
});
