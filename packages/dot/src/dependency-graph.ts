/**
 * Topological sort + cycle detection for pip dependencies.
 *
 * Internal to the kernel. Tests must reach it through `defineApp(...)`, never
 * directly.
 */

import type { AnyDotPip } from './pip-contract.js';
import { DotLifecycleError, DotLifecycleErrorCode } from './lifecycle.js';
import { pipDependencies } from './pip-contract.js';

/**
 * Sort pips so that every pip appears after the pips it depends on.
 *
 * @throws {DotLifecycleError}
 *   - `DOT_LIFECYCLE_E009` if the dependency graph contains a cycle.
 *   - `DOT_LIFECYCLE_E010` if a declared dependency isn't registered.
 *   - `DOT_LIFECYCLE_E011` if the same pip name appears twice.
 */
export function topologicalSort(pips: readonly AnyDotPip[]): readonly AnyDotPip[] {
  const byName = new Map<string, AnyDotPip>();
  for (const pip of pips) {
    if (byName.has(pip.name)) {
      throw new DotLifecycleError({
        code: DotLifecycleErrorCode.DuplicatePip,
        phase: 'configure',
        pip: pip.name,
        message: `Pip "${pip.name}" is registered twice`,
      });
    }
    byName.set(pip.name, pip);
  }

  const sorted: AnyDotPip[] = [];
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
        pip: name,
        message: `Dependency cycle detected: ${cyclePath}`,
      });
    }

    const pip = byName.get(name);
    if (!pip) {
      throw new DotLifecycleError({
        code: DotLifecycleErrorCode.MissingDependency,
        phase: 'configure',
        pip: name,
        message: `Pip "${name}" is required as a dependency but is not registered`,
      });
    }

    temporary.add(name);
    stack.push(name);

    for (const dep of pipDependencies(pip)) {
      visit(dep);
    }

    stack.pop();
    // eslint-disable-next-line drizzle/enforce-delete-with-where -- `temporary` is a JS Set, not a Drizzle query.
    temporary.delete(name);
    permanent.add(name);
    sorted.push(pip);
  };

  for (const name of byName.keys()) {
    visit(name);
  }

  return sorted;
}

/** Reverse a sorted pip array — used for `stop` and `dispose` ordering. */
export function reverseTopologicalSort(pips: readonly AnyDotPip[]): readonly AnyDotPip[] {
  // eslint-disable-next-line unicorn/no-array-reverse -- lib target is ES2022, toReversed is ES2023.
  return [...pips].reverse();
}

/** Build the list of dependency edges for the manifest. */
export function buildDependencyEdges(
  pips: readonly AnyDotPip[],
): readonly { from: string; to: string; kind: 'requires' }[] {
  const edges: { from: string; to: string; kind: 'requires' }[] = [];
  for (const pip of pips) {
    for (const dep of pipDependencies(pip)) {
      edges.push({ from: pip.name, to: dep, kind: 'requires' });
    }
  }
  return edges;
}
