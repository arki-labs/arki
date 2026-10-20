import { RuleTester } from '@typescript-eslint/rule-tester';
import { TSESLint } from '@typescript-eslint/utils';
import { afterAll, describe, expect, it } from 'vitest';

import plugin, { mustUse, noBlindAccept } from './eslint.js';

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

/** Real definitions keep callback and persistence fixtures tied to the public failure contract. */
const callbackDeclarations = `
import { defineFailure, isFailure } from '../index.js';
const Refused = defineFailure('fixture.refused');
function persist() { return Refused(); }
declare function foreign(callback: () => void): void;
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
    `${declarations} let stored: ReturnType<typeof save>; stored = save('a');`,
    `${declarations} declare function envelope(): { value: PostNotFound }; envelope();`,
    `${declarations} declare function plainStream(): AsyncIterable<string>; plainStream()[Symbol.asyncIterator]().next();`,
    `${callbackDeclarations} foreign(() => { const result = persist(); if (isFailure(result)) return; });`,
    `${callbackDeclarations} declare function retained<T>(callback: () => T): T; function f() { return retained(() => persist()); }`,
    `${callbackDeclarations} async function checkpoint() { return persist(); } async function workflow() { const written = await checkpoint(); if (isFailure(written)) return written; return 'checkpointed'; }`,
    `${callbackDeclarations} async function* stream() { yield persist(); } async function f() { const item = await stream().next(); if (!item.done && isFailure(item.value)) return item.value; }`,
    `${callbackDeclarations} async function middleware(next: () => Promise<ReturnType<typeof Refused>>) { return next(); }`,
    // The one deliberate discard left: a disable comment, which must say why. (The rule tester registers the rule as
    // `@rule-tester/must-use`; `configs.recommended` registers it as `failure/must-use`.)
    `${declarations} async function f() {
      // eslint-disable-next-line @rule-tester/must-use -- the post may already be gone, and either way we are done
      await remove('a');
    }`,
  ],
  invalid: [
    {
      // Schema failures now require the same check as domain failures.
      code: `import { parse } from '../schema.js'; import { z } from 'zod'; parse(z.string(), 42);`,
      errors: [{ messageId: 'mustUse' }],
    },
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
    ...[
      `await (void remove('a'));`,
      `void (void save('a'));`,
      `true && save('a');`,
      `true ? save('a') : save('b');`,
      `await Promise['all']([remove('a')]);`,
      `const all = Promise.all.bind(Promise); await all([remove('a')]);`,
      `async function collect() { return Promise.all([remove('a')]); } await collect();`,
      `const pending = Promise.all([remove('a')]); await pending;`,
      `await Promise.all([Promise.all([remove('a')])]);`,
      `await Promise['allSettled']([remove('a')]);`,
      `declareStream()[Symbol.asyncIterator]().next();`,
      `async function read() { return declareStream()[Symbol.asyncIterator]().next(); } await read();`,
      `const pending = declareStream()[Symbol.asyncIterator]().next(); await pending;`,
    ].map(body => ({
      // A different expression spelling or a forwarding helper must not hide the same refusal.
      code: `${declarations}
        declare function declareStream(): AsyncIterable<string | PostNotFound>;
        async function f() { ${body} }`,
      errors: [{ messageId: 'mustUse' as const }],
    })),
    ...[
      `foreign(() => persist());`,
      `foreign(() => { return persist(); });`,
      `foreign(persist);`,
      `foreign(async () => persist());`,
      `[1].forEach(() => persist());`,
      `const checkpoint: () => void = () => persist();`,
      `const checkpoint: () => void = persist;`,
      `let checkpoint: () => void; checkpoint = persist;`,
      `declare function hooks(options: { onClose: () => void }): void; hooks({ onClose: persist });`,
      `function workflow(checkpoint: () => void = persist) { checkpoint(); }`,
      `function workflow({ checkpoint = persist }: { checkpoint?: () => void }) { checkpoint(); }`,
    ].map(body => ({
      // A void callback boundary silently erases a persistence refusal that still must be handled.
      code: `${callbackDeclarations} ${body}`,
      errors: [{ messageId: 'callbackReturn' as const }],
    })),
    ...[
      `async function checkpoint() { return persist(); } async function workflow() { await checkpoint(); }`,
      `async function* stream() { yield persist(); } async function f() { await stream().next(); }`,
      `async function middleware(next: () => Promise<ReturnType<typeof Refused>>) { await next(); }`,
    ].map(body => ({
      // Persistence, streams and owned middleware must keep the same canonical refusal at the caller.
      code: `${callbackDeclarations} ${body}`,
      errors: [{ messageId: 'mustUse' as const }],
    })),
  ],
});

/**
 * A command that runs a child which can refuse with two kinds, the way `@arki/journal` hands them back.
 * `OutOfStock.is` and `Busy.is` narrow to one code each; `isFailure` narrows to every failure in the value.
 */
const acceptDeclarations = `
type Brand = { readonly '~failure': true };
type OutOfStock = { readonly code: 'stock.out' } & Brand;
type Busy = { readonly code: 'stock.busy' } & Brand;
type AnyFailure = { readonly code: string } & Brand;
type Reserved = { readonly reserved: number };
declare const OutOfStock: { is(value: unknown): value is OutOfStock };
declare const Busy: { is(value: unknown): value is Busy };
declare function isFailure<Value>(value: Value): value is Extract<Value, Brand>;
declare function isRefusal(value: unknown): value is AnyFailure;
declare function reserve(): Promise<Reserved | OutOfStock | Busy>;
declare function reserveAny(): Promise<Reserved | AnyFailure>;
declare function reserveOne(): Promise<Reserved | OutOfStock>;
declare function accept(failure: AnyFailure): void;
declare function handled(failure: AnyFailure): void;
declare const ctx: { accept(failure: AnyFailure): void };
declare const dialog: { accept(text?: string): void };
`;

ruleTester.run('no-blind-accept', noBlindAccept, {
  valid: [
    // Why: the intended use. The handler checked this one kind, so only this refusal may let the command commit.
    `${acceptDeclarations} async function f() { const r = await reserve(); if (OutOfStock.is(r)) { accept(r); return 0; } return r; }`,
    `${acceptDeclarations} async function f() { const r = await reserve(); if (OutOfStock.is(r)) ctx.accept(r); return r; }`,
    // Each kind is checked by name, so a code the child adds later is still not accepted.
    `${acceptDeclarations} async function f() { const r = await reserve(); if (OutOfStock.is(r) || Busy.is(r)) accept(r); return r; }`,
    // Checked kinds plus an extra condition are still those kinds.
    `${acceptDeclarations} async function f(retry: boolean) { const r = await reserve(); if ((OutOfStock.is(r) || Busy.is(r)) && retry) accept(r); return r; }`,
    `${acceptDeclarations} async function f() { const r = await reserve(); if (isFailure(r) && (r.code === 'stock.out' || r.code === 'stock.busy')) accept(r); return r; }`,
    // The kinds are checked in a nested condition: the nearest condition about r decides, not the outer isFailure.
    `${acceptDeclarations} async function f() { const r = await reserve(); if (isFailure(r)) { if (OutOfStock.is(r) || Busy.is(r)) accept(r); } return r; }`,
    // A wide failure narrowed by a definition's .is is one known kind.
    `${acceptDeclarations} async function f() { const r = await reserveAny(); if (OutOfStock.is(r)) accept(r); return r; }`,
    // Another API's accept takes no failure, so it is not this rule's business.
    `${acceptDeclarations} dialog.accept('yes'); dialog.accept();`,
    // With custom names, plain accept is someone else's function.
    {
      code: `${acceptDeclarations} async function f() { const r = await reserve(); if (isFailure(r)) accept(r); return r; }`,
      options: [{ names: ['handled'] }],
    },
    `${acceptDeclarations} async function f() { const r = await reserveOne(); if (OutOfStock.is(r)) accept(r); return r; }`,
    `${acceptDeclarations} async function f() { const r = await reserveOne(); if (!OutOfStock.is(r)) return r; accept(r); }`,
    `${acceptDeclarations} async function f() { const r = await reserve(); if (!(OutOfStock.is(r) || Busy.is(r))) return r; accept(r); }`,
    `${callbackDeclarations} declare function accept(value: ReturnType<typeof Refused>): void; accept(Refused());`,
    `${acceptDeclarations} async function f() { const r = await reserve(); let { accept: allow } = ctx; allow = () => {}; if (isFailure(r)) allow(r); }`,
  ],
  invalid: [
    {
      // The headline bug: isFailure accepts every refusal, so a refusal the handler never thought about commits too.
      code: `${acceptDeclarations} async function f() { const r = await reserve(); if (isFailure(r)) accept(r); return r; }`,
      errors: [{ messageId: 'noBlindAccept', data: { name: 'accept' } }],
    },
    ...[
      `const r = await reserveOne(); if (isFailure(r)) accept(r);`,
      `const r = await reserveOne(); if (!isFailure(r)) return r; accept(r);`,
      `const r = await reserveOne(); if (!isFailure(r)) { return r; } const alias = r; accept(alias);`,
      `const r = await reserveOne(); if (isFailure(r)) { const alias = r; accept(alias); }`,
      `const r = await reserve(); const allow = accept; if (isFailure(r)) allow(r);`,
      `const r = await reserve(); const { accept: allow } = ctx; if (isFailure(r)) allow(r);`,
      `const r = await reserve(); if (isFailure(r)) ctx['accept'](r);`,
      `const r = await reserve(); const allow = ctx.accept; if (isFailure(r)) allow(r);`,
    ].map(body => ({
      // Adding a new refusal later must not make an earlier blind acceptance silently commit it.
      code: `${acceptDeclarations} async function f() { ${body} }`,
      errors: [{ messageId: 'noBlindAccept' as const, data: { name: 'accept' } }],
    })),
    {
      code: `${callbackDeclarations} import { accept as allow } from './accept.js'; const r = persist(); if (isFailure(r)) allow(r);`,
      errors: [{ messageId: 'noBlindAccept', data: { name: 'accept' } }],
    },
    {
      // Same through the context, the way a journal handler writes it.
      code: `${acceptDeclarations} async function f() { const r = await reserve(); if (isFailure(r)) { ctx.accept(r); } return r; }`,
      errors: [{ messageId: 'noBlindAccept', data: { name: 'accept' } }],
    },
    {
      // A failure with a wide code (string) can be any refusal at all.
      code: `${acceptDeclarations} async function f() { const r = await reserveAny(); if (isFailure(r)) accept(r); return r; }`,
      errors: [{ messageId: 'noBlindAccept' }],
    },
    {
      // No check at all: r may not even be a failure.
      code: `${acceptDeclarations} async function f() { const r = await reserve(); accept(r); return r; }`,
      errors: [{ messageId: 'noBlindAccept' }],
    },
    {
      // Unchecked with one failure kind: r may still be the success.
      code: `${acceptDeclarations} async function f() { const r = await reserveOne(); accept(r); return r; }`,
      errors: [{ messageId: 'noBlindAccept' }],
    },
    {
      // One checked kind next to a blind check is still blind.
      code: `${acceptDeclarations} async function f() { const r = await reserve(); if (OutOfStock.is(r) || isFailure(r)) accept(r); return r; }`,
      errors: [{ messageId: 'noBlindAccept' }],
    },
    {
      // A hand-written guard that is not generic but names no single kind is as blind as isFailure.
      code: `${acceptDeclarations} async function f() { const r = await reserve(); if (isRefusal(r)) accept(r); return r; }`,
      errors: [{ messageId: 'noBlindAccept' }],
    },
    {
      // With custom names, the rule checks those calls instead, and names them in the message.
      code: `${acceptDeclarations} async function f() { const r = await reserve(); if (isFailure(r)) handled(r); return r; }`,
      options: [{ names: ['handled'] }],
      errors: [{ messageId: 'noBlindAccept', data: { name: 'handled' } }],
    },
  ],
});

describe('configs.recommended', () => {
  const linter = new TSESLint.Linter({ configType: 'flat' });
  const recommended = [plugin.configs.recommended];

  it('skips plain .js files, so a project-wide config does not crash on eslint.config.js, which has no type information', () => {
    expect(linter.verify('export default [];', recommended, 'eslint.config.js')).toEqual([]);
  });

  it('registers the rules as failure/*, the id the must-use message tells people to disable', () => {
    expect(plugin.configs.recommended.rules).toEqual({
      'failure/must-use': 'error',
      'failure/no-blind-accept': 'error',
    });
    expect(mustUse.meta.messages.mustUse).toContain('eslint-disable-next-line failure/must-use -- <reason>');
  });

  it('still runs the type-aware rule on TypeScript files', () => {
    expect(() => linter.verify('export default [];', recommended, 'post.ts')).toThrow(/type information/);
  });
});
