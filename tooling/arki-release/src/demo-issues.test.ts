import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExecRunner } from './runners';
import { DEMO_ISSUES_ERROR_CODES, issueDraft, linkRow, loadOpenDemoGaps, parseLibGaps, runDemoIssuesApply, runDemoIssuesPrepare } from './demo-issues';

const LOG = [
  '# Gaps',
  '',
  '| #   | Package | Gap | Found | Status |',
  '| --- | ------- | --- | ----- | ------ |',
  '| 1   | `@arki/db` | No migration helper. Every app re-implements it. | Phase 1 | open — demo builds its own |',
  '| 2   | `@arki/db` | Drizzle ignored the logger. | Phase 1 | **fixed in `@arki/db` (unreleased)** — `migrateDb(db, { a | b })` |',
  '| 3   | `@arki/*` (all) | Default linker differs \\| from the monorepo. | Phase 1 | open |',
  '| 4   | `@arki/dot` / OTel | Spans do not nest. | Phase 1 | open [#9](https://github.com/arki-labs/arki/issues/9) |',
  '',
].join('\n');

let root: string;
const config = { demos: [{ name: 'shop', repo: 'arki-labs/shop', path: 'demos/shop' }] };
const gapsPath = () => path.join(root, 'demos', 'shop', 'docs', 'lib-gaps.md');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'arki-demo-issues-'));
  mkdirSync(path.dirname(gapsPath()), { recursive: true });
  writeFileSync(gapsPath(), LOG);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('parseLibGaps', () => {
  // WHY: only "open" rows are work; a fixed row filed as an issue would be noise on the package page.
  it('marks open rows open and fixed rows closed', () => {
    expect(parseLibGaps(LOG).map(r => [r.number, r.open])).toEqual([[1, true], [2, false], [3, true], [4, true]]);
  });

  // WHY: row 2 has bare pipes inside its Status cell; they must not push text into the wrong column.
  it('keeps bare pipes in the Status cell and unescapes pipes in the Gap cell', () => {
    const rows = parseLibGaps(LOG);
    expect(rows[1]?.status).toContain('{ a | b }');
    expect(rows[2]?.gap).toBe('Default linker differs | from the monorepo.');
  });

  // WHY: a package page lists gaps by package, so "(all)" must name none and a shared row must name both.
  it('reads package names from the Package cell', () => {
    const rows = parseLibGaps(LOG);
    expect(rows[2]?.packages).toEqual([]);
    expect(rows[3]?.packages).toEqual(['@arki/dot']);
  });

  // WHY: a row with a link is already filed; --apply must not file it twice.
  it('finds an existing issue link', () => {
    expect(parseLibGaps(LOG).map(r => r.issueUrl)).toEqual([null, null, null, 'https://github.com/arki-labs/arki/issues/9']);
  });
});

describe('issueDraft', () => {
  it('labels with found-by and one package label per package', () => {
    const draft = issueDraft('shop', { ...parseLibGaps(LOG)[0]!, packages: ['@arki/db', '@arki/dot'] });
    expect(draft.labels).toEqual(['found-by:shop', 'package:@arki/db', 'package:@arki/dot']);
    expect(draft.title).toBe('@arki/db, @arki/dot: No migration helper');
  });
});

describe('runDemoIssuesPrepare', () => {
  // WHY: the verify step compares this count with the open rows by hand.
  it('writes one item per open row', async () => {
    const result = await runDemoIssuesPrepare({ cwd: root, config, demo: 'shop' });
    expect(result.status).toBe('success');
    expect(result.items.map(i => i.row)).toEqual([1, 3, 4]);
    const written = JSON.parse(readFileSync(path.join(root, '.release', 'demo-issues', 'shop.json'), 'utf8')) as { items: unknown[] };
    expect(written.items).toHaveLength(3);
  });

  it('fails on an unknown demo', async () => {
    const result = await runDemoIssuesPrepare({ cwd: root, config, demo: 'nope' });
    expect(result.errors[0]?.code).toBe(DEMO_ISSUES_ERROR_CODES.unknownDemo);
  });
});

describe('runDemoIssuesApply', () => {
  const calls: string[][] = [];
  const exec: ExecRunner = async (_command, args) => {
    calls.push([...args]);
    return { code: 0, stdout: `https://github.com/arki-labs/arki/issues/${100 + calls.length}\n`, stderr: '' };
  };
  const founder = { env: {}, isTty: () => true, exec };
  beforeEach(() => {
    calls.length = 0;
  });

  // WHY: agents must never create issues on the public repo; the guard is the only protection.
  it('refuses under CLAUDECODE and creates nothing', async () => {
    await runDemoIssuesPrepare({ cwd: root, config, demo: 'shop' });
    const result = await runDemoIssuesApply({ cwd: root, config, demo: 'shop', ...founder, env: { CLAUDECODE: '1' } });
    expect(result.errors[0]?.code).toBe(DEMO_ISSUES_ERROR_CODES.agentSession);
    expect(calls).toHaveLength(0);
  });

  it('refuses without a terminal', async () => {
    const result = await runDemoIssuesApply({ cwd: root, config, demo: 'shop', ...founder, isTty: () => false });
    expect(result.errors[0]?.code).toBe(DEMO_ISSUES_ERROR_CODES.notTerminal);
  });

  // WHY: each link must land in its own row; a link in the wrong row would point a gap at someone else's issue.
  it('creates issues only for unlinked open rows and writes each URL into its own row', async () => {
    await runDemoIssuesPrepare({ cwd: root, config, demo: 'shop' });
    const result = await runDemoIssuesApply({ cwd: root, config, demo: 'shop', ...founder });
    expect(result.status).toBe('success');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('arki-labs/arki');
    const lines = readFileSync(gapsPath(), 'utf8').split('\n');
    expect(lines[4]).toMatch(/\[#101\]\(https:\/\/github\.com\/arki-labs\/arki\/issues\/101\) \|$/);
    expect(lines[5]).toBe(LOG.split('\n')[5]);
    expect(lines[6]).toMatch(/\[#102\]/);
    expect(lines[7]).toBe(LOG.split('\n')[7]);
  });

  it('keeps the row unlinked and reports when gh fails', async () => {
    await runDemoIssuesPrepare({ cwd: root, config, demo: 'shop' });
    const failing: ExecRunner = async () => ({ code: 1, stdout: '', stderr: 'label not found' });
    const result = await runDemoIssuesApply({ cwd: root, config, demo: 'shop', ...founder, exec: failing });
    expect(result.status).toBe('failure');
    expect(result.errors[0]?.code).toBe(DEMO_ISSUES_ERROR_CODES.ghFailed);
    expect(readFileSync(gapsPath(), 'utf8')).toBe(LOG);
  });
});

describe('linkRow', () => {
  it('changes only the named line', () => {
    const row = parseLibGaps(LOG)[0]!;
    const after = linkRow(LOG, row, 'https://github.com/arki-labs/arki/issues/7').split('\n');
    expect(after.filter((line, i) => line !== LOG.split('\n')[i])).toHaveLength(1);
  });
});

describe('loadOpenDemoGaps', () => {
  // WHY: packages.json.openGaps shows these on the package page, so a missing demo clone must not crash the site build.
  it('returns open rows per demo and skips a demo with no file', async () => {
    const gaps = await loadOpenDemoGaps(root, { demos: [...config.demos, { name: 'absent', repo: 'a/b', path: 'demos/absent' }] });
    expect(gaps.filter(g => g.row.packages.includes('@arki/db')).map(g => [g.demo, g.row.number])).toEqual([['shop', 1]]);
    expect(gaps.every(g => g.demo === 'shop')).toBe(true);
  });
});
