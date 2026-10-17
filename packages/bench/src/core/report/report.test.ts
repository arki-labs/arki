import { describe, expect, it } from 'vitest';

import type { BenchResult, Block, CaseResult, Comparison, GroupResult, RunComparison, Summary } from '../types.js';
import { renderComparison, renderMarkdown, renderText } from './index.js';

// ---------------------------------------------------------------------------
// Fixture: a publish run of a money library against three competitors
// ---------------------------------------------------------------------------

function summary(estimate: number, spread = 0.03): Summary {
  return {
    estimate,
    interval: [estimate * (1 - spread), estimate * (1 + spread)],
    median: estimate,
    min: estimate * 0.9,
    max: estimate * 1.2,
    p75: estimate * 1.05,
    p99: estimate * 1.15,
    cv: 0.02,
    n: 50,
  };
}

function blocks(processes: number, perProcess: number, ns: number): Block[] {
  return Array.from({ length: processes * perProcess }, (_, index) => ({
    process: Math.floor(index / perProcess),
    block: index % perProcess,
    ns: ns * 1000,
    ops: 1000,
  }));
}

function row(key: string, estimate: number, extra: Partial<CaseResult> = {}): CaseResult {
  return {
    key,
    label: key,
    role: 'competitor',
    summary: summary(estimate),
    flags: [],
    blocks: blocks(5, 10, estimate),
    ...extra,
  };
}

const comparison = (
  name: string,
  ratio: number,
  interval: readonly [number, number],
  verdict: Comparison['verdict'],
): Comparison => ({
  case: name,
  ratio,
  interval,
  verdict,
});

const roundGroup: GroupResult = {
  kind: 'compare',
  id: 'round',
  title: 'Round to cents',
  unit: 'ns',
  contract: { id: 'round@1', description: 'the amount rounded half-even to 2 decimals' },
  check: { status: 'passed', inputs: 12, failures: [] },
  baseline: 'arki',
  cases: [
    row('arki', 412, { label: '@arki/money', package: '@arki/money', role: 'baseline' }),
    row('dinero', 1318, { label: 'dinero.js', package: 'dinero.js' }),
    row('big', 227, { label: 'big.js', package: 'big.js' }),
    row('decimal', 416, { label: 'decimal.js', package: 'decimal.js', flags: ['unstable'] }),
    row('currency', 450, { label: 'currency.js', package: 'currency.js' }),
    row('naive', 90, { label: 'naive | `toFixed`', role: 'differs', differs: 'rounds half-up only' }),
  ],
  comparisons: [
    comparison('dinero', 3.2, [3, 3.4], 'higher'),
    comparison('big', 0.55, [0.52, 0.58], 'lower'),
    comparison('decimal', 1.01, [0.995, 1.015], 'tie'),
    comparison('currency', 1.1, [0.9, 1.3], 'inconclusive'),
  ],
};

const sizeGroup: GroupResult = {
  kind: 'size',
  id: 'bundle',
  title: 'Bundle size',
  unit: 'B',
  baseline: 'arki',
  cases: [
    {
      ...row('arki', 8210, { label: '@arki/money', package: '@arki/money', role: 'baseline', blocks: undefined }),
      size: { raw: 24_100, gzip: 8210, brotli: 7100, files: [] },
      limit: 10_000,
    },
    {
      ...row('dinero', 21_000, { label: 'dinero.js', package: 'dinero.js', blocks: undefined, flags: ['over-limit'] }),
      size: { raw: 70_000, gzip: 21_000, brotli: 18_000, files: [] },
      limit: 10_000,
    },
  ],
  comparisons: [comparison('dinero', 2.56, [2.56, 2.56], 'higher')],
};

const metricGroup: GroupResult = {
  kind: 'metric',
  id: 'types',
  title: 'Type instantiations',
  unit: 'instantiations',
  deterministic: true,
  baseline: 'arki',
  cases: [
    {
      ...row('arki', 1200, { label: '@arki/money', role: 'baseline', blocks: undefined }),
      summary: { ...summary(1200), interval: [1200, 1200] },
    },
    {
      ...row('dinero', 3600, { label: 'dinero.js', blocks: undefined }),
      summary: { ...summary(3600), interval: [3600, 3600] },
    },
  ],
  comparisons: [comparison('dinero', 3, [3, 3], 'higher')],
};

function fixture(overrides: Partial<BenchResult> = {}): BenchResult {
  return {
    schema: 1,
    suite: {
      id: '@arki/money',
      title: 'Benchmarks',
      intro: 'Money math against the libraries people use.',
      notes: ['Inputs include negative amounts.'],
      specHash: 'abc123',
    },
    profile: 'publish',
    seed: 42,
    publishable: true,
    warnings: [],
    environment: {
      runtime: { name: 'node', version: '22.13.1' },
      os: 'darwin',
      arch: 'arm64',
      cpu: 'Apple M3 Max',
      cores: 14,
      memory: 36 * 1024 ** 3,
      flags: [],
      harness: { version: '0.1.0', mitata: '1.0.34' },
      git: { revision: '355df1909cabcdef', dirty: false },
      date: '2026-10-13T10:00:00.000Z',
    },
    packages: {
      '@arki/money': '1.2.0',
      'dinero.js': '2.0.0',
      'big.js': '6.2.1',
      'decimal.js': '10.4.3',
      'currency.js': '2.0.4',
    },
    groups: [roundGroup, sizeGroup, metricGroup],
    ...overrides,
  };
}

const ESC = String.fromCodePoint(27);
const stripAnsi = (text: string): string => text.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
const lineWith = (text: string, needle: string): string => text.split('\n').find(line => line.includes(needle)) ?? '';

/** Splits a Markdown table row on unescaped pipes. */
const cells = (line: string): string[] =>
  line
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim());

// ---------------------------------------------------------------------------
// renderText
// ---------------------------------------------------------------------------

describe('renderText', () => {
  const text = renderText(fixture());

  it('states every verdict with its interval, and never invents a winner for ties or unclear differences', () => {
    expect(lineWith(text, '  @arki/money ')).toContain('1.00× baseline');
    expect(lineWith(text, 'dinero.js')).toContain('3.2× slower [3.0–3.4]');
    // Faster rows show the speed-up factor with the interval inverted to match.
    expect(lineWith(text, 'big.js')).toContain('1.8× faster [1.7–1.9]');
    expect(lineWith(text, 'decimal.js')).toContain('≈ same');
    expect(lineWith(text, 'currency.js')).toContain('? inconclusive [0.90–1.30×]');
  });

  it('shows rows that do other work without a ratio', () => {
    const naive = lineWith(text, 'naive');
    expect(naive).toContain('different contract: rounds half-up only');
    expect(naive).not.toMatch(/\d×/);
  });

  it('flags unstable rows and sizes over budget', () => {
    expect(lineWith(text, 'decimal.js')).toContain('⚠ unstable');
    expect(
      text
        .split('\n')
        .filter(line => line.includes('dinero.js'))
        .some(line => line.includes('over budget')),
    ).toBe(true);
  });

  it('prints the run design and seed in the header, read from the recorded blocks', () => {
    const header = text.split('\n')[1] ?? '';
    expect(header).toContain('publish · 5 processes × 10 blocks');
    expect(header).toContain('seed 42');
    expect(header).toContain('Node 22.13.1');
    expect(header).toContain('Apple M3 Max (14 cores)');
  });

  it('prints the contract and its check under a compare group', () => {
    expect(text).toContain(
      'round@1: every ranked row returns the amount rounded half-even to 2 decimals · ✓ checked on 12 inputs',
    );
  });

  it('uses no escape codes unless asked, and colors never shift the columns', () => {
    expect(text).not.toContain(ESC);
    const colored = renderText(fixture(), { color: true });
    expect(colored).toContain(ESC);
    expect(stripAnsi(colored)).toBe(text);
  });

  it('marks a non-publishable result at the top and lists the reasons at the end', () => {
    const output = renderText(
      fixture({
        publishable: false,
        profile: 'quick',
        warnings: [{ code: 'quick', message: 'quick runs are smoke tests' }],
      }),
    );
    const lines = output.trimEnd().split('\n');
    expect(lines.slice(0, 4).join('\n')).toContain('NOT PUBLISHABLE');
    expect(lines.at(-1)).toContain('quick runs are smoke tests');
  });

  it('reports a failed contract with the mismatching input', () => {
    const failed: GroupResult = {
      ...roundGroup,
      check: {
        status: 'failed',
        inputs: 12,
        failures: [{ case: 'dinero', input: 3, expected: '"1.00"', actual: '"1.01"' }],
      },
    };
    const output = renderText(fixture({ groups: [failed] }));
    expect(output).toContain('✗ FAILED: 1 mismatch on 12 inputs');
    expect(output).toContain('dinero · input #3: expected "1.00", got "1.01"');
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  const markdown = renderMarkdown(fixture());

  it('starts with the section heading and ends with the meta line check reads', () => {
    expect(markdown.startsWith('## Benchmarks\n')).toBe(true);
    const last = markdown.trimEnd().split('\n').at(-1) ?? '';
    const match = /^<!-- bench:meta (\{.*\}) -->$/.exec(last);
    expect(match).not.toBeNull();
    expect(JSON.parse(match?.[1] ?? '{}')).toEqual({
      schema: 1,
      suite: '@arki/money',
      specHash: 'abc123',
      profile: 'publish',
      date: '2026-10-13T10:00:00.000Z',
      harness: '0.1.0',
    });
  });

  it('names the environment, run design and every competitor version', () => {
    expect(markdown).toContain('Measured on Node 22.13.1 (darwin arm64, Apple M3 Max (14 cores))');
    expect(markdown).toContain('@arki/bench 0.1.0 (mitata 1.0.34)');
    expect(markdown).toContain('publish · 5 processes × 10 blocks, seed 42');
    expect(markdown).toContain('commit 355df1909c');
    expect(markdown).toContain(
      'Versions: @arki/money 1.2.0 · big.js 6.2.1 · currency.js 2.0.4 · decimal.js 10.4.3 · dinero.js 2.0.0.',
    );
  });

  it('states the contract every ranked row keeps and how widely it was checked', () => {
    expect(markdown).toContain(
      'Every ranked row returns the amount rounded half-even to 2 decimals; checked on 12 inputs.',
    );
  });

  it('builds the compare table with intervals and verdict words, never "fastest"', () => {
    expect(markdown).toContain('| Library | Version | Time / op | 95% interval | vs @arki/money |');
    expect(cells(lineWith(markdown, '| **@arki/money**'))).toEqual([
      '**@arki/money**',
      '1.2.0',
      '412 ns',
      '400–424 ns',
      'baseline',
    ]);
    expect(lineWith(markdown, '| dinero.js |')).toContain('3.2× slower [3.0–3.4]');
    expect(lineWith(markdown, '| big.js |')).toContain('1.8× faster [1.7–1.9]');
    expect(lineWith(markdown, '| currency.js |')).toContain('inconclusive [0.90–1.30×]');
    expect(markdown.toLowerCase()).not.toContain('fastest');
  });

  it('escapes pipes and backticks so user labels cannot break a table', () => {
    const naive = lineWith(markdown, 'naive');
    expect(naive).toContain(String.raw`naive \| \`toFixed\``);
    expect(cells(naive)).toHaveLength(5);
    expect(cells(naive)[4]).toBe('different contract: rounds half-up only');
  });

  it('renders size tables with budgets and metric tables in their unit', () => {
    expect(markdown).toContain('| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/money |');
    expect(cells(lineWith(markdown, '| dinero.js | 2.0.0 | 21 kB'))).toEqual([
      'dinero.js',
      '2.0.0',
      '21 kB',
      '18 kB',
      '70 kB',
      '10 kB — **over budget**',
      '2.6× larger [2.6–2.6]',
    ]);
    // Deterministic metric: no interval column, unit as the header.
    expect(markdown).toContain('| Library | Version | instantiations | vs @arki/money |');
    expect(markdown).toContain('Deterministic metric in instantiations: measured once.');
  });

  it('calls a metric "measured once" only when the spec says deterministic, never from zero spread', () => {
    // Ten identical compile times are still ten repeats: the interval column and the wording must say so.
    const repeated: GroupResult = { ...metricGroup, deterministic: false };
    const output = renderMarkdown(fixture({ groups: [repeated] }));
    expect(output).not.toContain('measured once');
    expect(output).toContain('| Library | Version | instantiations | 95% interval | vs @arki/money |');
    expect(renderText(fixture({ groups: [repeated] }))).not.toContain('deterministic: measured once');
  });

  it('keeps the meta line one HTML comment even when a value contains -->', () => {
    // An unescaped --> would end the comment early and leak the rest of the JSON into the README.
    const output = renderMarkdown(
      fixture({ environment: { ...fixture().environment, date: '2026-10-13 --> <b>x</b>' } }),
    );
    const last = output.trimEnd().split('\n').at(-1) ?? '';
    expect(last.indexOf('-->')).toBe(last.length - 3);
    const json = /^<!-- bench:meta (\{.*\}) -->$/.exec(last)?.[1] ?? '{}';
    expect(JSON.parse(json)).toMatchObject({ date: '2026-10-13 --> <b>x</b>' });
  });

  it('records provenance, and the sha line matches what the release gate parses', () => {
    // Why: the release gate refuses stale numbers by reading `provenance: <sha>`; a reader needs the rest to judge whether they apply.
    const output = renderMarkdown(fixture(), { command: 'arki-bench run --profile publish --write-readme' });
    expect(/^provenance: ([0-9a-f]{7,40})\s*$/m.exec(output)?.[1]).toBe('355df1909cabcdef');
    expect(output).toContain('- command: `arki-bench run --profile publish --write-readme`');
    expect(output).toContain('- profile: publish');
    expect(output).toContain('@arki/bench 0.1.0, @arki/money 1.2.0, big.js 6.2.1');
    expect(output).toContain('- machine: darwin arm64, Apple M3 Max (14 cores), 36 GB RAM');
    expect(output).toMatch(/- inputs: .* 12/);
    expect(output).toContain('- source commit: 355df1909cabcdef');
    // Only the sha line starts with `provenance:`; the other fields cannot be mistaken for it.
    expect(output.split('\n').filter(line => line.startsWith('provenance:'))).toHaveLength(1);
  });

  it('leaves the sha line out when the run had no git revision, so the gate fails instead of trusting a guess', () => {
    // Why: a made-up sha would let stale numbers pass the freshness gate.
    const base = fixture();
    const output = renderMarkdown({ ...base, environment: { ...base.environment, git: undefined } });
    expect(output).not.toMatch(/^provenance:/m);
    expect(output).toContain('**Provenance**');
  });

  it('ends with a reproduce line that callers can change or drop', () => {
    expect(markdown).toContain('Reproduce: `bunx arki-bench run --profile publish` in the package directory.');
    expect(renderMarkdown(fixture(), { reproduce: 'Run `bun bench`.' })).toContain('Run `bun bench`.');
    expect(renderMarkdown(fixture(), { reproduce: '' })).not.toContain('Reproduce');
  });

  it('puts a visible warning right under the heading when the result is not publishable', () => {
    const output = renderMarkdown(
      fixture({ publishable: false, warnings: [{ code: 'busy-machine', message: 'load 34 on 12 cores' }] }),
    );
    const lines = output.split('\n');
    expect(lines[0]).toBe('## Benchmarks');
    expect(lines.slice(2, 5)).toEqual([
      '> **Not publishable.** Do not quote these numbers:',
      '>',
      '> - load 34 on 12 cores',
    ]);
  });

  it('never lets author text open an HTML comment that would collide with the README markers', () => {
    const output = renderMarkdown(fixture({ suite: { ...fixture().suite, intro: 'see <!-- bench:end -->' } }));
    expect(output).not.toContain('<!-- bench:end -->');
  });

  it('renders one column per runtime and warns that columns are not comparable', () => {
    const bun = fixture({
      environment: { ...fixture().environment, runtime: { name: 'bun', version: '1.4.2' } },
      groups: [roundGroup],
    });
    const node = fixture({ groups: [roundGroup] });
    const output = renderMarkdown(fixture({ runtimes: [node, bun], groups: [sizeGroup] }));
    expect(output).toContain('| Library | Version | Node 22.13.1 | Bun 1.4.2 |');
    expect(cells(lineWith(output, '| dinero.js | 2.0.0 | 1.32'))).toEqual([
      'dinero.js',
      '2.0.0',
      '1.32 µs ±3% · 3.2× slower [3.0–3.4]',
      '1.32 µs ±3% · 3.2× slower [3.0–3.4]',
    ]);
    expect(output).toContain('the columns are not comparable');
    // Size does not depend on the runtime: still a single table.
    expect(output).toContain('| Library | Version | JS+CSS gzip |');
    expect(renderText(fixture({ runtimes: [node, bun], groups: [] }))).toContain('Bun 1.4.2');
  });
});

// ---------------------------------------------------------------------------
// renderComparison
// ---------------------------------------------------------------------------

describe('renderComparison', () => {
  const failing: RunComparison = {
    status: 'fail',
    threshold: 0.05,
    warnings: [],
    rows: [
      {
        group: 'round',
        case: 'arki',
        base: 412,
        head: 470,
        unit: 'ns',
        ratio: 1.14,
        interval: [1.1, 1.18],
        status: 'regressed',
      },
      {
        group: 'round',
        case: 'big',
        base: 227,
        head: 226,
        unit: 'ns',
        ratio: 0.996,
        interval: [0.98, 1.01],
        status: 'within',
      },
      {
        group: 'bundle',
        case: 'arki',
        base: 8210,
        head: 8100,
        unit: 'B',
        ratio: 0.987,
        interval: [0.987, 0.987],
        status: 'within',
      },
      { group: 'round', case: 'naive', status: 'incompatible', reason: 'contract changed' },
    ],
  };

  it('ends with the verdict CI acts on, counting regressions beyond the threshold', () => {
    const text = renderComparison(failing, 'text');
    expect(text.trimEnd().split('\n').at(-1)).toBe(
      'FAIL — 1 regressed beyond 5% · 2 within tolerance · 1 incompatible',
    );
    const passing = renderComparison(
      { status: 'pass', threshold: 0.03, warnings: [], rows: failing.rows.slice(1) },
      'text',
    );
    expect(passing).toContain('PASS — none regressed beyond 3%');
  });

  it('prints base, head and the change with its interval in the case unit', () => {
    const line = lineWith(renderComparison(failing, 'text'), 'round/arki');
    expect(line).toMatch(/412 ns +470 ns +\+14% \[\+10%, \+18%\] +regressed/);
    expect(lineWith(renderComparison(failing, 'text'), 'bundle/arki')).toContain('8.21 kB');
    expect(lineWith(renderComparison(failing, 'text'), 'round/naive')).toContain('incompatible (contract changed)');
  });

  it('names a failed head contract as its own status and prints warnings under the verdict', () => {
    // A failed contract must read as a failure, never as cases that were simply removed.
    const comparison: RunComparison = {
      status: 'fail',
      threshold: 0.05,
      warnings: ['The base run is not publishable (explore-profile): its numbers may be noisy.'],
      rows: [
        { group: 'round', case: '(contract)', status: 'contract-failed', reason: 'contract check failed in head' },
      ],
    };
    const text = renderComparison(comparison, 'text');
    expect(text).toContain('FAIL — none regressed beyond 5% · 1 contract failed');
    expect(text.trimEnd().split('\n').at(-1)).toBe(
      'Warning: The base run is not publishable (explore-profile): its numbers may be noisy.',
    );
    expect(renderComparison(comparison, 'markdown')).toContain('> **Warning:** The base run is not publishable');
  });

  it('renders a Markdown table for PR comments', () => {
    const markdown = renderComparison(failing, 'markdown');
    expect(markdown).toContain('| Benchmark | Base | Head | Change [95% interval] | Status |');
    expect(markdown).toContain('**FAIL** — 1 regressed beyond 5%');
  });
});

describe('one-block rows', () => {
  // A quick run times one block per case: there is no interval to print, and
  // results saved before 0.0.2 even recorded a verdict for it. Neither may
  // reach a table as "50× slower [50–50]".
  const single = (estimate: number): Summary => ({
    ...summary(estimate),
    interval: [estimate, estimate],
    n: 1,
  });
  const quick: GroupResult = {
    ...roundGroup,
    cases: [
      row('arki', 100, { label: '@arki/money', role: 'baseline', summary: single(100), blocks: blocks(1, 1, 100) }),
      row('dinero', 5000, { label: 'dinero.js', summary: single(5000), blocks: blocks(1, 1, 5000) }),
    ],
    comparisons: [comparison('dinero', 50, [50, 50], 'higher')],
  };
  const result = fixture({ profile: 'quick', publishable: false, groups: [quick] });

  it('says "1 block" instead of a verdict or a zero-width interval', () => {
    const text = renderText(result);
    const markdown = renderMarkdown(result);
    for (const page of [text, markdown]) {
      expect(page).toContain('inconclusive (1 block)');
      expect(page).not.toContain('50× slower');
      expect(page).not.toMatch(/\[50(?:\.0+)?–50/);
    }
    // The interval column of the README table says why it is empty.
    expect(markdown).toMatch(/\| 5 µs \| 1 block \|/);
  });
});
