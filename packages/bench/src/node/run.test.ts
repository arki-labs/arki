import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { BenchResult, Block, CaseResult, GroupResult, ProgressEvent, Warning } from '../core/types.js';
import { compareBlocks, compareMedians, summarize, summarizeValues } from '../core/stats.js';
import { combineRuntimes, mergeProcessResults, runFile } from './run.js';

const SEED = 7;

function blocks(nsPerOp: readonly number[]): Block[] {
  // Every worker numbers itself process 0 here: the merge must retag blocks by worker index.
  return nsPerOp.map((ns, block) => ({ process: 0, block, ns: ns * 1000, ops: 1000 }));
}

function speedCase(key: string, role: CaseResult['role'], data: readonly Block[]): CaseResult {
  return { key, label: key, role, summary: summarize(data, { seed: SEED }), blocks: data, flags: [] };
}

const sizeGroup: GroupResult = {
  kind: 'size',
  id: 'bundle',
  title: 'Bundle',
  unit: 'bytes',
  baseline: 'ours',
  cases: [],
  comparisons: [],
};

function worker(options: {
  ours: readonly number[];
  theirs: readonly number[];
  load: readonly [number, number];
  checkFailed?: boolean;
  warnings?: readonly Warning[];
  floor?: readonly number[];
  extra?: readonly GroupResult[];
}): BenchResult {
  const ours = blocks(options.ours);
  const theirs = blocks(options.theirs);
  const floorBlocks = options.floor === undefined ? undefined : blocks(options.floor);
  const group: GroupResult = {
    kind: 'compare',
    id: 'parse',
    title: 'Parse',
    unit: 'ns/op',
    baseline: 'ours',
    contract: { id: 'parse-v1', description: 'same output' },
    check: options.checkFailed
      ? { status: 'failed', inputs: 1, failures: [{ case: 'theirs', input: 0, expected: '1', actual: '2' }] }
      : { status: 'passed', inputs: 1, failures: [] },
    ...(floorBlocks === undefined ? {} : { floorBlocks, floor: summarize(floorBlocks, { seed: SEED }) }),
    cases: [speedCase('ours', 'baseline', ours), speedCase('theirs', 'competitor', theirs)],
    comparisons: [{ case: 'theirs', ...compareBlocks(ours, theirs, { seed: SEED }) }],
  };
  return {
    schema: 1,
    suite: { id: 'demo', title: 'Benchmarks', notes: [], specHash: 'abc' },
    profile: 'publish',
    seed: SEED,
    publishable: !options.checkFailed,
    warnings: options.warnings ?? [],
    environment: {
      runtime: { name: 'node', version: '22.13.1' },
      cores: 1000,
      flags: [],
      harness: { version: '0.0.0', mitata: '1.0.34' },
      load: options.load,
      date: '2026-10-13T00:00:00.000Z',
    },
    packages: {},
    groups: [group, sizeGroup, ...(options.extra ?? [])],
  };
}

function metricGroup(values: Readonly<Record<'ours' | 'theirs', readonly number[]>>): GroupResult {
  const entry = (key: 'ours' | 'theirs', role: CaseResult['role']): CaseResult => {
    const observations = values[key].map((ns, block) => ({ process: 0, block, ns, ops: 1 }));
    return { key, label: key, role, summary: summarizeValues(values[key]), blocks: observations, flags: [] };
  };
  return {
    kind: 'metric',
    id: 'compile',
    title: 'Compile time',
    unit: 'ms',
    deterministic: false,
    baseline: 'ours',
    cases: [entry('ours', 'baseline'), entry('theirs', 'competitor')],
    comparisons: [],
  };
}

function caseOf(result: BenchResult, key: string): CaseResult {
  const found = result.groups[0]?.cases.find(item => item.key === key);
  if (!found) throw new Error(`case ${key} missing`);
  return found;
}

describe('mergeProcessResults', () => {
  const advice: Warning = { code: 'package-version-unknown', message: 'left-pad: version unknown' };
  // What one worker claimed about its own blocks; the merge must judge the merged data instead.
  const claimed: Warning = { code: 'unstable', message: 'theirs varies', group: 'parse', case: 'theirs' };
  const first = worker({
    ours: [10, 10.1, 10, 10.2],
    theirs: [20, 20.2, 20.1, 20],
    load: [1, 2],
    warnings: [advice, claimed],
  });
  const second = worker({ ours: [10.1, 10, 10.1, 10], theirs: [20.1, 20, 20, 20.3], load: [3, 4], warnings: [advice] });
  const merged = mergeProcessResults([first, second]);

  it('keeps every block and tags it with the process that measured it', () => {
    const ours = caseOf(merged, 'ours').blocks ?? [];
    expect(ours).toHaveLength(8);
    expect(ours.slice(0, 4).every(block => block.process === 0)).toBe(true);
    expect(ours.slice(4).every(block => block.process === 1)).toBe(true);
  });

  it('recomputes summaries and comparisons from all processes, not from one worker', () => {
    const ours = caseOf(merged, 'ours');
    const theirs = caseOf(merged, 'theirs');
    expect(ours.summary).toEqual(summarize(ours.blocks ?? [], { seed: SEED }));
    expect(ours.summary.n).toBe(8);
    expect(merged.groups[0]?.comparisons).toEqual([
      { case: 'theirs', ...compareBlocks(ours.blocks ?? [], theirs.blocks ?? [], { seed: SEED }) },
    ]);
    // Twice the time per op in every process: a clear loss, not a tie.
    expect(merged.groups[0]?.comparisons[0]?.verdict).toBe('higher');
  });

  it('keeps one environment whose load spans the whole run, and dedupes warnings', () => {
    expect(merged.environment.load).toEqual([1, 4]);
    expect(merged.warnings).toEqual([advice]);
    expect(merged.publishable).toBe(true);
    // Size groups are exact: the first process's numbers stand.
    expect(merged.groups[1]).toEqual(sizeGroup);
  });

  it('re-derives flags, warnings and publishable from the merged blocks, not from what each worker said', () => {
    // Each worker is steady on its own, but the processes disagree by 30%: that spread is what a reader must see.
    const low = worker({ ours: [10, 10, 10, 10], theirs: [20, 20, 20, 20], load: [1, 1] });
    const high = worker({ ours: [13, 13, 13, 13], theirs: [20, 20, 20, 20], load: [1, 1] });
    expect([low.publishable, high.publishable]).toEqual([true, true]);
    const result = mergeProcessResults([low, high]);
    expect(caseOf(result, 'ours').flags).toEqual(['unstable']);
    expect(result.warnings.map(warning => [warning.code, warning.case])).toEqual([['unstable', 'ours']]);
    expect(result.publishable).toBe(false);
  });

  it('merges the floor blocks, so optimized-out work is judged against every process', () => {
    // Two floor blocks per worker are too few to judge alone (fewer than three); merged, they are enough.
    const a = worker({ ours: [5.1, 5.1], theirs: [20, 20], load: [1, 1], floor: [5, 5] });
    const b = worker({ ours: [5.1, 5.1], theirs: [20, 20], load: [1, 1], floor: [5, 5] });
    const result = mergeProcessResults([a, b]);
    expect(result.groups[0]?.floorBlocks).toHaveLength(4);
    expect(result.groups[0]?.floor?.n).toBe(4);
    expect(caseOf(result, 'ours').flags).toContain('optimized-out');
    expect(result.publishable).toBe(false);
  });

  it('merges metric observations across processes instead of keeping only the first', () => {
    const a = worker({
      ours: [10],
      theirs: [20],
      load: [1, 1],
      extra: [metricGroup({ ours: [100, 101, 99], theirs: [200, 202, 198] })],
    });
    const b = worker({
      ours: [10],
      theirs: [20],
      load: [1, 1],
      extra: [metricGroup({ ours: [100, 100, 102], theirs: [201, 199, 200] })],
    });
    const metric = mergeProcessResults([a, b]).groups[2];
    const ours = metric?.cases.find(entry => entry.key === 'ours');
    const theirs = metric?.cases.find(entry => entry.key === 'theirs');
    expect(ours?.blocks).toHaveLength(6);
    expect(ours?.summary).toEqual(summarizeValues([100, 101, 99, 100, 100, 102]));
    expect(metric?.comparisons).toEqual([
      { case: 'theirs', ...compareMedians(ours?.blocks ?? [], theirs?.blocks ?? [], { seed: SEED }) },
    ]);
    expect(metric?.comparisons[0]?.verdict).toBe('higher');
  });

  it('is not publishable when any process failed its contract check', () => {
    const failing = worker({ ours: [10], theirs: [20], load: [1, 1], checkFailed: true });
    const result = mergeProcessResults([worker({ ours: [10], theirs: [20], load: [1, 1] }), failing]);
    expect(result.publishable).toBe(false);
    expect(result.groups[0]?.check?.status).toBe('failed');
  });
});

describe('combineRuntimes', () => {
  const run = (name: 'node' | 'bun', publishable: boolean, warnings: readonly Warning[] = []): BenchResult => ({
    ...worker({ ours: [10], theirs: [20], load: [0, 0] }),
    publishable,
    warnings,
    environment: { ...worker({ ours: [10], theirs: [20], load: [0, 0] }).environment, runtime: { name, version: '1' } },
  });

  it('is publishable only when every runtime is, so a clean first runtime cannot hide a noisy second', () => {
    const noisy: Warning = { code: 'unstable', message: 'varies', group: 'parse', case: 'ours' };
    const result = combineRuntimes([run('node', true), run('bun', false, [noisy])], []);
    expect(result.publishable).toBe(false);
    expect(result.warnings).toEqual([{ ...noisy, runtime: 'bun' }]);
    expect(combineRuntimes([run('node', true), run('bun', true)], []).publishable).toBe(true);
  });

  it('a missing runtime blocks publishing', () => {
    const missing: Warning = { code: 'runtime-missing', message: 'deno is not installed' };
    expect(combineRuntimes([run('node', true)], [missing]).publishable).toBe(false);
  });
});

describe('runFile', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arki-bench-run-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3', type: 'module' }));
  // A sibling imported the NodeNext way ('./helper.js' → helper.ts), plus type-only syntax Node must strip.
  writeFileSync(path.join(dir, 'helper.ts'), 'export const answer: number = 42;\n');
  writeFileSync(
    path.join(dir, 'suite.bench.ts'),
    `import { answer } from './helper.js';
type Unit = 'things';
const unit: Unit = 'things';
export default {
  id: 'fixture',
  groups: [
    { kind: 'metric', id: 'answer', title: 'Answer', unit, deterministic: true, baseline: 'answer',
      cases: { answer: { collect: (): number => answer } } },
    { kind: 'scenario', id: 'loop', title: 'Loop',
      cases: { sum: { run: (): number => [1, 2, 3].reduce((a, b) => a + b, 0) } } },
  ],
};
`,
  );
  writeFileSync(path.join(dir, 'empty.bench.js'), 'export const notASuite = 1;\n');
  const budget = { rounds: 2, blockMs: 1, warmupMs: 1 };

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('loads a TypeScript suite under Node in a child with type stripping, leaving this process untouched', async () => {
    const events: ProgressEvent[] = [];
    const result = await runFile('suite.bench.ts', {
      cwd: dir,
      profile: 'quick',
      budget,
      onProgress: event => events.push(event),
    });
    expect(result.groups.find(group => group.id === 'answer')?.cases[0]?.summary.estimate).toBe(42);
    expect(result.environment.flags).toContain('--experimental-strip-types');
    expect(process.execArgv).not.toContain('--experimental-strip-types');
    // Progress crosses the process boundary.
    expect(events).toContainEqual({ type: 'done', group: 'loop' });
    expect(result.packages['@arki/bench']).toBeDefined();
  }, 30_000);

  it('publish runs fresh processes one after another and merges their blocks', async () => {
    const result = await runFile(path.join(dir, 'suite.bench.ts'), { profile: 'publish', processes: 2, budget });
    const sum = result.groups.find(group => group.id === 'loop')?.cases[0];
    const processes = new Set(sum?.blocks?.map(block => block.process));
    expect([...processes].toSorted()).toEqual([0, 1]);
    expect(sum?.summary.n).toBe(sum?.blocks?.length);
  }, 60_000);

  it('honours processes in explore runs too, since fresh processes help there as well', async () => {
    const result = await runFile(path.join(dir, 'suite.bench.ts'), { profile: 'explore', processes: 2, budget });
    const sum = result.groups.find(group => group.id === 'loop')?.cases[0];
    expect([...new Set(sum?.blocks?.map(block => block.process))].toSorted()).toEqual([0, 1]);
    // Explore is never publishable, however many processes ran.
    expect(result.warnings.map(warning => warning.code)).toContain('explore-profile');
    expect(result.publishable).toBe(false);
  }, 60_000);

  it('drops raw blocks with samples: false', async () => {
    const result = await runFile('suite.bench.ts', { cwd: dir, profile: 'quick', budget, samples: false });
    expect(result.groups.flatMap(group => group.cases).every(item => item.blocks === undefined)).toBe(true);
  }, 30_000);

  it('runs the runtime matrix and reports a missing runtime as a warning, not a crash', async () => {
    // Only Node's own directory: bun and deno live elsewhere on this machine.
    vi.stubEnv('PATH', path.dirname(process.execPath));
    try {
      const result = await runFile('suite.bench.ts', {
        cwd: dir,
        profile: 'quick',
        budget,
        runtimes: ['node', 'deno'],
      });
      expect(result.runtimes?.map(item => item.environment.runtime.name)).toEqual(['node']);
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'runtime-missing' }));
      expect(result.warnings.find(warning => warning.code === 'runtime-missing')).toMatchObject({
        runtime: 'deno',
        message: expect.stringMatching(/deno/),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it('runs the same suite under Node, Bun and Deno in the matrix', async () => {
    const result = await runFile('suite.bench.ts', {
      cwd: dir,
      profile: 'quick',
      budget,
      runtimes: ['node', 'bun', 'deno'],
    });
    expect(result.runtimes?.map(item => item.environment.runtime.name)).toEqual(['node', 'bun', 'deno']);
    for (const item of result.runtimes ?? []) {
      expect(item.groups.find(group => group.id === 'answer')?.cases[0]?.summary.estimate).toBe(42);
    }
    expect(result.environment.runtime.name).toBe('node');
  }, 60_000);

  it('explains a file whose default export is not a suite', async () => {
    await expect(runFile('empty.bench.js', { cwd: dir, profile: 'quick' })).rejects.toThrow(/default export/);
  });
});
