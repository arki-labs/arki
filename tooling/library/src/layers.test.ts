import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isAdapterSubpath } from './adapters';
import { checkLayers, packageNameOf, parseImports, readBaseline, staleBaselineEntries } from './layers';

type Fixture = {
  readonly tag: string;
  /** Top-level folder; `packages` when omitted. */
  readonly group?: 'packages' | 'fleet';
  /** Package name; `@arki/<folder>` when omitted. */
  readonly name?: string;
  readonly manifest?: object;
  readonly files: Record<string, string>;
};

/** A tiny repo: root turbo.json with the real tag rules, plus the given workspaces under packages/ (or fleet/). */
function repo(workspaces: Record<string, Fixture>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'arki-layers-'));
  writeFileSync(
    path.join(root, 'turbo.json'),
    JSON.stringify({
      boundaries: {
        tags: {
          foundation: { dependencies: { allow: ['foundation', 'tooling'] } },
          platform: { dependencies: { allow: ['foundation', 'platform', 'tooling'] } },
          web: { dependencies: { allow: ['foundation', 'platform', 'web', 'tooling'], deny: ['@arki/db'] } },
          fleet: { dependencies: { allow: ['foundation', 'platform', 'web', 'fleet', 'tooling'] } },
        },
      },
    }),
  );
  for (const [folder, fixture] of Object.entries(workspaces)) {
    const dir = path.join(root, fixture.group ?? 'packages', folder);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'turbo.json'), JSON.stringify({ tags: [fixture.tag] }));
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: fixture.name ?? `@arki/${folder}`,
        exports: { '.': './src/index.ts' },
        ...fixture.manifest,
      }),
    );
    for (const [file, text] of Object.entries(fixture.files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    }
  }
  return root;
}

const reactPeer = {
  peerDependencies: { react: '^19' },
  peerDependenciesMeta: { react: { optional: true } },
  devDependencies: { react: '^19' },
};

describe('checkLayers', () => {
  it('flags a portable entry that reaches an optional peer (L003), because it breaks when the peer is absent', () => {
    const root = repo({
      demo: {
        tag: 'foundation',
        manifest: reactPeer,
        files: {
          'src/index.ts': "export * from './hook';",
          'src/hook.ts': "import { useState } from 'react';\nexport { useState };",
        },
      },
    });
    const findings = checkLayers({ root });
    expect(findings.map(f => [f.rule, f.file.split(path.sep).at(-1), f.line])).toEqual([['L003', 'hook.ts', 1]]);
  });

  it('allows a lazy import() of an optional peer from a portable entry, because nothing loads until it runs', () => {
    const root = repo({
      demo: {
        tag: 'foundation',
        manifest: reactPeer,
        files: { 'src/index.ts': "export const load = () => import('react');" },
      },
    });
    expect(checkLayers({ root })).toEqual([]);
  });

  it('lets an adapter entry import its own optional peer and a web package, whatever the layer (P3)', () => {
    const root = repo({
      ui: { tag: 'web', files: { 'src/index.ts': 'export const ui = 1;' } },
      demo: {
        tag: 'platform',
        manifest: {
          exports: { '.': './src/index.ts', './react': './src/react.ts' },
          peerDependencies: { '@arki/ui': 'workspace:*', react: '^19' },
          peerDependenciesMeta: { '@arki/ui': { optional: true }, react: { optional: true } },
        },
        files: {
          'src/index.ts': 'export const core = 1;',
          'src/react.ts': "import { ui } from '@arki/ui';\nimport { useState } from 'react';\nexport { ui, useState };",
        },
      },
    });
    expect(checkLayers({ root, only: '@arki/demo' })).toEqual([]);
  });

  it('flags an undeclared import (L001) and a devDependency used by shipped code, but allows it in tests', () => {
    const root = repo({
      demo: {
        tag: 'foundation',
        manifest: { devDependencies: { vitest: '^4', zod: '^4' } },
        files: {
          'src/index.ts': "import { z } from 'zod';\nimport { left } from 'left-pad';\nexport { z, left };",
          'src/index.test.ts': "import { it } from 'vitest';\nexport { it };",
        },
      },
    });
    const findings = checkLayers({ root });
    expect(findings.map(f => [f.rule, f.specifier, f.line])).toEqual([
      ['L001', 'zod', 1],
      ['L001', 'left-pad', 2],
    ]);
  });

  it('accepts a type-only import of a package backed by its @types package in shipped code', () => {
    const root = repo({
      demo: {
        tag: 'foundation',
        manifest: { dependencies: { '@types/mdast': '^4' } },
        files: { 'src/index.ts': "import type { Root } from 'mdast';\nexport type { Root };" },
      },
    });
    expect(checkLayers({ root })).toEqual([]);
  });

  it('flags a workspace import whose tag the importer may not use (L002) and a denied devDependency edge (L004)', () => {
    const root = repo({
      db: { tag: 'platform', files: { 'src/index.ts': 'export const db = 1;' } },
      core: { tag: 'foundation', files: { 'src/index.ts': 'export const core = 1;' } },
      app: {
        tag: 'web',
        manifest: { dependencies: { '@arki/db': 'workspace:*' }, devDependencies: { '@arki/db': 'workspace:*' } },
        files: { 'src/index.ts': "import { db } from '@arki/db';\nexport { db };" },
      },
      lower: {
        tag: 'foundation',
        manifest: { dependencies: { '@arki/core': 'workspace:*' }, devDependencies: { '@arki/db': 'workspace:*' } },
        files: { 'src/index.ts': "import { core } from '@arki/core';\nexport { core };" },
      },
    });
    const found = checkLayers({ root }).map(f => `${f.package} ${f.rule} ${f.specifier}`);
    expect(found).toContain('@arki/app L002 @arki/db');
    expect(found).toContain('@arki/app L004 @arki/db');
    expect(found).toContain('@arki/lower L004 @arki/db');
    expect(found.filter(line => line.startsWith('@arki/lower'))).toEqual(['@arki/lower L004 @arki/db']);
  });
});

describe('parseImports', () => {
  it('finds static, re-export and dynamic imports and marks type-only ones', () => {
    const text = [
      "import a from 'a';",
      "import type { B } from 'b';",
      "import { type C, type D } from 'c';",
      "export * from 'd';",
      "export type { E } from 'e';",
      "const f = () => import('f');",
      "type G = import('g').G;",
    ].join('\n');
    expect(parseImports('x.ts', text).map(i => [i.specifier, i.typeOnly])).toEqual([
      ['a', false],
      ['b', true],
      ['c', true],
      ['d', false],
      ['e', true],
      ['f', false],
      ['g', true],
    ]);
  });
});

describe('packageNameOf', () => {
  it('maps specifiers to package names and drops what is not an npm package', () => {
    expect(packageNameOf('@arki/ui/button')).toBe('@arki/ui');
    expect(packageNameOf('lodash/fp')).toBe('lodash');
    for (const ignored of ['./x', 'node:fs', 'fs', 'bun', 'bun:test', 'virtual:pwa', '#internal', '@/x', '~x']) {
      expect(packageNameOf(ignored)).toBeUndefined();
    }
  });
});

describe('staleBaselineEntries', () => {
  const finding = {
    package: '@arki/a',
    rule: 'L003',
    file: 'packages/a/src/hook.ts',
    line: 1,
    specifier: 'react',
    message: 'm',
    reach: 'portable',
  } as const;
  const entry = {
    package: '@arki/a',
    rule: 'L003',
    specifier: 'react',
    file: 'packages/a/src/hook.ts',
    reason: 'why',
  } as const;

  it('keeps an entry that still matches a live finding, so the known problem stays visible', () => {
    expect(staleBaselineEntries([entry], [finding])).toEqual([]);
  });

  it('reports an entry whose finding is gone, because the baseline may only shrink', () => {
    expect(staleBaselineEntries([entry], [])).toEqual([entry]);
    expect(staleBaselineEntries([{ ...entry, file: 'packages/a/src/other.ts' }], [finding])).toHaveLength(1);
    expect(staleBaselineEntries([{ ...entry, specifier: 'zod' }], [finding])).toHaveLength(1);
  });

  it('judges only the requested package, since other packages were not checked', () => {
    expect(staleBaselineEntries([entry], [], '@arki/b')).toEqual([]);
    expect(staleBaselineEntries([entry], [], '@arki/a')).toEqual([entry]);
  });
});

describe('isAdapterSubpath', () => {
  it('treats ./cli as an adapter because a command-line entry names a role (Node-only), not a library', () => {
    expect(isAdapterSubpath('./cli')).toBe(true);
    expect(isAdapterSubpath('./cli/render')).toBe(true);
  });

  it('treats entries named for the dependency they adapt to as adapters, and plain names as portable', () => {
    for (const name of ['zod', 'tanstack', 'orpc', 'sentry', 'mastra', 'pg', 'http', 'react']) {
      expect(isAdapterSubpath(`./${name}`)).toBe(true);
    }
    expect(isAdapterSubpath('./sentry/client')).toBe(true);
    expect(isAdapterSubpath('./serialize')).toBe(false);
    expect(isAdapterSubpath('./client')).toBe(false);
  });
});

// The direction is apps -> fleet -> Arki. An Arki package that reaches into fleet/ could never be released.
describe('checkLayers L005 (Arki -> fleet)', () => {
  const fleetShared: Fixture = {
    tag: 'fleet',
    group: 'fleet',
    name: '@fleet/shared',
    manifest: { private: true },
    files: { 'src/index.ts': 'export const shared = 1;' },
  };

  it('flags @fleet/* in optionalDependencies, because a manifest dep alone breaks the Arki release', () => {
    const root = repo({
      demo: {
        tag: 'foundation',
        manifest: { optionalDependencies: { '@fleet/shared': 'workspace:*' } },
        files: { 'src/index.ts': 'export const x = 1;' },
      },
    });
    expect(checkLayers({ root }).map(f => [f.rule, f.specifier, f.file])).toEqual([
      ['L005', '@fleet/shared', path.join('packages', 'demo', 'package.json')],
    ]);
  });

  it.each(['dependencies', 'devDependencies', 'peerDependencies'])('flags @fleet/* in %s too', bucket => {
    const root = repo({
      demo: {
        tag: 'foundation',
        manifest: { [bucket]: { '@fleet/shared': 'workspace:*' } },
        files: { 'src/index.ts': 'export const x = 1;' },
      },
    });
    expect(checkLayers({ root }).map(f => f.rule)).toEqual(['L005']);
  });

  it('flags an import of @fleet/* even from an adapter file that declares it as an optional peer', () => {
    const root = repo({
      demo: {
        tag: 'web',
        manifest: {
          exports: { '.': './src/index.ts', './react': './src/react.ts' },
          peerDependencies: { '@fleet/shared': 'workspace:*' },
          peerDependenciesMeta: { '@fleet/shared': { optional: true } },
        },
        files: {
          'src/index.ts': 'export const x = 1;',
          'src/react.ts': "import { shared } from '@fleet/shared';\nexport { shared };",
        },
      },
      shared: fleetShared,
    });
    const findings = checkLayers({ root });
    expect(findings.map(f => [f.rule, f.file.split(path.sep).at(-1)])).toEqual([
      ['L005', 'package.json'],
      ['L005', 'react.ts'],
    ]);
  });

  it('lets a fleet package import Arki, because fleet sits above Arki', () => {
    const root = repo({
      core: { tag: 'foundation', files: { 'src/index.ts': 'export const core = 1;' } },
      shared: {
        ...fleetShared,
        manifest: { private: true, dependencies: { '@arki/core': 'workspace:*' } },
        files: { 'src/index.ts': "export { core } from '@arki/core';" },
      },
    });
    expect(checkLayers({ root })).toEqual([]);
  });

  it('never lets a baseline entry waive L005, so the Arki -> fleet ban cannot rot into a known finding', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'arki-layers-baseline-')), 'baseline.json');
    const entry = { package: '@arki/demo', specifier: '@fleet/shared', reason: 'try to waive it' };
    writeFileSync(file, JSON.stringify({ entries: [{ ...entry, rule: 'L005' }] }));
    expect(() => readBaseline(file)).toThrow();
    writeFileSync(file, JSON.stringify({ entries: [{ ...entry, rule: 'L004' }] }));
    expect(readBaseline(file)).toEqual([{ ...entry, rule: 'L004' }]);
  });
});
