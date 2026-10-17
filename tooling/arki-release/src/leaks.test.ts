/**
 * Unit tests for the leak scanner.
 *
 * Strategy: drive the public seam (`scanText`, `scanFile`,
 * `scanDirectory`) with in-memory strings or temp-dir fixtures. We do
 * NOT scan the real workspace — that would couple the tests to changing
 * source files and produce flaky results.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_LEAK_PATTERNS, scanDirectory, scanFile, scanPackage, scanText } from './leaks';
import type { LeakPattern } from './types';

const patterns = DEFAULT_LEAK_PATTERNS;

describe('scanText', () => {
  it('finds furculita.net in a personal email line', () => {
    const hits = scanText('Email: dev@furculita.net', 'fixture.txt', patterns);
    const filtered = hits.filter(h => h.patternId === 'personal-domain-furculita');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.severity).toBe('error');
    expect(filtered[0]?.line).toBe(1);
    expect(filtered[0]?.column).toBe(12);
    expect(filtered[0]?.matchedText).toBe('furculita.net');
  });

  it('finds a private app name like hyphenate', () => {
    const hits = scanText('depends on hyphenate', 'fixture.md', patterns);
    const filtered = hits.filter(h => h.patternId === 'app-hyphenate');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.severity).toBe('error');
  });

  it('is case-insensitive — Furculita hits the afurculita handle pattern', () => {
    const hits = scanText('See @AFurculita on GitHub', 'fixture.md', patterns);
    const handleHits = hits.filter(h => h.patternId === 'personal-handle-afurculita');
    expect(handleHits.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT hit on neutral example "acme"', () => {
    const hits = scanText('contact acme for support', 'fixture.md', patterns);
    expect(hits).toHaveLength(0);
  });

  it('does NOT hit on neutral example "example.com"', () => {
    // Add a sweeping pattern that would match example.com so we test
    // the allow-list filter. The default patterns don't match it, so we
    // use a custom pattern here.
    const broad: LeakPattern[] = [
      { id: 'broad-domain', description: 'broad', pattern: /[\w-]+\.com/i, severity: 'error' },
    ];
    const hits = scanText('visit example.com today', 'fixture.md', broad);
    expect(hits).toHaveLength(0);
  });

  it('finds multiple hits across separate lines with correct line/col offsets', () => {
    const text = ['first line ok', 'second has hyphenate here', '', 'fourth has ekuation here'].join('\n');
    const hits = scanText(text, 'fixture.md', patterns);
    const sorted = [...hits].sort((a, b) => a.line - b.line);
    expect(sorted[0]?.line).toBe(2);
    expect(sorted[0]?.patternId).toBe('app-hyphenate');
    expect(sorted[1]?.line).toBe(4);
    expect(sorted[1]?.patternId).toBe('app-ekuation');
  });

  it('finds "private monorepo" phrasing as an error', () => {
    const hits = scanText('this is a private monorepo for internal use', 'fixture.md', patterns);
    const filtered = hits.filter(h => h.patternId === 'private-monorepo-phrase');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.severity).toBe('error');
  });

  it('finds "internal-only" phrasing as a warning', () => {
    const hits = scanText('this is an internal-only doc', 'fixture.md', patterns);
    const filtered = hits.filter(h => h.patternId === 'internal-only-phrase');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.severity).toBe('warning');
  });

  it('produces a snippet of approximately the surrounding context', () => {
    const long = 'a'.repeat(60) + ' furculita.net ' + 'b'.repeat(60);
    const hits = scanText(long, 'fixture.md', patterns);
    const hit = hits.find(h => h.patternId === 'personal-domain-furculita');
    expect(hit).toBeDefined();
    expect(hit?.snippet).toContain('furculita.net');
    // Snippet must contain ellipsis on both sides because the source was longer.
    expect(hit?.snippet).toMatch(/….*…/);
  });

  it('classifies sudoku as warning, not error', () => {
    const hits = scanText('we ship sudoku as a side project', 'fixture.md', patterns);
    const filtered = hits.filter(h => h.patternId === 'app-sudoku');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.severity).toBe('warning');
  });
});

describe('scanFile + scanDirectory (temp fixtures)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-release-leak-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('scanFile reads a UTF-8 file and reports hits', async () => {
    const file = path.join(tmp, 'doc.md');
    writeFileSync(file, 'Contact dev@furculita.net for details.');
    const hits = await scanFile(file, patterns, { displayPath: 'doc.md' });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.sourcePath).toBe('doc.md');
  });

  it('scanPackage audits what ships, not files negated in package.json files', async () => {
    // Why: a private plan kept out of the tarball with "!docs/plans/**" reaches no
    // one, so flagging it blocks a release for nothing; a shipped doc must still be caught.
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: '@arki/x', files: ['dist', 'docs', '!docs/plans/**'] }));
    mkdirSync(path.join(tmp, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmp, 'docs', 'guide.md'), 'has hyphenate');
    writeFileSync(path.join(tmp, 'docs', 'plans', 'next.md'), 'has ekuation');
    const hits = await scanPackage(tmp, { patterns });
    expect(hits.map(h => h.sourcePath)).toEqual([path.join('docs', 'guide.md')]);
  });

  it('scanDirectory walks recursively', async () => {
    writeFileSync(path.join(tmp, 'top.md'), 'has hyphenate');
    mkdirSync(path.join(tmp, 'nested'), { recursive: true });
    writeFileSync(path.join(tmp, 'nested', 'deep.md'), 'has ekuation');
    const hits = await scanDirectory(tmp, { patterns });
    const paths = hits.map(h => h.sourcePath).sort();
    expect(paths).toContain('top.md');
    expect(paths).toContain(path.join('nested', 'deep.md'));
  });

  it('scanDirectory excludes node_modules, dist, .turbo, .cache, .bench', async () => {
    for (const dirname of ['node_modules', 'dist', '.turbo', '.cache', '.bench']) {
      mkdirSync(path.join(tmp, dirname), { recursive: true });
      writeFileSync(path.join(tmp, dirname, 'leak.md'), 'has hyphenate');
    }
    writeFileSync(path.join(tmp, 'top.md'), 'has hyphenate');
    const hits = await scanDirectory(tmp, { patterns });
    // Only the top-level file should produce hits.
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sourcePath).toBe('top.md');
  });

  it('scanDirectory filters by extension', async () => {
    writeFileSync(path.join(tmp, 'doc.md'), 'has hyphenate');
    writeFileSync(path.join(tmp, 'config.toml'), 'has hyphenate');
    writeFileSync(path.join(tmp, 'image.bin'), 'has hyphenate');
    const hits = await scanDirectory(tmp, { patterns });
    const paths = hits.map(h => h.sourcePath);
    expect(paths).toContain('doc.md');
    expect(paths).not.toContain('config.toml');
    expect(paths).not.toContain('image.bin');
  });

  it('scanDirectory finds leaks in the file name itself', async () => {
    writeFileSync(path.join(tmp, 'furculita.net-notes.md'), 'clean body');
    const hits = await scanDirectory(tmp, { patterns });
    // The path itself contains furculita.net, so the path scan should fire.
    const pathHits = hits.filter(h => h.line === 0);
    expect(pathHits.length).toBeGreaterThanOrEqual(1);
    expect(pathHits[0]?.matchedText.toLowerCase()).toContain('furculita.net');
  });

  it('scanDirectory returns empty for a non-existent path', async () => {
    const hits = await scanDirectory(path.join(tmp, 'does-not-exist'), { patterns });
    expect(hits).toEqual([]);
  });

  it('scanDirectory can take a file path and still scan it', async () => {
    const file = path.join(tmp, 'doc.md');
    writeFileSync(file, 'has hyphenate');
    const hits = await scanDirectory(file, { patterns });
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it('scanDirectory skips files exceeding maxFileBytes (default 1MB)', async () => {
    // Build a ~2MB file with a real leak in the middle. If the size cap
    // is honored, the file is skipped before reading and the leak goes
    // undetected. If the cap regresses (or maxFileBytes is set high
    // enough), the leak fires. We assert BOTH directions to lock the
    // behaviour in.
    const huge = `${'A'.repeat(1_500_000)}furculita.net${'A'.repeat(500_000)}`;
    const file = path.join(tmp, 'big.md');
    writeFileSync(file, huge);

    const hitsDefault = await scanDirectory(tmp, { patterns });
    const personalDefault = hitsDefault.filter(h => h.patternId === 'personal-domain-furculita');
    expect(personalDefault).toHaveLength(0);

    const hitsRaised = await scanDirectory(tmp, { patterns, maxFileBytes: 5_000_000 });
    const personalRaised = hitsRaised.filter(h => h.patternId === 'personal-domain-furculita');
    expect(personalRaised.length).toBeGreaterThanOrEqual(1);
  });

  it('scanDirectory does not descend into nested workspaces by default', async () => {
    // Outer "package" with a leak, plus a nested sub-package (its own
    // package.json) that also contains a leak. Default behaviour skips
    // the nested workspace; opting out via skipNestedWorkspaces: false
    // walks into it.
    writeFileSync(path.join(tmp, 'outer.md'), 'has hyphenate');
    const innerDir = path.join(tmp, 'inner-pkg');
    mkdirSync(innerDir, { recursive: true });
    writeFileSync(path.join(innerDir, 'package.json'), '{"name":"inner"}');
    writeFileSync(path.join(innerDir, 'inner.md'), 'has hyphenate');

    const defaultHits = await scanDirectory(tmp, { patterns });
    const defaultPaths = defaultHits.map(h => h.sourcePath).sort();
    expect(defaultPaths).toContain('outer.md');
    expect(defaultPaths).not.toContain(path.join('inner-pkg', 'inner.md'));

    const allHits = await scanDirectory(tmp, { patterns, skipNestedWorkspaces: false });
    const allPaths = allHits.map(h => h.sourcePath).sort();
    expect(allPaths).toContain('outer.md');
    expect(allPaths).toContain(path.join('inner-pkg', 'inner.md'));
  });
});
