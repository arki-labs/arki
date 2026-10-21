import { describe, expect, it } from 'vitest';

import type { PackageEntry } from '@arki/arki-release/site-schema';

import {
  bannerOf,
  channelWord,
  demoLag,
  examplePills,
  exportCount,
  failureFile,
  firstNames,
  gapLine,
  skipSummary,
  snapshotStatus,
  versionLabel,
  withFocusableCode,
} from './-package-view';

const candidate = { wave: 'w1', sourceCommit: '0e70527fc5e65ba9e901cc177e03e22349b49f0b', createdAt: '2026-10-21T08:30:00Z' };
const dot = {
  short: 'dot',
  npmVersion: '0.6.1',
  nextVersion: '0.7.0',
  versions: [
    { version: '0.7.0', channel: 'next', archive: false },
    { version: '0.6.1', channel: 'published', archive: true },
    { version: '0.5.0', channel: 'published', archive: true },
  ],
} satisfies Pick<PackageEntry, 'short' | 'npmVersion' | 'nextVersion' | 'versions'>;
const journal = {
  short: 'journal',
  npmVersion: '0.2.1',
  nextVersion: null,
  versions: [
    { version: '0.2.1', channel: 'published', archive: false },
    { version: '0.1.1', channel: 'published', archive: false },
  ],
} satisfies Pick<PackageEntry, 'short' | 'npmVersion' | 'nextVersion' | 'versions'>;

describe('version labels', () => {
  it('say where each version stands', () => {
    expect(dot.versions.map(version => versionLabel(dot, version))).toEqual([
      'next: not on npm yet',
      'latest on npm · archive',
      'archive',
    ]);
    expect(journal.versions.map(version => versionLabel(journal, version))).toEqual(['latest on npm', '']);
  });

  it('name the channel of the version on screen', () => {
    expect(channelWord(journal, { channel: 'published', version: '0.2.1', archive: false })).toBe('latest');
    expect(channelWord(journal, { channel: 'published', version: '0.1.1', archive: false })).toBe('older');
    expect(snapshotStatus(null)).toBe('none');
    expect(snapshotStatus({ channel: 'published', version: '0.6.1', archive: true })).toBe('archive');
  });
});

describe('bannerOf', () => {
  it('tells a candidate is not on npm, with its commit and day, and what is on npm now', () => {
    const banner = bannerOf(dot, { channel: 'next', version: '0.7.0', archive: false, candidate });
    expect(banner?.title).toBe('0.7.0 is not on npm yet.');
    expect(banner?.text).toBe(
      'It is the release candidate for v0.7.0, built from commit 0e70527 on 21 Oct 2026. The docs on this page are for 0.7.0.',
    );
    expect(banner?.more).toBe('On npm now: 0.6.1, which is archived and not supported.');
  });

  it('points an archived version to the next one', () => {
    const banner = bannerOf(dot, { channel: 'published', version: '0.6.1', archive: true, candidate: null });
    expect(banner).toMatchObject({ kind: 'muted', title: '0.6.1 is archived.' });
    expect(banner?.link).toEqual({ href: '/packages/dot', label: 'Read the 0.7.0 page' });
  });

  it('points an older supported version to the newest on npm, and the newest has no banner', () => {
    const older = bannerOf(journal, { channel: 'published', version: '0.1.1', archive: false, candidate: null });
    expect(older).toMatchObject({ title: 'You are reading 0.1.1.', text: 'The newest version on npm is 0.2.1.' });
    expect(older?.link?.label).toBe('Read the 0.2.1 page');
    expect(bannerOf(journal, { channel: 'published', version: '0.2.1', archive: false, candidate: null })).toBeNull();
  });
});

describe('release health', () => {
  const report = { compiled: 61, ran: 22, skipped: 8, failures: [] };

  it('adds a failing pill only when something fails', () => {
    expect(examplePills(report).map(pill => pill.label)).toEqual(['61 compiled', '22 run', '8 skipped']);
    const failures = [{ file: 'docs/a.md', line: 1, rule: 'R', message: 'm' }];
    expect(examplePills({ ...report, failures }).at(-1)).toMatchObject({ kind: 'st-bad', label: '1 failing' });
  });

  it('names the file only when all failures share it', () => {
    const one = { file: 'docs/up.md', line: 1, rule: 'R', message: 'm' };
    const files = { files: ['README.md', 'docs/up.md'] };
    expect(failureFile({ failures: [one, { ...one, line: 2 }] }, dot, files, 'next')).toEqual({
      file: 'docs/up.md',
      count: 2,
      href: '/packages/dot/next/docs/up',
    });
    expect(failureFile({ failures: [one, { ...one, file: 'README.md' }] }, dot, files, 'next')).toBeNull();
    expect(failureFile({ failures: [] }, dot, files, 'next')).toBeNull();
    expect(failureFile({ failures: [{ ...one, file: 'docs/gone.md' }] }, dot, files, 'next')?.href).toBeNull();
  });

  it('counts skips, gaps and demo pins in plain words', () => {
    expect(skipSummary(1)).toBe('Why 1 example was skipped');
    expect(skipSummary(8)).toBe('Why 8 examples were skipped');
    expect(
      gapLine([
        { kind: 'readiness', title: 'a', url: null, foundBy: null },
        { kind: 'readiness', title: 'b', url: null, foundBy: null },
        { kind: 'demo', title: 'c', url: null, foundBy: 'drop-studio' },
      ]),
    ).toBe('2 release checks fail · 1 gap was found by demos');
    expect(gapLine([])).toBe('');
    expect(demoLag(null, '0.2.1')).toMatchObject({ glyph: '?', outdated: false });
    expect(demoLag('0.2.1', '0.2.1')).toMatchObject({ glyph: '●', outdated: false });
    expect(demoLag('0.1.0', '0.2.1')).toMatchObject({ glyph: '▲', outdated: true, text: 'pins 0.1.0, behind 0.2.1 on npm' });
    expect(demoLag('0.1.0', null).outdated).toBe(false);
  });
});

describe('public imports', () => {
  it('counts named exports and grouped names, and cuts the first names short', () => {
    const row = { names: ['a', 'b', 'c', 'd', 'e'].map(name => ({ name })), groups: [{ count: 10 }] };
    expect(exportCount(row)).toBe(15);
    expect(firstNames(row)).toBe('a, b, c, d, …');
    expect(firstNames({ names: [{ name: 'a' }], groups: [] })).toBe('a');
    expect(firstNames({ names: [], groups: [{ count: 3 }] })).toBe('…');
  });
});

describe('withFocusableCode', () => {
  it('makes each pre focusable once', () => {
    expect(withFocusableCode('<pre><code>x</code></pre><pre class="a" tabindex="0">y</pre><prefix>')).toBe(
      '<pre tabindex="0"><code>x</code></pre><pre class="a" tabindex="0">y</pre><prefix>',
    );
  });
});
