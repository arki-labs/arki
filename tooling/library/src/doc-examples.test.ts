import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { checkExamples, compileExamples, extractExamples, runExamples, stitch } from './doc-examples';
import { readManifest } from './manifest';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'doc-package');
const ZOD = path.dirname(createRequire(import.meta.url).resolve('zod/package.json'));

/**
 * A copy of the fixture next to a `node_modules` that links it by name (so
 * examples resolve `@arki/doc-package` through `exports`, like the workspace)
 * and links `zod` (so an undeclared import resolves, like a hoisted root).
 */
function fixture(readme?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'arki-doc-examples-'));
  const dir = path.join(root, 'doc-package');
  cpSync(FIXTURE, dir, { recursive: true });
  mkdirSync(path.join(root, 'node_modules', '@arki'), { recursive: true });
  symlinkSync(dir, path.join(root, 'node_modules', '@arki', 'doc-package'));
  symlinkSync(ZOD, path.join(root, 'node_modules', 'zod'));
  if (readme !== undefined) writeFileSync(path.join(dir, 'README.md'), readme);
  return dir;
}

const fence = (info: string, ...body: string[]): string => ['```' + info, ...body, '```'].join('\n');

/** The `--json` report, as a consumer reads it. */
const reportSchema = z.object({
  examples: z.number(),
  modules: z.number(),
  ran: z.number(),
  skipped: z.number(),
  failures: z.array(z.object({ rule: z.string(), file: z.string(), line: z.number(), message: z.string() })),
});

describe('extractExamples', () => {
  it('reads the four fence forms and ignores non-code languages', () => {
    const markdown = [
      fence('ts', 'a();'),
      fence('ts run', 'b();'),
      fence('ts continue', 'c();'),
      fence('ts skip="needs Stripe keys"', 'd();'),
      fence('sh', 'bun run test:docs'),
      fence('json', '{}'),
    ].join('\n\n');
    const { examples, failures } = extractExamples('README.md', markdown);
    expect(failures).toEqual([]);
    expect(examples.map(({ line, run, continues, skip }) => ({ line, run, continues, skip }))).toEqual([
      { line: 1, run: false, continues: false, skip: undefined },
      { line: 5, run: true, continues: false, skip: undefined },
      { line: 9, run: false, continues: true, skip: undefined },
      { line: 13, run: false, continues: false, skip: 'needs Stripe keys' },
    ]);
  });

  it('normalises language aliases, so `typescript` blocks are checked like `ts`', () => {
    const { examples } = extractExamples(
      'README.md',
      [fence('typescript', 'a();'), fence('javascript', 'b();')].join('\n'),
    );
    expect(examples.map(example => example.lang)).toEqual(['ts', 'js']);
  });

  it('reads tilde fences, fences inside list items (indent stripped) and CRLF files', () => {
    const markdown = ['1. Step one:', '', '   ~~~ts', '   const a = 1;', '   ~~~', ''].join('\r\n');
    const { examples } = extractExamples('README.md', markdown);
    expect(examples).toHaveLength(1);
    expect(examples[0]?.code).toBe('const a = 1;');
    expect(examples[0]?.line).toBe(3);
  });

  it('treats a fence inside a longer outer fence as text, so Markdown shown in Markdown is not an example', () => {
    const markdown = ['````md', '```ts', 'not(an, example);', '```', '````'].join('\n');
    expect(extractExamples('README.md', markdown)).toEqual({ examples: [], failures: [] });
  });

  it('fails a skip without a quoted reason, because a silent skip hides drift', () => {
    for (const info of ['ts skip', 'ts skip=""', 'ts skip=later']) {
      expect(extractExamples('README.md', fence(info, 'a();')).failures.map(item => item.rule)).toEqual(['DOCX_E003']);
    }
  });

  it('fails an unknown word and an unclosed fence at the opening line', () => {
    expect(extractExamples('README.md', fence('ts title="x"', 'a();')).failures).toMatchObject([
      { rule: 'DOCX_E005', line: 1 },
    ]);
    expect(extractExamples('README.md', 'text\n```ts\na();\n').failures).toMatchObject([
      { rule: 'DOCX_E005', line: 2, message: expect.stringContaining('unclosed') },
    ]);
  });

  it('fails a continue with nothing before it in the same file', () => {
    expect(extractExamples('docs/agent-guide.md', fence('ts continue', 'a();')).failures).toMatchObject([
      { rule: 'DOCX_E004', file: 'docs/agent-guide.md', line: 1 },
    ]);
  });

  it('skips a continue after a skipped block with the same reason, so the chain never compiles half-way', () => {
    const { examples } = extractExamples(
      'README.md',
      [fence('ts skip="needs Postgres"', 'a();'), fence('ts continue', 'b();')].join('\n'),
    );
    expect(examples.map(example => example.skip)).toEqual(['needs Postgres', 'needs Postgres']);
  });
});

describe('stitch', () => {
  it('appends continue blocks to the module before them and keeps run from the first block', () => {
    const { examples } = extractExamples(
      'README.md',
      [fence('ts run', 'const a = 1;'), fence('tsx continue', 'const b = <div />;'), fence('js', 'c();')].join('\n'),
    );
    const modules = stitch(examples);
    expect(modules.map(({ code, lang, run }) => ({ code, lang, run }))).toEqual([
      { code: 'const a = 1;\nconst b = <div />;', lang: 'tsx', run: true },
      { code: 'c();', lang: 'js', run: false },
    ]);
  });
});

describe('checkExamples on the fixture', () => {
  it('reports one failure per rule at the README line, and passes the good blocks', () => {
    const report = checkExamples(fixture(), { run: true });
    expect(report.failures.map(({ rule, file, line }) => `${rule} ${file}:${String(line)}`)).toEqual([
      'DOCX_E004 README.md:5',
      'DOCX_E001 README.md:21',
      'DOCX_E002 README.md:26',
      'DOCX_E003 README.md:32',
      'DOCX_E005 README.md:38',
      'DOCX_E006 README.md:45',
      'DOCX_E007 README.md:52',
    ]);
    // The guide's `run` chain asserts its outcome and passes; the README's throwing block fails.
    expect(report.ran).toBe(2);
    expect(reportSchema.parse(report).modules).toBe(6);
  });

  it('accepts a correct block that imports the package and a subpath by name', () => {
    const readme = fence(
      'ts run',
      "import { greet } from '@arki/doc-package';",
      "import { connect } from '@arki/doc-package/pg';",
      "if (greet(connect('pg://x').url) !== 'Hello, pg://x') throw new Error('wrong greeting');",
    );
    expect(checkExamples(fixture(readme), { run: true }).failures).toEqual([]);
  });

  it('bans @ts-expect-error, because any error satisfies it and the block proves nothing', () => {
    const readme = fence('ts', "import { greet } from '@arki/doc-package';", '// @ts-expect-error', 'greet(1);');
    expect(checkExamples(fixture(readme), { run: false }).failures).toMatchObject([
      { rule: 'DOCX_E006', line: 3, message: expect.stringContaining('@ts-expect-error') },
    ]);
  });

  it('bans as unknown as, because it hides a wrong type', () => {
    const readme = fence('ts', 'export const n = "1" as unknown as number;');
    expect(checkExamples(fixture(readme), { run: false }).failures.map(item => item.rule)).toEqual(['DOCX_E006']);
  });

  it('fails a relative import, because the reader has no ./app', () => {
    const readme =
      fence('ts skip="needs the app"', 'x();') + '\n' + fence('ts', "import { app } from './app';", 'app;');
    const rules = checkExamples(fixture(readme), { run: false }).failures.map(item => item.rule);
    expect(rules).toContain('DOCX_E007');
  });

  it('counts skips and runs nothing with --no-run', () => {
    const readme = [
      fence('ts skip="needs Stripe keys"', 'pay();'),
      fence('ts run', "throw new Error('never runs');"),
    ].join('\n');
    const report = checkExamples(fixture(readme), { run: false });
    // Two README blocks plus the guide's two-block chain.
    expect(report).toMatchObject({ examples: 4, skipped: 1, ran: 0, failures: [] });
  });

  it('fails once with E008 when the build output is missing, naming build', () => {
    const dir = fixture();
    rmSync(path.join(dir, 'dist'), { recursive: true });
    const failures = checkExamples(dir, { run: true }).failures.filter(item => item.rule === 'DOCX_E008');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('build');
  });

  it('passes a package with no examples', () => {
    const dir = fixture('# Nothing to run\n');
    rmSync(path.join(dir, 'docs'), { recursive: true });
    expect(checkExamples(dir, { run: true })).toMatchObject({ examples: 0, modules: 0, failures: [] });
  });

  it('writes only under .cache/doc-examples, with a header naming the source line', () => {
    const dir = fixture(fence('ts', 'export const a = 1;'));
    checkExamples(dir, { run: false });
    expect(readFileSync(path.join(dir, '.cache/doc-examples/readme-1.ts'), 'utf8')).toBe(
      '// from README.md:1\nexport const a = 1;\nexport {};\n',
    );
  });
});

describe('runExamples', () => {
  it('fails a run block that hangs, after the timeout', () => {
    const dir = fixture(fence('ts run', 'for (;;) {}'));
    const manifest = readManifest(dir);
    const modules = stitch(extractExamples('README.md', readFileSync(path.join(dir, 'README.md'), 'utf8')).examples);
    expect(compileExamples(dir, manifest, modules)).toEqual([]);
    expect(runExamples(dir, modules, { timeoutMs: 1500 })).toMatchObject([
      { rule: 'DOCX_E002', message: expect.stringContaining('timed out') },
    ]);
  });

  it('fails only run modules, naming bun, when bun is missing', () => {
    const dir = fixture(fence('ts run', 'export const a = 1;'));
    const modules = stitch(extractExamples('README.md', readFileSync(path.join(dir, 'README.md'), 'utf8')).examples);
    compileExamples(dir, readManifest(dir), modules);
    expect(runExamples(dir, modules, { env: { PATH: '/nonexistent' } })).toMatchObject([
      { rule: 'DOCX_E002', message: expect.stringContaining('bun') },
    ]);
  });
});
