import { describe, expect, it } from 'vitest';

import {
  checkBumps,
  evaluateDemoImpact,
  evaluateDocsImpact,
  parseChangeset,
  resolveBase,
  runImpact,
  withBumpErrors,
  type Changeset,
} from './impact';
import type { GitRunner } from './runners';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function cs(body: string, bumps: Record<string, 'patch' | 'minor' | 'major'> = { '@arki/math': 'minor' }): Changeset {
  return { file: 'x.md', bumps, body };
}

const docsInput = (changedFiles: string[] | null, changesets: Changeset[]) => ({
  pkg: '@arki/math',
  dir: 'math',
  changedFiles,
  changesets,
});

describe('docs-impact', () => {
  it('passes when the README changed', () => {
    // Why: a release that touched the docs is the whole point of A-27.
    expect(evaluateDocsImpact(docsInput(['packages/math/README.md'], [])).status).toBe('pass');
  });

  it('passes when docs/ changed', () => {
    // Why: guides live under docs/, not only in the README.
    expect(evaluateDocsImpact(docsInput(['packages/math/docs/agent-guide.md'], [])).status).toBe('pass');
  });

  it('ignores source-only changes and tells the author the exact line to paste', () => {
    // Why: code changes alone must never satisfy the docs rule.
    const res = evaluateDocsImpact(docsInput(['packages/math/src/a.ts'], []));
    expect(res.status).toBe('fail');
    expect(res.evidence[0]?.code).toBe('IMPACT_E001');
    expect(res.evidence[0]?.remediation).toContain('no docs impact: ');
  });

  it('rejects "no docs impact: n/a"', () => {
    // Why: a vague reason hides drift; the gate must say why it refused.
    const res = evaluateDocsImpact(docsInput([], [cs('no docs impact: n/a')]));
    expect(res.status).toBe('fail');
    expect(res.evidence.map(e => e.code)).toContain('IMPACT_E003');
  });

  it('rejects a deny-listed word even when padded to 12 characters', () => {
    // Why: the deny list is checked on the trimmed reason, not only its length.
    expect(evaluateDocsImpact(docsInput([], [cs('no docs impact:    internal   ')])).status).toBe('fail');
  });

  it('accepts a precise reason from a changeset that bumps the package', () => {
    // Why: real refactors with no doc surface need a way through.
    const res = evaluateDocsImpact(docsInput([], [cs('no docs impact: internal rename of a private helper')]));
    expect(res.status).toBe('pass');
  });

  it('ignores a reason in a changeset for another package', () => {
    // Why: one package cannot excuse another.
    const other = cs('no docs impact: internal rename of a private helper', { '@arki/money': 'patch' });
    expect(evaluateDocsImpact(docsInput([], [other])).status).toBe('fail');
  });
});

describe('demo-impact', () => {
  it('passes when every demo has a passing candidate check', () => {
    // Why: demos prove the release works for a real consumer.
    const res = evaluateDemoImpact({ pkg: '@arki/math', demos: ['drop-studio'], candidateChecks: { 'demo:drop-studio': { status: 'success' } }, changesets: [] });
    expect(res.status).toBe('pass');
  });

  it('fails when a demo check is missing', () => {
    // Why: a missing check is not a pass.
    const res = evaluateDemoImpact({ pkg: '@arki/math', demos: ['drop-studio'], candidateChecks: {}, changesets: [] });
    expect(res.status).toBe('fail');
    expect(res.evidence[0]?.code).toBe('IMPACT_E002');
  });

  it('suggests the not-used line for a package no demo uses', () => {
    // Why: unused packages still need an explicit, reviewable statement.
    const res = evaluateDemoImpact({ pkg: '@arki/math', demos: [], candidateChecks: {}, changesets: [] });
    expect(res.status).toBe('fail');
    expect(res.evidence[0]?.remediation).toContain('no demo impact: not used by any registered demo');
  });

  it('accepts that suggested line', () => {
    // Why: the printed remediation must itself pass the gate.
    const res = evaluateDemoImpact({ pkg: '@arki/math', demos: [], candidateChecks: {}, changesets: [cs('no demo impact: not used by any registered demo')] });
    expect(res.status).toBe('pass');
  });
});

describe('changesets', () => {
  it('parses quoted frontmatter and body', () => {
    // Why: matches the format real pending changesets use.
    const parsed = parseChangeset('a.md', "---\n'@arki/ai': minor\n'@arki/db': patch\n---\n\nNote.\n");
    expect(parsed.ok && parsed.changeset.bumps).toEqual({ '@arki/ai': 'minor', '@arki/db': 'patch' });
  });

  it('rejects an unknown bump type', () => {
    // Why: Zod guards external input; typos must not slip through.
    expect(parseChangeset('a.md', "---\n'@arki/ai': huge\n---\nx").ok).toBe(false);
  });

  it('rejects major below 1.0', () => {
    // Why: while 0.x, breaking changes are MINOR bumps.
    const errors = checkBumps([cs('x', { '@arki/math': 'major' })], { '@arki/math': '0.4.1' });
    expect(errors[0]?.code).toBe('IMPACT_E004');
  });

  it('allows major at 1.0 and above', () => {
    // Why: the rule ends at 1.0.
    expect(checkBumps([cs('x', { '@arki/math': 'major' })], { '@arki/math': '1.2.0' })).toEqual([]);
  });
});

describe('base and runImpact', () => {
  const git: GitRunner = async args => {
    if (args[0] === 'log') return { code: 0, stdout: 'abc123\n', stderr: '' };
    if (args[0] === 'show') return { code: 0, stdout: '{ "version": "1.0.0" }', stderr: '' };
    if (args[0] === 'diff') return { code: 0, stdout: 'packages/math/src/a.ts\n', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };

  it('prefers the last shipped candidate commit over a version search', async () => {
    // Why: the candidate commit is the exact shipped state.
    const base = await resolveBase({ root: '/repo', dir: 'math', npmVersion: '1.0.0', lastShippedCommit: 'feed', git });
    expect(base).toBe('feed');
  });

  it('falls back to the commit that set the npm version', async () => {
    // Why: packages shipped before candidates existed still need a base.
    expect(await resolveBase({ root: '/repo', dir: 'math', npmVersion: '1.0.0', lastShippedCommit: null, git })).toBe('abc123');
  });

  it('skips the commit that bumped the npm version away', async () => {
    // Why: git log -G also matches the removing commit. Taking it as the base
    // made every docs change since the npm release invisible (IMPACT_E001).
    const bumped: GitRunner = async args => {
      if (args[0] === 'log') return { code: 0, stdout: 'bump99\nabc123\n', stderr: '' };
      if (args[0] === 'show') {
        const version = args[1]?.startsWith('bump99') ? '1.1.0' : '1.0.0';
        return { code: 0, stdout: `{ "version": "${version}" }`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: '' };
    };
    expect(await resolveBase({ root: '/repo', dir: 'math', npmVersion: '1.0.0', lastShippedCommit: null, git: bumped })).toBe('abc123');
  });

  it('fails the run for a package with source-only changes', async () => {
    // Why: the envelope status is what CI reads.
    const root = mkdtempSync(path.join(tmpdir(), 'impact-'));
    mkdirSync(path.join(root, '.changeset'));
    writeFileSync(path.join(root, '.changeset', 'a.md'), "---\n'@arki/math': minor\n---\n\nChange.\n");
    const env = await runImpact({
      root,
      packages: [{ name: '@arki/math', dir: 'math', version: '0.4.1', npmVersion: '0.4.0', lastShippedCommit: null }],
      git,
      demosUsing: () => [],
      candidateChecks: {},
    });
    expect(env.status).toBe('failure');
    expect(env.items[0]?.dimensions['docs-impact'].status).toBe('fail');
  });

  it('a major bump below 1.0 fails docs-impact even when the docs were updated', async () => {
    // Why: IMPACT_E004 must close the gate. As a loose envelope error it was
    // ignored by the gate, and `changeset version` would ship 1.0.0 by accident.
    const passing = { status: 'pass' as const, details: 'docs touched', evidence: [] };
    const [bump] = checkBumps([{ file: 'a.md', bumps: { '@arki/math': 'major' }, body: '' }], { '@arki/math': '0.4.0' });
    expect(bump?.code).toBe('IMPACT_E004');
    const result = withBumpErrors(passing, bump === undefined ? [] : [bump]);
    expect(result.status).toBe('fail');
    expect(result.evidence.map(e => e.code)).toEqual(['IMPACT_E004']);
    expect(withBumpErrors(passing, [])).toBe(passing);
  });
});
