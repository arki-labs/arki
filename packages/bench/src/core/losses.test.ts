import { describe, expect, it } from 'vitest';

import type { BenchResult, CaseResult, Comparison, GroupResult, Loss } from './types.js';
import { collectLosses } from './losses.js';
import { renderLosses } from './report/losses.js';

// ---------------------------------------------------------------------------
// Fixtures: saved results with hand-written comparisons (no timing)
// ---------------------------------------------------------------------------

function row(key: string, extra: Partial<CaseResult> = {}): CaseResult {
  return {
    key,
    label: key,
    role: 'competitor',
    summary: {
      estimate: 100,
      interval: [97, 103],
      median: 100,
      min: 90,
      max: 120,
      p75: 105,
      p99: 115,
      cv: 0.02,
      n: 10,
    },
    flags: [],
    ...extra,
  };
}

const lower = (key: string, ratio: number, interval: readonly [number, number]): Comparison => ({
  case: key,
  ratio,
  interval,
  verdict: 'lower',
});

function group(
  id: string,
  cases: readonly CaseResult[],
  comparisons: readonly Comparison[],
  extra: Partial<GroupResult> = {},
): GroupResult {
  return { kind: 'compare', id, title: `Title ${id}`, unit: 'ns', baseline: 'arki', cases, comparisons, ...extra };
}

function result(suite: string, groups: readonly GroupResult[], extra: Partial<BenchResult> = {}): BenchResult {
  return {
    schema: 1,
    suite: { id: suite, title: 'Benchmarks', notes: [], specHash: 'h' },
    profile: 'publish',
    seed: 1,
    publishable: true,
    warnings: [],
    environment: {
      runtime: { name: 'node', version: '22.13.1' },
      flags: [],
      harness: { version: '0.0.2', mitata: '1.0.34' },
      date: '2026-10-13T00:00:00.000Z',
    },
    packages: {},
    groups,
    ...extra,
  };
}

const own = (pkg: string): CaseResult => row('arki', { label: pkg, package: pkg, role: 'baseline' });

// @arki/money: a rival is 2× cheaper, a variant is 1.25× cheaper, a `differs`
// row is 10× cheaper (other work: never a loss), one rival is slower (a win).
const money = result('@arki/money', [
  group(
    'round',
    [
      own('@arki/money'),
      row('big', { label: 'big.js', package: 'big.js' }),
      row('split', { label: 'arki split', role: 'variant' }),
      row('naive', { role: 'differs', differs: 'rounds half-up' }),
      row('dinero', { label: 'dinero.js' }),
    ],
    [
      lower('big', 0.5, [0.45, 0.55]),
      lower('split', 0.8, [0.78, 0.82]),
      lower('naive', 0.1, [0.09, 0.11]),
      { case: 'dinero', ratio: 3, interval: [2.8, 3.2], verdict: 'higher' },
    ],
  ),
  // Size groups are exact: interval [r, r].
  group('bundle', [own('@arki/money'), row('dinero', { label: 'dinero.js' })], [lower('dinero', 0.25, [0.25, 0.25])], {
    kind: 'size',
    unit: 'B',
  }),
]);

// @arki/date: a quick run (not publishable) measured on two runtimes.
const dateGroup = (ratio: number): GroupResult =>
  group('parse', [own('@arki/date'), row('luxon')], [lower('luxon', ratio, [ratio * 0.9, ratio * 1.1])]);
const date = result('@arki/date', [dateGroup(0.4)], {
  profile: 'quick',
  publishable: false,
  warnings: [
    { code: 'quick-profile', message: 'quick' },
    { code: 'inputs-shared', message: 'advice only' },
    { code: 'busy-machine', message: 'busy' },
  ],
  runtimes: [
    result('@arki/date', [dateGroup(0.4)]),
    result('@arki/date', [dateGroup(0.2)], {
      environment: {
        runtime: { name: 'bun', version: '1.4.2' },
        flags: [],
        harness: { version: '0.0.2', mitata: '1.0.34' },
        date: '2026-10-13T00:00:00.000Z',
      },
    }),
  ],
});

describe('collectLosses', () => {
  const losses = collectLosses([money, date]);
  const keys = losses.map(loss => `${loss.suite} ${loss.runtime} ${loss.group.id}/${loss.case.key}`);

  it('lists every lower row against our own library, worst first, across suites and runtimes', () => {
    expect(keys).toEqual([
      '@arki/date bun parse/luxon', // 5×
      '@arki/money node bundle/dinero', // 4×
      '@arki/date node parse/luxon', // 2.5×
      '@arki/money node round/big', // 2×
      '@arki/money node round/split', // 1.25×
    ]);
  });

  it('never counts a differs row (other work) or a row where our library wins', () => {
    expect(keys.some(key => key.includes('naive'))).toBe(false);
    expect(keys.some(key => key.includes('round/dinero'))).toBe(false);
  });

  it('reads a runtime matrix per runtime, not the duplicated top level', () => {
    expect(losses.filter(loss => loss.suite === '@arki/date').map(loss => loss.runtime)).toEqual(['bun', 'node']);
  });

  it('states the baseline as N× the other row, with the interval inverted to match', () => {
    const big = losses.find(loss => loss.case.key === 'big');
    expect(big).toMatchObject({ factor: 2, role: 'competitor', baseline: '@arki/money', publishable: true, rough: [] });
    expect(big?.interval[0]).toBeCloseTo(1 / 0.55);
    expect(big?.interval[1]).toBeCloseTo(1 / 0.45);
    expect(big?.group).toEqual({ id: 'round', title: 'Title round', kind: 'compare' });
  });

  it('marks a variant: another way to call our own library is cheaper', () => {
    expect(losses.find(loss => loss.case.key === 'split')?.role).toBe('variant');
  });

  it('keeps rough results but says why they are rough, from the blocking warnings only', () => {
    const rough = losses.find(loss => loss.suite === '@arki/date');
    expect(rough).toMatchObject({ publishable: false, rough: ['quick profile', 'busy machine'] });
  });

  it('skips groups whose baseline is not the suite’s own library', () => {
    const native = result('@arki/json', [
      group(
        'parse',
        [row('arki', { role: 'baseline', package: 'some-other-lib' }), row('x')],
        [lower('x', 0.5, [0.4, 0.6])],
      ),
    ]);
    expect(collectLosses([native])).toEqual([]);
  });

  it('skips one-block comparisons, even when an older result recorded a verdict for them', () => {
    const single = { ...row('x'), summary: { ...row('x').summary, interval: [100, 100] as const, n: 1 } };
    const quick = result('@arki/kv', [group('get', [own('@arki/kv'), single], [lower('x', 0.02, [0.02, 0.02])])]);
    expect(collectLosses([quick])).toEqual([]);
  });
});

describe('renderLosses', () => {
  const losses = collectLosses([money, date]);

  it('prints a terminal table with words per kind, sections per role, and rough sources', () => {
    const text = renderLosses(losses, { format: 'text' });
    expect(text.split('\n')[0]).toBe('Losses  5 losses in 2 suites · 2 from rough results (not publishable)');
    expect(text).toContain('Competitors: a rival costs less than our library');
    expect(text).toContain('Variants: another way to call our own library costs less');
    expect(text).toMatch(
      /@arki\/money\s+node\s+round\s+@arki\/money\s+big\.js\s+2\.0× slower \[1\.8–2\.2\]\s+publishable/,
    );
    expect(text).toContain('4.0× larger (exact)');
    expect(text).toContain('rough: quick profile / busy machine');
    // Variants come after every competitor, in their own section.
    expect(text.indexOf('arki split')).toBeGreaterThan(text.indexOf('Variants:'));
  });

  it('prints Markdown for an issue or a PR', () => {
    const markdown = renderLosses(losses, { format: 'markdown' });
    expect(markdown).toContain('## Benchmark losses');
    expect(markdown).toContain('| Suite | Runtime | Group | Ours | Cheaper | Ours is | Source |');
    expect(markdown).toContain(
      '| @arki/money | node | Title round · round | @arki/money | big.js | 2.0× slower [1.8–2.2] | publishable |',
    );
    expect(markdown).toContain('**rough:** quick profile / busy machine');
  });

  it('says so when there is nothing to list', () => {
    const none: Loss[] = [];
    expect(renderLosses(none, { format: 'text' })).toMatch(/^No losses/);
  });
});
