import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Warning } from '../core/types.js';
import type { DeclaredNode } from './node-version.js';
import { findDeclaredNode, satisfiesNode, withNodeVersionCheck } from './node-version.js';
import { currentRuntime, workerExecutable } from './run.js';

describe('satisfiesNode', () => {
  it.each([
    ['26.11.0', 'v26', true],
    ['22.13.1', 'v26', false],
    ['26.11.0', '26.11', true],
    ['26.10.2', '26.11', false],
    ['22.13.1', '22.13.1', true],
    ['22.13.2', '22.13.1', false],
    ['22.13.1', '>=22.10', true],
    ['22.9.0', '>=22.10', false],
    ['26.0.0', '^26', true],
    ['27.0.0', '^26', false],
    ['22.13.1', '~22.13', true],
    ['22.14.0', '~22.13', false],
    ['24.0.0', '>=20 <24', false],
    ['22.0.0', '>=20 <24', true],
    ['18.0.0', '20 || 22', false],
    ['22.1.0', '20 || 22', true],
    ['26.1.0', '26.x', true],
    ['26.1.0', '*', true],
  ])('Node %s against %s is %s', (version, range, expected) => {
    expect(satisfiesNode(version, range)).toBe(expected);
  });

  it('does not judge a declaration it cannot read, so it never blocks a run', () => {
    expect(satisfiesNode('22.13.1', 'lts/*')).toBeUndefined();
    expect(satisfiesNode('22.13.1', 'node')).toBeUndefined();
    expect(satisfiesNode('22.13.1', '')).toBeUndefined();
  });
});

describe('findDeclaredNode', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'arki-bench-node-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const make = (relative: string, files: Record<string, string>): string => {
    const dir = path.join(root, relative);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    return path.join(dir, 'x.bench.ts');
  };

  it('reads .nvmrc from a parent directory', () => {
    const file = make('a/pkg/bench', {});
    writeFileSync(path.join(root, 'a', '.nvmrc'), 'v26\n');
    make('a/pkg', { 'package.json': '{"name":"p"}' });
    expect(findDeclaredNode(file)).toEqual({ source: path.join(root, 'a', '.nvmrc'), range: 'v26' });
  });

  it('prefers a pin up the tree over a package engines range, which only says what the library supports', () => {
    const file = make('b/pkg', { 'package.json': '{"engines":{"node":">=22"}}' });
    writeFileSync(path.join(root, 'b', '.node-version'), '26.1.0\n');
    expect(findDeclaredNode(file)?.range).toBe('26.1.0');
  });

  it('reads volta, then engines when nothing pins', () => {
    expect(
      findDeclaredNode(make('c', { 'package.json': '{"volta":{"node":"26.2.0"},"engines":{"node":">=20"}}' }))?.range,
    ).toBe('26.2.0');
    expect(findDeclaredNode(make('d', { 'package.json': '{"engines":{"node":">=20"}}' }))?.range).toBe('>=20');
  });
});

const base = (name: string, version: string) => ({
  environment: { runtime: { name, version } },
  warnings: [] as readonly Warning[],
  publishable: true,
});

describe('withNodeVersionCheck', () => {
  const undeclared = undefined as DeclaredNode | undefined;
  const declared = { source: '/repo/.nvmrc', range: 'v26' };

  it('blocks publishing and names both versions when Node is older than the target', () => {
    const result = withNodeVersionCheck(base('node', '22.13.1'), declared);
    expect(result.publishable).toBe(false);
    expect(result.warnings[0]?.code).toBe('node-version-mismatch');
    expect(result.warnings[0]?.message).toMatch(/Node 22\.13\.1.*Node v26.*\/repo\/\.nvmrc/);
  });

  it('leaves a matching Node, other runtimes and undeclared projects alone', () => {
    const ok = base('node', '26.11.0');
    expect(withNodeVersionCheck(ok, declared)).toBe(ok);
    const bun = base('bun', '1.4.2');
    expect(withNodeVersionCheck(bun, declared)).toBe(bun);
    const old = base('node', '22.13.1');
    expect(withNodeVersionCheck(old, undeclared)).toBe(old);
  });
});

describe('workerExecutable', () => {
  it('uses the given Node binary for the Node leg, and this process otherwise', () => {
    expect(workerExecutable('node', '/opt/node26/bin/node')).toBe('/opt/node26/bin/node');
    if (currentRuntime() === 'node') expect(workerExecutable('node')).toBe(process.execPath);
    expect(workerExecutable('bun', '/opt/node26/bin/node')).toBe(currentRuntime() === 'bun' ? process.execPath : 'bun');
  });
});
