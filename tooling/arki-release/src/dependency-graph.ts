/**
 * Build an in-memory dependency graph of `@arki/*` workspace packages.
 *
 * The graph is used by the inventory command (Task 2) to detect when a
 * public-candidate package depends on a still-private ARKI package — the
 * classic "you can't publish A without first publishing B" failure mode.
 *
 * Scope is intentionally narrow:
 *
 *   - Only `dependencies`, `peerDependencies`, and `optionalDependencies`
 *     are considered. `devDependencies` are not part of the publish
 *     surface and would create false positives.
 *   - Only `workspace:`-prefixed versions are graph edges. Catalog
 *     references and concrete npm versions are resolved later by Task 3.
 *   - Only `@arki/*` package names are graph nodes. Third-party deps are
 *     not modelled here.
 */

import type { ParsedManifest } from './inventory';

/** A package node in the workspace dependency graph. */
export interface DependencyNode {
  readonly name: string;
  readonly manifest: ParsedManifest;
  /** Names of other `@arki/*` packages this node depends on at publish time. */
  readonly dependsOn: readonly string[];
}

/**
 * The materialized dependency graph. Keyed by package name for O(1)
 * lookup; downstream code iterates either the map or the topologically
 * stable insertion order via {@link DependencyGraph.nodes}.
 */
export interface DependencyGraph {
  readonly nodes: readonly DependencyNode[];
  /** O(1) lookup by package name. */
  readonly byName: ReadonlyMap<string, DependencyNode>;
}

/** Marker for workspace-protocol versions: `workspace:`, `workspace:*`, etc. */
const WORKSPACE_PREFIX = 'workspace:';

/**
 * Build a {@link DependencyGraph} from a list of parsed manifests.
 *
 * The graph only records edges between `@arki/*` workspace packages —
 * non-ARKI deps and catalog references are ignored here (Task 3 handles
 * catalog resolution; non-ARKI deps are out of scope for the inventory
 * blocker check).
 */
export function buildDependencyGraph(manifests: readonly ParsedManifest[]): DependencyGraph {
  const byName = new Map<string, DependencyNode>();
  const ordered: DependencyNode[] = [];

  // First pass — establish nodes so the second pass can ignore edges
  // pointing at packages outside the workspace.
  const knownNames = new Set<string>();
  for (const m of manifests) {
    knownNames.add(m.name);
  }

  for (const manifest of manifests) {
    const dependsOn = collectArkiWorkspaceDeps(manifest, knownNames);
    const node: DependencyNode = { name: manifest.name, manifest, dependsOn };
    byName.set(manifest.name, node);
    ordered.push(node);
  }

  return { nodes: ordered, byName };
}

/**
 * Extract `@arki/*` workspace-protocol deps from a parsed manifest.
 *
 * - Walks `dependencies`, `peerDependencies`, `optionalDependencies`.
 * - Keeps entries whose name starts with `@arki/` AND whose version
 *   starts with `workspace:`.
 * - Filters out names not present in `knownNames` (defensive — shouldn't
 *   happen in a well-formed monorepo, but skipping unknown nodes keeps
 *   the graph closed under traversal).
 *
 * The same dep may appear in multiple dep buckets; the result is
 * de-duplicated and order-stable.
 */
function collectArkiWorkspaceDeps(manifest: ParsedManifest, knownNames: ReadonlySet<string>): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  const buckets: ReadonlyArray<Readonly<Record<string, string>> | undefined> = [
    manifest.dependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ];

  for (const bucket of buckets) {
    if (bucket === undefined) continue;
    for (const [depName, depVersion] of Object.entries(bucket)) {
      if (!depName.startsWith('@arki/')) continue;
      if (typeof depVersion !== 'string' || !depVersion.startsWith(WORKSPACE_PREFIX)) continue;
      if (!knownNames.has(depName)) continue;
      if (seen.has(depName)) continue;
      seen.add(depName);
      ordered.push(depName);
    }
  }

  return ordered;
}

/**
 * Collect every `@arki/*` workspace package reachable from `root` via
 * `dependencies` / `peerDependencies` / `optionalDependencies` edges.
 *
 * Contract:
 *   - `root` itself is **never** included in the result, even when `root`
 *     reaches itself via a cycle. Callers asking "what does X depend on?"
 *     never want X in the answer.
 *   - Cycles are tolerated — a visited set prevents infinite recursion.
 *   - The returned order is the order packages were first reached during a
 *     depth-first walk; it is deterministic per input but is not a
 *     topological sort.
 *
 * Used by the inventory command to determine whether a public-candidate
 * pulls in any private packages anywhere in its dep chain.
 */
export function collectReachableArkiDeps(graph: DependencyGraph, root: string): readonly string[] {
  const visited = new Set<string>();
  const ordered: string[] = [];

  const stack: string[] = [root];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const node = graph.byName.get(next);
    if (node === undefined) continue;
    for (const dep of node.dependsOn) {
      if (dep === root) continue; // `root` itself is never included in the result.
      if (visited.has(dep)) continue;
      visited.add(dep);
      ordered.push(dep);
      stack.push(dep);
    }
  }
  return ordered;
}
