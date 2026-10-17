import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ApiEntry, ApiIndex } from './api-index';
import { diffApi, findDocMentions } from './api-diff';

const api = (...entries: ApiEntry[]): ApiIndex => ({ package: '@arki/demo', version: '1.0.0', entries, errorCodes: [] });
const fn = (name: string, signature: string, subpath = '.'): ApiEntry => ({
  subpath,
  name,
  kind: 'function',
  signature,
  jsdocSummary: '',
});

describe('diffApi', () => {
  it('reports added, removed and changed names', () => {
    // Why: a release reviewer needs to see breaking removals and signature edits before publishing.
    const before = api(fn('keep', 'a(): void'), fn('gone', 'g(): void'), fn('edit', 'e(x: string): void'));
    const after = api(fn('keep', 'a(): void'), fn('fresh', 'f(): void'), fn('edit', 'e(x: number): void'));
    const diff = diffApi(before, after);
    expect(diff.added.map(e => e.name)).toEqual(['fresh']);
    expect(diff.removed.map(e => e.name)).toEqual(['gone']);
    expect(diff.changed).toEqual([{ subpath: '.', name: 'edit', from: 'e(x: string): void', to: 'e(x: number): void' }]);
  });

  it('treats the same name on another subpath as a different export', () => {
    // Why: moving an export between entry points breaks importers even though the name survives.
    const diff = diffApi(api(fn('x', 'x(): void', '.')), api(fn('x', 'x(): void', './sub')));
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.changed).toEqual([]);
  });
});

describe('findDocMentions', () => {
  it('finds whole-word mentions with file and line in README, docs and llms.txt', () => {
    // Why: a removed or changed name left in the docs is a lie shipped to users.
    const dir = mkdtempSync(path.join(tmpdir(), 'arki-api-diff-'));
    mkdirSync(path.join(dir, 'docs', 'guide'), { recursive: true });
    writeFileSync(path.join(dir, 'README.md'), '# Demo\nCall `oldFn()` first.\n');
    writeFileSync(path.join(dir, 'docs', 'guide', 'use.md'), 'nothing\nuse oldFnExtra here\nand oldFn again\n');
    writeFileSync(path.join(dir, 'llms.txt'), 'oldFn\n');
    const mentions = findDocMentions(dir, ['oldFn']);
    expect(mentions.map(m => `${m.file}:${m.line}`)).toEqual(['README.md:2', 'llms.txt:1', 'docs/guide/use.md:3']);
  });
});
