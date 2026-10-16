// Speed of @arki/schema's issue helpers against @standard-schema/utils, the
// helper package the Standard Schema authors publish.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Every group states a contract that is checked before timing; a library that
// returns a different answer is marked `differs` and shown without a ratio.

import { getDotPath, SchemaError as UtilsSchemaError } from '@standard-schema/utils';

import type { StandardSchemaV1 } from '@arki/schema';
import { compare, defineSuite } from '@arki/bench';
import { pathOf, SchemaError } from '@arki/schema';

const SIZES = [1, 100, 10_000];

/**
 * `n` issues, each with string keys, number keys and `{ key }` segments, the
 * mix Zod and Valibot report. No symbol keys: `getDotPath` returns `null` for them.
 */
function issuesOf(n: number): StandardSchemaV1.Issue[] {
  const issues: StandardSchemaV1.Issue[] = [];
  for (let index = 0; index < n; index++) {
    issues.push({ message: 'invalid', path: ['items', index, { key: 'name' }, { key: index % 3 }] });
  }
  return issues;
}

/** The dot path every issue of `issuesOf(n)` must give, written out independently. */
function dotPathsOf(n: number): string {
  const paths: string[] = [];
  for (let index = 0; index < n; index++) paths.push(`items.${index}.name.${index % 3}`);
  return paths.join('|');
}

/** The issues one validation failure reports, reused for every construction in the error group. */
const ERROR_ISSUES = issuesOf(3);

export default defineSuite({
  id: '@arki/schema',
  intro:
    'Speed of the `@arki/schema` issue helpers against `@standard-schema/utils`. Each table only ranks libraries that returned the same answer on every checked input.',
  notes: [
    '`@arki/schema`’s `SchemaError` message lists every issue with its path; the `@standard-schema/utils` one uses the first issue’s message only.',
  ],
  groups: [
    compare<number>({
      id: 'dot-path',
      title: 'Dot path of every issue',
      contract: {
        id: 'schema-dot-path/v1',
        description: 'for n issues, the dot path of each issue, joined with "|"',
      },
      inputs: SIZES,
      expected: dotPathsOf,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/schema',
          package: '@arki/schema',
          setup: issuesOf,
          run: issues => issues.map(issue => pathOf(issue).join('.')),
          normalize: paths => paths.join('|'),
        }),
        utils: c({
          label: '@standard-schema/utils',
          package: '@standard-schema/utils',
          setup: issuesOf,
          run: issues => issues.map(issue => getDotPath(issue)),
          normalize: paths => paths.join('|'),
        }),
      }),
    }),
    compare<number>({
      id: 'error',
      title: 'Construct a SchemaError from three issues',
      contract: {
        id: 'schema-error/v1',
        description: 'for n constructions, the total of error.issues.length',
      },
      inputs: SIZES,
      expected: n => n * ERROR_ISSUES.length,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/schema',
          package: '@arki/schema',
          run: n => {
            let total = 0;
            for (let index = 0; index < n; index++) total += new SchemaError(ERROR_ISSUES).issues.length;
            return total;
          },
        }),
        utils: c({
          label: '@standard-schema/utils',
          package: '@standard-schema/utils',
          run: n => {
            let total = 0;
            for (let index = 0; index < n; index++) total += new UtilsSchemaError(ERROR_ISSUES).issues.length;
            return total;
          },
        }),
      }),
    }),
  ],
});
