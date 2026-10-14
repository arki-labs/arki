/**
 * The root entry must stay light
 *
 * `import '@arki/testing'` must not need Docker, msw or `@arki/auth`. Those live behind
 * explicit entries (`./containers`, `./integration-tester`, `./tester-builder`, `./msw`).
 * This test follows every runtime (non-type) import reachable from `src/index.ts` and fails
 * if one lands on a heavy package or a heavy local file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

const HEAVY_PACKAGES = [/^testcontainers/, /^@testcontainers\//, /^msw(\/|$)/, /^@arki\/auth(\/|$)/];
const HEAVY_FILES = ['containers', 'integration-tester', 'tester-builder', 'msw'];

// Matches `import ... from 'x'`, `export ... from 'x'` and `import 'x'`, but not `import type` / `export type`.
const specifierPattern = /^(?:import|export)\s(?!type\s)[^'";]*?from\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm;

function runtimeSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(specifierPattern)].map((m) => m[1] ?? m[2] ?? '');
}

function walk(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    for (const spec of runtimeSpecifiers(file)) {
      if (spec.startsWith('.')) queue.push(`${path.resolve(path.dirname(file), spec)}.ts`);
      else packages.add(spec);
    }
  }
  return { files: [...files], packages: [...packages] };
}

describe('root entry', () => {
  const graph = walk(path.resolve(srcDir, 'index.ts'));

  it('reaches no heavy local file', () => {
    const names = graph.files.map((f) => f.slice(srcDir.length + 1).replace(/\.ts$/, ''));
    for (const heavy of HEAVY_FILES) expect(names).not.toContain(heavy);
  });

  it('reaches no Docker client, msw or @arki/auth at runtime', () => {
    const hits = graph.packages.filter((p) => HEAVY_PACKAGES.some((re) => re.test(p)));
    expect(hits).toEqual([]);
  });

  it('still sees the files it should (guards the walker itself)', () => {
    expect(graph.files.length).toBeGreaterThan(5);
    expect(graph.packages).toContain('@faker-js/faker');
  });
});
