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
 * Same-shape exports are grouped. When {@link GROUP_THRESHOLD} or more
 * undocumented variables of one subpath share one declared type (an icon set:
 * `export declare const X: Icon;` times 22,000), `entries` gets no row per name.
 * `groups` gets one row with the shared type and a count, and the sorted names
 * go to a sibling file (`api-names/<subpath>-<n>.json`, next to `api.json`).
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

import type { ApiEntry, ApiGroup, ApiIndex } from './api-index-schema';
import { buildErrorIndex } from './error-index';
import { leaves, readManifest } from './manifest';

export type { ApiEntry, ApiGroup, ApiIndex } from './api-index-schema';
export { API_KINDS, apiEntrySchema, apiGroupSchema, apiIndexSchema } from './api-index-schema';

/**
 * A group is only worth its extra file at this size: 50 rows are about 10 KB of
 * `api.json`, less than a second file and a pointer to it. Icon sets are in the
 * thousands, so the threshold only needs to be well below them.
 */
export const GROUP_THRESHOLD = 50;

/** Names of one group, as stored in its `namesFile`. */
export type NamesReader = (group: ApiGroup) => readonly string[];

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

/** Declared type of a plain `declare const X: T;`, or undefined for any other declaration. */
function sharedTypeOf(declarations: readonly ts.Declaration[]): string | undefined {
  const [only] = declarations;
  if (declarations.length !== 1 || only === undefined || !ts.isVariableDeclaration(only) || only.type === undefined) {
    return undefined;
  }
  return only.type.getText().replace(/\s+/g, ' ').trim();
}

const namesFileOf = (subpath: string, position: number): string =>
  `api-names/${subpath === '.' ? '_root' : subpath.replace(/^\.\//, '').replaceAll('/', '__')}-${position}.json`;

/**
 * Entries for one built package folder. Skipped subpaths are returned in
 * `skipped`; `names` maps each group's `namesFile` to its sorted names.
 */
export function buildApiIndex(dir: string): {
  index: ApiIndex;
  skipped: string[];
  names: ReadonlyMap<string, readonly string[]>;
} {
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

  const all: { entry: ApiEntry; sharedType: string | undefined }[] = [];
  for (const { subpath, file } of targets) {
    const source = program.getSourceFile(file);
    const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declarations = symbol.declarations ?? [];
      const first = declarations[0];
      const entry: ApiEntry = {
        subpath,
        name: exported.name,
        kind: first ? kindOf(first) : 'unknown',
        signature: declarations.map(signatureOf).join(' ; '),
        jsdocSummary: summaryOf(symbol, checker),
      };
      // A documented export is never grouped: its summary would be lost.
      all.push({ entry, sharedType: entry.jsdocSummary === '' ? sharedTypeOf(declarations) : undefined });
    }
  }

  const byShape = new Map<string, string[]>();
  for (const { entry, sharedType } of all) {
    if (sharedType === undefined) continue;
    const key = `${entry.subpath}\u0000${sharedType}`;
    byShape.set(key, [...(byShape.get(key) ?? []), entry.name]);
  }
  const grouped = new Set([...byShape].filter(([, found]) => found.length >= GROUP_THRESHOLD).map(([key]) => key));
  const entries = all
    .filter(({ entry, sharedType }) => sharedType === undefined || !grouped.has(`${entry.subpath}\u0000${sharedType}`))
    .map(({ entry }) => entry)
    .toSorted((a, b) => a.subpath.localeCompare(b.subpath) || a.name.localeCompare(b.name));

  const groups: ApiGroup[] = [];
  const names = new Map<string, readonly string[]>();
  const perSubpath = new Map<string, number>();
  for (const key of [...grouped].toSorted()) {
    const [subpath = '', signature = ''] = key.split('\u0000');
    const position = (perSubpath.get(subpath) ?? 0) + 1;
    perSubpath.set(subpath, position);
    const sorted = (byShape.get(key) ?? []).toSorted((a, b) => a.localeCompare(b));
    const namesFile = namesFileOf(subpath, position);
    groups.push({ subpath, kind: 'variable', signature, count: sorted.length, namesFile });
    names.set(namesFile, sorted);
  }
  const errorCodes = buildErrorIndex(dir).map(entry => entry.code);
  return {
    index: { package: manifest.name, version: version ?? '0.0.0', entries, groups, errorCodes },
    skipped,
    names,
  };
}

/** Writes `api.json` and, next to it, the names file of every group. */
export function writeApiIndex(built: ReturnType<typeof buildApiIndex>, apiFile: string): void {
  mkdirSync(path.dirname(apiFile), { recursive: true });
  writeFileSync(apiFile, `${JSON.stringify(built.index, null, 2)}\n`);
  for (const [namesFile, names] of built.names) {
    const target = path.join(path.dirname(apiFile), namesFile);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(names)}\n`);
  }
}

const namesSchema = z.array(z.string());

/** Reads group names from the folder that holds `api.json`. */
export const namesReaderFor =
  (apiFile: string): NamesReader =>
  group =>
    namesSchema.parse(JSON.parse(readFileSync(path.join(path.dirname(apiFile), group.namesFile), 'utf8')));

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { dir: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' } },
  });
  const dir = path.resolve(values.dir ?? process.cwd());
  const built = buildApiIndex(dir);
  const { index, skipped } = built;
  for (const subpath of skipped) process.stderr.write(`arki-api-index: "${subpath}" skipped (types not built)\n`);
  if (values.out === undefined) {
    process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
  } else {
    writeApiIndex(built, path.resolve(values.out));
    process.stdout.write(
      `arki-api-index: ${index.entries.length} entries, ${index.groups.length} groups -> ${values.out}\n`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
