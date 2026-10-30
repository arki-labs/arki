/**
 * TYPES_E001: an export entry whose types expose Zod.
 *
 * `@arki/*` libraries take any Standard Schema validator. A Zod type in a
 * public entry ties every consumer to Zod, so only an entry whose last
 * segment is `zod` (`./zod`, `./foo/zod`) may show one.
 *
 * For each entry the check reads the `types` file, follows its relative
 * imports and re-exports inside the package, and collects AST identifiers
 * that look like Zod types (`ZodObject`, `$ZodType`). Comments are not AST
 * nodes, so a JSDoc mention never counts. Other packages are not followed:
 * each package answers for its own files.
 *
 * TYPES_W001: the types file does not exist yet (`library-check` runs before
 * `build`), so the entry is skipped with a warning.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import type { CheckResult } from './library-check';
import type { Manifest } from './manifest';
import { parseImports } from './layers';
import { leaves } from './manifest';

/**
 * Packages whose whole point is the Zod layer. `@arki/contracts` holds the
 * shared Zod contracts (standard-schema synthesis, decision 8), so it is exempt
 * in code rather than in the baseline.
 */
const ZOD_LAYER_PACKAGES = new Set(['@arki/contracts']);

/**
 * Single entries that are a Zod layer by design, keyed by package name.
 * - `@arki/db` `./id`, `./id-factory`: `defineId` columns carry the workspace's id schemas (zod, like contracts).
 * - `@arki/db` `./pg`, `./sqlite`, `./columns`: JSON and id columns take a zod schema, because `createInsertSchema`
 *   reads it from the column at runtime (founder, 2026-10-30; A-44).
 * - `@arki/env` `./contracts`: the zod parsing helpers (`json`, `csvArray`, ...) for `defineEnv`.
 * - `@arki/text` `./validation`: the zod input schemas of the text procedures.
 * - `@arki/content-build` `./presets`: `@content-collections` requires zod/v4 schemas in its collections, and the
 *   preset document types (`Post`, ...) are inferred from them.
 */
const ZOD_LAYER_ENTRIES: Readonly<Record<string, ReadonlySet<string>>> = {
  '@arki/db': new Set(['./id', './id-factory', './pg', './sqlite', './columns']),
  '@arki/env': new Set(['./contracts']),
  '@arki/content-build': new Set(['./presets']),
};

const ZOD_IDENTIFIER = /^\$?Zod[A-Z]/;

/** Candidate files for a relative specifier, declaration files first. */
const DECLARATION_SWAPS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.d.ts', '.ts', '.tsx'],
  '.jsx': ['.d.ts', '.tsx'],
  '.mjs': ['.d.mts', '.mts'],
  '.cjs': ['.d.cts', '.cts'],
};
const BARE_EXTENSIONS = ['.d.ts', '.ts', '.tsx', '.d.mts', '.mts', '.d.cts', '.cts'];

function isFile(candidate: string): boolean {
  return existsSync(candidate) && statSync(candidate).isFile();
}

function resolveTypesFile(base: string): string | undefined {
  const ext = path.extname(base);
  const swaps = DECLARATION_SWAPS[ext];
  if (swaps) {
    const stem = base.slice(0, -ext.length);
    for (const swap of swaps) if (isFile(stem + swap)) return stem + swap;
  }
  if (isFile(base)) return base;
  for (const extension of BARE_EXTENSIONS) {
    if (isFile(base + extension)) return base + extension;
    if (isFile(path.join(base, `index${extension}`))) return path.join(base, `index${extension}`);
  }
  return undefined;
}

function zodIdentifiers(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && ZOD_IDENTIFIER.test(node.text)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Zod identifiers in `entry` and every file it reaches through relative specifiers. */
function zodTypesReachedFrom(entry: string): Set<string> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const name of zodIdentifiers(file, text)) found.add(name);
    for (const { specifier } of parseImports(file, text)) {
      if (!specifier.startsWith('.')) continue;
      const next = resolveTypesFile(path.resolve(path.dirname(file), specifier));
      if (next !== undefined) queue.push(next);
    }
  }
  return found;
}

const isTypesLeaf = (leaf: { conditions: string[]; value: string }): boolean =>
  leaf.conditions.includes('types') || /\.d\.[cm]?ts$/.test(leaf.value);

export function checkPublicTypes(dir: string, manifest: Manifest): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (ZOD_LAYER_PACKAGES.has(manifest.name)) return { errors, warnings };

  const zodEntries = ZOD_LAYER_ENTRIES[manifest.name];
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (subpath === './package.json' || subpath.includes('*') || subpath.split('/').at(-1) === 'zod') continue;
    if (zodEntries?.has(subpath)) continue;
    const typesFiles = [
      ...new Set(
        leaves(target)
          .filter(isTypesLeaf)
          .map(leaf => leaf.value),
      ),
    ];
    const exposed = new Set<string>();
    for (const typesFile of typesFiles) {
      const file = path.resolve(dir, typesFile);
      if (!isFile(file)) {
        warnings.push(`TYPES_W001 export "${subpath}" types not built (${typesFile}): Zod check skipped`);
        continue;
      }
      for (const name of zodTypesReachedFrom(file)) exposed.add(name);
    }
    if (exposed.size > 0) {
      errors.push(`TYPES_E001 export "${subpath}" exposes Zod types: ${[...exposed].toSorted().join(', ')}`);
    }
  }
  return { errors, warnings };
}
