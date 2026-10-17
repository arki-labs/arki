import { describe, expect, it } from 'vitest';

import {
  evaluateBenchFresh,
  evaluateDocsFresh,
  findVersionRefs,
  parseBenchProvenance,
  topChangelogVersion,
  type DocsFreshInput,
} from './docs-fresh';
import type { GitRunner } from './runners';

const good: DocsFreshInput = {
  pkg: '@arki/math',
  packageVersion: '0.4.1',
  libraryCheckErrors: [],
  docExamples: { examples: 3, modules: 1, compiled: 1, ran: 1, skipped: 0, skippedBlocks: [], failures: [] },
  changelogVersion: '0.4.1',
  versionRefs: [],
  knownVersions: new Set(),
  undocumentedExports: [],
};

describe('docs-fresh', () => {
  it('passes when everything agrees', () => {
    // Why: the baseline must be green or the gate is noise.
    expect(evaluateDocsFresh(good).status).toBe('pass');
  });

  it('fails on a stale llms.txt import path list (DOC_E006)', () => {
    // Why: agents read llms.txt to learn which imports exist.
    const res = evaluateDocsFresh({ ...good, libraryCheckErrors: ['DOC_E005 x', 'DOC_E006 llms.txt "Import paths" differs from exports: missing ./pg'] });
    expect(res.evidence.map(e => e.code)).toEqual(['FRESH_E001']);
  });

  it('fails when doc examples fail or were not run', () => {
    // Why: a broken README example is the first thing a user copies.
    const failing = { examples: 1, modules: 1, compiled: 1, ran: 1, skipped: 0, skippedBlocks: [], failures: [{ file: 'README.md', line: 4, rule: 'DOCX_E001', message: 'x' }] };
    expect(evaluateDocsFresh({ ...good, docExamples: failing }).status).toBe('fail');
    expect(evaluateDocsFresh({ ...good, docExamples: null }).status).toBe('fail');
  });

  it('fails when CHANGELOG lags package.json', () => {
    // Why: `changeset version` was skipped.
    expect(evaluateDocsFresh({ ...good, changelogVersion: '0.4.0' }).evidence[0]?.code).toBe('FRESH_E003');
  });

  it('fails on a documented version that does not exist, passes on a candidate one', () => {
    // Why: docs naming unreleased versions send users to install failures.
    const refs = findVersionRefs('README.md', 'npm i @arki/log@9.9.9 and @arki/dot@0.6.1');
    const known = new Set(['@arki/dot@0.6.1']);
    const res = evaluateDocsFresh({ ...good, versionRefs: refs, knownVersions: known });
    expect(res.evidence.map(e => e.message)).toHaveLength(1);
    expect(res.evidence[0]?.message).toContain('@arki/log@9.9.9');
  });

  it('only warns about undocumented exports', () => {
    // Why: plan item (e) is advisory, not a blocker.
    expect(evaluateDocsFresh({ ...good, undocumentedExports: ['foo'] }).status).toBe('warn');
  });

  it('reads the top CHANGELOG version', () => {
    // Why: changesets writes `## x.y.z` headings, newest first.
    expect(topChangelogVersion('# @arki/math\n\n## 0.4.1\n\n### Patch\n\n## 0.4.0\n')).toBe('0.4.1');
  });
});

describe('bench-fresh', () => {
  const sha = 'a'.repeat(40);
  const readme = `# x\n<!-- bench:start -->\nprovenance: ${sha}\n| a | b |\n<!-- bench:end -->\n`;

  /** Fake git: `lastSrc` last touched src; provenance is an ancestor-or-equal of nothing unless `fresh`. */
  const gitWith = (fresh: boolean): GitRunner => async args => {
    if (args[0] === 'log') return { code: 0, stdout: 'b'.repeat(40), stderr: '' };
    if (args[0] === 'rev-parse') return { code: 0, stdout: sha, stderr: '' };
    return { code: fresh ? 0 : 1, stdout: '', stderr: '' };
  };

  it('parses the provenance line only inside the bench block', () => {
    // Why: T2.4 writes this format; a stray line elsewhere must not count.
    expect(parseBenchProvenance(readme)).toBe(sha);
    expect(parseBenchProvenance(`provenance: ${sha}\n`)).toBeNull();
  });

  it('fails when the bench is older than the last src commit', async () => {
    // Why: stale numbers in a README mislead users about performance.
    const res = await evaluateBenchFresh({ root: '/repo', pkg: '@arki/math', dir: 'math', leaf: true, readme, git: gitWith(false) });
    expect(res.status).toBe('fail');
    expect(res.evidence[0]?.code).toBe('FRESH_E010');
  });

  it('passes when the bench is at or after the last src commit', async () => {
    // Why: a fresh run must clear the gate.
    expect((await evaluateBenchFresh({ root: '/repo', pkg: '@arki/math', dir: 'math', leaf: true, readme, git: gitWith(true) })).status).toBe('pass');
  });

  it('fails a leaf lib with no provenance and skips non-leaf packages', async () => {
    // Why: only leaf libs carry benchmarks; for them a missing block is a gap.
    const bare = await evaluateBenchFresh({ root: '/repo', pkg: '@arki/math', dir: 'math', leaf: true, readme: '# x', git: gitWith(true) });
    expect(bare.evidence[0]?.code).toBe('FRESH_E011');
    expect((await evaluateBenchFresh({ root: '/repo', pkg: '@arki/dot', dir: 'dot', leaf: false, readme: '# x', git: gitWith(false) })).status).toBe('pass');
  });
});
