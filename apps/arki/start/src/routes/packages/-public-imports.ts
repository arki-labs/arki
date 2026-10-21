import type { ApiIndex } from '@arki/library-tooling/api-index-schema';

/** Turns a snapshot's API index into the "public imports" list the package page shows. */

/** `.` → `@arki/dot`; `./cli` → `@arki/dot/cli`. */
function importPath(packageName: string, subpath: string): string {
  return subpath === '.' ? packageName : `${packageName}/${subpath.replace(/^\.\//, '')}`;
}

/**
 * One row per subpath, in first-seen order: its import path, its named exports, and its grouped exports (a group is
 * many names that share one type, listed as a count instead of one row per name).
 */
export function publicImports(index: ApiIndex) {
  const subpaths = [...new Set([...index.entries.map(e => e.subpath), ...index.groups.map(g => g.subpath)])];
  return subpaths.map(subpath => ({
    importPath: importPath(index.package, subpath),
    names: index.entries.filter(e => e.subpath === subpath).map(e => ({ name: e.name, kind: e.kind })),
    groups: index.groups
      .filter(g => g.subpath === subpath)
      .map(g => ({ kind: g.kind, signature: g.signature, count: g.count })),
  }));
}
