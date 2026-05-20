/**
 * The `inventory` command — discover and classify every package under
 * `packages/**` against the release waves defined in
 * `arki.release.config.ts`.
 *
 * This module's job is HONEST CLASSIFICATION, not remediation. It does
 * NOT touch any manifest, never flips a `private` flag, and never
 * suggests a fix beyond a one-line remediation string in the envelope's
 * `errors[]`. Later tasks (Task 4, Task 5, Task 8) perform the actual
 * remediation work.
 *
 * Outputs:
 *   - A {@link ReleaseCommandEnvelope} with one item per discovered
 *     package, plus structured `errors[]` for every blocker.
 *   - Process exit code 1 when any package is classified
 *     `blocked-by-private-flag` or `blocked-by-private-dependency`;
 *     code 0 otherwise. Reserved blocker labels (`blocked-by-leak`,
 *     `blocked-by-build-shape`) don't trip the gate in Task 2 — they
 *     belong to later tasks.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import debugFactory from 'debug';

import {
  buildDependencyGraph,
  collectReachableArkiDeps,
} from './dependency-graph';
import { createEnvelope } from './json-output';
import type {
  InventoryBlocker,
  PackageClassification,
  ReleaseCommandEnvelope,
  ReleaseConfig,
  ReleaseError,
  ReleaseWaveId,
} from './types';

const debug = debugFactory('arki:release:inventory');

/** Stable error codes for the inventory command. */
export const INVENTORY_ERROR_CODES = {
  /** Manifest missing `name` field or non-`@arki/*` name (info — skipped). */
  invalidManifestName: 'INV_E001',
  /** Wave-allowlisted package is still `private: true`. */
  privateFlagBlocker: 'INV_E002',
  /** Public candidate transitively depends on a private ARKI package. */
  privateDependencyBlocker: 'INV_E003',
  /** Public manifest but not allowlisted in any wave (warning). */
  unclassifiedPublicManifest: 'INV_E004',
  /** Wave references a workspace package that does not exist (warning). */
  waveReferencesMissingPackage: 'INV_E005',
} as const;

/** A parsed manifest (a thin wrapper around the on-disk JSON shape). */
export interface ParsedManifest {
  /** Absolute or workspace-relative manifest path. */
  readonly manifestPath: string;
  /** The package's `name` (always `@arki/...` after filtering). */
  readonly name: string;
  /** The package's `version`, or `'0.0.0'` if absent. */
  readonly version: string;
  /** Resolved `private` flag — `false` when absent. */
  readonly private: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

/** A single classified package in the inventory output. */
export interface InventoryItem {
  readonly name: string;
  readonly version: string;
  readonly manifestPath: string;
  readonly private: boolean;
  readonly wave: ReleaseWaveId | null;
  readonly classification: PackageClassification;
  readonly blockers: readonly InventoryBlocker[];
}

/** Aggregate summary for the inventory envelope. */
export interface InventorySummary {
  readonly message: string;
  readonly totalDiscovered: number;
  readonly byClassification: Readonly<Record<string, number>>;
  readonly byWave: Readonly<Record<string, number>>;
}

/** Inputs accepted by {@link runInventory} — exposed for testing. */
export interface RunInventoryOptions {
  /** Workspace root to scan. */
  readonly cwd: string;
  /** Loaded `ReleaseConfig` (production: load from disk; tests: pass fixture). */
  readonly config: ReleaseConfig;
}

/**
 * Walk `packages/**` under `cwd`, parse each `package.json`, and return
 * the manifest list. Diagnostics (e.g. files with no `name`) are returned
 * separately so the caller can surface them in the envelope.
 *
 * - Excludes any path that contains a `node_modules` or `dist` segment.
 * - Uses Node's `readdir` recursively — portable across Bun and Vitest
 *   runners. (Bun.Glob is faster but isn't available under the Vitest
 *   Node runtime that owns the test suite.)
 */
export async function discoverManifests(cwd: string): Promise<{
  readonly manifests: readonly ParsedManifest[];
  readonly diagnostics: readonly ReleaseError[];
}> {
  const packagesRoot = path.join(cwd, 'packages');
  const manifests: ParsedManifest[] = [];
  const diagnostics: ReleaseError[] = [];

  const found = await walkForManifests(packagesRoot);
  for (const absPath of found) {
    const rel = path.relative(cwd, absPath);
    let json: unknown;
    try {
      const contents = await readFile(absPath, 'utf8');
      json = JSON.parse(contents) as unknown;
    } catch (cause) {
      diagnostics.push({
        code: INVENTORY_ERROR_CODES.invalidManifestName,
        severity: 'info',
        message: `Failed to parse ${rel}: ${cause instanceof Error ? cause.message : String(cause)}`,
        target: rel,
      });
      continue;
    }

    const parsed = parseManifest(rel, json);
    if (parsed === null) {
      diagnostics.push({
        code: INVENTORY_ERROR_CODES.invalidManifestName,
        severity: 'info',
        message: `Skipped ${rel}: missing or non-\`@arki/*\` \`name\` field.`,
        target: rel,
        remediation: 'Likely a stale build artifact (e.g. dist/package.json). Safe to ignore.',
      });
      continue;
    }
    manifests.push(parsed);
  }

  // Stable sort by name for deterministic output.
  manifests.sort((a, b) => a.name.localeCompare(b.name));
  debug('discovered %d manifests, %d diagnostics', manifests.length, diagnostics.length);
  return { manifests, diagnostics };
}

/**
 * Recursive directory walk that returns every `package.json` under `root`,
 * skipping `node_modules` and `dist` directories at any nesting depth.
 *
 * Returns `[]` when `root` doesn't exist — letting callers treat an
 * empty `packages/` dir as "no manifests" rather than an error.
 */
async function walkForManifests(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const nested = await walkForManifests(full);
      out.push(...nested);
    } else if (entry.isFile() && entry.name === 'package.json') {
      out.push(full);
    }
  }
  return out;
}

/** Parse a raw manifest JSON value, or return `null` to signal "skip". */
function parseManifest(manifestPath: string, raw: unknown): ParsedManifest | null {
  if (raw === null || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const name = m['name'];
  if (typeof name !== 'string' || !name.startsWith('@arki/')) return null;

  const version = typeof m['version'] === 'string' ? m['version'] : '0.0.0';
  const isPrivate = m['private'] === true;

  return {
    manifestPath,
    name,
    version,
    private: isPrivate,
    dependencies: narrowDepBucket(m['dependencies']),
    peerDependencies: narrowDepBucket(m['peerDependencies']),
    optionalDependencies: narrowDepBucket(m['optionalDependencies']),
  };
}

function narrowDepBucket(raw: unknown): Readonly<Record<string, string>> | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Build a map from package name → wave id from a config. Pure helper —
 * isolated so it can be unit-tested without touching disk.
 */
function buildWaveLookup(config: ReleaseConfig): ReadonlyMap<string, ReleaseWaveId> {
  const lookup = new Map<string, ReleaseWaveId>();
  for (const wave of config.waves) {
    for (const pkg of wave.packages) {
      lookup.set(pkg, wave.id);
    }
  }
  return lookup;
}

/**
 * Run the full inventory pass and produce the envelope.
 *
 * This is the public seam — both the CLI and the test suite call it.
 */
export async function runInventory(opts: RunInventoryOptions): Promise<
  ReleaseCommandEnvelope<InventoryItem, InventorySummary>
> {
  const { manifests, diagnostics } = await discoverManifests(opts.cwd);
  return classifyManifests({ manifests, diagnostics, config: opts.config });
}

/** Inputs to {@link classifyManifests} — exposed for tests using fixtures. */
export interface ClassifyManifestsOptions {
  readonly manifests: readonly ParsedManifest[];
  readonly diagnostics: readonly ReleaseError[];
  readonly config: ReleaseConfig;
}

/**
 * Type-level exhaustiveness guard. If a future task adds a new variant to
 * {@link PackageClassification} without updating the switch in
 * {@link classifyManifests}, the compiler will refuse to call this with the
 * unhandled variant — the function expects `never`.
 */
function assertNever(x: never): never {
  throw new Error(`Unhandled classification case: ${String(x)}`);
}

/**
 * Decide the classification label for a single manifest based on its
 * `private` flag, its wave assignment, and any private dep blockers found
 * earlier. Pure helper — no side effects, no error emission. The caller
 * uses the returned label to drive the error/blocker arrays.
 *
 * Reserved labels (`blocked-by-leak`, `blocked-by-build-shape`) are NOT
 * produced here — those belong to Tasks 4 and 5. Listing them in the
 * union keeps the seam stable so future tasks can extend without
 * touching this function's signature.
 */
function decideClassification(opts: {
  readonly manifest: ParsedManifest;
  readonly wave: ReleaseWaveId | null;
  readonly privateDepBlockers: readonly string[];
}): PackageClassification {
  const { manifest, wave, privateDepBlockers } = opts;
  if (wave === null) {
    return manifest.private ? 'private-only' : 'unassigned';
  }
  if (manifest.private) return 'blocked-by-private-flag';
  if (privateDepBlockers.length > 0) return 'blocked-by-private-dependency';
  return 'public-candidate';
}

/**
 * Classify every parsed manifest using the wave allowlist + dep graph.
 * Pure function — no disk access. Splitting it out lets us unit-test
 * classification without filesystem fixtures.
 */
export function classifyManifests(
  opts: ClassifyManifestsOptions,
): ReleaseCommandEnvelope<InventoryItem, InventorySummary> {
  const waveLookup = buildWaveLookup(opts.config);
  const graph = buildDependencyGraph(opts.manifests);

  const items: InventoryItem[] = [];
  const errors: ReleaseError[] = [...opts.diagnostics];

  for (const manifest of opts.manifests) {
    const wave = waveLookup.get(manifest.name) ?? null;
    const blockers: InventoryBlocker[] = [];

    // Compute private dep blockers up-front so the decision function has
    // all the inputs it needs and the switch below can stay shallow.
    let privateDepBlockers: readonly string[] = [];
    if (wave !== null && !manifest.private) {
      const reachable = collectReachableArkiDeps(graph, manifest.name);
      const offenders: string[] = [];
      for (const depName of reachable) {
        const depNode = graph.byName.get(depName);
        if (depNode !== undefined && depNode.manifest.private) {
          offenders.push(depName);
        }
      }
      privateDepBlockers = offenders;
    }

    const classification = decideClassification({ manifest, wave, privateDepBlockers });

    switch (classification) {
      case 'public-candidate':
      case 'private-only':
        // No diagnostics — the intended happy paths.
        break;
      case 'unassigned': {
        errors.push({
          code: INVENTORY_ERROR_CODES.unclassifiedPublicManifest,
          severity: 'warning',
          message: `${manifest.name} is not \`private: true\` but is not allowlisted for any release wave.`,
          target: manifest.name,
          remediation:
            'Add it to a wave in arki.release.config.ts, or set `"private": true` in its package.json.',
        });
        break;
      }
      case 'blocked-by-private-flag': {
        const reason = `Wave \`${wave!}\` lists ${manifest.name}, but its package.json still has \`"private": true\`.`;
        blockers.push({ code: INVENTORY_ERROR_CODES.privateFlagBlocker, reason });
        errors.push({
          code: INVENTORY_ERROR_CODES.privateFlagBlocker,
          severity: 'error',
          message: reason,
          target: manifest.name,
          remediation: 'Drop the `private` flag once the package is publish-ready (Task 8).',
        });
        break;
      }
      case 'blocked-by-private-dependency': {
        for (const offender of privateDepBlockers) {
          const reason = `${manifest.name} depends on private package ${offender}.`;
          blockers.push({
            code: INVENTORY_ERROR_CODES.privateDependencyBlocker,
            reason,
            target: offender,
          });
          errors.push({
            code: INVENTORY_ERROR_CODES.privateDependencyBlocker,
            severity: 'error',
            message: reason,
            target: manifest.name,
            remediation: `Promote ${offender} to public first, or remove the dep.`,
          });
        }
        break;
      }
      case 'blocked-by-leak':
      case 'blocked-by-build-shape':
        // Reserved for Tasks 4 and 5. Task 2 never produces these, but
        // listing them here keeps the switch exhaustive.
        break;
      default:
        assertNever(classification);
    }

    items.push({
      name: manifest.name,
      version: manifest.version,
      manifestPath: manifest.manifestPath,
      private: manifest.private,
      wave,
      classification,
      blockers,
    });
  }

  // Detect waves that reference workspace packages we never discovered.
  // Warning (not error): Task 8 may legitimately list a package in a wave
  // before it physically exists in the workspace. This surfaces the gap
  // without blocking the inventory.
  const discoveredNames = new Set(opts.manifests.map(m => m.name));
  for (const wave of opts.config.waves) {
    for (const pkgName of wave.packages) {
      if (!discoveredNames.has(pkgName)) {
        errors.push({
          code: INVENTORY_ERROR_CODES.waveReferencesMissingPackage,
          severity: 'warning',
          message: `Wave \`${wave.id}\` references \`${pkgName}\` but no workspace manifest with that name was found.`,
          remediation: `Either create the package or remove it from the \`${wave.id}\` wave in arki.release.config.ts.`,
          target: pkgName,
        });
      }
    }
  }

  const byClassification: Record<string, number> = {};
  const byWave: Record<string, number> = {};
  for (const item of items) {
    byClassification[item.classification] = (byClassification[item.classification] ?? 0) + 1;
    const key = item.wave ?? 'unassigned';
    byWave[key] = (byWave[key] ?? 0) + 1;
  }

  const hasBlocker = items.some(
    i =>
      i.classification === 'blocked-by-private-flag' ||
      i.classification === 'blocked-by-private-dependency',
  );

  const summary: InventorySummary = {
    message: hasBlocker
      ? `Inventory complete: ${items.length.toString()} packages, blockers present.`
      : `Inventory complete: ${items.length.toString()} packages, no blockers.`,
    totalDiscovered: items.length,
    byClassification,
    byWave,
  };

  return createEnvelope<InventoryItem, InventorySummary>({
    command: 'inventory',
    status: hasBlocker ? 'failure' : 'success',
    summary,
    items,
    errors,
  });
}
