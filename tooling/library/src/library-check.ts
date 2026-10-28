#!/usr/bin/env bun
/**
 * `arki-library-check`: checks the manifest of the package in the current
 * directory against the structure RFC (`docs/rfcs/2026-10-14-arki-structure.md`).
 *
 * Hard errors (exit 1): an export without `types`, an export that points
 * nowhere under `dist/` or `src/`, a package with no Boundaries tag, a folder
 * name that differs from the package name (`folder = name`, RFC B17), a scope
 * that differs from the parent folder (`scope = folder`: `packages/x` is
 * `@arki/x`, `fleet/x` is `@fleet/x`), a fleet package without `"private": true`.
 * Warnings (printed, exit 0): a `"./*"` wildcard export, `sideEffects` is not
 * `false` or an exact file list.
 *
 * A public library (`"private"` is not `true`) also gets the agent-docs rules
 * of `docs.ts`: DOC_E001-E003 (README.md, llms.txt, docs/agent-guide.md exist),
 * DOC_E004-E007 (llms.txt shape, "Import paths" equals `exports`, 80 lines /
 * 8 KiB), DOC_E008-E009 (links resolve inside the package), DOC_E010-E011
 * (guide sections; `dot explain/doctor --json` for a `./dot` export),
 * DOC_E012 (`files` ships the docs), DOC_E013 (a `test:docs` script),
 * DOC_E014-E016 (CHANGELOG.md, LICENSE, AGENTS.md exist), DOC_E017 (README H2s,
 * `README_SECTIONS`), DOC_E018 (AGENTS.md role line and sections), DOC_E019
 * (banned words in README, docs and llms.txt), SRC_E001 (the package's own
 * version as a string literal in `src/**`).
 * Warnings: DOC_W001 forward-looking words, DOC_W002 llms.txt over 60 lines.
 *
 * Every library, private or public, gets `error-index.ts`: ERR_E001 (missing
 * summary, `@fix` or `@verify`) and ERR_E002 (multiple original definitions).
 * The collector also checks ERR_E002 across packages.
 *
 * Every library, private or public, also gets `public-types.ts`: TYPES_E001 (an
 * export entry other than `./zod` exposes Zod types), TYPES_W001 (the entry's
 * types file is not built, so that check is skipped).
 *
 * Every library also gets `contract-entry.ts`: CONTRACT_E001 (the `./contract`
 * entry does not bundle for the browser, or bundles server-only code),
 * CONTRACT_E002 (an entry named `./contracts`: the one browser-safe contract
 * entry is `./contract`), CONTRACT_W001 (the entry is not built: check skipped).
 *
 * `--all` checks every package under `packages/`, `tooling/` and `fleet/`. Known errors
 * are listed with a reason in `tooling/library/library-check-baseline.json`; only
 * errors outside it fail the run, and a baseline entry that no longer matches
 * an error fails it too (so the file cannot rot).
 *
 * `--all --update-baseline [--reason "<why>"]` rewrites that file: stale entries
 * are dropped, matching ones keep their reason, and every new error is added
 * with `--reason` (required when there is one). The diff is the review.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

import type { ErrorEntry } from './error-index';
import { checkContractEntry } from './contract-entry';
import { checkDocs, checkSource } from './docs';
import { buildErrorIndex, checkErrorDocs, duplicateErrorCodes, ERR_RULES } from './error-index';
import { leaves, readManifest } from './manifest';
import { checkPublicTypes } from './public-types';
import { complain, say } from './report';

export type CheckResult = { readonly errors: string[]; readonly warnings: string[] };

const turboSchema = z.object({ tags: z.array(z.string()).optional() });

function readTags(dir: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, 'turbo.json'), 'utf8');
  } catch {
    return [];
  }
  return turboSchema.parse(JSON.parse(raw)).tags ?? [];
}

const underBuildOrSource = /^\.\/(?:dist|src)\//;
/** Only code files carry types; CSS, JSON and other assets are exported as plain files. */
const codeFile = /\.[cm]?[jt]sx?$/;

/**
 * `library` packages are products with typed entries. `tooling` packages ship
 * configs and bins for the repo itself, so only the Boundaries tag applies.
 */
export type Kind = 'library' | 'tooling';

export function checkLibrary(dir: string, kind: Kind = 'library'): CheckResult {
  const manifest = readManifest(dir);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (kind === 'tooling') {
    if (readTags(dir).length === 0) errors.push('no Boundaries tag: add "tags": ["<layer>"] to turbo.json');
    return { errors, warnings };
  }

  const folder = path.basename(path.resolve(dir));
  const expected = manifest.name.replace(/^@[^/]+\//, '');
  if (folder !== expected) {
    errors.push(`folder "${folder}" should be "${expected}" (folder = name)`);
  }
  // Fleet packages are shared across our apps, not Arki: never released, so always private.
  const isFleet = path.basename(path.dirname(path.resolve(dir))) === 'fleet';
  const scope = isFleet ? '@fleet/' : '@arki/';
  if (!manifest.name.startsWith(scope)) {
    errors.push(`name "${manifest.name}" should start with "${scope}" (scope = folder)`);
  }
  if (isFleet && !manifest.private) {
    errors.push('a fleet package must be "private": true (fleet packages are never released)');
  }

  const wildcards = Object.keys(manifest.exports).filter(key => key.includes('*'));
  if (wildcards.length > 0) {
    warnings.push(`wildcard exports (list each entry explicitly): ${wildcards.join(', ')}`);
  }

  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (subpath === './package.json' || subpath.includes('*')) continue;
    const found = leaves(target);
    const isTypes = (leaf: { conditions: string[]; value: string }): boolean =>
      leaf.conditions.at(-1) === 'types' || leaf.value.endsWith('.d.ts');
    if (found.some(leaf => !isTypes(leaf) && codeFile.test(leaf.value)) && !found.some(leaf => isTypes(leaf))) {
      errors.push(`export "${subpath}" has no "types"`);
    }
    // A plain string target (no conditions) is what every importer gets, like `default`.
    const runtime = found.filter(
      leaf =>
        leaf.conditions.length === 0 || leaf.conditions.at(-1) === 'import' || leaf.conditions.at(-1) === 'default',
    );
    if (!runtime.some(leaf => underBuildOrSource.test(leaf.value))) {
      errors.push(`export "${subpath}" has no "import" or "default" under dist/ or src/`);
    }
  }

  // `false`, or an exact list of the files that really run on import (CSS, a register file).
  if (manifest.sideEffects === undefined || manifest.sideEffects === true) {
    warnings.push('"sideEffects" is not false or an exact list of files');
  }

  if (readTags(dir).length === 0) {
    errors.push('no Boundaries tag: add "tags": ["<layer>"] to turbo.json');
  }

  if (!manifest.private) {
    const docs = checkDocs(dir, manifest);
    errors.push(...docs.errors);
    warnings.push(...docs.warnings);
    errors.push(...checkSource(dir).errors);
  }

  errors.push(...checkErrorDocs(dir));

  // Private packages too: wave-1 Zod targets such as ai, queue and testing are private.
  const types = checkPublicTypes(dir, manifest);
  errors.push(...types.errors);
  warnings.push(...types.warnings);

  const contract = checkContractEntry(dir, manifest);
  errors.push(...contract.errors);
  warnings.push(...contract.warnings);

  return { errors, warnings };
}

const BASELINE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'library-check-baseline.json');

const baselineSchema = z.object({
  entries: z.array(z.object({ package: z.string(), error: z.string(), reason: z.string().min(1) })),
});

type BaselineEntry = z.infer<typeof baselineSchema>['entries'][number];

function readBaseline(file: string): BaselineEntry[] {
  if (!existsSync(file)) return [];
  return baselineSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).entries;
}

function findRepoRoot(from: string): string {
  let current = path.resolve(from);
  while (!existsSync(path.join(current, 'turbo.json')) || !existsSync(path.join(current, 'packages'))) {
    const parent = path.dirname(current);
    if (parent === current)
      throw new Error('arki-library-check --all: run it inside the monorepo (no root turbo.json found)');
    current = parent;
  }
  return current;
}

/** Every `packages/*`, `tooling/*` and `fleet/*` folder that has a manifest. A missing group is skipped. */
function workspaceDirs(root: string): { dir: string; kind: Kind }[] {
  return (['packages', 'tooling', 'fleet'] as const).flatMap(group => {
    const base = path.join(root, group);
    if (!existsSync(base)) return [];
    return readdirSync(base, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(path.join(base, entry.name, 'package.json')))
      .map(entry => ({
        dir: path.join(base, entry.name),
        kind: group === 'tooling' ? ('tooling' as const) : ('library' as const),
      }))
      .toSorted((a, b) => a.dir.localeCompare(b.dir));
  });
}

export type AllResult = {
  readonly errors: { readonly package: string; readonly error: string }[];
  readonly warnings: { readonly package: string; readonly warning: string }[];
  readonly baselined: number;
  /** Baseline entries that match no error any more. */
  readonly stale: BaselineEntry[];
};

/**
 * What a baseline entry must match. Usually the whole error text. TYPES_E001
 * ends with the list of Zod type names the export exposes; that list changes
 * whenever a dependency's build changes, while the finding (this export
 * exposes Zod) does not. So TYPES_E001 matches on the text before the list.
 */
export function findingKey(error: string): string {
  return error.startsWith('TYPES_E001 ') ? (error.split(': ')[0] ?? error) : error;
}

export function checkAll(root: string, baseline: readonly BaselineEntry[]): AllResult {
  const errors: AllResult['errors'][number][] = [];
  const warnings: AllResult['warnings'][number][] = [];
  const originals: ErrorEntry[] = [];
  const used = new Set<BaselineEntry>();
  let baselined = 0;
  const results = workspaceDirs(root).map(({ dir, kind }) => {
    const name = readManifest(dir).name;
    const result = checkLibrary(dir, kind);
    if (kind === 'library') originals.push(...buildErrorIndex(dir));
    return { name, result };
  });
  // Re-exports add no entries: only original definitions compete for a public code URL.
  for (const code of duplicateErrorCodes(originals)) {
    const owners = new Set(originals.filter(entry => entry.code === code).map(entry => entry.package));
    if (owners.size < 2) continue;
    const error = `ERR_E002 ${ERR_RULES.ERR_E002}: ${code}`;
    for (const { name, result } of results) {
      if (owners.has(name) && !result.errors.includes(error)) result.errors.push(error);
    }
  }
  for (const { name, result } of results) {
    for (const warning of result.warnings) warnings.push({ package: name, warning });
    for (const error of result.errors) {
      const known = baseline.find(entry => entry.package === name && findingKey(entry.error) === findingKey(error));
      if (known) {
        used.add(known);
        baselined += 1;
      } else {
        errors.push({ package: name, error });
      }
    }
  }
  return { errors, warnings, baselined, stale: baseline.filter(entry => !used.has(entry)) };
}

/**
 * The baseline after `--update-baseline`: entries that still match an error,
 * plus one entry per unbaselined error with `reason`, sorted by package then error.
 */
export function updateBaseline(
  baseline: readonly BaselineEntry[],
  result: Pick<AllResult, 'errors' | 'stale'>,
  reason: string,
): BaselineEntry[] {
  const kept = baseline.filter(entry => !result.stale.includes(entry));
  const added = result.errors.map(({ package: name, error }) => ({ package: name, error, reason }));
  return [...kept, ...added].toSorted((a, b) => a.package.localeCompare(b.package) || a.error.localeCompare(b.error));
}

function main(): number {
  const { values } = parseArgs({
    options: {
      all: { type: 'boolean' },
      baseline: { type: 'string' },
      'update-baseline': { type: 'boolean' },
      reason: { type: 'string' },
    },
  });
  if (values.all) {
    const file = values.baseline ? path.resolve(values.baseline) : BASELINE_FILE;
    const baseline = readBaseline(file);
    const result = checkAll(findRepoRoot(process.cwd()), baseline);
    if (values['update-baseline']) {
      if (result.errors.length > 0 && !values.reason) {
        complain(
          `arki-library-check: ${String(result.errors.length)} new error(s); pass --reason "<why>" to baseline them`,
        );
        return 1;
      }
      const entries = updateBaseline(baseline, result, values.reason ?? '');
      writeFileSync(file, `${JSON.stringify({ entries }, null, 2)}\n`);
      say(
        `arki-library-check: baseline updated (${String(result.errors.length)} added, ${String(result.stale.length)} removed, ${String(entries.length)} total)`,
      );
      return 0;
    }
    const { errors, warnings, baselined, stale } = result;
    for (const { package: name, warning } of warnings) say(`WARN  ${name}: ${warning}`);
    for (const { package: name, error } of errors) complain(`ERROR ${name}: ${error}`);
    for (const entry of stale)
      complain(`STALE baseline entry (no longer an error, remove it): ${entry.package}: ${entry.error}`);
    if (errors.length > 0 || stale.length > 0) {
      complain(
        `arki-library-check: ${String(errors.length)} error(s), ${String(stale.length)} stale baseline entr(ies)`,
      );
      return 1;
    }
    say(
      `arki-library-check: ok (${String(warnings.length)} warning(s)${baselined > 0 ? `, ${String(baselined)} baselined` : ''})`,
    );
    return 0;
  }
  const { errors, warnings } = checkLibrary(process.cwd());
  for (const warning of warnings) say(`WARN  ${warning}`);
  for (const error of errors) complain(`ERROR ${error}`);
  if (errors.length > 0) {
    complain(`arki-library-check: ${String(errors.length)} error(s)`);
    return 1;
  }
  say(`arki-library-check: ok (${String(warnings.length)} warning(s))`);
  return 0;
}

if (import.meta.main) process.exit(main());
