import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkDocs } from './docs';
import { applyImportPaths, generateLlms, importPathLines, LlmsError, lineDiff, LLMS_END, LLMS_START } from './llms';
import { readManifest } from './manifest';

const entry = (name: string) => ({ types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` });

/** A package with `package.json`, source files and an `llms.txt` (path relative to the package). */
function packageDir(files: Readonly<Record<string, string>>, exports: object = { '.': entry('index') }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'arki-llms-'));
  const all: Record<string, string> = { 'package.json': JSON.stringify({ name: '@arki/demo', exports }), ...files };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const llmsTxt = (importPaths: string, rest = '') =>
  `# @arki/demo\n\n> Demo.\n\n## Import paths\n${importPaths}\n## Start here\n\n- [Guide](docs/agent-guide.md)\n\n## By task\n\n- [Task](docs/agent-guide.md#task)\n\n## Rules that bite\n\n- Careful.\n${rest}`;

function generated(dir: string, current: string): string {
  return generateLlms(dir, readManifest(dir), current);
}

describe('importPathLines', () => {
  it('lists the first comment line, values, then types', () => {
    // Why: an agent picks an import path from this line without opening the module.
    const dir = packageDir({
      'src/index.ts': `/**\n * The demo core.\n * More text.\n */\nexport const zed = 1;\nexport function alpha(): void {}\nexport type Shape = { a: 1 };\n`,
    });
    expect(importPathLines(dir, readManifest(dir))).toEqual([
      '- `@arki/demo`: The demo core. `alpha`, `zed`; types `Shape`.',
    ]);
  });

  it('follows re-exports and export *', () => {
    // Why: most entries are barrels; naming only their own declarations would list nothing.
    const dir = packageDir({
      'src/index.ts': `export * from './inner.js';\nexport { hidden as shown } from './other.js';\n`,
      'src/inner.ts': `export const one = 1;\nexport interface Two {}\n`,
      'src/other.ts': `export const hidden = 2;\n`,
    });
    expect(importPathLines(dir, readManifest(dir))).toEqual(['- `@arki/demo`: `one`, `shown`; types `Two`.']);
  });

  it('keeps the first sentence of a multi-line comment and drops a leading package title', () => {
    // Why: a wrapped title line would otherwise land in llms.txt cut off mid-sentence.
    const dir = packageDir({
      'src/index.ts': '/**\n * @arki/demo - the core of\n * the demo. More detail follows.\n */\nexport const a = 1;\n',
    });
    expect(importPathLines(dir, readManifest(dir))).toEqual(['- `@arki/demo`: the core of the demo. `a`.']);
  });

  it('skips package.json and wildcard keys and keeps exports order', () => {
    // Why: DOC_E006 does not ask for those keys, so naming them would be an "extra" error.
    const dir = packageDir(
      { 'src/index.ts': 'export const a = 1;\n', 'src/zz.ts': 'export const z = 1;\n' },
      { '.': entry('index'), './zz': entry('zz'), './wild/*': './dist/wild/*.js', './package.json': './package.json' },
    );
    expect(importPathLines(dir, readManifest(dir)).map(line => line.split(':')[0])).toEqual([
      '- `@arki/demo`',
      '- `@arki/demo/zz`',
    ]);
  });

  it('writes a backticked package specifier in a comment as plain text', () => {
    // Why: DOC_E006 reads every backticked specifier as a named import path.
    const dir = packageDir({ 'src/index.ts': '/** Wraps `@arki/demo/ghost` for you. */\nexport const a = 1;\n' });
    const [line] = importPathLines(dir, readManifest(dir));
    expect(line).toBe('- `@arki/demo`: Wraps @arki/demo/ghost for you. `a`.');
  });

  it('fails loudly when an entry has neither source nor built types', () => {
    // Why: a silent empty bullet would hide a broken export.
    const dir = packageDir({});
    expect(() => importPathLines(dir, readManifest(dir))).toThrow(LlmsError);
  });
});

describe('applyImportPaths', () => {
  const bullets = ['- `@arki/demo`: new'];

  it('replaces only what sits between the markers', () => {
    // Why: hand-written sections and notes around the markers must survive a regeneration.
    const text = llmsTxt(`\nNote above.\n${LLMS_START}\n- old\n${LLMS_END}\nNote below.\n`);
    const next = applyImportPaths(text, bullets);
    expect(next).toBe(llmsTxt(`\nNote above.\n${LLMS_START}\n- \`@arki/demo\`: new\n${LLMS_END}\nNote below.\n`));
  });

  it('adds markers to an unmarked section and replaces its body', () => {
    // Why: existing llms.txt files have no markers yet; --write must adopt them in one step.
    const next = applyImportPaths(llmsTxt('\n- `@arki/demo`: hand-written\n'), bullets);
    expect(next).toBe(llmsTxt(`\n${LLMS_START}\n- \`@arki/demo\`: new\n${LLMS_END}\n`));
  });

  it('does not mistake a heading inside a code fence for the section', () => {
    // Why: a sample llms.txt shown in a fence must not be edited.
    const text = `# @arki/demo\n\n> Demo.\n\n\`\`\`md\n## Import paths\n\`\`\`\n`;
    expect(() => applyImportPaths(text, bullets)).toThrow(/no "## Import paths"/);
  });

  it('rejects a lone marker', () => {
    // Why: guessing the other end could eat hand-written text.
    expect(() => applyImportPaths(llmsTxt(`\n${LLMS_START}\n- old\n`), bullets)).toThrow(LlmsError);
  });

  it('is idempotent', () => {
    // Why: --check compares against a fresh generation, so a second run must change nothing.
    const once = applyImportPaths(llmsTxt('\n- old\n'), bullets);
    expect(applyImportPaths(once, bullets)).toBe(once);
  });
});

describe('generateLlms', () => {
  it('produces an Import paths section that DOC_E006 accepts', () => {
    // Why: the whole point is that the generated list can never drift from exports.
    const dir = packageDir(
      {
        'src/index.ts': '/** Core. */\nexport const a = 1;\n',
        'src/b.ts': 'export const b = 1;\n',
        'README.md': '# @arki/demo\n',
        'docs/agent-guide.md': '# Guide\n',
      },
      { '.': entry('index'), './b': entry('b') },
    );
    const next = generated(dir, llmsTxt('\n- `@arki/demo`: stale\n'));
    writeFileSync(path.join(dir, 'llms.txt'), next);
    const result = checkDocs(dir, readManifest(dir));
    expect([...result.errors, ...result.warnings].filter(line => line.includes('DOC_E006'))).toEqual([]);
    expect(next).toContain('`@arki/demo/b`');
  });

  it('fails over the line budget instead of truncating, naming the overflow', () => {
    // Why: DOC_E007 caps llms.txt at 80 lines; dropping bullets silently would lose import paths.
    const keys = Array.from({ length: 70 }, (_, index) => `./e${String(index)}`);
    const exports = Object.fromEntries([['.', entry('index')], ...keys.map(key => [key, entry(key.slice(2))])]);
    const files = Object.fromEntries([
      ['src/index.ts', 'export const a = 1;\n'],
      ...keys.map(key => [`src/${key.slice(2)}.ts`, 'export const a = 1;\n']),
    ]);
    const dir = packageDir(files, exports);
    expect(() => generated(dir, llmsTxt('\n- old\n'))).toThrow(/\d+ line\(s\) over 80/);
  });
});

describe('lineDiff', () => {
  it('shows removed and added lines only', () => {
    // Why: --check output must point at the stale bullets, not reprint the file.
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual(['- b', '+ B']);
  });
});
