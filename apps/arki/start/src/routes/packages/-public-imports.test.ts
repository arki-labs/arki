import { describe, expect, it } from 'vitest';

import type { ApiIndex } from '@arki/library-tooling/api-index-schema';

import { publicImports } from './-public-imports';

const entry = (subpath: string, name: string, kind: 'function' | 'type') => ({
  subpath,
  name,
  kind,
  signature: '',
  jsdocSummary: '',
});

describe('publicImports', () => {
  // Readers copy the import path, so `.` must become the bare package name and `./cli` a deep import.
  it('groups names by subpath and turns subpaths into import paths', () => {
    const index: ApiIndex = {
      package: '@arki/dot',
      version: '0.7.0',
      entries: [entry('.', 'defineApp', 'function'), entry('./cli', 'run', 'function'), entry('.', 'App', 'type')],
      groups: [],
      errorCodes: [],
    };
    expect(publicImports(index)).toEqual([
      {
        importPath: '@arki/dot',
        names: [
          { name: 'defineApp', kind: 'function' },
          { name: 'App', kind: 'type' },
        ],
        groups: [],
      },
      { importPath: '@arki/dot/cli', names: [{ name: 'run', kind: 'function' }], groups: [] },
    ]);
  });

  // Icon packages export thousands of names of one type; the page shows "N names of type X", not every name.
  it('keeps grouped exports as counts, even on a subpath with no named entries', () => {
    const index: ApiIndex = {
      package: '@arki/icons',
      version: '0.1.2',
      entries: [],
      groups: [{ subpath: './phosphor', kind: 'variable', signature: 'Icon', count: 1512, namesFile: 'a.json' }],
      errorCodes: [],
    };
    expect(publicImports(index)).toEqual([
      { importPath: '@arki/icons/phosphor', names: [], groups: [{ kind: 'variable', signature: 'Icon', count: 1512 }] },
    ]);
  });
});
