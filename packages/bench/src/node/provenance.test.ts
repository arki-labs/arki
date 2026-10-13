import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { BenchResult } from '../core/types.js';
import { applyLoadCheck, collectProvenance } from './provenance.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function version(packageJson: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(packageJson, 'utf8'));
  return typeof parsed === 'object' && parsed !== null && 'version' in parsed ? parsed.version : undefined;
}

function result(overrides: Partial<BenchResult> = {}): BenchResult {
  return {
    schema: 1,
    suite: { id: 'demo', title: 'Benchmarks', notes: [], specHash: 'abc' },
    profile: 'publish',
    seed: 1,
    publishable: true,
    warnings: [],
    environment: {
      runtime: { name: 'node', version: process.versions.node },
      flags: [],
      // The core's compiled-in constants; provenance must replace them with what is installed.
      harness: { version: 'core-constant', mitata: 'core-constant' },
      date: '2026-10-13T00:00:00.000Z',
    },
    packages: { '@arki/bench': 'core-constant', mitata: 'core-constant' },
    groups: [
      {
        kind: 'metric',
        id: 'm',
        title: 'M',
        unit: 'things',
        baseline: 'a',
        cases: [
          { key: 'a', label: 'a', role: 'baseline', package: 'mitata', summary: summaryOf(1), flags: [] },
          {
            key: 'b',
            label: 'b',
            role: 'competitor',
            package: 'arki-bench-no-such-package',
            summary: summaryOf(2),
            flags: [],
          },
        ],
        comparisons: [],
      },
    ],
    ...overrides,
  };
}

function summaryOf(value: number): BenchResult['groups'][number]['cases'][number]['summary'] {
  return {
    estimate: value,
    interval: [value, value],
    median: value,
    min: value,
    max: value,
    p75: value,
    p99: value,
    cv: 0,
    n: 1,
  };
}

describe('collectProvenance', () => {
  it('records the installed versions a reader needs to reproduce the run', async () => {
    const collected = await collectProvenance(result(), { cwd: packageRoot });
    const mitata = version(createRequire(path.join(packageRoot, 'package.json')).resolve('mitata/package.json'));
    const own = version(path.join(packageRoot, 'package.json'));

    expect(collected.packages.mitata).toBe(mitata);
    expect(collected.packages['@arki/bench']).toBe(own);
    expect(collected.environment.harness).toEqual({ version: own, mitata });
    // A competitor that is not installed is recorded honestly, never guessed.
    expect(collected.packages['arki-bench-no-such-package']).toBe('unknown');
    expect(collected.warnings).toContainEqual(expect.objectContaining({ code: 'package-version-unknown' }));
  });

  it('records the machine, flags and source revision', async () => {
    const collected = await collectProvenance(result(), { cwd: packageRoot });
    const environment = collected.environment;
    expect(environment.git?.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof environment.git?.dirty).toBe('boolean');
    expect(environment.cores).toBeGreaterThan(0);
    expect(environment.os).toBeTruthy();
    expect(environment.arch).toBe(process.arch);
    expect(environment.flags).toEqual(process.execArgv);
    expect(environment.load).toHaveLength(2);
  });

  it('keeps the load the host recorded around the run and is safe to call twice', async () => {
    const once = await collectProvenance(result({ environment: { ...result().environment, load: [0, 0] } }), {
      cwd: packageRoot,
    });
    const twice = await collectProvenance(once, { cwd: packageRoot });
    expect(twice.environment.load).toEqual([0, 0]);
    expect(twice.warnings).toEqual(once.warnings);
  });
});

function busy(profile: BenchResult['profile'], load: readonly [number, number]): BenchResult {
  return applyLoadCheck(result({ profile, environment: { ...result().environment, cores: 8, load } }));
}

describe('applyLoadCheck', () => {
  it('makes a publish run unpublishable when load exceeded half the cores at the start or the end', () => {
    for (const load of [
      [5, 1],
      [1, 5],
    ] as const) {
      const checked = busy('publish', load);
      expect(checked.publishable).toBe(false);
      expect(checked.warnings.map(warning => warning.code)).toEqual(['busy-machine']);
    }
  });

  it('checks the load in every profile, and stays quiet on an idle machine', () => {
    // A busy explore run is flagged too: its numbers are as noisy, even though only publish runs can be published.
    expect(busy('explore', [5, 5]).publishable).toBe(false);
    expect(busy('explore', [5, 5]).warnings.map(warning => warning.code)).toEqual(['busy-machine']);
    // Bundle sizes and deterministic counts are the same on a busy machine, so they stay publishable.
    const sizeOnly = applyLoadCheck(
      result({
        environment: { ...result().environment, cores: 8, load: [50, 50] },
        groups: [
          { ...result().groups[0]!, kind: 'size', unit: 'bytes' },
          { ...result().groups[0]!, id: 'n', deterministic: true },
        ],
      }),
    );
    expect(sizeOnly.publishable).toBe(true);
    expect(sizeOnly.warnings).toEqual([]);
    const idle = busy('publish', [4, 4]);
    expect(idle.publishable).toBe(true);
    expect(idle.warnings).toEqual([]);
  });
});
