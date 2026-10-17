#!/usr/bin/env bun
/**
 * `arki-error-index`: reads every error code a package defines and writes
 * `dist/errors.json`, the data behind `https://arki.dev/errors/<code>`.
 *
 * Two shapes carry a code:
 *  - thrown: a property of a `*_ERROR_CODES` / `*ErrorCode(s)` object whose value is a string
 *    literal (`duplicateRouterKey: 'ARKI_DOT_E022'`). The property's JSDoc is the entry.
 *  - failure: a `defineFailure('<pkg>.<code>', ...)` call. The JSDoc of its declaration is the entry.
 *
 * In the JSDoc, the summary is "what happened"; `@fix <text>` says what to do; `@verify <command>`
 * says how to check the fix worked.
 *
 *   arki-error-index [--out dist/errors.json]     (run in a package directory)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { z } from 'zod';

import { complain, say } from './report';

export const errorEntrySchema = z.object({
  code: z.string().min(1),
  package: z.string().min(1),
  kind: z.enum(['thrown', 'failure']),
  what: z.string(),
  fix: z.string().nullable(),
  verify: z.string().nullable(),
  /** `src/file.ts:line`, relative to the package. */
  source: z.string().regex(/^.+:\d+$/),
});
export const errorIndexSchema = z.array(errorEntrySchema);
export type ErrorEntry = z.infer<typeof errorEntrySchema>;

/** Base of the public page of one code. Dotted failure codes are used as they are. */
export const ERROR_DOCS_URL = 'https://arki.dev/errors';

export function errorDocsUrl(code: string): string {
  return `${ERROR_DOCS_URL}/${code}`;
}

const REGISTRY_NAME = /(?:ERROR_CODES|ErrorCodes?)$/;
const SKIPPED_DIRS = new Set(['node_modules', '__tests__', '__fixtures__', 'fixtures', 'dist']);
const SKIPPED_FILE = /\.(?:test|test-d|spec|d)\.tsx?$/;

function collapse(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/** The last JSDoc block on a node: its summary and the text of its `@fix` and `@verify` tags. */
function readDoc(node: ts.Node): Pick<ErrorEntry, 'what' | 'fix' | 'verify'> {
  const block = ts.getJSDocCommentsAndTags(node).findLast(ts.isJSDoc);
  const tagText = (name: string): string | null => {
    const tag = block?.tags?.find(candidate => candidate.tagName.text === name);
    const text = tag === undefined ? '' : collapse(ts.getTextOfJSDocComment(tag.comment) ?? '');
    return text === '' ? null : text;
  };
  return {
    what: collapse(ts.getTextOfJSDocComment(block?.comment) ?? ''),
    fix: tagText('fix'),
    verify: tagText('verify'),
  };
}

/** `{...} as const` and `satisfies` wrappers hide the object literal; peel them. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Every error entry one source file defines. `file` is the path shown in `source`. */
export function readErrorEntries(sourceText: string, file: string, packageName: string): ErrorEntry[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const entries: ErrorEntry[] = [];
  const at = (node: ts.Node): string =>
    `${file}:${String(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1)}`;

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = unwrap(node.initializer);
      if (REGISTRY_NAME.test(node.name.text) && ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties) {
          if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(unwrap(property.initializer))) {
            const value = unwrap(property.initializer);
            if (ts.isStringLiteralLike(value)) {
              entries.push({
                code: value.text,
                package: packageName,
                kind: 'thrown',
                ...readDoc(property),
                source: at(property),
              });
            }
          }
        }
      } else if (
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'defineFailure'
      ) {
        const [code] = initializer.arguments;
        if (code !== undefined && ts.isStringLiteralLike(code)) {
          entries.push({ code: code.text, package: packageName, kind: 'failure', ...readDoc(node), source: at(node) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return entries;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (!SKIPPED_DIRS.has(item.name)) found.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(item.name) && !SKIPPED_FILE.test(item.name)) {
      found.push(full);
    }
  }
  return found;
}

const packageJsonSchema = z.object({ name: z.string() });

/** The index of one package directory: every entry under `src/`, sorted by code. */
export function buildErrorIndex(packageDir: string): ErrorEntry[] {
  const { name } = packageJsonSchema.parse(JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')));
  const srcDir = path.join(packageDir, 'src');
  if (!existsSync(srcDir)) return [];
  const entries = sourceFiles(srcDir).flatMap(file =>
    readErrorEntries(readFileSync(file, 'utf8'), path.relative(packageDir, file), name),
  );
  return errorIndexSchema.parse(entries).toSorted((a, b) => a.code.localeCompare(b.code));
}

/** Entries that lack `@fix` or `@verify`. The rule ERR_E001 of `arki-library-check` reports these. */
export function missingErrorDocs(entries: readonly ErrorEntry[]): ErrorEntry[] {
  return entries.filter(entry => entry.fix === null || entry.verify === null);
}

export const ERR_RULES = {
  ERR_E001: 'error code lacks @fix or @verify in its JSDoc',
} as const;

/**
 * ERR_E001 findings for `arki-library-check`, one per code. No line number:
 * the baseline matches findings by text, so moving a code must not unbaseline it.
 */
export function checkErrorDocs(packageDir: string): string[] {
  return missingErrorDocs(buildErrorIndex(packageDir)).map(entry => {
    const lacking = [entry.fix === null ? '@fix' : null, entry.verify === null ? '@verify' : null].filter(
      tag => tag !== null,
    );
    return `ERR_E001 ${ERR_RULES.ERR_E001}: ${entry.code} (no ${lacking.join(', ')})`;
  });
}

function main(): number {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'dist/errors.json' } } });
  const packageDir = process.cwd();
  const entries = buildErrorIndex(packageDir);
  const out = path.resolve(packageDir, values.out);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
  const missing = missingErrorDocs(entries).length;
  say(`arki-error-index: ${String(entries.length)} code(s), ${String(missing)} without @fix/@verify -> ${out}`);
  if (entries.length === 0) complain('arki-error-index: no error codes found under src/');
  return 0;
}

if (import.meta.main) process.exit(main());
