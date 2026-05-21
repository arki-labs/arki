/**
 * Topological sort + cycle detection for plugin dependencies.
 *
 * Internal to the kernel. Tests must reach it through `defineApp(...)`, never
 * directly.
 */

import type { AnyDotPlugin } from './plugin-contract.js';
import { DotLifecycleError, DotLifecycleErrorCode } from './lifecycle.js';
import { pluginDependencies } from './plugin-contract.js';

/**
 * Sort plugins so that every plugin appears after the plugins it depends on.
 *
 * @throws {DotLifecycleError}
 *   - `DOT_LIFECYCLE_E009` if the dependency graph contains a cycle.
 *   - `DOT_LIFECYCLE_E010` if a declared dependency isn't registered.
 *   - `DOT_LIFECYCLE_E011` if the same plugin name appears twice.
 */
export function topologicalSort(plugins: readonly AnyDotPlugin[]): readonly AnyDotPlugin[] {
  const byName = new Map<string, AnyDotPlugin>();
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) {
      throw new DotLifecycleError({
        code: DotLifecycleErrorCode.DuplicatePlugin,
        phase: 'configure',
        plugin: plugin.name,
        message: `Plugin "${plugin.name}" is registered twice`,
      });
    }
    byName.set(plugin.name, plugin);
  }

  const sorted: AnyDotPlugin[] = [];
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const stack: string[] = [];

  const visit = (name: string): void => {
    if (permanent.has(name)) return;
    if (temporary.has(name)) {
      const cyclePath = [...stack.slice(stack.indexOf(name)), name].join(' -> ');
      throw new DotLifecycleError({
        code: DotLifecycleErrorCode.DependencyCycle,
        phase: 'configure',
        plugin: name,
        message: `Dependency cycle detected: ${cyclePath}`,
      });
    }

    const plugin = byName.get(name);
    if (!plugin) {
      throw new DotLifecycleError({
        code: DotLifecycleErrorCode.MissingDependency,
        phase: 'configure',
        plugin: name,
        message: `Plugin "${name}" is required as a dependency but is not registered`,
      });
    }

    temporary.add(name);
    stack.push(name);

    for (const dep of pluginDependencies(plugin)) {
      visit(dep);
    }

    stack.pop();
    // eslint-disable-next-line drizzle/enforce-delete-with-where -- `temporary` is a JS Set, not a Drizzle query.
    temporary.delete(name);
    permanent.add(name);
    sorted.push(plugin);
  };

  for (const name of byName.keys()) {
    visit(name);
  }

  return sorted;
}

/** Reverse a sorted plugin array — used for `stop` and `dispose` ordering. */
export function reverseTopologicalSort(plugins: readonly AnyDotPlugin[]): readonly AnyDotPlugin[] {
  // eslint-disable-next-line unicorn/no-array-reverse -- lib target is ES2022, toReversed is ES2023.
  return [...plugins].reverse();
}

/** Build the list of dependency edges for the manifest. */
export function buildDependencyEdges(
  plugins: readonly AnyDotPlugin[],
): readonly { from: string; to: string; kind: 'requires' }[] {
  const edges: { from: string; to: string; kind: 'requires' }[] = [];
  for (const plugin of plugins) {
    for (const dep of pluginDependencies(plugin)) {
      edges.push({ from: plugin.name, to: dep, kind: 'requires' });
    }
  }
  return edges;
}
