/**
 * Guards the "runs everywhere" promise: Node, Bun, Deno, browsers, and React Native (Hermes).
 * Library source may use only ECMAScript 2022 plus Unicode property escapes. Anything host-specific
 * or newer must go through a feature check (`Intl.Segmenter` in `internal/graphemes.ts` is the only
 * one) so the fallback path stays exercised.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.join(import.meta.dirname, '.');

const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/\bfrom ['"]node:/, 'Node built-in import'],
  [/\brequire\(/, 'CommonJS require'],
  [/\bBuffer\b/, 'Node Buffer'],
  [/\bprocess\.\w/, 'Node process'],
  [/__(?:dirname|filename)\b/, 'Node module globals'],
  [/\b(?:window|document|navigator)\./, 'browser globals'],
  [/\b(?:Deno|Bun)\./, 'runtime-specific globals'],
  [/\b(?:atob|btoa|fetch|structuredClone|queueMicrotask|setTimeout)\(/, 'host functions'],
  [/\bText(?:Encoder|Decoder)\b/, 'TextEncoder/TextDecoder (missing on older Hermes)'],
  [/\.(?:toSorted|toReversed|toSpliced|with)\(/, 'ES2023 change-array-by-copy (missing on older engines)'],
  [/\bObject\.groupBy\b|\bPromise\.withResolvers\b|\bArray\.fromAsync\b/, 'ES2024 built-ins'],
  [
    /\bSet\.prototype\.(?:union|intersection|difference)|\.(?:union|intersection|difference|isSubsetOf)\(/,
    'ES2025 Set methods',
  ],
];

function sourceFiles(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') result.push(...sourceFiles(entryPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      result.push(entryPath);
    }
  }
  return result;
}

describe('runtime portability', () => {
  const files = sourceFiles(SOURCE_ROOT);

  it('scans the library source', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it('uses no host-specific or post-ES2022 APIs in library source', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
        for (const [pattern, reason] of FORBIDDEN) {
          if (pattern.test(line))
            violations.push(`${path.relative(SOURCE_ROOT, file)}:${index + 1} ${reason}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('feature-detects Intl.Segmenter in exactly one place', () => {
    const users = files.filter(file => readFileSync(file, 'utf8').includes('Intl.Segmenter'));
    expect(users.map(file => path.relative(SOURCE_ROOT, file))).toEqual(['internal/graphemes.ts']);
    expect(readFileSync(path.join(SOURCE_ROOT, 'internal/graphemes.ts'), 'utf8')).toMatch(
      /typeof Intl\.Segmenter|'Segmenter' in Intl/,
    );
  });
});
