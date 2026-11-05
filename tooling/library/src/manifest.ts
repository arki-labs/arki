import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** One `exports` value: a path, `null` (blocked), or a map of conditions to more of the same. */
export type ExportTarget = string | null | { readonly [condition: string]: ExportTarget };

const exportTarget: z.ZodType<ExportTarget> = z.lazy(() =>
  z.union([z.string(), z.null(), z.record(z.string(), exportTarget)]),
);

/** Engines `arki-runtimes` can run a package on. `purity` is not listed: it always runs. */
export const RUNTIMES = ['node', 'bun', 'deno', 'browser', 'hermes'] as const;
export type Runtime = (typeof RUNTIMES)[number];

/**
 * The `"arki"` claim in a package.json.
 * - `runtimes`: the engines the package claims. Missing means all of them.
 * - `bundlerOnly`: export keys (`./react`) that load only inside a bundler or a
 *   worker. The release smoke bundles them with Vite instead of importing them
 *   under plain Node and Bun; `arki-runtimes` runs their own smoke file as a
 *   bundle on every engine. Each key must be in `exports`.
 * - `entryRuntimes`: export keys (`./geocoding`) that run on fewer engines than
 *   the package, each with its engines. Each key must be in `exports`, and each
 *   engine must be in `runtimes`.
 */
export const arkiClaimSchema = z.object({
  runtimes: z.array(z.enum(RUNTIMES)).min(1).optional(),
  bundlerOnly: z.array(z.string().min(1)).min(1).optional(),
  entryRuntimes: z.record(z.string().min(1), z.array(z.enum(RUNTIMES)).min(1)).optional(),
});

const manifestSchema = z.object({
  name: z.string().min(1),
  exports: z.union([z.string(), z.record(z.string(), exportTarget)]).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional() })).optional(),
  sideEffects: z.union([z.boolean(), z.array(z.string())]).optional(),
  arki: arkiClaimSchema.optional(),
  private: z.boolean().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  files: z.array(z.string()).optional(),
});

export type Manifest = {
  readonly name: string;
  /** Subpath (`.`, `./foo`) to target. A string `exports` becomes `{ '.': value }`. */
  readonly exports: Readonly<Record<string, ExportTarget>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  /** Names of peers marked `"optional": true` in `peerDependenciesMeta`. */
  readonly optionalPeers: ReadonlySet<string>;
  readonly sideEffects: boolean | readonly string[] | undefined;
  /** The engines the package claims; every engine when `arki.runtimes` is absent. */
  readonly runtimes: ReadonlySet<Runtime>;
  /** `arki.bundlerOnly`: export keys that load only inside a bundler. */
  readonly bundlerOnly: ReadonlySet<string>;
  /** `arki.entryRuntimes`: export key to the engines that entry runs on (a subset of `runtimes`). */
  readonly entryRuntimes: ReadonlyMap<string, ReadonlySet<Runtime>>;
  /** `"private": true` keeps the package off npm; it defaults to `false`. */
  readonly private: boolean;
  readonly scripts: Readonly<Record<string, string>>;
  /** The `files` allow-list; `undefined` means npm ships everything. */
  readonly files: readonly string[] | undefined;
};

/** Reads and validates `<dir>/package.json`. */
export function readManifest(dir: string): Manifest {
  const file = path.join(dir, 'package.json');
  const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new Error(`${file} is not a valid package manifest: ${z.prettifyError(parsed.error)}`);
  }
  const {
    name,
    exports,
    dependencies,
    devDependencies,
    peerDependencies,
    optionalDependencies,
    peerDependenciesMeta,
    sideEffects,
    arki,
    private: isPrivate,
    scripts,
    files,
  } = parsed.data;
  const exportMap = typeof exports === 'string' ? { '.': exports } : (exports ?? {});
  const runtimes = new Set(arki?.runtimes ?? RUNTIMES);
  const problems = entryRuntimeProblems(arki?.entryRuntimes ?? {}, Object.keys(exportMap), runtimes);
  if (problems.length > 0) {
    throw new Error(`${file} is not a valid package manifest: ${problems.join('; ')}`);
  }
  return {
    name,
    exports: exportMap,
    dependencies: dependencies ?? {},
    devDependencies: devDependencies ?? {},
    peerDependencies: peerDependencies ?? {},
    optionalDependencies: optionalDependencies ?? {},
    optionalPeers: new Set(
      Object.entries(peerDependenciesMeta ?? {})
        .filter(([, meta]) => meta.optional === true)
        .map(([peer]) => peer),
    ),
    sideEffects,
    runtimes,
    bundlerOnly: new Set(arki?.bundlerOnly ?? []),
    entryRuntimes: new Map(Object.entries(arki?.entryRuntimes ?? {}).map(([key, engines]) => [key, new Set(engines)])),
    private: isPrivate ?? false,
    scripts: scripts ?? {},
    files,
  };
}

/** Why an `arki.entryRuntimes` claim is wrong: a key that is not an export, or an engine the package does not claim. */
function entryRuntimeProblems(
  claim: Readonly<Record<string, readonly Runtime[]>>,
  exportKeys: readonly string[],
  runtimes: ReadonlySet<Runtime>,
): string[] {
  return Object.entries(claim).flatMap(([key, engines]) => [
    ...(exportKeys.includes(key) ? [] : [`arki.entryRuntimes lists ${key}, but exports has no such key`]),
    ...engines
      .filter(engine => !runtimes.has(engine))
      .map(engine => `arki.entryRuntimes gives ${key} the engine ${engine}, which arki.runtimes does not claim`),
  ]);
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

/**
 * True for a React Native package: one that claims Hermes and no other engine. It
 * loads `react-native` (itself, or through a peer such as `react-native-purchases`),
 * whose Flow source only Metro bundles, so its Hermes leg bundles the way Metro does.
 */
export function isReactNativePackage(manifest: Manifest): boolean {
  return manifest.runtimes.size === 1 && manifest.runtimes.has('hermes');
}
