import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { BenchResult } from '../core/types.js';
import { renderMarkdown } from '../core/report/index.js';
import { checkReadme, END_MARKER, START_MARKER, writeReadme } from './readme.js';

function readme(content: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'arki-bench-readme-')), 'README.md');
  writeFileSync(file, content);
  return file;
}

const result = (specHash: string): BenchResult => ({
  schema: 1,
  suite: { id: 'demo', title: 'Benchmarks', notes: [], specHash },
  profile: 'publish',
  seed: 1,
  publishable: true,
  warnings: [],
  environment: {
    runtime: { name: 'node', version: '22.13.1' },
    flags: [],
    harness: { version: '0.1.0', mitata: '1.0.34' },
    date: '2026-10-13T00:00:00.000Z',
  },
  packages: {},
  groups: [],
});

const PAGE = `# demo\n\nIntro stays.\n\n${START_MARKER}\nold section\n${END_MARKER}\n\n## License\n\nMIT\n`;

describe('writeReadme', () => {
  it('replaces only the marked section and keeps everything around it', () => {
    const file = readme(PAGE);
    writeReadme(file, '## Benchmarks\n\nnew table\n');
    const text = readFileSync(file, 'utf8');
    expect(text).toBe(
      `# demo\n\nIntro stays.\n\n${START_MARKER}\n## Benchmarks\n\nnew table\n${END_MARKER}\n\n## License\n\nMIT\n`,
    );
    // Writing the same section again changes nothing.
    writeReadme(file, '## Benchmarks\n\nnew table\n');
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('fails loudly instead of guessing where the section goes', () => {
    expect(() => writeReadme(readme('# demo\n'), 'x')).toThrow(/no benchmark markers/);
    expect(() => writeReadme(readme(`${START_MARKER}\n`), 'x')).toThrow(/no <!-- bench:end -->/);
    expect(() => writeReadme(readme(`${END_MARKER}\n`), 'x')).toThrow(/no <!-- bench:start -->/);
    expect(() => writeReadme(readme(`${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}`), 'x')).toThrow(
      /2 <!-- bench:start --> markers; keep exactly one pair/,
    );
    expect(() => writeReadme(readme(`${END_MARKER}\n${START_MARKER}\n`), 'x')).toThrow(/before/);
    expect(() => writeReadme(path.join(tmpdir(), 'arki-bench-missing', 'README.md'), 'x')).toThrow(/does not exist/);
  });

  it('refuses a section that contains a marker, so the README stays updatable', () => {
    expect(() => writeReadme(readme(PAGE), `text ${END_MARKER}`)).toThrow(/contains a bench marker/);
  });
});

describe('checkReadme', () => {
  it('accepts a section rendered from the same suite (the meta written is the meta read)', () => {
    const file = readme(PAGE);
    writeReadme(file, renderMarkdown(result('hash-1')));
    expect(checkReadme(file, result('hash-1'))).toEqual({ upToDate: true });
  });

  it('reports a stale section when the suite changed', () => {
    const file = readme(PAGE);
    writeReadme(file, renderMarkdown(result('hash-1')));
    const verdict = checkReadme(file, result('hash-2'));
    expect(verdict.upToDate).toBe(false);
    expect(verdict.reason).toContain('the suite changed since the section was generated (spec hash-1 → hash-2)');
  });

  it('reports a schema change and a section for another suite', () => {
    const file = readme(PAGE);
    writeReadme(file, '<!-- bench:meta {"schema":0,"suite":"demo","specHash":"hash-1"} -->');
    expect(checkReadme(file, result('hash-1')).reason).toMatch(/schema 0; this arki-bench writes schema 1/);
    writeReadme(file, '<!-- bench:meta {"schema":1,"suite":"other","specHash":"hash-1"} -->');
    expect(checkReadme(file, result('hash-1')).reason).toMatch(/for suite "other", not "demo"/);
  });

  it('explains a missing, empty or hand-written section', () => {
    expect(checkReadme(readme('# demo\n'), result('h')).reason).toMatch(/no benchmark markers/);
    expect(checkReadme(readme(`${START_MARKER}\n\n${END_MARKER}`), result('h')).reason).toMatch(/is empty/);
    expect(checkReadme(readme(PAGE), result('h')).reason).toMatch(/no bench:meta line/);
    expect(checkReadme(path.join(tmpdir(), 'arki-bench-missing', 'README.md'), result('h')).reason).toMatch(
      /does not exist/,
    );
  });
});
