import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { SuiteSpec } from './core/index.js';
import { validateSuite } from './core/index.js';

const isSuite = (value: unknown): value is SuiteSpec =>
  typeof value === 'object' && value !== null && 'groups' in value;

// The README quick start shows examples/sum.bench.ts. This test keeps that file a valid suite.
async function loadExampleSuite(file: string): Promise<SuiteSpec> {
  const loaded: unknown = await import(pathToFileURL(path.join(import.meta.dirname, '../examples', file)).href);
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded))
    throw new Error(`${file} has no default export`);
  const suite = loaded.default;
  if (!isSuite(suite)) throw new Error(`${file} does not export a suite`);
  return suite;
}

describe('examples/sum.bench.ts', () => {
  it('is a valid suite whose cases satisfy their own contract', async () => {
    const suite = await loadExampleSuite('sum.bench.ts');
    expect(() => validateSuite(suite)).not.toThrow();
    expect(suite.groups.map(group => group.id)).toEqual(['sum']);
  });
});
