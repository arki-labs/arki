import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { tanstackStartDot } from './tanstack-start.js';

const RULE = 'arki-tanstack-start/no-services';
const linter = new Linter();

/** Lint `code` as if it lived at `filename`; return the rule ids that fired. */
const ruleIds = (/** @type {string} */ filename, /** @type {string} */ code) =>
  linter
    .verify(
      code,
      [...tanstackStartDot(), { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser } }],
      { filename },
    )
    .map(m => m.ruleId);

const SERVER_FN = 'src/features/posts/publish.ts';

test('a server function reaching services skips the contract, so every way of reading them fails', () => {
  assert.deepEqual(ruleIds(SERVER_FN, `export const f = ({ context }) => context.services.posts.publish();`), [RULE]);
  assert.deepEqual(ruleIds(SERVER_FN, `export const f = ({ context }) => context['services'];`), [RULE]);
  assert.deepEqual(
    ruleIds(SERVER_FN, `export const f = ({ context }) => { const { services } = context; return services; };`),
    [RULE],
  );
  assert.deepEqual(ruleIds(SERVER_FN, `export const f = ({ context: { services } }) => services;`), [RULE]);
});

test('the contract is the door: context.rpc and the other context keys pass', () => {
  assert.deepEqual(ruleIds(SERVER_FN, `export const f = ({ data, context }) => context.rpc.posts.publish(data);`), []);
  assert.deepEqual(
    ruleIds(SERVER_FN, `export const f = async ({ context }) => [await context.session(), context.requestId];`),
    [],
  );
  assert.deepEqual(
    ruleIds('src/routes/posts/index.tsx', `export const loader = ({ context }) => context.queryClient;`),
    [],
  );
});

test('server routes under routes/api/ are the mounts, so they may read services', () => {
  assert.deepEqual(
    ruleIds('src/routes/api/webhooks/stripe.ts', `export const h = ({ context }) => context.services.billing;`),
    [],
  );
});

test('an object literal that merely has a services key is not a read', () => {
  assert.deepEqual(ruleIds(SERVER_FN, `export const f = (context) => ({ context: { services: [] } });`), []);
});

const PAGE_ROUTE = 'src/routes/unsubscribe.tsx';

test('a server route on a page path is a mount too, so its server.handlers may read services', () => {
  const code = `export const Route = createFileRoute('/unsubscribe')({
    server: { handlers: { GET: ({ context }) => context.services.digest, POST: ({ context: { services } }) => services } },
  });`;
  assert.deepEqual(ruleIds(PAGE_ROUTE, code), []);
});

test('a server function in that same route file still goes through the contract', () => {
  const code = `export const Route = createFileRoute('/unsubscribe')({ server: { handlers: { GET: () => new Response() } } });
  export const fn = createServerFn().handler(({ context }) => context.services.digest);
  export const other = { handlers: { GET: ({ context }) => context.services.digest } };`;
  assert.deepEqual(ruleIds(PAGE_ROUTE, code), [RULE, RULE]);
});
