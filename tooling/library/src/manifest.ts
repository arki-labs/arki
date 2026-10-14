import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** One `exports` value: a path, `null` (blocked), or a map of conditions to more of the same. */
export type ExportTarget = string | null | { readonly [condition: string]: ExportTarget };

const exportTarget: z.ZodType<ExportTarget> = z.lazy(() =>
  z.union([z.string(), z.null(), z.record(z.string(), exportTarget)]),
);

const manifestSchema = z.object({
  name: z.string().min(1),
  exports: z.union([z.string(), z.record(z.string(), exportTarget)]).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  sideEffects: z.union([z.boolean(), z.array(z.string())]).optional(),
});

export type Manifest = {
  readonly name: string;
  /** Subpath (`.`, `./foo`) to target. A string `exports` becomes `{ '.': value }`. */
  readonly exports: Readonly<Record<string, ExportTarget>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly sideEffects: boolean | readonly string[] | undefined;
};

/** Reads and validates `<dir>/package.json`. */
export function readManifest(dir: string): Manifest {
  const file = path.join(dir, 'package.json');
  const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new Error(`${file} is not a valid package manifest: ${z.prettifyError(parsed.error)}`);
  }
  const { name, exports, dependencies, sideEffects } = parsed.data;
  return {
    name,
    exports: typeof exports === 'string' ? { '.': exports } : (exports ?? {}),
    dependencies: dependencies ?? {},
    sideEffects,
  };
}

/** Every string leaf of a target, with the condition names on the way to it. */
export function leaves(
  target: ExportTarget,
  conditions: readonly string[] = [],
): { conditions: string[]; value: string }[] {
  if (target === null) return [];
  if (typeof target === 'string') return [{ conditions: [...conditions], value: target }];
  return Object.entries(target).flatMap(([condition, inner]) => leaves(inner, [...conditions, condition]));
}

const RUNTIME_CONDITIONS = new Set(['import', 'default', 'node']);

/**
 * The file a Node/Bun importer gets for an export: the first leaf reached through
 * `import`, `node` or `default` only (no `types`, `browser`, `react-native`, ...).
 * Returns `undefined` for a target nobody can import (types only, `null`, non-JS file).
 */
export function runtimeEntry(target: ExportTarget): string | undefined {
  return leaves(target).find(
    leaf =>
      leaf.conditions.every(condition => RUNTIME_CONDITIONS.has(condition)) &&
      /\.(?:[cm]?js|ts|mts)$/.test(leaf.value) &&
      !leaf.value.endsWith('.d.ts'),
  )?.value;
}

/** True when the package depends on nothing from npm (only `workspace:` links, or nothing). */
export function hasNoNpmDependencies(manifest: Manifest): boolean {
  return Object.values(manifest.dependencies).every(range => range.startsWith('workspace:'));
}
