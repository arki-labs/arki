/** Reading the issues a schema reports, the same way for every validator. */
import type { StandardSchemaV1 } from './types.js';

/**
 * The path of an issue as plain keys: `{ key }` segments (Valibot writes
 * these) are unwrapped. Empty when the issue is about the whole value.
 */
export function pathOf(issue: StandardSchemaV1.Issue): readonly PropertyKey[] {
  if (issue.path === undefined) return [];
  // `Array.from`, not `.map`: ArkType's path is an Array subclass, and `.map` would return that subclass.
  return Array.from(issue.path, segment => (typeof segment === 'object' ? segment.key : segment));
}

/** One line for people: `"a.0.b: message; message"`. A root issue has no path prefix. */
export function formatIssues(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues
    .map(issue => {
      const path = pathOf(issue);
      return path.length === 0 ? issue.message : `${path.map(String).join('.')}: ${issue.message}`;
    })
    .join('; ');
}
