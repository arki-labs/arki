#!/usr/bin/env bun
/**
 * `arki-library-check`: checks the manifest of the package in the current
 * directory against the structure RFC (`docs/rfcs/2026-10-14-arki-structure.md`).
 *
 * Hard errors (exit 1): an export without `types`, an export that points
 * nowhere under `dist/` or `src/`, a package with no Boundaries tag, a folder
 * name that differs from the package name (`folder = name`, RFC B17).
 * Warnings (printed, exit 0): a `"./*"` wildcard export, `sideEffects` is not
 * `false`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

export function checkLibrary(dir: string): CheckResult {
  const manifest = readManifest(dir);
  const errors: string[] = [];
  const warnings: string[] = [];

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
    if (!found.some(leaf => leaf.conditions.at(-1) === 'types' || leaf.value.endsWith('.d.ts'))) {
      errors.push(`export "${subpath}" has no "types"`);
    }
    const runtime = found.filter(leaf => leaf.conditions.at(-1) === 'import' || leaf.conditions.at(-1) === 'default');
    if (!runtime.some(leaf => underBuildOrSource.test(leaf.value))) {
      errors.push(`export "${subpath}" has no "import" or "default" under dist/ or src/`);
    }
  }

  if (manifest.sideEffects !== false) {
    warnings.push('"sideEffects" is not false');
  }

  if (readTags(dir).length === 0) {
    errors.push('no Boundaries tag: add "tags": ["<layer>"] to turbo.json');
  }

  return { errors, warnings };
}

if (import.meta.main) {
  const { errors, warnings } = checkLibrary(process.cwd());
  for (const warning of warnings) say(`WARN  ${warning}`);
  for (const error of errors) complain(`ERROR ${error}`);
  if (errors.length > 0) {
    complain(`arki-library-check: ${String(errors.length)} error(s)`);
    process.exit(1);
  }
  say(`arki-library-check: ok (${String(warnings.length)} warning(s))`);
}
