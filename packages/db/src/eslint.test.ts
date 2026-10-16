import { RuleTester } from '@typescript-eslint/rule-tester';
import { TSESLint } from '@typescript-eslint/utils';
import { afterAll, describe, expect, it } from 'vitest';

import plugin, { noEffectsInTransaction } from './eslint.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: true,
      // The fixture folder has its own tsconfig (with the DOM lib, for `fetch`) that includes the linted file name.
      tsconfigRootDir: new URL('__fixtures__/lint', import.meta.url).pathname,
    },
  },
});

/** Shapes like the real ones: the rule reads the marker, and the names of the types that declare queue methods. */
const declarations = `
type Scope = { readonly tx: unknown; readonly repos: { accounts: { add(id: string): Promise<void> } }; readonly '~arkiTransaction': true };
type HandlerOptions = { context: Scope & { session: null }; input: { id: string } };
declare function transact(handler: (options: HandlerOptions) => Promise<unknown>): void;
declare class Queue { add(name: string, data: unknown): Promise<void>; addBulk(jobs: unknown[]): Promise<void> }
type JobDefinition<I> = { _type: 'job'; trigger: (data: I) => Promise<string> };
type QueueEnqueue = <I>(job: JobDefinition<I>, data: I) => Promise<string>;
type QueueClient = { readonly keyPrefix: string; enqueue: QueueEnqueue };
declare const queue: Queue;
declare const sendEmail: JobDefinition<{ to: string }>;
declare const client: QueueClient;
declare const journal: { effect(name: string): void };
`;

ruleTester.run('no-effects-in-transaction', noEffectsInTransaction, {
  valid: [
    // Why: outside a transaction a fetch runs once; it is not this rule's business.
    `${declarations} async function plain(id: string) { await fetch(id); await queue.add('a', {}); }`,
    // A local function named fetch is not the network.
    `${declarations} async function t(scope: Scope) { const fetch = (url: string) => url; fetch('x'); }`,
    // Set#add is not a queue write.
    `${declarations} function t(scope: Scope) { new Set<string>().add('x'); }`,
    // Database work through the bound repositories is what a transaction is for.
    `${declarations} async function t({ repos }: Scope) { await repos.accounts.add('a'); }`,
    // Limitations, documented, not claimed safe: a dynamic member name, an erased type, an SDK wrapper,
    // and a helper whose parameters do not carry the marker.
    `${declarations} async function t(scope: Scope, name: 'add' | 'addBulk') { await queue[name]('a', {} as never); }`,
    `${declarations} async function t(scope: Scope) { const q: { add(n: string, d: unknown): Promise<void> } = queue; await q.add('a', {}); }`,
    `${declarations} declare const stripe: { checkout: { sessions: { create(o: object): Promise<unknown> } } };
      async function t(scope: Scope) { await stripe.checkout.sessions.create({}); }`,
    `${declarations} const notify = () => fetch('x'); async function t(scope: Scope) { await notify(); }`,
  ],
  invalid: [
    {
      // The headline bug: a retried usecase calls an external API twice.
      code: `${declarations} async function transfer(scope: Scope) { await fetch('https://bank.example'); }`,
      errors: [{ messageId: 'effect', data: { what: '`fetch`' } }],
    },
    {
      code: `${declarations} async function t({ repos }: Scope) { await globalThis.fetch('x'); }`,
      errors: [{ messageId: 'effect', data: { what: '`fetch`' } }],
    },
    {
      code: `${declarations} const send = fetch; async function t(scope: Scope) { await send('x'); }`,
      errors: [{ messageId: 'effect', data: { what: '`fetch`' } }],
    },
    {
      // A handler after `.use(transact)`: the marker sits on its context.
      code: `${declarations} transact(async ({ context, input }) => { await fetch(input.id); return context.tx; });`,
      errors: [{ messageId: 'effect', data: { what: '`fetch`' } }],
    },
    {
      code: `${declarations} async function t(scope: Scope) { await queue.add('a', {}); await queue.addBulk([]); }`,
      errors: [
        { messageId: 'effect', data: { what: '`Queue#add`' } },
        { messageId: 'effect', data: { what: '`Queue#addBulk`' } },
      ],
    },
    {
      // Through an alias, destructuring, a string-literal member and an optional call.
      code: `${declarations} async function t(scope: Scope) {
        const q = queue; await q.add('a', {});
        const { add } = queue; await add('a', {});
        await queue['add']('a', {});
        await queue?.add('a', {});
      }`,
      errors: [{ messageId: 'effect' }, { messageId: 'effect' }, { messageId: 'effect' }, { messageId: 'effect' }],
    },
    {
      code: `${declarations} async function t(scope: Scope) { await sendEmail.trigger({ to: 'a' }); await client.enqueue(sendEmail, { to: 'a' }); }`,
      errors: [
        { messageId: 'effect', data: { what: '`JobDefinition#trigger`' } },
        { messageId: 'effect', data: { what: '`QueueClient#enqueue`' } },
      ],
    },
    {
      code: `${declarations} function t(scope: Scope) { journal.effect('notify'); }`,
      errors: [{ messageId: 'effect', data: { what: '`.effect()`' } }],
    },
    {
      // A callback nested inside the transaction runs inside it too.
      code: `${declarations} function t(scope: Scope) { [1, 2].forEach(() => { void fetch('x'); }); }`,
      errors: [{ messageId: 'effect' }],
    },
  ],
});

describe('db/no-effects-in-transaction without type information', () => {
  it('fails loudly instead of passing silently', () => {
    const linter = new TSESLint.Linter({ configType: 'flat' });
    expect(() =>
      linter.verify('fetch("x");', [{ files: ['**/*.js'], ...plugin.configs.recommended }], 'file.js'),
    ).toThrow(/type information|parserServices/);
  });
});
