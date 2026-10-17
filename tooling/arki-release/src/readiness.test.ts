import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  README_H2_ORDER,
  evaluateReadiness,
  generateReadinessBaseline,
  readmeH2s,
  renderReadinessTable,
  type ReadinessItemId,
} from './readiness';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'readiness-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** `@arki/math` is Tier 2, as in arki.release.config.ts. */
const config = { tiers: { stack: ['@arki/dot'], libraries: ['@arki/math'] } };

const README = README_H2_ORDER.map((s) => `## ${s.id}\n\ntext\n`).join('\n');

/** A tier 2 leaf package ("math") that passes every disk item. */
function makePackage(mutate: (pkg: Record<string, unknown>) => void = () => {}): string {
  const dir = path.join(root, 'packages', 'math');
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  for (const f of ['README.md', 'CHANGELOG.md', 'LICENSE', 'llms.txt', 'AGENTS.md', 'docs/agent-guide.md']) {
    writeFileSync(path.join(dir, f), f === 'README.md' ? README : 'x');
  }
  const pkg: Record<string, unknown> = {
    name: '@arki/math',
    description: 'Math',
    keywords: ['math'],
    homepage: 'https://arki.dev',
    repository: { type: 'git', url: 'x', directory: 'packages/math' },
    funding: 'https://example.com',
    sideEffects: false,
    engines: { node: '>=22' },
    files: ['dist/**', 'docs/**'],
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    license: 'MIT',
  };
  mutate(pkg);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

const status = (r: ReturnType<typeof evaluateReadiness>, id: ReadinessItemId) => r.items.find((i) => i.id === id)?.status;

describe('evaluateReadiness', () => {
  it('fails when repository.directory is removed', () => {
    // Why: the mirror and npm page link to the package folder; a missing directory breaks "view source".
    const dir = makePackage((p) => {
      p.repository = { type: 'git', url: 'x' };
    });
    const r = evaluateReadiness({ config, dir });
    expect(status(r, 'pkg-repository-directory')).toBe('fail');
    expect(r.dimension.status).toBe('fail');
  });

  it('passes every disk item for a complete package and reports external items as missing', () => {
    // Why: a package must not look ready on evidence another module never produced.
    const r = evaluateReadiness({ config, dir: makePackage() });
    expect(r.items.filter((i) => i.status === 'fail')).toEqual([]);
    expect(status(r, 'install-smoke')).toBe('missing');
    expect(r.dimension.status).toBe('warn');
  });

  it('is pass once every blocking external result is in', () => {
    // Why: the dimension must be reachable; optional proofs must not hold it back.
    const external = { 'install-smoke': 'pass', 'docs-fresh': 'pass', 'mirror-tag': 'pass', 'mirror-release': 'pass', 'mirror-integrity': 'pass', runtimes: 'pass' } as const;
    expect(evaluateReadiness({ config, dir: makePackage(), external }).dimension.status).toBe('pass');
  });

  it('skips runtimes for packages that depend on other @arki packages', () => {
    // Why: only leaf libraries promise the five-runtime matrix.
    const r = evaluateReadiness({ config, dir: makePackage((p) => { p.dependencies = { '@arki/log': '^0.1.0' }; }) });
    expect(status(r, 'runtimes')).toBe('n/a');
  });

  it('a blocking fail is never averaged away by passing items', () => {
    // Why: one missing LICENSE must block even if 20 other items pass.
    const dir = makePackage();
    rmSync(path.join(dir, 'LICENSE'));
    expect(evaluateReadiness({ config, dir }).dimension.status).toBe('fail');
  });

  it('a baselined failure is non-blocking and a stale baseline entry is reported', () => {
    // Why: the baseline may only shrink, so a fixed gap still listed must show up.
    const dir = makePackage((p) => {
      delete p.funding;
    });
    const r = evaluateReadiness({ config, dir, baseline: ['pkg-funding', 'pkg-engines'] });
    expect(status(r, 'pkg-funding')).toBe('fail');
    expect(r.items.find((i) => i.id === 'pkg-funding')).toMatchObject({ blocking: false, baselined: true });
    expect(status(r, 'pkg-engines')).toBe('baseline-stale');
    expect(r.dimension.evidence.some((e) => e.code === 'READY_E003')).toBe(true);
  });

  it('flags README sections that are missing or out of order', () => {
    // Why: agents and readers rely on the same section order in every package.
    const dir = makePackage();
    writeFileSync(path.join(dir, 'README.md'), '## Quick start\n\n## Installation\n');
    const r = evaluateReadiness({ config, dir });
    expect(status(r, 'readme-h2-order')).toBe('fail');
  });

  it('ignores H2 lines inside code fences', () => {
    // Why: examples of markdown in READMEs are not real sections.
    expect(readmeH2s('## A\n```md\n## B\n```\n## C')).toEqual(['A', 'C']);
  });

  it('does not evaluate untiered packages', () => {
    // Why: only packages with a tier carry the obligations.
    const dir = makePackage((p) => {
      p.name = '@arki/live';
    });
    expect(evaluateReadiness({ config, dir }).items).toEqual([]);
  });
});

describe('baseline and table', () => {
  it('generates a baseline from failing items only', () => {
    // Why: the seed baseline must hold exactly today's gaps.
    const dir = makePackage();
    rmSync(path.join(dir, 'llms.txt'));
    expect(generateReadinessBaseline([evaluateReadiness({ config, dir })])).toEqual({ '@arki/math': ['file-llms-txt'] });
  });

  it('renders one fixed-width row per package', () => {
    // Why: scorecard --table must stay scannable in a terminal.
    const table = renderReadinessTable([evaluateReadiness({ config, dir: makePackage() })]);
    const lines = table.split('\n');
    expect(lines[1]).toContain('@arki/math');
    expect(lines[1]).toContain('ok');
    expect(lines[1]).toContain('miss');
    expect(lines[0]?.split(/\s+/).length).toBe(lines[1]?.split(/\s+/).length);
  });

  it('shows a non-blocking failure as warn, a blocking one as FAIL', () => {
    // Why: FAIL in the table means "this blocks the release"; an optional item
    // (funding) shown as FAIL sends the founder after a gap that blocks nothing.
    const table = renderReadinessTable([
      {
        name: '@arki/x',
        tier: 1,
        items: [
          { id: 'pkg-funding', status: 'fail', blocking: false, baselined: false, detail: 'no funding' },
          { id: 'install-smoke', status: 'fail', blocking: true, baselined: false, detail: 'smoke failed' },
        ],
        dimension: { status: 'fail', details: '', evidence: [] },
      },
    ]);
    const row = table.split('\n')[1] ?? '';
    expect(row).toContain('warn');
    expect(row.match(/FAIL/g)?.length).toBe(1);
  });
});
