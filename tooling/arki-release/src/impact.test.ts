import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkBumps,
  evaluateDemoImpact,
  evaluateDocsImpact,
  loadChangesets,
  parseChangeset,
  releaseChangesets,
  resolveBase,
  runImpact,
  withBumpErrors,
  type Changeset,
} from './impact';
import { defaultGitRunner, type GitRunner } from './runners';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('passes a first release, which has no previous release to diff against', () => {
    // Why: a never-published package has no baseline; warning here closed the gate on every first publish, and docs-fresh already checks its docs.
    expect(evaluateDocsImpact(docsInput(null, [])).status).toBe('pass');
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

  it('passes a package no registered demo uses, with that fact as the reason', () => {
    // Why: the demo registry already proves it; a typed line restating it adds
    // nothing, and consumed changesets could not carry it at --resume.
    const res = evaluateDemoImpact({ pkg: '@arki/math', demos: [], candidateChecks: {}, changesets: [] });
    expect(res.status).toBe('pass');
    expect(res.details).toBe('no registered demo uses this package');
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
    // abc123 left package.json at the npm version of each test below (1.0.0, 0.4.0).
    if (args[0] === 'show') return { code: 0, stdout: '"version": "1.0.0"\n"version": "0.4.0"', stderr: '' };
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

describe('changesets consumed by `changeset version`', () => {
  let repo: string;
  const run = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const write = (relative: string, text: string): void => {
    mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    writeFileSync(path.join(repo, relative), text);
  };
  const commitAll = (message: string): string => {
    run('add', '-A');
    run('commit', '-q', '--allow-empty', '-m', message);
    return run('rev-parse', 'HEAD');
  };
  const reasons = "---\n'@arki/math': minor\n---\n\nChange.\n\nno docs impact: only the parser internals changed\nno demo impact: the demos call no function that changed\n";
  // Phase 1 of `ship`: `changeset version` deletes the changeset and the orchestrator commits the deletion.
  const consume = (file: string): void => {
    rmSync(path.join(repo, '.changeset', file));
    write('packages/math/package.json', '{"name":"@arki/math","version":"0.5.0"}\n');
    commitAll('version packages');
  };
  const score = (lastShippedCommit: string) =>
    runImpact({
      root: repo,
      packages: [{ name: '@arki/math', dir: 'math', version: '0.5.0', npmVersion: '0.4.0', lastShippedCommit }],
      git: defaultGitRunner,
      demosUsing: () => ['calculator'],
      candidateChecks: {},
    });

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'impact-consumed-'));
    run('init', '-q', '-b', 'main');
    write('.changeset/README.md', 'Changesets.\n');
    write('packages/math/package.json', '{"name":"@arki/math","version":"0.4.0"}\n');
    write('packages/math/src/a.ts', 'export const a = 1;\n');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('accepts a reason from a changeset that phase 1 consumed', async () => {
    // Why: the scorecard runs at freeze (phase 2), after `changeset version`
    // deleted the changeset. Reading only pending files made the documented
    // `no ... impact:` remedy impossible exactly where the gate runs.
    const release = commitAll('release 0.4.0');
    write('packages/math/src/a.ts', 'export const a = 2;\n');
    write('.changeset/brave-fox.md', reasons);
    commitAll('feat: change a');
    consume('brave-fox.md');
    const env = await score(release);
    expect(env.items[0]?.dimensions['docs-impact']).toMatchObject({ status: 'pass', details: 'no docs impact: only the parser internals changed' });
    expect(env.items[0]?.dimensions['demo-impact']).toMatchObject({ status: 'pass', details: 'no demo impact: the demos call no function that changed' });
  });

  it('ignores a changeset consumed before the last release', async () => {
    // Why: a reason belongs to the release it was written for. Reusing an old
    // one would let every later release skip its docs and demos forever.
    write('.changeset/old-owl.md', reasons);
    commitAll('feat: old change');
    consume('old-owl.md');
    const release = commitAll('release 0.5.0');
    write('packages/math/src/a.ts', 'export const a = 3;\n');
    commitAll('feat: change a again');
    const env = await score(release);
    expect(env.items[0]?.dimensions['docs-impact'].status).toBe('fail');
    expect(env.items[0]?.dimensions['demo-impact'].status).toBe('fail');
  });

  it('reads pending and consumed changesets together, each once', async () => {
    // Why: a wave can hold a consumed docs reason and a still-pending demo
    // reason; both must count. A file that is pending again (same name) is
    // judged by its current text, not by the consumed copy.
    const release = commitAll('release 0.4.0');
    write('packages/math/src/a.ts', 'export const a = 2;\n');
    write('.changeset/docs-reason.md', "---\n'@arki/math': minor\n---\n\nno docs impact: only the parser internals changed\n");
    write('.changeset/again.md', "---\n'@arki/math': patch\n---\n\nno demo impact: n/a\n");
    commitAll('feat: change a');
    consume('docs-reason.md');
    rmSync(path.join(repo, '.changeset', 'again.md'));
    commitAll('drop again');
    write('.changeset/again.md', "---\n'@arki/math': patch\n---\n\nno demo impact: the demos call no function that changed\n");
    const env = await score(release);
    expect(env.items[0]?.dimensions['docs-impact'].status).toBe('pass');
    const demo = env.items[0]?.dimensions['demo-impact'];
    expect(demo?.status).toBe('pass');
    expect(await releaseChangesets(repo, release, (await loadChangesets(repo)).changesets, defaultGitRunner)).toHaveLength(2);
  });
});
