import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Io } from './cli.js';
import type { BenchResult, GroupResult, SuiteSpec } from './core/types.js';
import { ciProblems, helpText, main, parseArgs, parseThreshold, resultPath, suggest, UsageError } from './cli.js';
import { specHash } from './core/spec.js';
import { END_MARKER, START_MARKER } from './node/readme.js';

function capture(cwd: string): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: text => {
        out += text;
      },
      stderr: text => {
        err += text;
      },
      cwd,
      env: {},
      stdoutIsTTY: false,
      stderrIsTTY: false,
    },
    out: () => out,
    err: () => err,
  };
}

function usageError(argv: readonly string[]): string {
  try {
    parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return error.message;
    throw error;
  }
  throw new Error(`parseArgs(${argv.join(' ')}) did not reject`);
}

describe('parseArgs', () => {
  it('runs every discovered suite in explore mode when called with nothing', () => {
    const args = parseArgs([]);
    expect(args.command).toBe('run');
    expect(args.positionals).toEqual([]);
    expect(args.flags.size).toBe(0);
  });

  it('treats a leading file as `run <file>` and reads flags in both spellings', () => {
    const args = parseArgs(['bench/money.bench.ts', '--profile', 'publish', '--seed=7', '--ci']);
    expect(args.command).toBe('run');
    expect(args.positionals).toEqual(['bench/money.bench.ts']);
    expect(Object.fromEntries(args.flags)).toEqual({ profile: 'publish', seed: '7', ci: true });
  });

  it('rejects a mistyped option with a suggestion instead of ignoring it', () => {
    expect(usageError(['--profle', 'publish'])).toMatch(
      /Unknown option --profle for "arki-bench run"\. Did you mean --profile\?/,
    );
    expect(usageError(['compare', 'a.json', 'b.json', '--treshold', '5%'])).toMatch(/Did you mean --threshold\?/);
    // An option that exists on another command is still unknown here.
    expect(usageError(['report', 'x.json', '--ci'])).toMatch(/Unknown option --ci for "arki-bench report"/);
    expect(usageError(['-p', 'publish'])).toMatch(/two dashes/);
  });

  it('rejects a mistyped command or value with a suggestion', () => {
    expect(usageError(['reprot'])).toMatch(/Unknown command "reprot"\. Did you mean "report"\?/);
    expect(usageError(['--profile', 'publsh'])).toMatch(
      /must be one of quick, explore, publish; got "publsh"\. Did you mean publish\?/,
    );
  });

  it('rejects values on switches and missing values on options', () => {
    expect(usageError(['--json=yes'])).toMatch(/--json is a switch/);
    expect(usageError(['--seed'])).toMatch(/--seed needs a value/);
  });

  it('lets --write-readme take any path but a suite file, or default to the package README', () => {
    expect(parseArgs(['--write-readme']).flags.get('write-readme')).toBe(true);
    expect(parseArgs(['--write-readme', 'docs/BENCH.md']).flags.get('write-readme')).toBe('docs/BENCH.md');
    // Not only *.md: a docs file without the extension (or .markdown) is still the target.
    expect(parseArgs(['--write-readme', 'docs/BENCHMARKS']).flags.get('write-readme')).toBe('docs/BENCHMARKS');
    expect(parseArgs(['--write-readme', 'README.markdown']).flags.get('write-readme')).toBe('README.markdown');
    const args = parseArgs(['--write-readme', 'bench/x.bench.ts']);
    expect(args.flags.get('write-readme')).toBe(true);
    expect(args.positionals).toEqual(['bench/x.bench.ts']);
  });

  it('parses thresholds without ambiguity', () => {
    expect(parseThreshold('5%')).toBeCloseTo(0.05);
    expect(parseThreshold('0.05')).toBeCloseTo(0.05);
    expect(() => parseThreshold('5')).toThrow(/ambiguous; write 5% or 0.05/);
    expect(() => parseThreshold('-1%')).toThrow(/positive/);
  });

  it('suggests only near misses', () => {
    expect(suggest('jsno', ['json', 'markdown'])).toBe('json');
    expect(suggest('zebra', ['json', 'markdown'])).toBeUndefined();
  });
});

describe('main', () => {
  it('exits 1 with a plain message, not a stack trace, when no requested runtime is installed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arki-bench-cli-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    writeFileSync(path.join(dir, 'a.bench.ts'), 'export default { id: "a", groups: [] };\n');
    const { io, out, err } = capture(dir);
    // Before the fix runFile threw a plain Error that main rethrew: an unhandled rejection with a stack trace.
    expect(await main(['run', 'a.bench.ts', '--runtime', 'node', '--node', '/no/such/node'], io)).toBe(1);
    expect(err()).toMatch(/arki-bench: None of the requested runtimes is installed: node\.\n$/);
    expect(out()).toBe('');
  });

  it('exits 2 with the suggestion on stderr for a bad command line, and keeps stdout clean', async () => {
    const { io, out, err } = capture(tmpdir());
    expect(await main(['--profle', 'publish'], io)).toBe(2);
    expect(err()).toContain('Did you mean --profile?');
    expect(out()).toBe('');
  });

  it('prints help per command with examples', async () => {
    const { io, out } = capture(tmpdir());
    expect(await main(['compare', '--help'], io)).toBe(0);
    expect(out()).toBe(helpText('compare'));
    expect(out()).toContain('Usage: arki-bench compare <base.json> <head.json>');
    expect(out()).toContain('arki-bench compare .bench/base.json .bench/head.json --ci');
    const root = capture(tmpdir());
    await main(['--help'], root.io);
    expect(root.out()).toContain('arki-bench doctor');
  });

  it('prints the package version', async () => {
    const { io, out } = capture(tmpdir());
    expect(await main(['--version'], io)).toBe(0);
    expect(out()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// Commands against a throwaway package
// ---------------------------------------------------------------------------

function tempPackage(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'arki-bench-cli-'));
  writeFileSync(path.join(root, 'package.json'), '{"name":"demo","type":"module"}\n');
  mkdirSync(path.join(root, 'bench'));
  return root;
}

const SUITE_SOURCE = (body: string): string => `export default {
  id: 'demo',
  groups: [
    {
      kind: 'compare',
      id: 'sum',
      title: 'Sum',
      baseline: 'loop',
      contract: { id: 'sum/v1', description: 'the sum' },
      inputs: [[1, 2, 3]],
      cases: {
        loop: { run: xs => { ${body} } },
        reduce: { run: xs => xs.reduce((a, b) => a + b, 0) },
      },
    },
  ],
};
`;

const isSuite = (value: unknown): value is SuiteSpec =>
  typeof value === 'object' && value !== null && 'groups' in value;

describe('arki-bench check', () => {
  it('passes when the README section came from this suite and fails once the suite changes', async () => {
    const root = tempPackage();
    writeFileSync(
      path.join(root, 'bench', 'demo.bench.mjs'),
      SUITE_SOURCE('let s = 0; for (const x of xs) s += x; return s;'),
    );
    const module: unknown = await import(path.join(root, 'bench', 'demo.bench.mjs'));
    const spec = typeof module === 'object' && module !== null && 'default' in module ? module.default : undefined;
    if (!isSuite(spec)) throw new Error('the fixture suite did not load');
    const hash = specHash(spec);
    const readme = (meta: string): void =>
      writeFileSync(
        path.join(root, 'README.md'),
        `# demo\n\n${START_MARKER}\n## Benchmarks\n\n${meta}\n${END_MARKER}\n`,
      );

    readme(`<!-- bench:meta {"schema":1,"suite":"demo","specHash":"${hash}"} -->`);
    const fresh = capture(root);
    expect(await main(['check'], fresh.io)).toBe(0);
    expect(fresh.out()).toContain('✓ README.md is up to date with bench/demo.bench.mjs');

    // The README was generated from an older version of the suite.
    readme('<!-- bench:meta {"schema":1,"suite":"demo","specHash":"0000"} -->');
    const stale = capture(root);
    expect(await main(['check'], stale.io)).toBe(1);
    expect(stale.out()).toContain('README.md is stale: the suite changed since the section was generated');
    expect(stale.out()).toContain('arki-bench bench/demo.bench.mjs --profile publish --write-readme');
  });

  it('fails when the README has no generated section', async () => {
    const root = tempPackage();
    writeFileSync(path.join(root, 'bench', 'demo.bench.mjs'), SUITE_SOURCE('return xs.length;'));
    writeFileSync(path.join(root, 'README.md'), '# demo\n');
    const { io, out } = capture(root);
    expect(await main(['check'], io)).toBe(1);
    expect(out()).toContain('no benchmark markers');
  });

  it('tells a first-time user how to write a suite when none exists', async () => {
    const root = tempPackage();
    const { io, err } = capture(root);
    expect(await main(['list'], io)).toBe(1);
    expect(err()).toContain('No suites found');
    expect(err()).toContain("import { compare, defineSuite } from '@arki/bench';");
  });

  it('lists groups, contracts and case roles without running anything', async () => {
    const root = tempPackage();
    writeFileSync(path.join(root, 'bench', 'demo.bench.mjs'), SUITE_SOURCE('throw new Error("must not run");'));
    const { io, out } = capture(root);
    expect(await main(['list'], io)).toBe(0);
    expect(out()).toContain('contract sum/v1: the sum');
    expect(out()).toContain('cases: loop (baseline), reduce');
  });
});

// ---------------------------------------------------------------------------
// report / compare / --ci against saved results
// ---------------------------------------------------------------------------

const sizeGroup = (gzip: number, overLimit = false): GroupResult => ({
  kind: 'size',
  id: 'bundle',
  title: 'Bundle size',
  unit: 'B',
  baseline: 'demo',
  cases: [
    {
      key: 'demo',
      label: 'demo',
      role: 'baseline',
      summary: {
        estimate: gzip,
        interval: [gzip, gzip],
        median: gzip,
        min: gzip,
        max: gzip,
        p75: gzip,
        p99: gzip,
        cv: 0,
        n: 1,
      },
      size: { raw: gzip * 3, gzip, brotli: gzip - 10, files: [] },
      limit: 1000,
      flags: overLimit ? ['over-limit'] : [],
    },
  ],
  comparisons: [],
});

const saved = (overrides: Partial<BenchResult>): BenchResult => ({
  schema: 1,
  suite: { id: '@demo/lib', title: 'Benchmarks', notes: [], specHash: 'h' },
  profile: 'publish',
  seed: 1,
  publishable: true,
  warnings: [],
  environment: {
    runtime: { name: 'node', version: '22.13.1' },
    flags: [],
    harness: { version: '0.9.0', mitata: '1.0.34' },
    date: '2026-10-13T00:00:00.000Z',
  },
  packages: {},
  groups: [sizeGroup(500)],
  ...overrides,
});

function writeResult(root: string, name: string, result: BenchResult): string {
  const file = path.join(root, name);
  writeFileSync(file, JSON.stringify(result));
  return file;
}

describe('arki-bench report', () => {
  it('refuses to put a non-publishable result in the README unless forced, and the forced section keeps the warning', async () => {
    const root = tempPackage();
    const page = `# demo\n\n${START_MARKER}\nold\n${END_MARKER}\n`;
    writeFileSync(path.join(root, 'README.md'), page);
    writeResult(
      root,
      'quick.json',
      saved({
        profile: 'quick',
        publishable: false,
        warnings: [{ code: 'quick', message: 'quick runs are smoke tests' }],
      }),
    );

    const refused = capture(root);
    expect(await main(['report', 'quick.json', '--write', 'README.md'], refused.io)).toBe(1);
    expect(refused.err()).toContain('Not writing README.md: this result is not publishable.');
    expect(refused.err()).toContain('quick runs are smoke tests');
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(page);

    const forced = capture(root);
    expect(await main(['report', 'quick.json', '--write', 'README.md', '--force'], forced.io)).toBe(0);
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toContain('> - quick runs are smoke tests');
  });

  it('rejects files that are not results, naming the schema it found', async () => {
    const root = tempPackage();
    writeFileSync(path.join(root, 'old.json'), '{"schema":7}');
    const { io, err } = capture(root);
    expect(await main(['report', 'old.json'], io)).toBe(1);
    expect(err()).toContain('uses result schema 7; this arki-bench reads schema 1');
  });

  it('validates the whole result, naming the file and the first bad path', async () => {
    // A hand-edited or truncated result must fail loudly, not render a nonsense table.
    const root = tempPackage();
    const [group] = saved({}).groups;
    if (!group) throw new Error('fixture has no group');
    const [entry] = group.cases;
    if (!entry) throw new Error('fixture has no case');
    const cases: { name: string; result: BenchResult; path: string; message: string }[] = [
      {
        name: 'reversed.json',
        result: saved({
          groups: [{ ...group, cases: [{ ...entry, summary: { ...entry.summary, interval: [600, 400] } }] }],
        }),
        path: 'groups[0].cases[0].summary.interval',
        message: 'interval low is above high',
      },
      {
        name: 'twice.json',
        result: saved({ groups: [group, group] }),
        path: 'groups[1].id',
        message: 'group id "bundle" is used twice',
      },
      {
        name: 'keys.json',
        result: saved({ groups: [{ ...group, cases: [entry, entry] }] }),
        path: 'groups[0].cases[1].key',
        message: 'case key "demo" is used twice',
      },
      {
        name: 'negative.json',
        result: saved({ groups: [{ ...group, cases: [{ ...entry, summary: { ...entry.summary, cv: -1 } }] }] }),
        path: 'groups[0].cases[0].summary.cv',
        message: '',
      },
    ];
    for (const { name, result, path: where, message } of cases) {
      writeResult(root, name, result);
      const { io, err } = capture(root);
      expect(await main(['report', name], io)).toBe(1);
      expect(err()).toContain(`${name} is not a valid schema-1 result: at ${where}: ${message}`);
    }
  });

  it('renders Markdown from a saved result', async () => {
    const root = tempPackage();
    writeResult(root, 'r.json', saved({}));
    const { io, out } = capture(root);
    expect(await main(['report', 'r.json', '--format', 'markdown'], io)).toBe(0);
    expect(out()).toMatch(/^## Benchmarks\n/);
  });
});

describe('arki-bench run --json', () => {
  it('prints an array even for one suite, so scripts read one shape', async () => {
    const root = tempPackage();
    writeFileSync(
      path.join(root, 'bench', 'sum.bench.mjs'),
      SUITE_SOURCE('let s = 0; for (const x of xs) s += x; return s;'),
    );
    const { io, out } = capture(root);
    expect(await main(['run', '--profile', 'quick', '--json'], io)).toBe(0);
    const printed: unknown = JSON.parse(out());
    expect(Array.isArray(printed)).toBe(true);
    expect(Array.isArray(printed) ? printed.length : 0).toBe(1);
  }, 30_000);
});

describe('arki-bench run --profile quick --write-readme', () => {
  it('never writes the README, because quick numbers are smoke tests and must not be quoted', async () => {
    // Why: a README must only ever carry publishable numbers with provenance.
    const root = tempPackage();
    writeFileSync(
      path.join(root, 'bench', 'sum.bench.mjs'),
      SUITE_SOURCE('let s = 0; for (const x of xs) s += x; return s;'),
    );
    const page = `# demo\n\n${START_MARKER}\nold\n${END_MARKER}\n`;
    writeFileSync(path.join(root, 'README.md'), page);
    const { io, err } = capture(root);
    expect(await main(['run', '--profile', 'quick', '--write-readme'], io)).toBe(1);
    expect(err()).toContain('Not writing README.md');
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(page);
  }, 30_000);
});

describe('arki-bench compare --ci', () => {
  it('fails CI only when asked and only on a regression', async () => {
    const root = tempPackage();
    writeResult(root, 'base.json', saved({ groups: [sizeGroup(500)] }));
    writeResult(root, 'head.json', saved({ groups: [sizeGroup(800)] }));
    const report = capture(root);
    expect(await main(['compare', 'base.json', 'head.json'], report.io)).toBe(0);
    expect(report.out()).toContain('FAIL — 1 regressed beyond 5%');
    expect(await main(['compare', 'base.json', 'head.json', '--ci'], capture(root).io)).toBe(1);
    expect(await main(['compare', 'base.json', 'base.json', '--ci'], capture(root).io)).toBe(0);
  });
});

describe('arki-bench losses', () => {
  const summary = {
    estimate: 100,
    interval: [97, 103] as const,
    median: 100,
    min: 90,
    max: 110,
    p75: 105,
    p99: 109,
    cv: 0.02,
    n: 10,
  };
  const lossGroup = (role: 'competitor' | 'variant'): GroupResult => ({
    kind: 'compare',
    id: 'sum',
    title: 'Sum',
    unit: 'ns',
    baseline: 'demo',
    cases: [
      { key: 'demo', label: '@demo/lib', package: '@demo/lib', role: 'baseline', summary, flags: [] },
      { key: 'rival', label: 'rival', role, summary, flags: [] },
    ],
    comparisons: [{ case: 'rival', ratio: 0.5, interval: [0.45, 0.55], verdict: 'lower' }],
  });
  const rough = {
    profile: 'quick' as const,
    publishable: false,
    warnings: [{ code: 'quick-profile', message: 'quick' }],
  };

  it('reads the package .bench by default and fails CI only on a loss in a publishable result', async () => {
    const root = tempPackage();
    mkdirSync(path.join(root, '.bench'));
    writeResult(root, '.bench/rough.json', saved({ ...rough, groups: [lossGroup('competitor')] }));
    const listed = capture(root);
    // A rough result alone is listed, never a CI failure.
    expect(await main(['losses', '--ci'], listed.io)).toBe(0);
    expect(listed.out()).toContain('2.0× slower [1.8–2.2]');
    expect(listed.out()).toContain('rough: quick profile');

    writeResult(root, '.bench/clean.json', saved({ groups: [lossGroup('competitor')] }));
    const failing = capture(root);
    expect(await main(['losses', '--ci'], failing.io)).toBe(1);
    expect(failing.err()).toContain('FAIL — 1 loss in publishable results');
    expect(await main(['losses'], capture(root).io)).toBe(0);
  });

  it('finds **/.bench/*.json under a directory, skipping node_modules, and hides variants on request', async () => {
    const root = tempPackage();
    for (const folder of ['packages/a/.bench', 'node_modules/x/.bench'])
      mkdirSync(path.join(root, folder), { recursive: true });
    writeResult(root, 'packages/a/.bench/a.json', saved({ groups: [lossGroup('variant')] }));
    writeResult(root, 'node_modules/x/.bench/x.json', saved({ groups: [lossGroup('competitor')] }));
    const json = capture(root);
    expect(await main(['losses', '.', '--json'], json.io)).toBe(0);
    const losses: unknown = JSON.parse(json.out());
    expect(losses).toEqual([expect.objectContaining({ role: 'variant', suite: '@demo/lib' })]);
    expect(json.err()).toContain('Read 1 result.');
    // Variants count for CI while they are listed; --no-variants hides them from both.
    expect(await main(['losses', '.', '--ci'], capture(root).io)).toBe(1);
    const hidden = capture(root);
    expect(await main(['losses', '.', '--ci', '--no-variants'], hidden.io)).toBe(0);
    expect(hidden.out()).toMatch(/^No losses/);
  });

  it('reports a directory without results instead of printing an empty table', async () => {
    const root = tempPackage();
    const report = capture(root);
    expect(await main(['losses', '.'], report.io)).toBe(1);
    expect(report.err()).toContain('No .bench/*.json results under .');
  });
});

describe('ciProblems', () => {
  it('fails a failed contract, a size over budget, and a publish run that is not publishable', () => {
    const contract: GroupResult = {
      ...sizeGroup(500),
      kind: 'compare',
      id: 'sum',
      check: { status: 'failed', inputs: 3, failures: [{ case: 'x', input: 0, expected: '1', actual: '2' }] },
    };
    const problems = ciProblems(
      saved({
        publishable: false,
        warnings: [{ code: 'busy', message: 'load 30 on 12 cores' }],
        groups: [contract, sizeGroup(1500, true)],
      }),
    );
    expect(problems).toEqual([
      'sum: contract check failed (1 mismatches)',
      'bundle/demo: over its size budget',
      'the publish run is not publishable: load 30 on 12 cores',
    ]);
    // An explore run is allowed to be unpublishable.
    expect(ciProblems(saved({ profile: 'explore', publishable: false }))).toEqual([]);
  });
});

describe('resultPath', () => {
  it('saves results under the package root with a file-safe suite name', () => {
    expect(resultPath('/pkg', '@arki/money')).toBe(path.join('/pkg', '.bench', 'arki-money.json'));
  });
});
