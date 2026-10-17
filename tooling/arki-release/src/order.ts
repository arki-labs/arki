/**
 * Release order for a wave.
 *
 * A wave publishes the packages that have a pending changeset, plus every
 * `@arki/*` dependency whose required version npm does not have yet. If a
 * dependency is missing from npm the consumer's install breaks, so the
 * dependency must publish first. The output is a dependency-first list.
 *
 * Required ranges are the ones `manifest.ts` writes at publish time: the
 * exact workspace version for `dependencies` / `optionalDependencies`, and
 * `^version` for `peerDependencies`. Only those two forms exist, so a tiny
 * local check replaces a semver dependency (`semver` is not declared in this
 * package).
 */

import debugFactory from 'debug';
import { z } from 'zod';

import { buildDependencyGraph } from './dependency-graph';
import type { DependencyGraph } from './dependency-graph';
import { discoverManifests } from './inventory';
import type { ParsedManifest } from './inventory';
import { bumpedPackages, loadChangesets } from './impact';
import { createEnvelope } from './json-output';
import { defaultNpmRunner, type NpmRunner } from './runners';
import type { ReleaseCommandEnvelope, ReleaseConfig, ReleaseError } from './types';

const debug = debugFactory('arki:release:order');

export const ORDER_ERROR_CODES = {
  /** A required dependency is private or not in any wave. */
  dependencyNotAdmitted: 'ORDER_E001',
  /** `npm view` failed or returned something unreadable. */
  npmViewFailed: 'ORDER_E002',
  /** The dependency graph has a cycle among the packages to publish. */
  cycle: 'ORDER_E003',
  // ORDER_E004 (unreadable changeset) is retired: the one changeset reader
  // reports IMPACT_E005.
  /** The requested wave is not in the config. */
  unknownWave: 'ORDER_E005',
} as const;

export const ORDER_KINDS = ['candidate', 'published-dep'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

export interface OrderItem {
  readonly name: string;
  readonly version: string;
  readonly kind: OrderKind;
  /** 1-based; lower publishes first. */
  readonly publishOrder: number;
}

export interface OrderSummary {
  readonly message: string;
  readonly wave: string;
  readonly candidates: number;
  readonly publishedDeps: number;
}

export type OrderEnvelope = ReleaseCommandEnvelope<OrderItem, OrderSummary>;

// ---------------------------------------------------------------------------
// Range check (exact and caret only)
// ---------------------------------------------------------------------------

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text: string): Version | null {
  const match = VERSION_PATTERN.exec(text);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  };
}

export type RequiredRange =
  | { readonly kind: 'exact'; readonly version: string }
  | { readonly kind: 'caret'; readonly version: string };

function compareCore(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** True when the published version `candidate` satisfies `range`. Pre-releases only match exactly. */
export function satisfiesRange(candidate: string, range: RequiredRange): boolean {
  if (range.kind === 'exact') return candidate === range.version;
  const floor = parseVersion(range.version);
  const found = parseVersion(candidate);
  if (floor === null || found === null || found.prerelease) return false;
  if (compareCore(found, floor) < 0) return false;
  if (floor.major > 0) return found.major === floor.major;
  if (floor.minor > 0) return found.major === 0 && found.minor === floor.minor;
  return compareCore(found, floor) === 0;
}

// ---------------------------------------------------------------------------
// npm view
// ---------------------------------------------------------------------------

export type VersionLookup = (name: string) => Promise<{ readonly versions: readonly string[] } | { readonly error: string }>;

// `npm view <name> versions --json` prints a string for one version and an array for many.
const versionsOutput = z.union([z.string().transform(one => [one]), z.array(z.string())]);

/** Builds a {@link VersionLookup} over an injected npm runner. An unpublished package (E404) has no versions. */
export function npmVersionLookup(runner: NpmRunner, cwd: string): VersionLookup {
  return async name => {
    const out = await runner(['view', name, 'versions', '--json'], { cwd });
    if (out.code !== 0) {
      if (/E404|404 Not Found/.test(`${out.stdout}${out.stderr}`)) return { versions: [] };
      return { error: `npm view ${name} exited with code ${out.code.toString()}: ${out.stderr.trim() || out.stdout.trim()}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(out.stdout) as unknown;
    } catch {
      return { error: `npm view ${name} printed invalid JSON.` };
    }
    const parsed = versionsOutput.safeParse(json);
    return parsed.success ? { versions: parsed.data } : { error: `npm view ${name} returned an unexpected shape.` };
  };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export interface ComputeOrderInput {
  readonly graph: DependencyGraph;
  /** Packages that must publish (wave packages with a pending changeset, or affected packages). */
  readonly seeds: readonly string[];
  /** Public packages that belong to a wave. A dependency outside this set is not admitted. */
  readonly admitted: ReadonlySet<string>;
  readonly lookup: VersionLookup;
}

export interface ComputeOrderResult {
  readonly items: readonly OrderItem[];
  readonly errors: readonly ReleaseError[];
}

function requiredRange(consumer: ParsedManifest, dep: string, depVersion: string): RequiredRange {
  const exact = consumer.dependencies?.[dep] !== undefined || consumer.optionalDependencies?.[dep] !== undefined;
  return { kind: exact ? 'exact' : 'caret', version: depVersion };
}

export async function computeOrder(input: ComputeOrderInput): Promise<ComputeOrderResult> {
  const { graph, admitted, lookup } = input;
  const errors: ReleaseError[] = [];
  const kinds = new Map<string, OrderKind>();
  for (const seed of input.seeds) if (graph.byName.has(seed)) kinds.set(seed, 'candidate');

  // Breadth-first: each package in the set pulls in the dependencies npm lacks.
  const queue = [...kinds.keys()];
  const checked = new Set<string>();
  const lookups = new Map<string, Awaited<ReturnType<VersionLookup>>>();
  while (queue.length > 0) {
    const name = queue.shift();
    const node = name === undefined ? undefined : graph.byName.get(name);
    if (node === undefined) continue;
    for (const dep of node.dependsOn) {
      const depNode = graph.byName.get(dep);
      if (depNode === undefined || kinds.has(dep)) continue;
      const key = `${name ?? ''}>${dep}`;
      if (checked.has(key)) continue;
      checked.add(key);
      if (depNode.manifest.private || !admitted.has(dep)) {
        errors.push({
          code: ORDER_ERROR_CODES.dependencyNotAdmitted,
          severity: 'error',
          message: `${node.manifest.name} requires ${dep}, which is ${depNode.manifest.private ? 'private' : 'not in any wave'}.`,
          target: dep,
          remediation: `Admit ${dep}: make it public and add it to a wave in arki.release.config.ts, or remove the dependency.`,
        });
        continue;
      }
      let found = lookups.get(dep);
      if (found === undefined) {
        found = await lookup(dep);
        lookups.set(dep, found);
      }
      if ('error' in found) {
        errors.push({
          code: ORDER_ERROR_CODES.npmViewFailed,
          severity: 'error',
          message: found.error,
          target: dep,
          remediation: 'Check network and npm login, then run the command again.',
        });
        continue;
      }
      const range = requiredRange(node.manifest, dep, depNode.manifest.version);
      if (!found.versions.some(v => satisfiesRange(v, range))) {
        debug('%s needs %s (%s %s) which npm lacks', node.manifest.name, dep, range.kind, range.version);
        kinds.set(dep, 'published-dep');
        queue.push(dep);
      }
    }
  }

  const sorted = sortDependenciesFirst(graph, [...kinds.keys()]);
  if (sorted === null) {
    errors.push({
      code: ORDER_ERROR_CODES.cycle,
      severity: 'error',
      message: 'The packages to publish depend on each other in a cycle, so no publish order exists.',
      remediation: 'Break the cycle: move the shared code to a lower package or make one dependency an optional peer.',
    });
    return { items: [], errors };
  }
  const items = sorted.map((name, index): OrderItem => {
    const node = graph.byName.get(name);
    return {
      name,
      version: node?.manifest.version ?? '0.0.0',
      kind: kinds.get(name) ?? 'candidate',
      publishOrder: index + 1,
    };
  });
  return { items, errors };
}

/** Kahn's algorithm over the induced subgraph; ties break by name so output is stable. Null on a cycle. */
function sortDependenciesFirst(graph: DependencyGraph, names: readonly string[]): string[] | null {
  const inSet = new Set(names);
  const remaining = new Map<string, Set<string>>();
  for (const name of names) {
    const deps = (graph.byName.get(name)?.dependsOn ?? []).filter(dep => inSet.has(dep) && dep !== name);
    remaining.set(name, new Set(deps));
  }
  const out: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([name]) => name)
      .toSorted();
    if (ready.length === 0) return null;
    for (const name of ready) {
      remaining.delete(name);
      out.push(name);
    }
    for (const deps of remaining.values()) for (const name of ready) deps.delete(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface PlanOrderOptions {
  readonly cwd: string;
  readonly config: ReleaseConfig;
  /** Packages to publish. */
  readonly seeds: readonly string[];
  readonly npmRunner?: NpmRunner;
}

/** Order for explicit seeds. Shared by `order` and `candidate`. */
export async function planOrder(options: PlanOrderOptions): Promise<ComputeOrderResult> {
  const { manifests } = await discoverManifests(options.cwd);
  const admitted = new Set(options.config.waves.flatMap(wave => wave.packages));
  return computeOrder({
    graph: buildDependencyGraph(manifests),
    seeds: options.seeds,
    admitted,
    lookup: npmVersionLookup(options.npmRunner ?? defaultNpmRunner, options.cwd),
  });
}

export interface RunOrderOptions {
  readonly cwd: string;
  readonly config: ReleaseConfig;
  readonly wave: string;
  readonly npmRunner?: NpmRunner;
}

export async function runOrder(options: RunOrderOptions): Promise<OrderEnvelope> {
  const wave = options.config.waves.find(w => w.id === options.wave);
  const errors: ReleaseError[] = [];
  let items: readonly OrderItem[] = [];
  if (wave === undefined) {
    errors.push({
      code: ORDER_ERROR_CODES.unknownWave,
      severity: 'error',
      message: `Wave \`${options.wave}\` is not in arki.release.config.ts.`,
      target: options.wave,
      remediation: `Use one of: ${options.config.waves.map(w => w.id).join(', ')}.`,
    });
  } else {
    const pending = await pendingPackages(options.cwd);
    errors.push(...pending.errors);
    const result = await planOrder({
      cwd: options.cwd,
      config: options.config,
      seeds: wave.packages.filter(name => pending.names.has(name)),
      npmRunner: options.npmRunner,
    });
    items = result.items;
    errors.push(...result.errors);
  }
  const failed = errors.some(e => e.severity === 'error');
  const publishedDeps = items.filter(i => i.kind === 'published-dep').length;
  return createEnvelope<OrderItem, OrderSummary>({
    command: 'order',
    status: failed ? 'failure' : 'success',
    summary: {
      message: failed
        ? `Release order for ${options.wave} failed (${errors.length.toString()} errors).`
        : `Release order for ${options.wave}: ${items.length.toString()} packages (${publishedDeps.toString()} missing dependencies).`,
      wave: options.wave,
      candidates: items.length - publishedDeps,
      publishedDeps,
    },
    items: [...items],
    errors,
  });
}

/** Package names with a pending changeset (any bump). Shared by `order` and `candidate`. */
export async function pendingPackages(
  rootCwd: string,
): Promise<{ readonly names: ReadonlySet<string>; readonly errors: readonly ReleaseError[] }> {
  const { changesets, errors } = await loadChangesets(rootCwd);
  return { names: bumpedPackages(changesets), errors };
}
