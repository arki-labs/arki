import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checkDocs, checkSource, headingAnchors, isShipped, localLinks, parseLlmsTxt } from './docs';
import { checkAll, checkLibrary } from './library-check';
import { readManifest } from './manifest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'doc-package');
const REPO = path.join(HERE, '..', '..', '..');

/** A copy of the well-formed fixture; `edit` rewrites files in it before the check. */
function docPackage(edit: Record<string, string | null> = {}, manifest: object = {}): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'arki-docs-')), 'doc-package');
  cpSync(FIXTURE, dir, { recursive: true });
  for (const [file, body] of Object.entries(edit)) {
    if (body === null) rmSync(path.join(dir, file));
    else writeFileSync(path.join(dir, file), body);
  }
  const current: object = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...current, ...manifest }));
  return dir;
}

function errorsOf(dir: string): string[] {
  return checkDocs(dir, readManifest(dir)).errors;
}

const llms = readFileSync(path.join(FIXTURE, 'llms.txt'), 'utf8');
const guide = readFileSync(path.join(FIXTURE, 'docs/agent-guide.md'), 'utf8');

describe('checkDocs', () => {
  it('passes the well-formed fixture', () => {
    expect(checkDocs(docPackage(), readManifest(docPackage()))).toEqual({ errors: [], warnings: [] });
  });

  it('names each missing file once, so a package with no docs is three baseline lines', () => {
    const dir = docPackage({ 'README.md': null, 'llms.txt': null, 'docs/agent-guide.md': null }, { scripts: {} });
    expect(errorsOf(dir)).toEqual([
      'DOC_E001 no README.md',
      'DOC_E002 no llms.txt',
      'DOC_E003 no docs/agent-guide.md',
      'DOC_E013 no "test:docs" script: add "test:docs": "arki-doc-examples"',
    ]);
  });

  it('fails a title that is not the package name, because agents match the H1 to the import', () => {
    expect(errorsOf(docPackage({ 'llms.txt': llms.replace('# @arki/doc-package', '# Doc package') }))).toEqual([
      'DOC_E004 llms.txt must start with "# @arki/<name>" then one "> " summary line: line 1 is not "# @arki/doc-package"',
    ]);
  });

  it('fails a missing summary line', () => {
    expect(errorsOf(docPackage({ 'llms.txt': llms.replace('> A fixture', 'A fixture') }))[0]).toMatch(
      /^DOC_E004 .*no "> " line/,
    );
  });

  it('fails misordered or extra sections and allows a trailing Optional', () => {
    const swapped = llms
      .replace('## Start here', '## TEMP')
      .replace('## By task', '## Start here')
      .replace('## TEMP', '## By task');
    expect(errorsOf(docPackage({ 'llms.txt': swapped }))[0]).toMatch(/^DOC_E005 /);
    expect(errorsOf(docPackage({ 'llms.txt': `${llms}\n## Files\n- src\n` }))[0]).toMatch(/^DOC_E005 .*Files/);
    expect(errorsOf(docPackage({ 'llms.txt': `${llms}\n## Optional\n- [README](README.md)\n` }))).toEqual([]);
  });

  it('lists missing and extra import paths, because they are the drift agents copy', () => {
    const edited = llms.replace('- `@arki/doc-package/pg`: `connect(url)`.', '- `@arki/doc-package/x`: nothing.');
    expect(errorsOf(docPackage({ 'llms.txt': edited }))).toEqual([
      'DOC_E006 llms.txt "Import paths" differs from exports: missing ./pg; extra ./x',
    ]);
  });

  it('accepts several specifiers on one bullet, so a package with 70 subpaths fits', () => {
    const grouped = llms.replace(
      '- `@arki/doc-package`: `greet(name)`.\n- `@arki/doc-package/pg`: `connect(url)`.',
      '- Entries: `@arki/doc-package`, `@arki/doc-package/pg`',
    );
    expect(errorsOf(docPackage({ 'llms.txt': grouped }))).toEqual([]);
  });

  it('fails above 80 lines or 8 KiB and warns above 60 lines, because agents read the file whole', () => {
    const padded = (lines: number): string => `${llms}${'\n'.repeat(lines - llms.split('\n').length + 1)}`;
    expect(errorsOf(docPackage({ 'llms.txt': padded(81) }))[0]).toMatch(/^DOC_E007 .*81 lines/);
    const warned = checkDocs(docPackage({ 'llms.txt': padded(61) }), readManifest(FIXTURE));
    expect(warned.errors).toEqual([]);
    expect(warned.warnings).toEqual(['DOC_W002 llms.txt over 60 lines: 61 lines']);
    const heavy = llms.replace('## Rules that bite\n', `## Rules that bite\n- ${'x'.repeat(8193 - llms.length)}\n`);
    expect(errorsOf(docPackage({ 'llms.txt': heavy }))[0]).toMatch(/^DOC_E007 .*bytes/);
  });

  it('fails a broken file link and a broken anchor, and resolves a numbered heading anchor', () => {
    const broken = llms
      .replace('(docs/agent-guide.md#greet-someone)', '(docs/agent-guide.md#nowhere)')
      .replace('(README.md)', '(docs/missing.md)');
    expect(errorsOf(docPackage({ 'llms.txt': broken }))).toEqual([
      'DOC_E008 broken local link or anchor: llms.txt links docs/missing.md',
      'DOC_E008 broken local link or anchor: llms.txt links docs/agent-guide.md#nowhere',
    ]);
    const numbered = guide.replace('## Verify', '## Verify\n\n## 4. The verification loop');
    const linked = llms.replace('(docs/agent-guide.md#greet-someone)', '(docs/agent-guide.md#4-the-verification-loop)');
    expect(errorsOf(docPackage({ 'llms.txt': linked, 'docs/agent-guide.md': numbered }))).toEqual([]);
  });

  it('fails a link that leaves the package, because it is dead in the tarball', () => {
    const outside = guide.replace('[llms.txt](../llms.txt)', '[app](../../apps/x/README.md)');
    expect(errorsOf(docPackage({ 'docs/agent-guide.md': outside }))).toEqual([
      'DOC_E009 link leaves the package: docs/agent-guide.md links ../../apps/x/README.md',
    ]);
  });

  it('fails a missing guide section but allows extra H2s between them', () => {
    // The llms.txt link to #verify breaks with it.
    expect(errorsOf(docPackage({ 'docs/agent-guide.md': guide.replace('## Verify', '## Checks') }))).toEqual([
      'DOC_E008 broken local link or anchor: llms.txt links docs/agent-guide.md#verify',
      'DOC_E010 agent guide missing or misordered section: missing Verify',
    ]);
    expect(
      errorsOf(docPackage({ 'docs/agent-guide.md': guide.replace('## Errors', '## Setup\n\nx\n\n## Errors') })),
    ).toEqual([]);
  });

  it('asks a package with a ./dot export to verify with dot explain and dot doctor', () => {
    const exports = {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './pg': { types: './dist/pg.d.ts', import: './dist/pg.js' },
      './dot': { types: './dist/index.d.ts', import: './dist/index.js' },
    };
    const withDot = llms.replace('## Start here', '- `@arki/doc-package/dot`: the adapter.\n\n## Start here');
    expect(errorsOf(docPackage({ 'llms.txt': withDot }, { exports }))).toEqual([
      'DOC_E011 agent guide "Verify" lacks dot explain --json and dot doctor --json: missing dot explain --json | jq .data..., dot doctor --json | jq .data...',
    ]);
    const verified = guide.replace(
      'bun run test:docs',
      "bun run test:docs\ndot explain --json | jq '.data.plugins'\ndot doctor --json | jq '.data.diagnostics'",
    );
    expect(errorsOf(docPackage({ 'llms.txt': withDot, 'docs/agent-guide.md': verified }, { exports }))).toEqual([]);
  });

  it('fails when "files" does not ship a doc file or a file the docs link to', () => {
    expect(errorsOf(docPackage({}, { files: ['dist/**'] }))).toEqual([
      'DOC_E012 package.json "files" does not ship a doc file: docs/agent-guide.md, llms.txt',
    ]);
  });

  it('warns about forward-looking words outside code', () => {
    const promised = guide.replace('It has no side effects.', 'Streaming will land in v1.1.');
    expect(checkDocs(docPackage({ 'docs/agent-guide.md': promised }), readManifest(FIXTURE)).warnings).toEqual([
      'DOC_W001 forward-looking language: docs/agent-guide.md line 7 "will land", line 7 "v1.1"',
    ]);
  });
});

describe('isShipped', () => {
  it('reads files like npm: names, dir/**, globs and negations', () => {
    expect(isShipped(undefined, 'llms.txt')).toBe(true);
    expect(isShipped(['docs'], 'docs/agent-guide.md')).toBe(true);
    expect(isShipped(['docs/**'], 'docs/a/b.md')).toBe(true);
    expect(isShipped(['./llms.txt'], 'llms.txt')).toBe(true);
    expect(isShipped(['src/**', '!src/**/*.test.*'], 'src/a/b.test.ts')).toBe(false);
    expect(isShipped(['*.md'], 'docs/x.md')).toBe(false);
  });
});

describe('Markdown helpers', () => {
  it('makes GitHub slugs, with -1 on a repeated heading and backticks dropped', () => {
    const anchors = headingAnchors(
      '## 4. The verification loop\n## `dot new`\n## Setup\n## Setup\n```md\n## Not a heading\n```\n',
    );
    expect([...anchors]).toEqual(['4-the-verification-loop', 'dot-new', 'setup', 'setup-1']);
  });

  it('finds local links outside code and skips URLs', () => {
    const markdown = '[a](docs/a.md) [b](https://x.dev) `[c](c.md)`\n```md\n[d](d.md)\n```\n[e]: ./e.md';
    expect(localLinks(markdown)).toEqual([
      { href: 'docs/a.md', line: 1 },
      { href: './e.md', line: 5 },
    ]);
  });

  it('parses the journal llms.txt, the model file', () => {
    const parsed = parseLlmsTxt(readFileSync(path.join(REPO, 'packages/journal/llms.txt'), 'utf8'));
    expect(parsed.name).toBe('@arki/journal');
    expect(parsed.summary).not.toBe('');
    expect(parsed.sections.get('Import paths')?.some(line => line.includes('`@arki/journal`'))).toBe(true);
  });
});

/** A repo with one public and one private package, both with only a README. */
function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'arki-docs-all-'));
  const manifest = {
    sideEffects: false,
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
  };
  for (const [name, isPrivate] of [
    ['open', false],
    ['closed', true],
  ] as const) {
    const dir = path.join(root, 'packages', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ ...manifest, name: `@arki/${name}`, private: isPrivate }),
    );
    writeFileSync(path.join(dir, 'turbo.json'), JSON.stringify({ tags: ['foundation'] }));
    writeFileSync(path.join(dir, 'README.md'), '# x\n');
  }
  return root;
}

describe('library-check scope', () => {
  it('checks docs on public packages only', () => {
    const root = repo();
    expect(checkLibrary(path.join(root, 'packages', 'closed')).errors).toEqual([]);
    const open = checkAll(root, []).errors;
    expect(new Set(open.map(item => item.package))).toEqual(new Set(['@arki/open']));
    expect(open.map(item => item.error.split(' ')[0])).toEqual([
      'DOC_E017',
      'DOC_E014',
      'DOC_E015',
      'DOC_E016',
      'DOC_E002',
      'DOC_E003',
      'DOC_E013',
    ]);
  });

  it('lets a baselined doc error pass and fails once it is fixed, so the baseline only shrinks', () => {
    const root = repo();
    const entry = { package: '@arki/open', error: 'DOC_E002 no llms.txt', reason: 'docs backlog' };
    expect(checkAll(root, [entry]).stale).toEqual([]);
    writeFileSync(path.join(root, 'packages', 'open', 'llms.txt'), '# @arki/open\n');
    expect(checkAll(root, [entry]).stale).toEqual([entry]);
  });
});

describe('Now-tier doc rules', () => {
  const problems = (edit: Record<string, string | null>): string[] => errorsOf(docPackage(edit));
  const readme = readFileSync(path.join(FIXTURE, 'README.md'), 'utf8');

  it('asks for CHANGELOG.md, LICENSE and AGENTS.md by name', () => {
    // Why: npm shows these files first; a package that lacks one looks abandoned.
    expect(problems({ 'CHANGELOG.md': null, LICENSE: null, 'AGENTS.md': null })).toEqual([
      'DOC_E014 no CHANGELOG.md',
      'DOC_E015 no LICENSE',
      'DOC_E016 no AGENTS.md',
    ]);
  });

  it('wants the four lead H2s first, in order, and the rest anywhere', () => {
    // Why: every README answers the same questions in the same order, for people and agents alike.
    const body = readme.replace('## Install\n', '## Intro\n\nText.\n\n## Install\n');
    expect(problems({ 'README.md': body }).join('\n')).toContain(
      'DOC_E017 README H2s missing or misordered: the first H2s are Intro',
    );
    const gone = readme.replace('## Support', '## Help');
    expect(problems({ 'README.md': gone })).toEqual(['DOC_E017 README H2s missing or misordered: missing Support']);
    const late = readme.replace('## Limits', '## Zzz').replace('## Support', '## Limits\n\nx\n\n## Support');
    expect(problems({ 'README.md': late })).toEqual([]);
  });

  it('wants the AGENTS.md role line and its three sections', () => {
    // Why: an agent reads AGENTS.md first and must learn where laws, tasks and the map live.
    const result = problems({ 'AGENTS.md': '# Agents\n\n## Laws\n' });
    expect(result).toEqual([
      'DOC_E018 AGENTS.md lacks the role line or a required section: line 1 is not "AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map."',
      'DOC_E018 AGENTS.md lacks the role line or a required section: missing Changing this package, Verify',
    ]);
  });

  it('bans soft words in prose but not in code', () => {
    // Why: claims like "just" and "easy" promise what the code does not prove.
    const body = `${readme}\nIt is simply easy. Use \`just\` here.\n\n\`\`\`ts\nconst might = 1;\n\`\`\`\n`;
    expect(problems({ 'README.md': body }).map(line => line.replaceAll(/ line \d+/g, ' line N'))).toEqual([
      'DOC_E019 banned word in README, docs or llms.txt: README.md line N "simply", line N "easy"',
    ]);
    expect(problems({ 'docs/agent-guide.md': `${guide}\nThis is robust.\n` })).toEqual([
      expect.stringContaining('DOC_E019 banned word in README, docs or llms.txt: docs/agent-guide.md'),
    ]);
  });

  it('finds the own version as a string literal in src, except src/version.ts', () => {
    // Why: a hard-coded version goes stale at the next release and lies to users.
    const dir = docPackage({}, { version: '1.2.3' });
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src/index.ts'), "export const a = '1.2.3';\nexport const b = '1.2.30';\n");
    writeFileSync(path.join(dir, 'src/version.ts'), "export const version = '1.2.3';\n");
    expect(checkSource(dir).errors).toEqual([expect.stringMatching(/^SRC_E001 .*: src\/index\.ts line 1$/)]);
  });
});
