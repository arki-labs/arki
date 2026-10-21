import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ApiEntry, ApiGroup, ApiIndex, NamesReader } from './api-index';
import type { ApiSide } from './api-diff';
import { diffApi, findDocMentions } from './api-diff';

const api = (...entries: ApiEntry[]): ApiSide => ({
  index: { package: '@arki/demo', version: '1.0.0', entries, groups: [], errorCodes: [] },
  namesOf: () => [],
});
const grouped = (signature: string, names: readonly string[], entries: ApiEntry[] = []): ApiSide => {
  const group: ApiGroup = { subpath: '.', kind: 'variable', signature, count: names.length, namesFile: 'api-names/index-1.json' };
  const index: ApiIndex = { package: '@arki/demo', version: '1.0.0', entries, groups: [group], errorCodes: [] };
  const namesOf: NamesReader = () => names;
  return { index, namesOf };
};
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

describe('diffApi with grouped exports', () => {
  const names = ['A', 'B', 'C'];

  it('still sees one removed name inside a group', () => {
    // Why: dropping one icon breaks every importer of it; grouping must not hide that.
    const diff = diffApi(grouped('Icon', names), grouped('Icon', ['A', 'C']));
    expect(diff.removed.map(e => e.name)).toEqual(['B']);
    expect(diff.added).toEqual([]);
    expect(diff.changedGroups).toEqual([]);
  });

  it('sees an added name inside a group', () => {
    // Why: additions feed the upgrade guide's "Added" list.
    const diff = diffApi(grouped('Icon', names), grouped('Icon', [...names, 'D']));
    expect(diff.added.map(e => e.name)).toEqual(['D']);
  });

  it('reports a shared type change once for the whole group', () => {
    // Why: 22,000 identical lines in an upgrade guide hide the one fact that matters.
    const diff = diffApi(grouped('Icon', names), grouped('Icon2', names));
    expect(diff.changed).toEqual([]);
    expect(diff.changedGroups).toEqual([{ subpath: '.', kind: 'variable', from: 'Icon', to: 'Icon2', count: 3 }]);
  });

  it('reports nothing for names that move between a group and plain entries at the threshold', () => {
    // Why: a package growing from 49 to 50 icons must not look like 49 signature changes.
    const plainEntries = names.map(name => ({ subpath: '.', name, kind: 'variable' as const, signature: `export declare const ${name}: Icon;`, jsdocSummary: '' }));
    const diff = diffApi(api(...plainEntries), grouped('Icon', names));
    expect(diff).toEqual({ added: [], removed: [], changed: [], changedGroups: [] });
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
