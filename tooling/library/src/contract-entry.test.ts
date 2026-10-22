import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkContractEntry } from './contract-entry';
import { readManifest } from './manifest';

/** A package with `files` written relative to its folder; `exports` goes into its manifest. */
function packageDir(exports: object, files: Record<string, string>): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'arki-contract-entry-')), 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@arki/demo', private: true, exports }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

const contractExport = { './contract': { types: './src/contract.ts', import: './src/contract.ts' } };

function check(dir: string) {
  return checkContractEntry(dir, readManifest(dir));
}

describe('checkContractEntry', () => {
  it('passes a contract entry that bundles for the browser', () => {
    const dir = packageDir(contractExport, {
      'src/contract.ts': "export { NotFound } from './failures';",
      'src/failures.ts': "export const NotFound = { code: 'demo.not_found' } as const;",
    });
    expect(check(dir)).toEqual({ errors: [], warnings: [] });
  });

  it('ignores a library without a contract entry, because a browser-safe root needs none', () => {
    const dir = packageDir({ '.': { types: './src/index.ts', import: './src/index.ts' } }, {
      'src/index.ts': "import { readFileSync } from 'node:fs'; export const read = readFileSync;",
    });
    expect(check(dir)).toEqual({ errors: [], warnings: [] });
  });

  it('fails an entry that reaches a Node built-in, because a browser contract would not bundle', () => {
    const dir = packageDir(contractExport, {
      'src/contract.ts': "export { NotFound } from './failures';",
      'src/failures.ts': "import { readFileSync } from 'node:fs'; export const NotFound = readFileSync;",
    });
    const { errors } = check(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^CONTRACT_E001 export "\.\/contract" does not bundle for the browser: .*node:fs/);
  });

  it('fails an entry that bundles a server-only package, even when every import resolves', () => {
    const dir = packageDir(contractExport, {
      'src/contract.ts': "import { Queue } from 'bullmq'; export const failures = [Queue];",
      'node_modules/bullmq/package.json': JSON.stringify({ name: 'bullmq', main: 'index.js' }),
      'node_modules/bullmq/index.js': 'export class Queue {}',
    });
    expect(check(dir).errors).toEqual(['CONTRACT_E001 export "./contract" bundles server-only code: bullmq']);
  });

  it('fails a "./contracts" entry, because the browser-safe contract entry has one name', () => {
    const dir = packageDir({ './contracts': { types: './src/contracts.ts', import: './src/contracts.ts' } }, {
      'src/contracts.ts': 'export const x = 1;',
    });
    expect(check(dir).errors).toEqual([
      'CONTRACT_E002 export "./contracts": the browser-safe contract entry is "./contract"',
    ]);
  });

  it('warns and skips an entry that is not built yet, because library-check runs before build', () => {
    const dir = packageDir({ './contract': { types: './dist/contract.d.ts', import: './dist/contract.js' } }, {});
    expect(check(dir)).toEqual({
      errors: [],
      warnings: ['CONTRACT_W001 export "./contract" not built (./dist/contract.js): browser bundle check skipped'],
    });
  });
});
