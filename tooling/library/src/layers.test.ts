import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkLayers, packageNameOf, parseImports } from './layers';

type Fixture = {
  readonly tag: string;
  readonly manifest?: object;
  readonly files: Record<string, string>;
};

/** A tiny repo: root turbo.json with the real tag rules, plus the given workspaces under packages/. */
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
        },
      },
    }),
  );
  for (const [folder, fixture] of Object.entries(workspaces)) {
    const dir = path.join(root, 'packages', folder);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'turbo.json'), JSON.stringify({ tags: [fixture.tag] }));
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: `@arki/${folder}`, exports: { '.': './src/index.ts' }, ...fixture.manifest }),
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
        files: { 'src/index.ts': "export * from './hook';", 'src/hook.ts': "import { useState } from 'react';\nexport { useState };" },
      },
    });
    const findings = checkLayers({ root });
    expect(findings.map(f => [f.rule, f.file.split(path.sep).at(-1), f.line])).toEqual([['L003', 'hook.ts', 1]]);
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
