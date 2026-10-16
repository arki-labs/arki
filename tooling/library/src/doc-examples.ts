#!/usr/bin/env bun
/**
 * `arki-doc-examples`: every `ts`/`tsx`/`js` block in the package's
 * `README.md` and `docs/agent-guide.md` must typecheck against the built
 * package, and every `run` block must exit 0 on Bun. Runs as the package
 * script `test:docs` (turbo task `test:docs`, after `build`).
 *
 * The fence grammar: words after the language, space separated.
 *
 *   ```ts                            typecheck as its own module
 *   ```ts run                        typecheck, then `bun` runs it; a throw or non-zero exit fails
 *   ```ts continue                   appended to the previous block of this file (tutorial steps)
 *   ```ts skip="needs Stripe keys"   not compiled; the quoted reason is required and counted
 *
 * Banned in blocks: `any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`,
 * `@ts-nocheck`. A block may import only the package itself, its declared
 * dependencies and `node:` builtins. Generated files go to `.cache/doc-examples/`
 * and nowhere else.
 *
 *   arki-doc-examples [--no-run] [--json]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';

import type { Manifest } from './manifest';
import { leaves, readManifest } from './manifest';
import { scanFences, splitLines } from './markdown';
import { complain, say } from './report';

export const DOCX_RULES = {
  DOCX_E001: 'example does not typecheck',
  DOCX_E002: 'run example failed or timed out',
  DOCX_E003: 'skip without a reason',
  DOCX_E004: 'continue with no previous example in this file',
  DOCX_E005: 'unknown fence word or unclosed fence',
  DOCX_E006: 'forbidden construct (any, @ts-ignore, @ts-expect-error, @ts-nocheck, as unknown as)',
  DOCX_E007: 'import of a package not declared in package.json, or a relative import',
  DOCX_E008: 'no build output: run build first',
} as const;
export type DocxRule = keyof typeof DOCX_RULES;

/** Fence languages that are examples. Everything else (`sh`, `json`, `md`, `text`, ...) is ignored. */
export const EXAMPLE_LANGS = ['ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript'] as const;
const LANG_ALIASES = {
  ts: 'ts',
  tsx: 'tsx',
  typescript: 'ts',
  js: 'js',
  jsx: 'jsx',
  javascript: 'js',
} as const satisfies Record<(typeof EXAMPLE_LANGS)[number], string>;

/** The files whose blocks are examples, relative to the package. */
export const DOC_FILES = ['README.md', 'docs/agent-guide.md'] as const;
const OUT = '.cache/doc-examples';
const RUN_TIMEOUT_MS = 30_000;

export type Example = {
  /** `README.md` or `docs/agent-guide.md`. */
  readonly file: string;
  /** The opening fence, 1-based. */
  readonly line: number;
  /** Aliases normalised: `typescript` is `ts`, `javascript` is `js`. */
  readonly lang: (typeof LANG_ALIASES)[keyof typeof LANG_ALIASES];
  readonly run: boolean;
  readonly continues: boolean;
  /** The reason, when the block is not compiled. */
  readonly skip?: string;
  readonly code: string;
};

/** One compiled file: a block plus the `continue` blocks after it. */
export type ExampleModule = {
  readonly examples: readonly Example[];
  readonly code: string;
  readonly lang: Example['lang'];
  readonly run: boolean;
};

export type ExampleFailure = {
  readonly rule: DocxRule;
  readonly file: string;
  readonly line: number;
  readonly message: string;
};

function failure(rule: DocxRule, file: string, line: number, detail = ''): ExampleFailure {
  return { rule, file, line, message: `${DOCX_RULES[rule]}${detail}` };
}

function isExampleLang(word: string): word is keyof typeof LANG_ALIASES {
  return Object.hasOwn(LANG_ALIASES, word);
}

/** `run`, `continue`, `skip="reason"` (or `'reason'`); anything else is an unknown word. */
const FENCE_WORD = /([^\s=]+)(?:=("[^"]*"|'[^']*'|\S*))?/g;

type FenceWords = { run: boolean; continues: boolean; skip?: string; problem?: { rule: DocxRule; detail: string } };

function parseFenceWords(words: string): FenceWords {
  const parsed: FenceWords = { run: false, continues: false };
  for (const [word, key, value] of words.matchAll(FENCE_WORD)) {
    if (key === 'run' && value === undefined) parsed.run = true;
    else if (key === 'continue' && value === undefined) parsed.continues = true;
    else if (key === 'skip') {
      const reason = value !== undefined && /^(["']).*\1$/.test(value) ? value.slice(1, -1).trim() : '';
      if (reason === '') return { ...parsed, problem: { rule: 'DOCX_E003', detail: ': write skip="<why>"' } };
      parsed.skip = reason;
    } else return { ...parsed, problem: { rule: 'DOCX_E005', detail: `: "${word}"` } };
  }
  if (parsed.skip !== undefined && (parsed.run || parsed.continues)) {
    return { ...parsed, problem: { rule: 'DOCX_E005', detail: ': skip cannot be combined with run or continue' } };
  }
  if (parsed.run && parsed.continues) {
    return { ...parsed, problem: { rule: 'DOCX_E005', detail: ': put run on the first block of the chain' } };
  }
  return parsed;
}

/**
 * The example blocks of one Markdown file. A fence whose words are wrong is
 * reported and dropped, and so is a `continue` block right after it (its
 * head already failed). A `continue` after a skipped block is skipped too,
 * with the same reason.
 */
export function extractExamples(file: string, markdown: string): { examples: Example[]; failures: ExampleFailure[] } {
  const examples: Example[] = [];
  const failures: ExampleFailure[] = [];
  let previous: Example | undefined;
  let previousFailed = false;
  for (const fence of scanFences(markdown).fences) {
    if (!fence.closed) {
      failures.push(failure('DOCX_E005', file, fence.line, ': unclosed fence'));
      continue;
    }
    const [first = '', ...rest] = fence.info.split(/\s+/);
    const lang = first.toLowerCase();
    if (!isExampleLang(lang)) continue;
    const words = parseFenceWords(rest.join(' '));
    if (words.problem) {
      failures.push(failure(words.problem.rule, file, fence.line, words.problem.detail));
      previousFailed = true;
      continue;
    }
    if (words.continues && previousFailed) continue;
    if (words.continues && previous === undefined) {
      failures.push(failure('DOCX_E004', file, fence.line));
      previousFailed = true;
      continue;
    }
    const skip = words.skip ?? (words.continues ? previous?.skip : undefined);
    const example: Example = {
      file,
      line: fence.line,
      lang: LANG_ALIASES[lang],
      run: words.run,
      continues: words.continues,
      ...(skip === undefined ? {} : { skip }),
      code: fence.body.join('\n'),
    };
    examples.push(example);
    previous = example;
    previousFailed = false;
  }
  return { examples, failures };
}

/** The widest language of a chain: any TypeScript makes it TS, any JSX makes it JSX. */
function chainLang(examples: readonly Example[]): Example['lang'] {
  const typed = examples.some(example => example.lang === 'ts' || example.lang === 'tsx');
  const jsx = examples.some(example => example.lang === 'tsx' || example.lang === 'jsx');
  if (typed) return jsx ? 'tsx' : 'ts';
  return jsx ? 'jsx' : 'js';
}

/** Joins each `continue` block onto the module before it. Skipped blocks are left out. */
export function stitch(examples: readonly Example[]): ExampleModule[] {
  const chains: Example[][] = [];
  for (const example of examples) {
    if (example.skip !== undefined) continue;
    const last = chains.at(-1);
    if (example.continues && last?.[0]?.file === example.file) last.push(example);
    else chains.push([example]);
  }
  return chains.map(chain => ({
    examples: chain,
    code: chain.map(example => example.code).join('\n'),
    lang: chainLang(chain),
    run: chain[0]?.run ?? false,
  }));
}

/** Where a module is written, relative to the package: `.cache/doc-examples/readme-12.ts`. */
export function moduleFile(module: ExampleModule): string {
  const head = module.examples[0];
  const slug = (head?.file ?? 'doc')
    .replace(/\.md$/i, '')
    .replaceAll(/[^a-z\d]+/gi, '-')
    .toLowerCase();
  return `${OUT}/${slug}-${String(head?.line ?? 0)}.${module.lang}`;
}

/** The Markdown line behind a 0-based line of `module.code`. */
function sourceOf(module: ExampleModule, codeLine: number): { file: string; line: number } {
  let offset = codeLine;
  for (const example of module.examples) {
    const count = splitLines(example.code).length;
    if (offset >= 0 && offset < count) return { file: example.file, line: example.line + 1 + offset };
    offset -= count;
  }
  const head = module.examples[0];
  return { file: head?.file ?? '', line: head?.line ?? 0 };
}

/** The 0-based line of a character offset. */
function lineAt(code: string, position: number): number {
  return code.slice(0, position).split('\n').length - 1;
}

const SUPPRESSION = /@ts-(?:ignore|expect-error|nocheck)\b/g;

/** `any` and `as unknown as` found in the syntax tree; suppression comments found in the text. */
function forbidden(module: ExampleModule): { name: string; codeLine: number }[] {
  const kind = module.lang === 'tsx' || module.lang === 'jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile('example.tsx', module.code, ts.ScriptTarget.Latest, true, kind);
  const found: { name: string; codeLine: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      found.push({ name: 'any', codeLine: lineAt(module.code, node.getStart(source)) });
    }
    if (
      ts.isAsExpression(node) &&
      ts.isAsExpression(node.expression) &&
      node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      found.push({ name: 'as unknown as', codeLine: lineAt(module.code, node.expression.type.getStart(source)) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const match of module.code.matchAll(SUPPRESSION)) {
    found.push({ name: match[0], codeLine: lineAt(module.code, match.index) });
  }
  return found;
}

function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
}

/** Imports outside the package, its declared dependencies and `node:` builtins. */
function undeclaredImports(manifest: Manifest, module: ExampleModule): { detail: string; codeLine: number }[] {
  const declared = new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.peerDependencies),
    ...Object.keys(manifest.devDependencies),
    ...Object.keys(manifest.optionalDependencies),
  ]);
  return ts.preProcessFile(module.code, true, true).importedFiles.flatMap(({ fileName, pos }) => {
    const codeLine = lineAt(module.code, pos);
    if (fileName.startsWith('node:')) return [];
    if (fileName.startsWith('.') || fileName.startsWith('/')) {
      return [{ detail: `: "${fileName}" is relative; import the package by name`, codeLine }];
    }
    if (declared.has(packageOf(fileName))) return [];
    return [{ detail: `: "${fileName}" is not in package.json`, codeLine }];
  });
}

/** A `dist/` file named by `exports` that is not on disk; `undefined` when the build is there. */
function missingBuildOutput(dir: string, manifest: Manifest): string | undefined {
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (subpath === './package.json' || subpath.includes('*')) continue;
    const absent = leaves(target).find(
      leaf => leaf.value.startsWith('./dist/') && !existsSync(path.join(dir, leaf.value)),
    );
    if (absent) return absent.value.slice(2);
  }
  return undefined;
}

/**
 * The generated tsconfig: the package's own settings, plus what an example
 * needs. Unused names are allowed, since a block often shows a declaration
 * nobody calls. Nothing is emitted, so an inherited `rootDir` / `outDir` is
 * reset with `null`: kept, TypeScript 6 fails every package whose exports
 * point at `src/*.ts` (TS6059: file is not under rootDir).
 */
function exampleTsconfig(dir: string): object {
  return {
    ...(existsSync(path.join(dir, 'tsconfig.json')) ? { extends: '../../tsconfig.json' } : {}),
    compilerOptions: {
      noEmit: true,
      rootDir: null,
      outDir: null,
      declaration: false,
      declarationMap: false,
      emitDeclarationOnly: false,
      composite: false,
      incremental: false,
      sourceMap: false,
      allowJs: true,
      checkJs: true,
      jsx: 'react-jsx',
      skipLibCheck: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
    },
    include: ['./*'],
  };
}

/**
 * Bans, import check, then one `ts.Program` over every module. Writes the
 * modules and a tsconfig to `.cache/doc-examples/` (cleared first).
 */
export function compileExamples(dir: string, manifest: Manifest, modules: readonly ExampleModule[]): ExampleFailure[] {
  const failures: ExampleFailure[] = [];
  for (const module of modules) {
    for (const { name, codeLine } of forbidden(module)) {
      const at = sourceOf(module, codeLine);
      failures.push(failure('DOCX_E006', at.file, at.line, `: ${name}`));
    }
    for (const { detail, codeLine } of undeclaredImports(manifest, module)) {
      const at = sourceOf(module, codeLine);
      failures.push(failure('DOCX_E007', at.file, at.line, detail));
    }
  }
  if (modules.length === 0) return failures;

  const missing = missingBuildOutput(dir, manifest);
  if (missing !== undefined) {
    return [...failures, failure('DOCX_E008', 'package.json', 1, `: ${missing} is missing (bun run build)`)];
  }

  const out = path.join(dir, OUT);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const byFile = new Map<string, ExampleModule>();
  for (const module of modules) {
    const file = path.join(dir, moduleFile(module));
    const head = module.examples[0];
    writeFileSync(file, `// from ${head?.file ?? ''}:${String(head?.line ?? 0)}\n${module.code}\nexport {};\n`);
    byFile.set(path.resolve(file), module);
  }
  const configFile = path.join(out, 'tsconfig.json');
  writeFileSync(configFile, `${JSON.stringify(exampleTsconfig(dir), null, 2)}\n`);

  const config = ts.readConfigFile(configFile, file => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, out, undefined, configFile);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  for (const diagnostic of diagnostics) {
    const text = `: TS${String(diagnostic.code)} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
    const source = diagnostic.file;
    if (source === undefined || diagnostic.start === undefined) {
      failures.push(failure('DOCX_E001', `${OUT}/tsconfig.json`, 1, text));
      continue;
    }
    const generatedLine = source.getLineAndCharacterOfPosition(diagnostic.start).line;
    const module = byFile.get(path.resolve(source.fileName));
    if (module === undefined) {
      failures.push(failure('DOCX_E001', path.relative(dir, source.fileName), generatedLine + 1, text));
      continue;
    }
    // Line 0 of the generated file is the `// from` header, so code line = generated line - 1.
    const at = sourceOf(module, generatedLine - 1);
    failures.push(failure('DOCX_E001', at.file, at.line, text));
  }
  return failures;
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split('\n').slice(-count).join('\n');
}

/** Only PATH and HOME from the caller's environment, so no secret reaches an example. */
function runEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME'] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Runs each module with `bun`, serially, from the package directory. Call it
 * after `compileExamples`, which writes the files. `env` defaults to PATH and
 * HOME only; `timeoutMs` to 30 s.
 */
export function runExamples(
  dir: string,
  modules: readonly ExampleModule[],
  options: { readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string>> } = {},
): ExampleFailure[] {
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  const env = options.env ?? runEnvironment();
  return modules.flatMap(module => {
    const head = module.examples[0];
    const at = { file: head?.file ?? '', line: head?.line ?? 0 };
    const result = spawnSync('bun', [moduleFile(module)], { cwd: dir, env, encoding: 'utf8', timeout: timeoutMs });
    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
      return [failure('DOCX_E002', at.file, at.line, ': bun is not installed')];
    }
    if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
      return [failure('DOCX_E002', at.file, at.line, `: timed out after ${String(timeoutMs / 1000)} s`)];
    }
    if (result.error) return [failure('DOCX_E002', at.file, at.line, `: ${result.error.message}`)];
    if (result.status !== 0) {
      const output = lastLines(result.stderr || result.stdout, 20);
      return [failure('DOCX_E002', at.file, at.line, `: exit ${String(result.status)}\n${output}`)];
    }
    return [];
  });
}

export type ExamplesReport = {
  readonly examples: number;
  readonly modules: number;
  readonly ran: number;
  readonly skipped: number;
  readonly failures: readonly ExampleFailure[];
};

/** The Markdown lines a module covers: each block's fences and body. */
function covers(module: ExampleModule, failure: ExampleFailure): boolean {
  return module.examples.some(
    example =>
      example.file === failure.file &&
      failure.line >= example.line &&
      failure.line <= example.line + splitLines(example.code).length + 1,
  );
}

/** Extract, compile and (unless `run` is false) run every example of the package in `dir`. */
export function checkExamples(dir: string, options: { readonly run: boolean }): ExamplesReport {
  const root = realpathSync(dir);
  const manifest = readManifest(root);
  const examples: Example[] = [];
  const failures: ExampleFailure[] = [];
  for (const file of DOC_FILES) {
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    const extracted = extractExamples(file, readFileSync(full, 'utf8'));
    examples.push(...extracted.examples);
    failures.push(...extracted.failures);
  }
  const modules = stitch(examples);
  const compiled = compileExamples(root, manifest, modules);
  failures.push(...compiled);
  const built = !compiled.some(item => item.rule === 'DOCX_E008');
  const runnable =
    options.run && built ? modules.filter(module => module.run && !compiled.some(item => covers(module, item))) : [];
  failures.push(...runExamples(root, runnable));
  return {
    examples: examples.length,
    modules: modules.length,
    ran: runnable.length,
    skipped: examples.filter(example => example.skip !== undefined).length,
    failures: failures.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  };
}

function main(): number {
  const { values } = parseArgs({
    options: { 'no-run': { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
  });
  const report = checkExamples(process.cwd(), { run: !values['no-run'] });
  if (values.json) {
    const { examples, modules, skipped, failures } = report;
    say(JSON.stringify({ examples, modules, skipped, failures }, null, 2));
    return failures.length > 0 ? 1 : 0;
  }
  for (const item of report.failures) complain(`${item.file}:${String(item.line)}  ${item.rule}  ${item.message}`);
  const summary = `arki-doc-examples: ${String(report.examples)} example(s), ${String(report.modules)} module(s), ${String(report.ran)} run, ${String(report.skipped)} skipped, ${String(report.failures.length)} failure(s)`;
  if (report.failures.length > 0) {
    complain(summary);
    return 1;
  }
  say(report.examples === 0 ? `${summary} (no examples)` : summary);
  return 0;
}

if (import.meta.main) process.exit(main());
