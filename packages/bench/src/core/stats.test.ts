import { describe, expect, it } from 'vitest';

import type { BenchResult, Block, CaseResult, GroupResult, Interval } from './types.js';
import {
  bandVerdict,
  compareBlocks,
  compareMedians,
  compareRuns,
  createRandom,
  MIN_COMPARISON_BLOCKS,
  summarize,
  summarizeValues,
} from './stats.js';

// ---------------------------------------------------------------------------
// Synthetic data (no timing anywhere)
// ---------------------------------------------------------------------------

type BlockShape = {
  nsPerOp: number;
  processes?: number;
  blocks?: number;
  /** Relative per-block noise, uniform in ±noise. */
  noise?: number;
  /** Relative offset per process (machine state that every block of a process shares). */
  offsets?: readonly number[];
  ops?: number;
  seed?: number;
};

function makeBlocks(shape: BlockShape): Block[] {
  const { nsPerOp, processes = 3, blocks = 20, noise = 0.01, offsets = [], ops = 1000, seed = 1 } = shape;
  const random = createRandom(seed);
  const result: Block[] = [];
  for (let process = 0; process < processes; process++) {
    const offset = offsets[process] ?? 0;
    for (let block = 0; block < blocks; block++) {
      const jitter = 1 + noise * (2 * random() - 1);
      result.push({ process, block, ns: ops * nsPerOp * (1 + offset) * jitter, ops });
    }
  }
  return result;
}

const width = ([low, high]: Interval): number => high - low;

function speedCase(key: string, blocks: readonly Block[], keepBlocks = true): CaseResult {
  return {
    key,
    label: key,
    role: 'competitor',
    summary: summarize(blocks),
    ...(keepBlocks ? { blocks } : {}),
    flags: [],
  };
}

function group(id: string, cases: readonly CaseResult[], extra: Partial<GroupResult> = {}): GroupResult {
  return {
    kind: 'compare',
    id,
    title: id,
    unit: 'ns/op',
    contract: { id: `${id}@1`, description: 'same work' },
    specHash: `hash-${id}`,
    cases,
    comparisons: [],
    ...extra,
  };
}

function run(groups: readonly GroupResult[], extra: Partial<BenchResult> = {}): BenchResult {
  return {
    schema: 1,
    suite: { id: 'suite', title: 'Suite', notes: [], specHash: 'suite-hash' },
    profile: 'publish',
    seed: 1,
    publishable: true,
    warnings: [],
    environment: {
      runtime: { name: 'node', version: '22.13.1' },
      flags: [],
      harness: { version: '0.0.0', mitata: '1.0.34' },
      date: '2026-10-13T00:00:00.000Z',
    },
    packages: {},
    groups,
    ...extra,
  };
}

function sizeCase(key: string, gzip: number, limit?: number): CaseResult {
  return {
    key,
    label: key,
    role: 'competitor',
    summary: summarizeValues([gzip]),
    size: { raw: gzip * 3, gzip, brotli: gzip - 10, files: [] },
    ...(limit === undefined ? {} : { limit }),
    flags: limit !== undefined && gzip > limit ? ['over-limit'] : [],
  };
}

function sizeGroup(cases: readonly CaseResult[]): GroupResult {
  return group('size', cases, { kind: 'size', unit: 'bytes', contract: undefined });
}

function metricGroup(value: number): GroupResult {
  const metricCase: CaseResult = {
    key: 'types',
    label: 'types',
    role: 'baseline',
    summary: summarizeValues([value]),
    flags: [],
  };
  return group('m', [metricCase], { kind: 'metric', unit: 'instantiations', deterministic: true, contract: undefined });
}

// ---------------------------------------------------------------------------

describe('createRandom', () => {
  it('replays the same stream for the same seed, so every interval is reproducible', () => {
    const a = createRandom(42);
    const b = createRandom(42);
    const c = createRandom(43);
    const first = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(first);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(first);
  });

  it('yields uniform floats in [0, 1)', () => {
    const random = createRandom(7);
    const values = Array.from({ length: 10_000 }, () => random());
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(values.reduce((sum, value) => sum + value, 0) / values.length).toBeCloseTo(0.5, 1);
  });
});

describe('summarize', () => {
  it('estimates total time over total operations, the cost the work actually pays', () => {
    // Nine fast blocks and one block that hit a GC stall. Throughput is what
    // 10,000 operations cost: 1.09 ms, i.e. 109 ns/op. A median of block
    // averages (10 ns/op) would claim 0.1 ms and hide the stall entirely.
    const blocks: Block[] = Array.from({ length: 10 }, (_, block) => ({
      process: 0,
      block,
      ns: block === 9 ? 1_000_000 : 10_000,
      ops: 1000,
    }));
    const summary = summarize(blocks);
    const totalNs = blocks.reduce((sum, block) => sum + block.ns, 0);
    const totalOps = blocks.reduce((sum, block) => sum + block.ops, 0);
    expect(summary.estimate).toBeCloseTo(109, 9);
    expect(summary.estimate * totalOps).toBeCloseTo(totalNs, 3);
    expect(summary.median).toBe(10);
    expect(summary.max).toBe(1000);
  });

  it('weights blocks by their operations instead of averaging block averages', () => {
    // 100 ops in 1 µs and 10 ops in 1 µs: 110 ops cost 2 µs = 18.18 ns/op,
    // not the 55 ns/op a mean of the two averages would report.
    const summary = summarize([
      { process: 0, block: 0, ns: 1000, ops: 100 },
      { process: 0, block: 1, ns: 1000, ops: 10 },
    ]);
    expect(summary.estimate).toBeCloseTo(2000 / 110, 9);
  });

  it('widens the interval when processes disagree, instead of trusting blocks that share a process', () => {
    // Three processes landed in different machine states (−15%, 0, +15%),
    // each with tight blocks. Naive block resampling treats 60 blocks as 60
    // independent observations and reports a narrow interval; the two-stage
    // design knows there are only three independent process draws.
    const blocks = makeBlocks({ nsPerOp: 100, processes: 3, blocks: 20, noise: 0.01, offsets: [-0.15, 0, 0.15] });
    const hierarchical = summarize(blocks, { seed: 3 });
    const naive = summarize(
      blocks.map(block => ({ ...block, process: 0 })),
      { seed: 3 },
    );
    expect(hierarchical.estimate).toBeCloseTo(naive.estimate, 9);
    expect(width(hierarchical.interval)).toBeGreaterThan(3 * width(naive.interval));
    expect(hierarchical.interval[0]).toBeLessThan(95);
    expect(hierarchical.interval[1]).toBeGreaterThan(105);
  });

  it('is deterministic for a fixed seed', () => {
    const blocks = makeBlocks({ nsPerOp: 50, noise: 0.2 });
    expect(summarize(blocks, { seed: 9 })).toEqual(summarize(blocks, { seed: 9 }));
    expect(summarize(blocks, { seed: 9 }).interval).not.toEqual(summarize(blocks, { seed: 10 }).interval);
  });

  it('reports spread over per-block ns/op', () => {
    const blocks = [10, 20, 30, 40].map((nsPerOp, block) => ({ process: 0, block, ns: nsPerOp * 10, ops: 10 }));
    const summary = summarize(blocks);
    expect(summary).toMatchObject({ median: 25, min: 10, max: 40, n: 4 });
    expect(summary.p75).toBeCloseTo(32.5, 9);
    expect(summary.cv).toBeCloseTo(Math.sqrt(500 / 3) / 25, 9);
  });

  it('gives a single block a zero-width interval and zero cv', () => {
    const summary = summarize([{ process: 0, block: 0, ns: 500, ops: 5 }]);
    expect(summary).toMatchObject({ estimate: 100, interval: [100, 100], cv: 0, n: 1 });
  });

  it('rejects empty and malformed input rather than inventing a number', () => {
    expect(() => summarize([])).toThrow(RangeError);
    expect(() => summarize([{ process: 0, block: 0, ns: 10, ops: 0 }])).toThrow(/ops/);
    expect(() => summarize([{ process: 0, block: 0, ns: Number.NaN, ops: 1 }])).toThrow(/ns/);
  });
});

describe('summarizeValues', () => {
  it('uses the median, so one stalled compile does not move the estimate', () => {
    const summary = summarizeValues([100, 101, 99, 102, 98, 100, 5000]);
    expect(summary.estimate).toBe(100);
    expect(summary.n).toBe(7);
    // n = 7 gives the order-statistic interval [x(1), x(7)] (98.4% coverage).
    expect(summary.interval).toEqual([98, 5000]);
  });

  it('tightens the median interval as repeats grow', () => {
    const values = Array.from({ length: 40 }, (_, index) => 100 + (index % 10));
    const summary = summarizeValues(values);
    expect(summary.interval[0]).toBeGreaterThan(100);
    expect(summary.interval[1]).toBeLessThan(109);
  });

  it('gives a deterministic metric a zero-width interval', () => {
    expect(summarizeValues([1234]).interval).toEqual([1234, 1234]);
    expect(summarizeValues([7, 7, 7]).interval).toEqual([7, 7]);
    expect(() => summarizeValues([])).toThrow(RangeError);
  });
});

describe('compareBlocks', () => {
  it('calls identical distributions a tie', () => {
    const base = makeBlocks({ nsPerOp: 100, seed: 1 });
    const other = makeBlocks({ nsPerOp: 100, seed: 2 });
    const result = compareBlocks(base, other, { seed: 5 });
    expect(result.verdict).toBe('tie');
    expect(result.interval[0]).toBeGreaterThan(1 / 1.02);
    expect(result.interval[1]).toBeLessThan(1.02);
  });

  it('calls a clear 30% slowdown slower, and the reverse faster', () => {
    const base = makeBlocks({ nsPerOp: 100, seed: 1 });
    const slow = makeBlocks({ nsPerOp: 130, seed: 2 });
    const slower = compareBlocks(base, slow, { seed: 5 });
    expect(slower.verdict).toBe('higher');
    expect(slower.ratio).toBeCloseTo(1.3, 2);
    expect(slower.interval[0]).toBeGreaterThan(1.02);
    expect(compareBlocks(slow, base, { seed: 5 }).verdict).toBe('lower');
  });

  it('calls a small difference under heavy noise inconclusive, never a tie', () => {
    // 3% apart with ±40% block noise over few blocks: the data cannot tell
    // whether the cases are equal, so claiming equivalence would be a lie.
    const base = makeBlocks({ nsPerOp: 100, processes: 2, blocks: 5, noise: 0.4, seed: 1 });
    const other = makeBlocks({ nsPerOp: 103, processes: 2, blocks: 5, noise: 0.4, seed: 2 });
    const result = compareBlocks(base, other, { seed: 5 });
    expect(result.verdict).toBe('inconclusive');
    expect(result.interval[0]).toBeLessThan(1);
    expect(result.interval[1]).toBeGreaterThan(1.02);
  });

  it('calls a tiny but certain difference a tie, not a win', () => {
    // 0.5% slower, established beyond doubt, but inside the ±2% band.
    const base = makeBlocks({ nsPerOp: 100, noise: 0.001, seed: 1 });
    const other = makeBlocks({ nsPerOp: 100.5, noise: 0.001, seed: 2 });
    const result = compareBlocks(base, other, { seed: 5 });
    expect(result.interval[0]).toBeGreaterThan(1);
    expect(result.verdict).toBe('tie');
  });

  it('is deterministic for a fixed seed', () => {
    const base = makeBlocks({ nsPerOp: 100, noise: 0.3, seed: 1 });
    const other = makeBlocks({ nsPerOp: 110, noise: 0.3, seed: 2 });
    expect(compareBlocks(base, other, { seed: 11 })).toEqual(compareBlocks(base, other, { seed: 11 }));
  });
});

describe('comparisons on too few blocks', () => {
  // A quick run times one block per case. One block resamples to itself, so a
  // bootstrap would give a zero-width interval and turn one noisy sample into
  // a confident "50× slower [50–50]". Such a comparison must never rank.
  const one = (nsPerOp: number, process = 0): Block[] => [{ process, block: 0, ns: nsPerOp * 1000, ops: 1000 }];

  it('never calls a one-block comparison lower or higher, however large the gap', () => {
    for (const [base, other] of [
      [one(100), one(5000)],
      [one(5000), one(100)],
      [one(100), makeBlocks({ nsPerOp: 5000 })],
      [makeBlocks({ nsPerOp: 100 }), one(5000)],
    ] as const) {
      const result = compareBlocks(base, other, { seed: 5 });
      expect(result.verdict).toBe('inconclusive');
      // The point ratio stays; the interval is [ratio, ratio]: nothing was resampled.
      expect(result.interval).toEqual([result.ratio, result.ratio]);
    }
    expect(compareBlocks(one(100), one(5000)).ratio).toBe(50);
  });

  it('applies the same minimum to repeated metric observations', () => {
    const value = (ns: number): Block[] => [{ process: 0, block: 0, ns, ops: 1 }];
    expect(compareMedians(value(10), value(500)).verdict).toBe('inconclusive');
  });

  it('counts blocks over all processes: one block in each of two processes is enough to resample', () => {
    expect(MIN_COMPARISON_BLOCKS).toBe(2);
    const base = [...one(100, 0), ...one(101, 1)];
    const other = [...one(5000, 0), ...one(5050, 1)];
    expect(compareBlocks(base, other, { seed: 5 }).verdict).toBe('higher');
  });

  it('never reports a one-block run as regressed or improved in CI', () => {
    const base = run([group('g', [speedCase('a', one(100))])]);
    const head = run([group('g', [speedCase('a', one(5000))])]);
    const result = compareRuns(base, head);
    expect(result.status).toBe('pass');
    expect(result.rows[0]).toMatchObject({ status: 'inconclusive', reason: expect.stringContaining('1 block') });
    expect(result.rows[0]?.interval).toBeUndefined();
    // Without samples the stored summary interval is [x, x]: still not a verdict.
    const bare = compareRuns(
      run([group('g', [speedCase('a', one(100), false)])]),
      run([group('g', [speedCase('a', one(5000), false)])]),
    );
    expect(bare.rows[0]?.status).toBe('inconclusive');
  });
});

describe('compareRuns', () => {
  const fast = makeBlocks({ nsPerOp: 100, seed: 1 });
  const same = makeBlocks({ nsPerOp: 100, seed: 2 });
  const slow = makeBlocks({ nsPerOp: 130, seed: 3 });
  const halved = makeBlocks({ nsPerOp: 50, seed: 4 });

  it('passes an unchanged run with every row within tolerance', () => {
    const result = compareRuns(run([group('g', [speedCase('a', fast)])]), run([group('g', [speedCase('a', same)])]));
    expect(result.status).toBe('pass');
    expect(result.threshold).toBe(0.05);
    expect(result.rows).toEqual([expect.objectContaining({ group: 'g', case: 'a', status: 'within' })]);
  });

  it('carries each group unit on its rows so a CI table never prints a bare number', () => {
    const result = compareRuns(
      run([group('g', [speedCase('a', fast)]), sizeGroup([sizeCase('s', 1000)])]),
      run([group('g', [speedCase('a', same), speedCase('new', same)]), sizeGroup([sizeCase('s', 1000)])]),
    );
    const units = Object.fromEntries(result.rows.map(row => [`${row.group}/${row.case}`, row.unit]));
    expect(units).toEqual({ 'g/a': 'ns/op', 'g/new': 'ns/op', 'size/s': 'bytes' });
  });

  it('fails on an established slowdown beyond the threshold', () => {
    const result = compareRuns(run([group('g', [speedCase('a', fast)])]), run([group('g', [speedCase('a', slow)])]));
    expect(result.status).toBe('fail');
    expect(result.rows[0]).toMatchObject({ status: 'regressed' });
    expect(result.rows[0]?.ratio).toBeCloseTo(1.3, 2);
  });

  it('marks a changed contract incompatible instead of reporting a 2× improvement', () => {
    // The head did less work under a new contract; that is a new baseline, not a win.
    const head = group('g', [speedCase('a', halved)], { contract: { id: 'g@2', description: 'less work' } });
    const result = compareRuns(run([group('g', [speedCase('a', fast)])]), run([head]));
    expect(result.rows[0]).toMatchObject({ status: 'incompatible' });
    expect(result.rows[0]?.reason).toMatch(/contract changed \(g@1 → g@2\)/);
    expect(result.rows[0]?.ratio).toBeUndefined();
    expect(result.status).toBe('pass');
  });

  it('marks a changed group definition incompatible without touching other groups', () => {
    const base = run([group('g', [speedCase('a', fast)]), group('h', [speedCase('a', fast)])]);
    const head = run(
      [group('g', [speedCase('a', same)], { specHash: 'changed' }), group('h', [speedCase('a', same)])],
      {
        suite: { id: 'suite', title: 'Suite', notes: [], specHash: 'suite-hash-2' },
      },
    );
    const rows = compareRuns(base, head).rows;
    expect(rows.map(row => row.status)).toEqual(['incompatible', 'within']);
  });

  it('never compares a quick run, in either direction', () => {
    const quick = run([group('g', [speedCase('a', slow)])], { profile: 'quick' });
    const normal = run([group('g', [speedCase('a', fast)])]);
    for (const result of [compareRuns(normal, quick), compareRuns(quick, normal)]) {
      expect(result.status).toBe('pass');
      expect(result.rows[0]).toMatchObject({ status: 'incompatible', reason: expect.stringMatching(/quick run/) });
    }
  });

  it('refuses to compare different runtimes or units', () => {
    const bun = run([group('g', [speedCase('a', fast)])], {
      environment: { ...run([]).environment, runtime: { name: 'bun', version: '1.4.2' } },
    });
    expect(compareRuns(run([group('g', [speedCase('a', fast)])]), bun).rows[0]?.reason).toMatch(/runtime changed/);
    const ms = run([group('g', [speedCase('a', fast)], { unit: 'ms' })]);
    expect(compareRuns(run([group('g', [speedCase('a', fast)])]), ms).rows[0]?.reason).toMatch(/unit changed/);
  });

  it('lists added and removed groups and cases', () => {
    const base = run([
      group('g', [speedCase('a', fast), speedCase('gone', fast)]),
      group('old', [speedCase('x', fast)]),
    ]);
    const head = run([
      group('g', [speedCase('a', same), speedCase('new', fast)]),
      group('fresh', [speedCase('y', fast)]),
    ]);
    const statuses = compareRuns(base, head).rows.map(row => `${row.group}:${row.case}:${row.status}`);
    expect(statuses).toEqual(['g:a:within', 'g:new:added', 'g:gone:removed', 'fresh:y:added', 'old:x:removed']);
  });

  it('falls back to stored summaries when samples were omitted, and says so', () => {
    const result = compareRuns(
      run([group('g', [speedCase('a', fast, false), speedCase('b', fast, false)])]),
      run([group('g', [speedCase('a', slow, false), speedCase('b', same, false)])]),
    );
    expect(result.rows.map(row => row.status)).toEqual(['regressed', 'within']);
    expect(result.rows[0]?.reason).toMatch(/samples omitted/);
    // The fallback interval is at least the box built from both stored intervals.
    const [low, high] = result.rows[0]?.interval ?? [0, 0];
    const baseSummary = summarize(fast);
    const headSummary = summarize(slow);
    expect(low).toBeLessThanOrEqual(headSummary.interval[0] / baseSummary.interval[1]);
    expect(high).toBeGreaterThanOrEqual(headSummary.interval[1] / baseSummary.interval[0]);
  });

  it('widens each interval as more rows are gated (Bonferroni), so many rows do not manufacture a false regression', () => {
    const noisyBase = makeBlocks({ nsPerOp: 100, noise: 0.3, seed: 1 });
    const noisyHead = makeBlocks({ nsPerOp: 105, noise: 0.3, seed: 2 });
    const target = group('target', [speedCase('a', noisyHead)]);
    const alone = compareRuns(run([group('target', [speedCase('a', noisyBase)])]), run([target]));
    // Nine more gated rows: each interval is now built at 99.5% instead of 95%.
    const tiny = makeBlocks({ nsPerOp: 100, processes: 1, blocks: 4 });
    const others = Array.from({ length: 9 }, (_, index) => `other${index}`);
    const crowded = compareRuns(
      run([group('target', [speedCase('a', noisyBase)]), ...others.map(id => group(id, [speedCase('a', tiny)]))]),
      run([target, ...others.map(id => group(id, [speedCase('a', tiny)]))]),
    );
    const aloneRow = alone.rows[0];
    const crowdedRow = crowded.rows.find(row => row.group === 'target');
    expect(aloneRow?.interval && crowdedRow?.interval).toBeTruthy();
    expect(width(crowdedRow?.interval ?? [0, 0])).toBeGreaterThan(1.2 * width(aloneRow?.interval ?? [0, 0]));
  });

  it('compares size exactly and fails a row over its budget even when the size did not change', () => {
    const result = compareRuns(
      run([sizeGroup([sizeCase('a', 1000), sizeCase('b', 1000), sizeCase('c', 9000, 8000)])]),
      run([sizeGroup([sizeCase('a', 1030), sizeCase('b', 1100), sizeCase('c', 9000, 8000)])]),
    );
    expect(result.rows.map(row => row.status)).toEqual(['within', 'regressed', 'regressed']);
    expect(result.rows[0]?.interval).toEqual([1.03, 1.03]);
    expect(result.rows[2]?.reason).toMatch(/size budget/);
    expect(result.status).toBe('fail');
  });

  it('compares deterministic metrics exactly', () => {
    const result = compareRuns(run([metricGroup(1000)]), run([metricGroup(900)]));
    expect(result.rows[0]).toMatchObject({ status: 'improved', ratio: 0.9, interval: [0.9, 0.9] });
  });

  it('compares per runtime and prefixes rows with the runtime name', () => {
    const withRuntime = (name: 'node' | 'bun', blocks: readonly Block[]): BenchResult =>
      run([group('g', [speedCase('a', blocks)])], {
        environment: { ...run([]).environment, runtime: { name, version: '1' } },
      });
    const base = run([], { runtimes: [withRuntime('node', fast), withRuntime('bun', fast)] });
    const head = run([], { runtimes: [withRuntime('node', same), withRuntime('bun', slow)] });
    const result = compareRuns(base, head);
    expect(result.rows.map(row => `${row.group}:${row.status}`)).toEqual(['node/g:within', 'bun/g:regressed']);
    expect(result.status).toBe('fail');
  });

  it('is deterministic for a fixed seed', () => {
    const base = run([group('g', [speedCase('a', fast)])]);
    const head = run([group('g', [speedCase('a', slow)])]);
    expect(compareRuns(base, head, { seed: 4 })).toEqual(compareRuns(base, head, { seed: 4 }));
  });
});

describe('bandVerdict', () => {
  it('uses one log-symmetric band for intervals and exact ratios alike', () => {
    // 2% lower and 2% higher are the same size of effect, so 1/1.02 is the edge, not 0.98.
    expect(bandVerdict([0.981, 0.981])).toBe('tie');
    expect(bandVerdict([0.97, 0.97])).toBe('lower');
    expect(bandVerdict([1.03, 1.03])).toBe('higher');
    expect(bandVerdict([0.95, 1.05])).toBe('inconclusive');
  });
});

describe('compareRuns: CI rules', () => {
  const fast = makeBlocks({ nsPerOp: 100, seed: 1 });
  const same = makeBlocks({ nsPerOp: 100, seed: 2 });
  const failedCheck = {
    status: 'failed' as const,
    inputs: 2,
    failures: [{ case: 'a', input: 1, expected: '1', actual: '2' }],
  };

  it('fails when the head contract check failed, instead of calling its cases removed', () => {
    // A head that broke the contract is not timed; reading that as "removed" would let CI pass.
    const base = run([group('g', [speedCase('a', fast)])]);
    const head = run([group('g', [], { check: failedCheck })]);
    const result = compareRuns(base, head);
    expect(result.status).toBe('fail');
    expect(result.rows).toEqual([
      expect.objectContaining({ group: 'g', case: '(contract)', status: 'contract-failed' }),
    ]);
  });

  it('fails when a head group is missing because its contract failed', () => {
    const base = run([group('g', [speedCase('a', fast)])]);
    const head = run([], { warnings: [{ code: 'contract-failed', group: 'g', message: 'not timed' }] });
    const result = compareRuns(base, head);
    expect(result.status).toBe('fail');
    expect(result.rows.map(row => row.status)).toEqual(['contract-failed']);
  });

  it('checks every head size budget, even on added or incompatible rows', () => {
    const base = run([sizeGroup([sizeCase('s', 1000)])]);
    const added = run([sizeGroup([sizeCase('s', 1000), sizeCase('new', 900, 500)])]);
    expect(compareRuns(base, added).rows.find(row => row.case === 'new')).toMatchObject({ status: 'regressed' });
    const changed = run([sizeGroup([{ ...sizeCase('s', 1000, 500), workHash: 'other' }])]);
    const result = compareRuns(run([sizeGroup([{ ...sizeCase('s', 1000), workHash: 'one' }])]), changed);
    expect(result.rows[0]).toMatchObject({
      status: 'regressed',
      reason: expect.stringMatching(/over its size budget/),
    });
    expect(result.status).toBe('fail');
  });

  it('judges compatibility per case, so one changed case does not void the others', () => {
    const base = run([
      group('g', [
        { ...speedCase('a', fast), workHash: 'a1' },
        { ...speedCase('b', fast), workHash: 'b1' },
      ]),
    ]);
    const head = run(
      [
        group(
          'g',
          [
            { ...speedCase('a', same), workHash: 'a2' },
            { ...speedCase('b', same), workHash: 'b1' },
          ],
          {
            specHash: 'changed',
          },
        ),
      ],
      { suite: { id: 'suite', title: 'Suite', notes: [], specHash: 'other' } },
    );
    const rows = compareRuns(base, head).rows;
    expect(rows.map(row => [row.case, row.status])).toEqual([
      ['a', 'incompatible'],
      ['b', 'within'],
    ]);
    expect(rows[0]?.reason).toMatch(/work hash differs/);
  });

  it('refuses to compare runs from different profiles, and warns when the base is not publishable', () => {
    const explore = run([group('g', [speedCase('a', fast)])], {
      profile: 'explore',
      publishable: false,
      warnings: [{ code: 'explore-profile', message: 'explore' }],
    });
    const publish = run([group('g', [speedCase('a', same)])]);
    const result = compareRuns(explore, publish);
    expect(result.rows[0]).toMatchObject({
      status: 'incompatible',
      reason: expect.stringContaining('profiles differ (explore vs publish)'),
    });
    expect(result.status).toBe('pass');
    expect(result.warnings).toEqual([expect.stringContaining('The base run is not publishable (explore-profile)')]);
    expect(compareRuns(publish, publish).warnings).toEqual([]);
  });

  it('compares repeated metrics by their medians, so one stalled repeat is not a regression', () => {
    const observations = (values: readonly number[]): Block[] =>
      values.map((ns, block) => ({ process: 0, block, ns, ops: 1 }));
    const metricCase = (values: readonly number[]): CaseResult => ({
      key: 'compile',
      label: 'compile',
      role: 'baseline',
      summary: summarizeValues(values),
      blocks: observations(values),
      flags: [],
    });
    const steady = [10, 10, 10.1, 9.9, 10, 10, 10.1, 9.9, 10, 10];
    const stalled = [10, 10, 10.1, 9.9, 10, 10, 10.1, 9.9, 10, 100];
    const metric = (values: readonly number[]): GroupResult =>
      group('m', [metricCase(values)], { kind: 'metric', unit: 'ms', contract: undefined, deterministic: false });
    const result = compareRuns(run([metric(steady)]), run([metric(stalled)]));
    // The mean would rise 90%; the median, what the report shows, did not move.
    expect(result.rows[0]).toMatchObject({ status: 'within', ratio: 1 });
  });
});
