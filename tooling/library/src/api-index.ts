#!/usr/bin/env bun
/**
 * `arki-api-index`: lists every public export of a built package, with its
 * signature and the first line of its JSDoc, as `api.json`.
 *
 *   arki-api-index [--dir <packageDir>] [--out <file>] [--json]
 *
 * Run it in a package folder after `build`. It reads `exports` from
 * `package.json`, takes the `types` file of each subpath, and asks the
 * TypeScript compiler for that file's exports. The site, the mirrors and
 * `arki-api-diff` read the result (`apiIndexSchema`). Without `--out` the JSON
 * goes to stdout; `--json` is accepted for symmetry with the other tools.
 *
 * Wildcard subpaths (`./*`) and `package.json` are skipped: they have no fixed
 * list of names. A subpath whose types file is not built is skipped and
 * reported on stderr.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { z } from 'zod';

import { buildErrorIndex } from './error-index';
import { leaves, readManifest } from './manifest';

export const API_KINDS = ['function', 'class', 'interface', 'type', 'enum', 'variable', 'namespace', 'unknown'] as const;

export const apiEntrySchema = z.object({
  subpath: z.string(),
  name: z.string(),
  kind: z.enum(API_KINDS),
  signature: z.string(),
  jsdocSummary: z.string(),
});

/** `errorCodes` are the codes of `buildErrorIndex` for the same package (`dist/errors.json` holds the details). */
export const apiIndexSchema = z.object({
  package: z.string(),
  version: z.string(),
  entries: z.array(apiEntrySchema),
  errorCodes: z.array(z.string()),
});

export type ApiEntry = z.infer<typeof apiEntrySchema>;
export type ApiIndex = z.infer<typeof apiIndexSchema>;

const versionSchema = z.object({ version: z.string().optional() });

function kindOf(declaration: ts.Declaration): ApiEntry['kind'] {
  if (ts.isFunctionDeclaration(declaration)) return 'function';
  if (ts.isClassDeclaration(declaration)) return 'class';
  if (ts.isInterfaceDeclaration(declaration)) return 'interface';
  if (ts.isTypeAliasDeclaration(declaration)) return 'type';
  if (ts.isEnumDeclaration(declaration)) return 'enum';
  if (ts.isVariableDeclaration(declaration)) return 'variable';
  if (ts.isModuleDeclaration(declaration)) return 'namespace';
  return 'unknown';
}

/** Declaration text without JSDoc (`getText` skips leading trivia) and with whitespace collapsed. */
const signatureOf = (declaration: ts.Declaration): string => {
  // A variable's text is only `x: T`; the statement above it carries `declare const`.
  const node =
    ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      ? declaration.parent.parent
      : declaration;
  return node.getText().replace(/\s+/g, ' ').trim();
};

function summaryOf(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  return (text.split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim();
}

function typesFileOf(dir: string, target: Parameters<typeof leaves>[0]): string | undefined {
  const found = leaves(target).find(leaf => leaf.conditions.includes('types') || /\.d\.[cm]?ts$/.test(leaf.value));
  return found ? path.resolve(dir, found.value) : undefined;
}

/** Entries for one built package folder. Skipped subpaths are returned in `skipped`. */
export function buildApiIndex(dir: string): { index: ApiIndex; skipped: string[] } {
  const manifest = readManifest(dir);
  const { version } = versionSchema.parse(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')));
  const skipped: string[] = [];
  const targets: { subpath: string; file: string }[] = [];
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (subpath === './package.json' || subpath.includes('*')) continue;
    const file = typesFileOf(dir, target);
    if (file !== undefined && existsSync(file)) targets.push({ subpath, file });
    else skipped.push(subpath);
  }

  const program = ts.createProgram(
    targets.map(target => target.file),
    {
      noEmit: true,
      skipLibCheck: true,
      allowJs: false,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext,
    },
  );
  const checker = program.getTypeChecker();

  const entries: ApiEntry[] = [];
  for (const { subpath, file } of targets) {
    const source = program.getSourceFile(file);
    const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declarations = symbol.declarations ?? [];
      const first = declarations[0];
      entries.push({
        subpath,
        name: exported.name,
        kind: first ? kindOf(first) : 'unknown',
        signature: declarations.map(signatureOf).join(' ; '),
        jsdocSummary: summaryOf(symbol, checker),
      });
    }
  }
  entries.sort((a, b) => a.subpath.localeCompare(b.subpath) || a.name.localeCompare(b.name));
  const errorCodes = buildErrorIndex(dir).map(entry => entry.code);
  return { index: { package: manifest.name, version: version ?? '0.0.0', entries, errorCodes }, skipped };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { dir: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' } },
  });
  const dir = path.resolve(values.dir ?? process.cwd());
  const { index, skipped } = buildApiIndex(dir);
  for (const subpath of skipped) process.stderr.write(`arki-api-index: "${subpath}" skipped (types not built)\n`);
  const text = `${JSON.stringify(index, null, 2)}\n`;
  if (values.out === undefined) {
    process.stdout.write(text);
  } else {
    mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
    writeFileSync(values.out, text);
    process.stdout.write(`arki-api-index: ${index.entries.length} entries -> ${values.out}\n`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
