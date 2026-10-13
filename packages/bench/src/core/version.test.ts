import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { MITATA_VERSION, VERSION } from './version.js';

function versionIn(file: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return typeof parsed === 'object' && parsed !== null && 'version' in parsed ? parsed.version : undefined;
}

describe('version constants', () => {
  // Every result records these; a stale constant would mislabel published numbers.
  it('match the package version', () => {
    expect(VERSION).toBe(versionIn(new URL('../../package.json', import.meta.url).pathname));
  });

  it('match the installed mitata, which the measurement loop (and a deep import in the CLI) depend on', () => {
    const require = createRequire(import.meta.url);
    expect(MITATA_VERSION).toBe(versionIn(require.resolve('mitata/package.json')));
  });
});
