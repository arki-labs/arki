import { RuleTester } from '@typescript-eslint/rule-tester';
import { TSESLint } from '@typescript-eslint/utils';
import { afterAll, describe, expect, it } from 'vitest';

import plugin, { mustUse } from './eslint.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: true,
      // The fixture folder has its own tsconfig that includes the linted file name.
      tsconfigRootDir: new URL('__fixtures__', import.meta.url).pathname,
    },
  },
});

/** Failure types shaped like the real ones: the rule only looks at the `~failure` brand and `code`. */
const declarations = `
type PostNotFound = { readonly code: 'post.not_found'; readonly '~failure': true };
type Locked = { readonly code: 'post.locked'; readonly '~failure': true };
declare function remove(id: string): Promise<void | PostNotFound | Locked>;
declare function save(id: string): void | PostNotFound;
declare function log(text: string): void;
declare const repo: { find(id: string): { title: string } | PostNotFound } | undefined;
`;

ruleTester.run('must-use', mustUse, {
  valid: [
    // Why: using the value is how the compiler forces the check.
    `${declarations} async function f() { const result = await remove('a'); return result; }`,
    `${declarations} function f() { return save('a'); }`,
    // An explicit discard is a decision, not an accident.
    `${declarations} async function f() { void (await remove('a')); }`,
    `${declarations} function f() { void save('a'); }`,
    // Calls that cannot fail are not this rule's business.
    `${declarations} log('hello');`,
  ],
  invalid: [
    {
      // The headline bug: an awaited usecase whose failure is silently dropped.
      code: `${declarations} async function f() { await remove('a'); }`,
      errors: [{ messageId: 'mustUse', data: { codes: '"post.not_found", "post.locked"' } }],
    },
    {
      code: `${declarations} function f() { save('a'); }`,
      errors: [{ messageId: 'mustUse', data: { codes: '"post.not_found"' } }],
    },
    {
      // Not awaited either: the promise's failure is dropped too.
      code: `${declarations} function f() { remove('a'); }`,
      errors: [{ messageId: 'mustUse' }],
    },
    {
      code: `${declarations} function f() { repo?.find('a'); }`,
      errors: [{ messageId: 'mustUse' }],
    },
  ],
});

describe('configs.recommended', () => {
  const linter = new TSESLint.Linter({ configType: 'flat' });
  const recommended = [plugin.configs.recommended];

  it('skips plain .js files, so a project-wide config does not crash on eslint.config.js, which has no type information', () => {
    expect(linter.verify('export default [];', recommended, 'eslint.config.js')).toEqual([]);
  });

  it('still runs the type-aware rule on TypeScript files', () => {
    expect(() => linter.verify('export default [];', recommended, 'post.ts')).toThrow(/type information/);
  });
});
