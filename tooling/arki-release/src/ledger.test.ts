import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Candidate } from './candidate';
import { renderLedgerEntry, writeLedgerEntry } from './ledger';

const candidate: Candidate = {
  wave: 'foundation',
  sourceCommit: 'abcdef1234567890',
  createdAt: '2026-10-17T00:00:00.000Z',
  packages: [
    { name: '@arki/b', version: '0.2.0', tarball: 'tarballs/b.tgz', sha512: 'bb', publishOrder: 2 },
    { name: '@arki/a', version: '0.3.0', tarball: 'tarballs/a.tgz', sha512: 'aa', publishOrder: 1 },
  ],
  checks: {
    smoke: { status: 'success', at: '2026-10-17T00:00:00.000Z', envelope: {} },
    scorecard: {
      status: 'success',
      at: '2026-10-17T00:00:00.000Z',
      envelope: { stableReleaseGate: 'open', pass: 2, warn: 1, fail: 0, deferred: 0 },
    },
  },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ledger-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ledger', () => {
  it('renders packages in publish order with the scorecard verdict from candidate.json', () => {
    // Why: the ledger is the human record of what shipped; it must match the verified candidate, in the order it was published.
    const entry = renderLedgerEntry({ candidate, candidateId: 'foundation-abcdef1', waveLabel: 'Foundation', date: new Date('2026-10-17T12:00:00Z') });
    expect(entry).toContain('## Foundation (foundation) @ abcdef1 (2026-10-17)');
    expect(entry.indexOf('| @arki/a | 0.3.0 | 1 |')).toBeLessThan(entry.indexOf('| @arki/b | 0.2.0 | 2 |'));
    expect(entry).toContain('`OPEN` (2 pass, 1 warn, 0 fail, 0 deferred)');
  });

  it('inserts newest first below the intro and never twice for the same candidate', async () => {
    // Why: RELEASES.md is newest-first, and a resumed --finish must not duplicate an entry.
    const file = path.join(dir, 'RELEASES.md');
    writeFileSync(file, '# Ledger\n\nIntro.\n\n---\n\n## v0.0.1 older\n');
    expect(await writeLedgerEntry(file, '## new entry\n<!-- candidate: c1 -->\n', 'c1')).toBe('written');
    expect(await writeLedgerEntry(file, '## new entry\n<!-- candidate: c1 -->\n', 'c1')).toBe('exists');
    const text = readFileSync(file, 'utf8');
    expect(text.indexOf('Intro.')).toBeLessThan(text.indexOf('## new entry'));
    expect(text.indexOf('## new entry')).toBeLessThan(text.indexOf('## v0.0.1 older'));
    expect(text.split('## new entry').length).toBe(2);
  });
});
