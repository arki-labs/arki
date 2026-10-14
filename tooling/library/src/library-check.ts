#!/usr/bin/env bun
/**
 * `arki-library-check`: checks the manifest of the package in the current
 * directory against the structure RFC (`docs/rfcs/2026-10-14-arki-structure.md`).
 *
 * Hard errors (exit 1): an export without `types`, an export that points
 * nowhere under `dist/` or `src/`, a package with no Boundaries tag, a folder
 * name that differs from the package name (`folder = name`, RFC B17).
 * Warnings (printed, exit 0): a `"./*"` wildcard export, `sideEffects` is not
 * `false` or an exact file list.
 *
 * `--all` checks every package under `packages/` and `tooling/`. Known errors
 * are listed with a reason in `tooling/library/library-check-baseline.json`; only
 * errors outside it fail the run, and a baseline entry that no longer matches
 * an error fails it too (so the file cannot rot).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

import { leaves, readManifest } from './manifest';
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
  const expected = manifest.name.replace(/^@arki\//, '');
  if (folder !== expected) {
    errors.push(`folder "${folder}" should be "${expected}" (folder = name)`);
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

/** Every `packages/*` and `tooling/*` folder that has a manifest. */
function workspaceDirs(root: string): { dir: string; kind: Kind }[] {
  return (['packages', 'tooling'] as const).flatMap(group => {
    const base = path.join(root, group);
    if (!existsSync(base)) return [];
    return readdirSync(base, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(path.join(base, entry.name, 'package.json')))
      .map(entry => ({
        dir: path.join(base, entry.name),
        kind: group === 'packages' ? ('library' as const) : ('tooling' as const),
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

export function checkAll(root: string, baseline: readonly BaselineEntry[]): AllResult {
  const errors: AllResult['errors'][number][] = [];
  const warnings: AllResult['warnings'][number][] = [];
  const used = new Set<BaselineEntry>();
  let baselined = 0;
  for (const { dir, kind } of workspaceDirs(root)) {
    const name = readManifest(dir).name;
    const result = checkLibrary(dir, kind);
    for (const warning of result.warnings) warnings.push({ package: name, warning });
    for (const error of result.errors) {
      const known = baseline.find(entry => entry.package === name && entry.error === error);
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

function main(): number {
  const { values } = parseArgs({ options: { all: { type: 'boolean' }, baseline: { type: 'string' } } });
  if (values.all) {
    const baseline = readBaseline(values.baseline ? path.resolve(values.baseline) : BASELINE_FILE);
    const { errors, warnings, baselined, stale } = checkAll(findRepoRoot(process.cwd()), baseline);
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
