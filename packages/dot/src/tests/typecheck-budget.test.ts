/**
 * Type-check budget for the app builder's list guard. `bench/typecheck/gen-features.mjs N`
 * writes an app of N chained features (feature i needs i-1 and i-2 through the graph) and
 * `tsc --extendedDiagnostics` reports how many type instantiations checking it took. The
 * guard walks the list by index (`tuple-index.ts`), so the count grows gently with N; a
 * change that brings back a per-step re-slice or a whole-record comparison trips these
 * ceilings (counts, not seconds: stable on a busy machine). Measured 2026-10-16: 340,081 at
 * N=50 and 937,481 at N=100 (before the index walk: 766,013 and 2,650,513).
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

/** Generate the N-feature app (alone in `.generated/`) and return tsc's instantiation count. */
function instantiationsFor(features: number): { readonly instantiations: number; readonly errors: readonly string[] } {
  rmSync(new URL('../../bench/typecheck/.generated', import.meta.url), { recursive: true, force: true });
  const gen = spawnSync(process.execPath, ['bench/typecheck/gen-features.mjs', String(features)], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  expect(gen.status, gen.stderr).toBe(0);
  const check = spawnSync(process.execPath, [tsc, '-p', 'bench/typecheck/tsconfig.json', '--extendedDiagnostics'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  const output = `${check.stdout}\n${check.stderr}`;
  const match = /^Instantiations:\s+(\d+)/m.exec(output);
  expect(match, output.slice(0, 2000)).not.toBeNull();
  return {
    instantiations: Number(match?.[1]),
    errors: output.split('\n').filter(line => line.includes('error TS')),
  };
}

describe('type-check budget: mounting N features', () => {
  it('50 features stay under 400k instantiations and type-check clean', { timeout: 120_000 }, () => {
    const { instantiations, errors } = instantiationsFor(50);
    expect(errors).toEqual([]);
    expect(instantiations).toBeLessThanOrEqual(400_000);
  });

  it('100 features stay under 1.1M instantiations and type-check clean', { timeout: 120_000 }, () => {
    const { instantiations, errors } = instantiationsFor(100);
    expect(errors).toEqual([]);
    expect(instantiations).toBeLessThanOrEqual(1_100_000);
  });
});
