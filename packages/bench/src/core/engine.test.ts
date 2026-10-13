import { describe, expect, it } from 'vitest';

import type { BenchResult, Block, GroupResult, ProgressEvent, SuiteSpec, Summary } from './types.js';
import {
  assessResult,
  BLOCKING_WARNINGS,
  caseFlags,
  deepEqual,
  formatValue,
  PROFILE_BUDGETS,
  runSuite,
} from './engine.js';
import { compare, defineSuite, metric, scenario, size, SpecError } from './spec.js';
import { MITATA_VERSION, VERSION } from './version.js';

// Timing tests run on a busy machine: small budgets, orderings with wide margins.

const arrays = [64, 96, 128].map(length => Array.from({ length }, (_, index) => index * 0.5));

const sumGroup = (id = 'sum') =>
  compare({
    id,
    title: 'Sum',
    contract: { id: 'sum/v1', description: 'sum of the numbers' },
    inputs: arrays,
    baseline: 'loop',
    cases: c => ({
      loop: c({
        run: list => {
          let total = 0;
          for (const value of list) total += value;
          return total;
        },
      }),
      reduce: c({ run: list => list.reduce((total, value) => total + value, 0) }),
    }),
  });

function measureEvents(events: readonly ProgressEvent[], group: string): { case: string; block: number }[] {
  return events.flatMap(event =>
    event.type === 'measure' && event.group === group ? [{ case: event.case, block: event.block }] : [],
  );
}

function group(result: BenchResult, id: string): GroupResult {
  const found = result.groups.find(candidate => candidate.id === id);
  if (!found) throw new Error(`no group ${id}`);
  return found;
}

describe('equality and display for the contract check', () => {
  it('compares by value with stable edge cases', () => {
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(deepEqual(0, -0)).toBe(false); // -0 is a real rounding difference
    expect(deepEqual(10n ** 30n, 10n ** 30n)).toBe(true);
    expect(deepEqual(new Map([['a', [1]]]), new Map([['a', [1]]]))).toBe(true);
    expect(deepEqual(new Map([['a', 1]]), new Map([['a', 2]]))).toBe(false);
    expect(deepEqual(new Set([{ x: 1 }]), new Set([{ x: 1 }]))).toBe(true);
    expect(deepEqual(new Date(5), new Date(5))).toBe(true);
    expect(deepEqual(new Date(5), new Date(6))).toBe(false);
    expect(deepEqual({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(deepEqual(1, '1')).toBe(false);
  });

  it('renders values readably', () => {
    expect(formatValue(1n)).toBe('1n');
    expect(formatValue(-0)).toBe('-0');
    expect(formatValue({ a: '1', b: [Number.NaN] })).toBe('{ "a": "1", "b": [NaN] }');
    expect(formatValue(new Map([['k', 1]]))).toBe('Map(1) { "k" => 1 }');
  });
});

describe('contract check', () => {
  it('blocks timing of a group whose case gives a different answer, with a readable diff', async () => {
    const events: ProgressEvent[] = [];
    const suite = defineSuite({
      id: 'x',
      groups: [
        compare({
          id: 'round',
          title: 'Round',
          contract: { id: 'round/v1', description: 'half-even to integer' },
          inputs: [1.5, 2.5],
          expected: () => 2, // half-even: 1.5 → 2, 2.5 → 2
          baseline: 'even',
          cases: c => ({
            even: c({ run: n => (Math.floor(n) % 2 === 0 ? Math.floor(n) : Math.ceil(n)) }),
            up: c({ run: n => Math.round(n) }), // half-up: wrong on 2.5
          }),
        }),
        sumGroup(),
      ],
    });
    const result = await runSuite(suite, { profile: 'quick', onProgress: event => events.push(event) });
    const failed = group(result, 'round');
    expect(failed.check).toEqual({
      status: 'failed',
      inputs: 2,
      failures: [{ case: 'up', input: 1, expected: '2', actual: '3' }],
    });
    expect(failed.cases).toEqual([]);
    expect(measureEvents(events, 'round')).toEqual([]);
    expect(group(result, 'sum').check?.status).toBe('passed');
    expect(measureEvents(events, 'sum').length).toBeGreaterThan(0);
    expect(result.publishable).toBe(false);
    expect(result.warnings.find(warning => warning.code === 'contract-failed')?.message).toMatch(
      /case "up", input 1: expected 2, got 3/,
    );
  });

  it('checks against the baseline when there is no oracle, and reports thrown errors', async () => {
    const suite = defineSuite({
      id: 'x',
      groups: [
        compare({
          id: 'g',
          title: 'G',
          contract: { id: 'c', description: 'd' },
          inputs: [1, 2],
          baseline: 'a',
          cases: c => ({
            a: c({ run: n => n * 2 }),
            b: c({
              run: n => {
                if (n === 2) throw new RangeError('too big');
                return n * 2;
              },
            }),
          }),
        }),
      ],
    });
    const result = await runSuite(suite, { profile: 'quick' });
    expect(group(result, 'g').check?.failures).toEqual([
      { case: 'b', input: 1, expected: '4', actual: 'threw RangeError: too big' },
    ]);
  });

  it('excludes `differs` cases from the check and from ranking, but still measures them', async () => {
    const base = sumGroup();
    const suite = defineSuite({
      id: 'x',
      groups: [
        {
          ...base,
          cases: {
            ...base.cases,
            rounded: {
              run: (list: unknown) => (Array.isArray(list) ? list.length : 0),
              differs: 'returns the length, not the sum',
            },
          },
        },
      ],
    });
    const result = await runSuite(suite, { profile: 'quick' });
    const sum = group(result, 'sum');
    expect(sum.check?.status).toBe('passed');
    expect(sum.cases.map(entry => [entry.key, entry.role])).toEqual([
      ['loop', 'baseline'],
      ['reduce', 'competitor'],
      ['rounded', 'differs'],
    ]);
    expect(sum.cases.find(entry => entry.key === 'rounded')?.summary.estimate).toBeGreaterThan(0);
    expect(sum.comparisons.map(comparison => comparison.case)).toEqual(['reduce']);
  });
});

describe('async', () => {
  const asyncCases = {
    a: { run: async (n: unknown) => Number(n) + 1 },
    b: { run: async (n: unknown) => Number(n) + 1 },
  };

  it('rejects a promise-returning case in sync mode instead of timing only its synchronous start', async () => {
    const suite = defineSuite({
      id: 'x',
      groups: [
        compare({
          id: 'g',
          title: 'G',
          contract: { id: 'c', description: 'd' },
          inputs: [1],
          baseline: 'a',
          cases: asyncCases,
        }),
      ],
    });
    await expect(runSuite(suite, { profile: 'quick' })).rejects.toThrow(SpecError);
    await expect(runSuite(suite, { profile: 'quick' })).rejects.toThrow(/Set `mode: 'async'`/);

    const sc = defineSuite({
      id: 'x',
      groups: [scenario({ id: 's', title: 'S', cases: { a: { run: async () => 1 } } })],
    });
    await expect(runSuite(sc, { profile: 'quick' })).rejects.toThrow(/mode: 'async'/);
  });

  // Async rivals (HTTP routers, DB clients) need the awaited value in
  // normalize, sometimes an async normalize (reading a Response body), and a
  // teardown so connections opened in setup are closed after the run.
  it('gives normalize the awaited result, awaits an async normalize, and tears down every state', async () => {
    const opened: number[] = [];
    const closed: number[] = [];
    const suite = defineSuite({
      id: 'x',
      groups: [
        compare({
          id: 'g',
          title: 'G',
          contract: { id: 'c', description: 'd' },
          inputs: [1, 2],
          expected: (n: number) => n * 2,
          baseline: 'a',
          mode: 'async',
          cases: c => ({
            a: c({
              setup: n => {
                opened.push(n);
                return { n };
              },
              run: async state => ({ doubled: state.n * 2 }),
              normalize: result => result.doubled,
              teardown: state => {
                closed.push(state.n);
              },
            }),
            b: c({ run: async (n: number) => n * 2, normalize: async result => result }),
          }),
        }),
      ],
    });
    const result = await runSuite(suite, { profile: 'quick' });
    expect(group(result, 'g').check?.status).toBe('passed');
    expect(opened.length).toBeGreaterThan(0);
    expect(closed).toHaveLength(opened.length);
    expect(closed).toEqual(expect.arrayContaining(opened));

    const failing = defineSuite({
      id: 'x',
      groups: [
        compare({
          id: 'g',
          title: 'G',
          contract: { id: 'c', description: 'd' },
          inputs: [1],
          baseline: 'a',
          cases: {
            a: { run: (n: number) => n },
            b: {
              run: (n: number) => n,
              teardown: () => {
                throw new Error('close failed');
              },
            },
          },
        }),
      ],
    });
    const check = group(await runSuite(failing, { profile: 'quick' }), 'g').check;
    expect(check?.status).toBe('failed');
    expect(check?.failures[0]?.actual).toContain('teardown: ');
  });

  it('awaits every call in async mode and times out a hanging case during the check', async () => {
    const ok = defineSuite({
      id: 'x',
      groups: [
        compare({
          id: 'g',
          title: 'G',
          contract: { id: 'c', description: 'd' },
          inputs: [1, 2],
          baseline: 'a',
          mode: 'async',
          cases: asyncCases,
        }),
      ],
    });
    const result = await runSuite(ok, { profile: 'quick' });
    expect(group(result, 'g').check?.status).toBe('passed');
    expect(group(result, 'g').cases.every(entry => entry.summary.estimate > 0)).toBe(true);

    const hang = defineSuite({
      id: 'x',
      groups: [
        compare({
          id: 'g',
          title: 'G',
          contract: { id: 'c', description: 'd' },
          inputs: [1],
          baseline: 'a',
          mode: 'async',
          cases: {
            a: asyncCases.a,
            b: {
              run: () =>
                new Promise<number>(() => {
                  /* never settles */
                }),
            },
          },
        }),
      ],
    });
    const hung = await runSuite(hang, { profile: 'quick', timeoutMs: 50 });
    expect(group(hung, 'g').check?.failures[0]).toMatchObject({
      case: 'b',
      actual: 'threw Error: timed out after 50 ms',
    });
  });
});

describe('measurement', () => {
  it('does not favour the first case: identical work under swapped keys and order ties', async () => {
    const body = (list: readonly number[]): number => {
      let total = 0;
      for (const value of list) total += value * 1.5;
      return total;
    };
    const twin = (order: readonly ['first' | 'second', 'first' | 'second']) =>
      compare({
        id: 'twins',
        title: 'Twins',
        contract: { id: 'twins/v1', description: 'same work' },
        inputs: arrays,
        baseline: order[0],
        // Two separate function objects with the same body.
        cases: c => Object.fromEntries(order.map(key => [key, c({ run: list => body(list) })])),
      });
    const budget = { rounds: 15, blockMs: 5, warmupMs: 20 };
    for (const order of [
      ['first', 'second'],
      ['second', 'first'],
    ] as const) {
      const result = await runSuite({ id: 'x', groups: [twin(order)] }, { profile: 'explore', budget, seed: 7 });
      const twins = group(result, 'twins');
      const [base, other] = twins.cases;
      // A favoured first case is a systematic gap that even each case's fastest block shows. Interference only
      // adds time, so fastest blocks resist a loaded machine; the bound is generous on purpose.
      const fastestRatio = other!.summary.min / base!.summary.min;
      expect(fastestRatio).toBeGreaterThan(0.67);
      expect(fastestRatio).toBeLessThan(1.5);
      // The verdict never declares a winner between identical twins unless the run admits it was noisy.
      const noisy = twins.cases.some(entry => entry.flags.includes('unstable'));
      if (!noisy) expect(['tie', 'inconclusive']).toContain(twins.comparisons[0]!.verdict);
    }
  }, 30_000);

  it('flags a body the JIT can drop (`() => 1`) against the empty-function floor, not real work', async () => {
    const suite = defineSuite({
      id: 'x',
      groups: [
        scenario({
          id: 'opt',
          title: 'Opt',
          inputs: arrays,
          cases: c => ({
            real: c({ run: list => list.reduce((total, value) => total + Math.sqrt(value), 0) }),
            constant: c({ run: () => 1 }),
          }),
        }),
      ],
    });
    const result = await runSuite(suite, { profile: 'explore', budget: { rounds: 7, blockMs: 3, warmupMs: 10 } });
    const opt = group(result, 'opt');
    expect(opt.floor?.estimate).toBeGreaterThan(0);
    expect(opt.cases.find(entry => entry.key === 'constant')?.flags).toContain('optimized-out');
    expect(opt.cases.find(entry => entry.key === 'real')?.flags).not.toContain('optimized-out');
    expect(result.publishable).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'optimized-out', case: 'constant' }));
  }, 30_000);

  it('keeps setup out of the timing', async () => {
    const busy = (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        // spin: a slow setup
      }
    };
    const suite = defineSuite({
      id: 'x',
      groups: [
        scenario({
          id: 'setup',
          title: 'Setup',
          inputs: [1, 2],
          cases: c => ({
            slow: c({
              setup: n => {
                busy(20);
                return [n, n + 1];
              },
              run: pair => pair[0]! + pair[1]!,
            }),
          }),
        }),
      ],
    });
    const result = await runSuite(suite, { profile: 'quick' });
    // If the 20 ms setup were timed per call, the estimate would be ≥ 2e7 ns.
    expect(group(result, 'setup').cases[0]!.summary.estimate).toBeLessThan(1e5);
  }, 30_000);

  it('interleaves rounds in a seeded random order', async () => {
    const four = compare({
      id: 'four',
      title: 'Four',
      contract: { id: 'c', description: 'd' },
      inputs: [1, 2],
      baseline: 'a',
      cases: {
        a: { run: (n: unknown) => n },
        b: { run: (n: unknown) => n },
        c: { run: (n: unknown) => n },
        d: { run: (n: unknown) => n },
      },
    });
    const order = async (seed: number) => {
      const events: ProgressEvent[] = [];
      await runSuite(
        { id: 'x', groups: [four] },
        {
          profile: 'quick',
          budget: { rounds: 4, blockMs: 1, warmupMs: 0 },
          seed,
          onProgress: event => events.push(event),
        },
      );
      return measureEvents(events, 'four');
    };
    const first = await order(1);
    // Every round times each case exactly once (interleaved, not case after case).
    for (let round = 1; round <= 4; round++) {
      expect(
        first
          .filter(event => event.block === round)
          .map(event => event.case)
          .toSorted(),
      ).toEqual(['a', 'b', 'c', 'd']);
    }
    expect(await order(1)).toEqual(first);
    expect(await order(2)).not.toEqual(first);
  }, 30_000);
});

describe('filter, metrics, size and the result shape', () => {
  const suite = (): SuiteSpec =>
    defineSuite({
      id: '@arki/x',
      title: 'X',
      groups: [
        sumGroup('one'),
        sumGroup('two'),
        metric({
          id: 'count',
          title: 'Count',
          unit: 'calls',
          deterministic: false,
          baseline: 'a',
          cases: { a: { collect: () => 3 }, b: { collect: async () => 4 } },
        }),
        size({ id: 'bundle', title: 'Bundle', baseline: 'a', cases: { a: { source: 'export {}' } } }),
      ],
    });

  it('runs only the selected group, or the selected case plus its baseline', async () => {
    const byGroup = await runSuite(suite(), { profile: 'quick', filter: 'two' });
    expect(byGroup.groups.map(entry => entry.id)).toEqual(['two']);
    const byCase = await runSuite(suite(), { profile: 'quick', filter: /^one\/reduce$/ });
    expect(byCase.groups.map(entry => entry.id)).toEqual(['one']);
    expect(group(byCase, 'one').cases.map(entry => entry.key)).toEqual(['loop', 'reduce']);
    await expect(runSuite(suite(), { profile: 'quick', filter: 'nothing-matches' })).rejects.toThrow(SpecError);
  });

  it('never marks a filtered run publishable, so a README cannot lose the groups it skipped', async () => {
    const filtered = await runSuite(suite(), { profile: 'quick', filter: 'two' });
    expect(filtered.publishable).toBe(false);
    expect(filtered.warnings.map(warning => warning.code)).toContain('filtered');
  });

  // A metric table (e.g. type instantiations vs type-fest) is only useful with
  // the ratio against the baseline; `differs` rows still get none.
  it('compares metric cases against the baseline: exact when deterministic, bootstrapped otherwise', async () => {
    const result = await runSuite(
      defineSuite({
        id: 'x',
        groups: [
          metric({
            id: 'exact',
            title: 'Exact',
            unit: 'instantiations',
            deterministic: true,
            baseline: 'a',
            cases: {
              a: { collect: () => 100 },
              b: { collect: () => 250 },
              c: { collect: () => 101 },
              d: { collect: () => 10, differs: 'counts something else' },
            },
          }),
          metric({
            id: 'repeated',
            title: 'Repeated',
            unit: 'calls',
            deterministic: false,
            baseline: 'a',
            cases: { a: { collect: () => 4 }, b: { collect: () => 2 } },
          }),
        ],
      }),
      { profile: 'quick' },
    );
    expect(group(result, 'exact').comparisons).toEqual([
      { case: 'b', ratio: 2.5, interval: [2.5, 2.5], verdict: 'higher' },
      { case: 'c', ratio: 1.01, interval: [1.01, 1.01], verdict: 'tie' },
    ]);
    expect(group(result, 'repeated').comparisons).toEqual([
      { case: 'b', ratio: 0.5, interval: [0.5, 0.5], verdict: 'lower' },
    ]);
  });

  it('repeats non-deterministic metrics, collects deterministic ones once, and skips size without a bundler', async () => {
    let calls = 0;
    const once = metric({
      id: 'once',
      title: 'Once',
      unit: 'x',
      deterministic: true,
      baseline: 'a',
      cases: { a: { collect: () => ++calls } },
    });
    const result = await runSuite({ id: 'x', groups: [once, ...suite().groups.slice(2)] }, { profile: 'quick' });
    expect(calls).toBe(1);
    expect(group(result, 'once')).toMatchObject({ deterministic: true, unit: 'x' });
    expect(group(result, 'count').cases.map(entry => entry.summary.n)).toEqual([
      PROFILE_BUDGETS.quick.metricRepeats,
      PROFILE_BUDGETS.quick.metricRepeats,
    ]);
    expect(result.groups.some(entry => entry.id === 'bundle')).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'size-skipped', group: 'bundle' }));

    const seen: string[] = [];
    const withSize = await runSuite(
      { id: 'x', groups: suite().groups.slice(3) },
      {
        profile: 'quick',
        sizeRunner: async spec => {
          seen.push(spec.id);
          return { kind: 'size', id: spec.id, title: spec.title, unit: 'B', cases: [], comparisons: [] };
        },
      },
    );
    expect(seen).toEqual(['bundle']);
    expect(group(withSize, 'bundle').specHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns a complete, JSON-safe schema-1 result', async () => {
    const result = await runSuite(suite(), { profile: 'quick', seed: 42 });
    // A JSON round trip (not structuredClone) is the point: NaN/Infinity would come back as null.
    // eslint-disable-next-line unicorn/prefer-structured-clone
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result).toMatchObject({ schema: 1, profile: 'quick', seed: 42, publishable: false });
    expect(result.suite).toMatchObject({ id: '@arki/x', title: 'X', notes: [] });
    expect(result.suite.specHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.warnings.map(warning => warning.code)).toContain('quick-profile');
    expect(result.environment.runtime.name).toBe('node');
    expect(result.environment.harness).toEqual({ version: VERSION, mitata: MITATA_VERSION });
    expect(Number.isNaN(Date.parse(result.environment.date))).toBe(false);

    const checkSummary = (summary: Summary) => {
      for (const value of [
        summary.estimate,
        summary.median,
        summary.min,
        summary.max,
        summary.p75,
        summary.p99,
        summary.cv,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(summary.interval[0]).toBeLessThanOrEqual(summary.interval[1]);
      expect(summary.n).toBeGreaterThan(0);
    };
    const checkBlock = (block: Block) => {
      expect(block).toEqual({ process: 0, block: 0, ns: expect.any(Number), ops: expect.any(Number) });
      expect(block.ops).toBeGreaterThan(0);
    };
    for (const entry of result.groups) {
      expect(entry.specHash).toMatch(/^[0-9a-f]{16}$/);
      for (const row of entry.cases) {
        checkSummary(row.summary);
        if (entry.kind === 'compare') for (const block of row.blocks ?? []) checkBlock(block);
      }
    }
    expect(group(result, 'one')).toMatchObject({
      kind: 'compare',
      unit: 'ns/op',
      baseline: 'loop',
      contract: { id: 'sum/v1' },
    });
    expect(group(result, 'one').floor).toBeDefined();
    expect(group(result, 'one').specHash).not.toBe(group(result, 'two').specHash);
  });
});

describe('caseFlags', () => {
  const summary = (estimate: number, interval: [number, number], cv = 0.01, n = 10): Summary => ({
    estimate,
    interval,
    median: estimate,
    min: estimate,
    max: estimate,
    p75: estimate,
    p99: estimate,
    cv,
    n,
  });
  const floor = summary(10, [9, 11]);

  it('does not judge from a single floor block, because one block has no "fastest of several"', () => {
    expect(caseFlags(summary(6, [6, 6], 0, 1), summary(10, [10, 10], 0, 1), 0.1)).toEqual([]);
  });

  it('does not flag real work against a floor that was itself preempted', () => {
    // An empty call never costs 853 ns: that floor was interrupted, so it cannot judge a 927 ns parse.
    const disturbed = summary(853, [853, 853]);
    expect(caseFlags(summary(927, [927, 927]), disturbed, 0.1)).toEqual([]);
    expect(caseFlags(summary(128, [128, 128]), disturbed, 0.1)).toEqual([]);
  });

  it('flags work inside or barely above the floor, and noisy cases', () => {
    expect(caseFlags(summary(6, [5, 7]), floor, 0.1)).toEqual(['optimized-out']); // `() => 1` can be below the floor
    expect(caseFlags(summary(11.9, [11, 13]), floor, 0.1)).toEqual(['optimized-out']); // within 20% of the floor
    // A preempted floor block inflates the floor's interval, not its median: real work is not flagged.
    expect(
      caseFlags(summary(50, [48, 52]), { ...floor, estimate: 400, interval: [10, 2000], median: 300, max: 5000 }, 0.1),
    ).toEqual([]);
    // A dropped body stays flagged even when some of its blocks were preempted.
    expect(
      caseFlags(
        { ...summary(10.5, [10, 900]), estimate: 400, median: 300, max: 5000 },
        floor,
        Number.POSITIVE_INFINITY,
      ),
    ).toEqual(['optimized-out']);
    expect(caseFlags(summary(50, [48, 52]), floor, 0.1)).toEqual([]);
    expect(caseFlags(summary(50, [48, 52], 0.2), floor, 0.1)).toEqual(['unstable']);
    expect(caseFlags(summary(50, [50, 50], 0.2, 1), floor, 0.1)).toEqual([]); // one block has no spread
  });
});

describe('deepEqual: what the contract check calls equal', () => {
  it('matches Set and Map entries one-to-one, so two equal entries cannot both claim the same partner', () => {
    expect(deepEqual(new Set([{ a: 1 }, { a: 1 }]), new Set([{ a: 1 }, { b: 2 }]))).toBe(false);
    expect(deepEqual(new Set([{ a: 1 }, { b: 2 }]), new Set([{ b: 2 }, { a: 1 }]))).toBe(true);
    const twin = (): Map<unknown, number> =>
      new Map([
        [{ k: 1 }, 1],
        [{ k: 1 }, 1],
      ]);
    expect(
      deepEqual(
        twin(),
        new Map<unknown, number>([
          [{ k: 1 }, 1],
          [{ k: 2 }, 1],
        ]),
      ),
    ).toBe(false);
    expect(deepEqual(twin(), twin())).toBe(true);
  });

  it('compares binary data by bytes, dates by time and patterns by source and flags', () => {
    expect(deepEqual(new Uint8Array([1]).buffer, new Uint8Array([2]).buffer)).toBe(false);
    expect(deepEqual(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer)).toBe(true);
    expect(deepEqual(new DataView(new Uint8Array([1]).buffer), new DataView(new Uint8Array([3]).buffer))).toBe(false);
    expect(deepEqual(new Float64Array([0]), new Float64Array([-0]))).toBe(false);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint16Array([1, 2]))).toBe(false);
    expect(deepEqual(new Date(Number.NaN), new Date(Number.NaN))).toBe(true);
    expect(deepEqual(/a/g, /a/g)).toBe(true);
    expect(deepEqual(/a/g, /a/i)).toBe(false);
  });

  it('never calls two opaque objects equal: they have no data to compare', () => {
    class Money {
      readonly #cents: number;
      constructor(cents: number) {
        this.#cents = cents;
      }
      get cents(): number {
        return this.#cents;
      }
    }
    // Before: two instances with only private state compared like two empty objects, so any amount passed.
    expect(deepEqual(new Money(1), new Money(2))).toBe(false);
    expect(deepEqual(Promise.resolve(1), Promise.resolve(1))).toBe(false);
    expect(deepEqual(new WeakMap(), new WeakMap())).toBe(false);
    expect(
      deepEqual(
        () => 1,
        () => 1,
      ),
    ).toBe(false);
    const same = new Money(3);
    expect(deepEqual(same, same)).toBe(true);
    // Instances with own data still compare by it.
    class Point {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }
    expect(deepEqual(new Point(1, 2), new Point(1, 2))).toBe(true);
  });

  it('fails the check with a message that says the value is not comparable and to normalize it', async () => {
    const opaque = () => new WeakMap();
    const result = await runSuite(
      defineSuite({
        id: 'x',
        groups: [
          compare({
            id: 'opaque',
            title: 'Opaque',
            contract: { id: 'o/v1', description: 'a map' },
            inputs: [1],
            baseline: 'a',
            cases: { a: { run: opaque }, b: { run: opaque } },
          }),
        ],
      }),
      { profile: 'quick' },
    );
    const failure = group(result, 'opaque').check?.failures[0];
    expect(failure?.actual).toContain('not comparable');
    expect(failure?.actual).toContain('`normalize`');
  });
});

describe('inputs and state', () => {
  const tiny = { rounds: 3, blockMs: 1, warmupMs: 1 };

  it('gives the oracle and each case their own input, and catches a run() that changes its input while timed', async () => {
    // `drain` empties its list. Shared inputs would let it change what `plain` and the oracle see.
    const result = await runSuite(
      defineSuite({
        id: 'x',
        groups: [
          compare({
            id: 'length',
            title: 'Length',
            contract: { id: 'len/v1', description: 'the length' },
            inputs: [[1, 2, 3]],
            expected: (list: number[]) => list.length,
            baseline: 'plain',
            cases: {
              drain: {
                run: (list: number[]) => {
                  const length = list.length;
                  list.length = 0;
                  return length;
                },
              },
              plain: { run: (list: number[]) => list.length },
            },
          }),
        ],
      }),
      { profile: 'quick', budget: tiny },
    );
    expect(group(result, 'length').check?.status).toBe('passed');
    const mutated = result.warnings.filter(warning => warning.code === 'state-mutated');
    expect(mutated.map(warning => warning.case)).toEqual(['drain']);
    expect(mutated[0]?.message).toContain(
      'run() changed its input during timing; give each call fresh state or do not mutate',
    );
    expect(BLOCKING_WARNINGS).toContain('state-mutated');
  });

  it('shares inputs that cannot be copied faithfully, with a non-blocking warning naming the group', async () => {
    class Box {
      constructor(readonly value: number) {}
      double(): number {
        return this.value * 2;
      }
    }
    const result = await runSuite(
      defineSuite({
        id: 'x',
        groups: [
          compare({
            id: 'boxes',
            title: 'Boxes',
            contract: { id: 'b/v1', description: 'twice the value' },
            inputs: [new Box(2)],
            baseline: 'method',
            // structuredClone would turn Box into a plain object and break `double()`.
            cases: { method: { run: (box: Box) => box.double() }, field: { run: (box: Box) => box.value * 2 } },
          }),
        ],
      }),
      { profile: 'quick', budget: tiny },
    );
    expect(group(result, 'boxes').check?.status).toBe('passed');
    const shared = result.warnings.find(warning => warning.code === 'inputs-shared');
    expect(shared).toMatchObject({ group: 'boxes' });
    expect(BLOCKING_WARNINGS).not.toContain('inputs-shared');
  });

  it('rejects a setup that returns a promise, since only synchronous setup is supported', async () => {
    const suite = defineSuite({
      id: 'x',
      groups: [
        compare({
          id: 'g',
          title: 'G',
          contract: { id: 'g/v1', description: 'x' },
          inputs: [1],
          baseline: 'a',
          cases: { a: { setup: async (n: number) => n, run: n => n }, b: { run: (n: number) => n } },
        }),
      ],
    });
    await expect(runSuite(suite, { profile: 'quick' })).rejects.toThrow(
      'setup() returned a promise; setup is synchronous — open async resources at module load or in a top-level await',
    );
  });

  it('reports a run error and a teardown error together in the check', async () => {
    const result = await runSuite(
      defineSuite({
        id: 'x',
        groups: [
          compare({
            id: 'g',
            title: 'G',
            contract: { id: 'g/v1', description: 'x' },
            inputs: [1],
            baseline: 'a',
            cases: {
              a: { run: (n: number) => n },
              b: {
                run: () => {
                  throw new Error('run broke');
                },
                teardown: () => {
                  throw new Error('close broke');
                },
              },
            },
          }),
        ],
      }),
      { profile: 'quick' },
    );
    const actual = group(result, 'g').check?.failures[0]?.actual ?? '';
    expect(actual).toContain('run broke');
    expect(actual).toContain('teardown: Error: close broke');
  });

  it('tears down every state after timing even when one teardown or a later setup throws', async () => {
    const closed: string[] = [];
    let setups = 0;
    const lateSetupFailure = defineSuite({
      id: 'x',
      groups: [
        compare({
          id: 'g',
          title: 'G',
          contract: { id: 'g/v1', description: 'x' },
          inputs: [1],
          baseline: 'a',
          cases: {
            a: { setup: (n: number) => n, run: n => n, teardown: () => void closed.push('a') },
            b: {
              setup: (n: number) => {
                // The check's call succeeds; the timing call (the second) throws.
                if (++setups === 2) throw new Error('setup broke');
                return n;
              },
              run: n => n,
            },
          },
        }),
      ],
    });
    await expect(runSuite(lateSetupFailure, { profile: 'quick', budget: tiny })).rejects.toThrow('setup broke');
    // a: once after the check, once for the state made before b's setup threw.
    expect(closed).toEqual(['a', 'a']);

    closed.length = 0;
    const failingTeardown = defineSuite({
      id: 'x',
      groups: [
        compare({
          id: 'g',
          title: 'G',
          contract: { id: 'g/v1', description: 'x' },
          inputs: [1],
          baseline: 'a',
          cases: {
            a: {
              run: (n: number) => n,
              teardown: () => {
                if (closed.includes('b')) throw new Error('close broke');
                closed.push('a');
              },
            },
            b: { run: (n: number) => n, teardown: () => void closed.push('b') },
          },
        }),
      ],
    });
    const result = await runSuite(failingTeardown, { profile: 'quick', budget: tiny });
    expect(closed.filter(name => name === 'b')).toHaveLength(2);
    expect(result.warnings.find(warning => warning.code === 'teardown-failed')?.message).toContain('close broke');
    expect(BLOCKING_WARNINGS).toContain('teardown-failed');
  });
});

describe('metrics', () => {
  const metricSuite = (collect: () => number, deterministic = false): SuiteSpec =>
    defineSuite({
      id: 'x',
      groups: [
        metric({
          id: 'm',
          title: 'M',
          unit: 'ms',
          deterministic,
          baseline: 'a',
          cases: { a: { collect }, b: { collect: () => 5 } },
        }),
      ],
    });

  it('rejects a negative value, naming the case and collect()', async () => {
    await expect(
      runSuite(
        metricSuite(() => -1),
        { profile: 'quick' },
      ),
    ).rejects.toThrow(/case "a": collect\(\) returned -1; it must return a finite number ≥ 0/);
  });

  it('keeps every observation as a one-op block, so hosts can merge processes', async () => {
    let value = 10;
    const result = await runSuite(
      metricSuite(() => value++),
      { profile: 'explore' },
    );
    const observations = group(result, 'm').cases[0]?.blocks ?? [];
    expect(observations).toHaveLength(PROFILE_BUDGETS.explore.metricRepeats);
    expect(observations.every(block => block.ops === 1)).toBe(true);
    expect(observations.map(block => block.ns)).toEqual(Array.from({ length: observations.length }, (_, i) => 10 + i));
  });

  it('estimates with the median and compares medians, so one stalled repeat does not move the verdict', async () => {
    // 9 repeats of 5 ms and one 500 ms stall: the mean would call `a` 11× slower than `b`.
    let call = 0;
    const result = await runSuite(
      metricSuite(() => (++call === 3 ? 500 : 5)),
      {
        profile: 'explore',
        budget: { maxCv: Number.POSITIVE_INFINITY },
      },
    );
    expect(group(result, 'm').cases[0]?.summary.estimate).toBe(5);
    expect(group(result, 'm').comparisons[0]).toMatchObject({ case: 'b', ratio: 1, verdict: 'tie' });
  });

  it('flags a repeated metric that varies beyond the profile limit, like a timed case', async () => {
    let value = 1;
    const result = await runSuite(
      metricSuite(() => (value *= 2)),
      { profile: 'explore' },
    );
    expect(group(result, 'm').cases[0]?.flags).toEqual(['unstable']);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'unstable', group: 'm', case: 'a' }));
  });
});

describe('assessResult', () => {
  const base = async (): Promise<BenchResult> =>
    runSuite(defineSuite({ id: 'x', groups: [sumGroup()] }), {
      profile: 'quick',
      budget: { rounds: 3, blockMs: 1, warmupMs: 1 },
    });

  it('makes only publish runs publishable: explore gets a blocking warning like quick', async () => {
    const result = await base();
    expect(assessResult({ ...result, profile: 'explore', warnings: [] }).warnings.map(w => w.code)).toContain(
      'explore-profile',
    );
    expect(assessResult({ ...result, profile: 'explore', warnings: [] }).publishable).toBe(false);
    expect(BLOCKING_WARNINGS).toEqual(expect.arrayContaining(['quick-profile', 'explore-profile']));
  });

  it('blocks publishing when size groups were skipped or unmeasured, or a runtime was missing', async () => {
    const result = { ...(await base()), profile: 'publish' as const, groups: [] };
    for (const code of ['size-skipped', 'size-unavailable', 'runtime-missing']) {
      expect(assessResult({ ...result, warnings: [{ code, message: code }] }).publishable).toBe(false);
    }
    expect(assessResult({ ...result, warnings: [{ code: 'package-version-unknown', message: 'x' }] }).publishable).toBe(
      true,
    );
  });

  it('drops derived warnings it can no longer justify and keeps every other warning', async () => {
    const result = { ...(await base()), profile: 'publish' as const, groups: [] };
    const stale = { code: 'unstable', message: 'old claim', group: 'gone', case: 'x' };
    const kept = { code: 'state-mutated', message: 'drained', group: 'g', case: 'y' };
    const assessed = assessResult({ ...result, warnings: [stale, kept] });
    expect(assessed.warnings).toEqual([kept]);
    expect(assessed.publishable).toBe(false);
  });
});
