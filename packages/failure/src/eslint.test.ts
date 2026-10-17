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
declare function fetchTitle(id: string): Promise<string>;
declare const repo: { find(id: string): { title: string } | PostNotFound } | undefined;
`;

ruleTester.run('must-use', mustUse, {
  valid: [
    // Why: using the value is how the compiler forces the check.
    `${declarations} async function f() { const result = await remove('a'); return result; }`,
    `${declarations} function f() { return save('a'); }`,
    // Calls that cannot fail are not this rule's business.
    `${declarations} log('hello');`,
    // `void` on a call that cannot fail stays the usual way to drop a promise on purpose.
    `${declarations} function f() { void fetchTitle('a'); }`,
    // Waiting for plain work in parallel drops nothing that could be a failure.
    `${declarations} async function f() { await Promise.all([fetchTitle('a'), fetchTitle('b')]); }`,
    // A kept Promise.all result is checked by the compiler, like any other value.
    `${declarations} async function f() { const results = await Promise.all([remove('a'), remove('b')]); return results; }`,
    // The one deliberate discard left: a disable comment, which must say why. (The rule tester registers the rule as
    // `@rule-tester/must-use`; `configs.recommended` registers it as `failure/must-use`.)
    `${declarations} async function f() {
      // eslint-disable-next-line @rule-tester/must-use -- the post may already be gone, and either way we are done
      await remove('a');
    }`,
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
    {
      // `void` hides the failure just as well as a bare statement, so it no longer counts as handling it.
      code: `${declarations} async function f() { void (await remove('a')); }`,
      errors: [{ messageId: 'mustUse', data: { codes: '"post.not_found", "post.locked"' } }],
    },
    {
      code: `${declarations} function f() { void save('a'); }`,
      errors: [{ messageId: 'mustUse', data: { codes: '"post.not_found"' } }],
    },
    {
      // A discarded Promise.all of child commands hides each refusal, so the parent would go on and commit the rest.
      // The result is a tuple, not a union, so the rule looks at each item.
      code: `${declarations} async function f() { await Promise.all([remove('a'), fetchTitle('b')]); }`,
      errors: [{ messageId: 'mustUse', data: { codes: '"post.not_found", "post.locked"' } }],
    },
    {
      // Same over a mapped array, and without `await`: the failures are dropped either way.
      code: `${declarations} function f(ids: string[]) { Promise.all(ids.map(id => remove(id))); }`,
      errors: [{ messageId: 'mustUse', data: { codes: '"post.not_found", "post.locked"' } }],
    },
    {
      // allSettled reports rejections, but a failure is a fulfilled value: it sits in `value`, unread.
      code: `${declarations} async function f() { await Promise.allSettled([remove('a')]); }`,
      errors: [{ messageId: 'mustUse', data: { codes: '"post.not_found", "post.locked"' } }],
    },
    {
      // race returns one item's result, so the failure can come out of it and is dropped here.
      code: `${declarations} async function f() { void (await Promise.race([remove('a'), fetchTitle('b')])); }`,
      errors: [{ messageId: 'mustUse', data: { codes: '"post.not_found", "post.locked"' } }],
    },
  ],
});

describe('configs.recommended', () => {
  const linter = new TSESLint.Linter({ configType: 'flat' });
  const recommended = [plugin.configs.recommended];

  it('skips plain .js files, so a project-wide config does not crash on eslint.config.js, which has no type information', () => {
    expect(linter.verify('export default [];', recommended, 'eslint.config.js')).toEqual([]);
  });

  it('registers the rule as failure/must-use, the id the message tells people to disable', () => {
    expect(plugin.configs.recommended.rules).toEqual({ 'failure/must-use': 'error' });
    expect(mustUse.meta.messages.mustUse).toContain('eslint-disable-next-line failure/must-use -- <reason>');
  });

  it('still runs the type-aware rule on TypeScript files', () => {
    expect(() => linter.verify('export default [];', recommended, 'post.ts')).toThrow(/type information/);
  });
});
