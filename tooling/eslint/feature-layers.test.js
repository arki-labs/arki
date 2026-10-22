import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { featureLayers } from './feature-layers.js';

const NEW_RULE = 'arki-feature-layers/usecase-runtime-imports';
const BACK = 'arki-feature-layers/feature-runtime-imports';
const RESTRICT = 'no-restricted-imports';
const CALLS_USECASES = 'arki-feature-layers/procedures-call-usecases';
const INFRA = 'arki-feature-layers/infra-runtime-imports';
const BOUNDARY = 'arki-feature-layers/feature-boundaries';
const SIBLING = 'arki-feature-layers/sibling-imports';
const DS = 'arki-feature-layers/domain-service-imports';
const BARREL = 'arki-feature-layers/no-table-barrel';

const linter = new Linter();

/** Lint `code` as if it lived at `filename`; return the rule ids that fired. */
const ruleIds = (/** @type {string} */ filename, /** @type {string} */ code, /** @type {string[]} */ clients = []) =>
  linter
    .verify(code, [...featureLayers({ root: process.cwd(), clients }), { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }], { filename })
    .map((m) => m.ruleId);

const USECASE = 'src/features/demo/usecases/run.ts';
const PROCEDURES = 'src/features/demo/entrypoints/procedures.ts';

test('contracts ship to the browser, so importing outside their vocabulary fails', () => {
  assert.deepEqual(ruleIds('src/features/demo/entrypoints/rpc.ts', `import { x } from '../usecases/run';`), [RESTRICT]);
  assert.deepEqual(ruleIds('src/features/demo/entrypoints/rpc.ts', `import { z } from 'zod'; import { m } from '../model/m';`), []);
});

test('a contract declares canonical failures and their RPC map without importing an exception bridge', () => {
  assert.deepEqual(ruleIds('src/features/demo/entrypoints/rpc.ts', `import { errorMap } from '@arki/failure/orpc';`), []);
  assert.deepEqual(ruleIds('src/features/demo/entrypoints/rpc.ts', `import { defineFailure, SCHEMA_FAILURES } from '@arki/failure';`), []);
  assert.deepEqual(ruleIds('src/features/demo/entrypoints/rpc.ts', `import { orThrow } from '@arki/failure';`), [RESTRICT]);
  assert.deepEqual(ruleIds('src/features/demo/entrypoints/rpc.ts', `import { orThrow as unwrap } from '@arki/failure';`), [RESTRICT]);
});

test('contracts may annotate browser-safe actions, canonical failures and MCP policy without importing executors', () => {
  const contractFile = 'src/features/demo/entrypoints/rpc.ts';
  for (const source of ['@arki/dot/action', '@arki/auth', '@arki/db/errors', '@arki/mcp/contract']) {
    assert.deepEqual(ruleIds(contractFile, `import { x } from '${source}';`), []);
  }
  for (const source of ['@arki/dot/execute', '@arki/auth/http', '@arki/db/orpc', '@arki/db/transaction', '@arki/mcp']) {
    assert.deepEqual(ruleIds(contractFile, `import { x } from '${source}';`), [RESTRICT]);
  }
});

test('model is the inside layer: it never imports usecases', () => {
  assert.deepEqual(ruleIds('src/features/demo/model/x.ts', `import { y } from '../usecases/y';`), [RESTRICT]);
});

test('model holds no database runtime', () => {
  assert.deepEqual(ruleIds('src/features/demo/model/x.ts', `import { sql } from 'drizzle-orm';`), [RESTRICT]);
});

test('model/tables.ts is where tables are declared, so pg-core is allowed', () => {
  assert.deepEqual(ruleIds('src/features/demo/model/tables.ts', `import { pgTable } from 'drizzle-orm/pg-core';`), []);
});

test('model/relations.ts declares a relations part, so @arki/db/orm is allowed (feature and app model)', () => {
  assert.deepEqual(ruleIds('src/features/demo/model/relations.ts', `import { defineRelationsPart } from '@arki/db/orm';`), []);
  assert.deepEqual(ruleIds('src/model/auth/relations.ts', `import { defineRelationsPart } from '@arki/db/orm';`), []);
});

test('a usecase does not know how it is called: no entrypoints import', () => {
  assert.deepEqual(ruleIds(USECASE, `import { c } from '../entrypoints/rpc';`), [RESTRICT]);
});

test('a usecase may not runtime-import infra: dependencies come from the graph', () => {
  assert.deepEqual(ruleIds(USECASE, `import { store } from '../infra/store';`), [NEW_RULE]);
});

test('import type of infra is allowed: it vanishes at build time', () => {
  assert.deepEqual(ruleIds(USECASE, `import type { store } from '../infra/store';`), []);
});

test('inline type specifiers are also type-only', () => {
  assert.deepEqual(ruleIds(USECASE, `import { type store } from '../infra/store';`), []);
  assert.deepEqual(ruleIds(USECASE, `import { type a, b } from '../infra/store';`), [NEW_RULE]);
});

test('a usecase may not reach the app database module', () => {
  assert.deepEqual(ruleIds(USECASE, `import { database } from '../../../db';`), [NEW_RULE]);
});

test('a usecase may not run drizzle queries itself', () => {
  assert.deepEqual(ruleIds(USECASE, `import { sql } from 'drizzle-orm';`), [NEW_RULE]);
});

test('a usecase may not import the app core oRPC module', () => {
  assert.deepEqual(ruleIds(USECASE, `import { ORPCError } from '../../../core/orpc';`), [NEW_RULE]);
});

test('re-exports are runtime imports too', () => {
  assert.deepEqual(ruleIds(USECASE, `export { x } from '../infra/x';`), [NEW_RULE]);
  assert.deepEqual(ruleIds(USECASE, `export * from '../infra/x';`), [NEW_RULE]);
  assert.deepEqual(ruleIds(USECASE, `export type { x } from '../infra/x';`), []);
});

test('side-effect and dynamic imports are runtime imports', () => {
  assert.deepEqual(ruleIds(USECASE, `import '../infra/x';`), [NEW_RULE]);
  assert.deepEqual(ruleIds(USECASE, `export const f = async () => import('../infra/x');`), [NEW_RULE]);
});

test('app-specific clients must come through the graph, but their types are fine', () => {
  assert.deepEqual(ruleIds(USECASE, `import Stripe from 'stripe';`, ['^stripe$']), [NEW_RULE]);
  assert.deepEqual(ruleIds(USECASE, `import type Stripe from 'stripe';`, ['^stripe$']), []);
  assert.deepEqual(ruleIds(USECASE, `import Stripe from 'stripe';`), []);
});

test('the oRPC server belongs to the entrypoints and the core, not usecases', () => {
  assert.deepEqual(ruleIds(USECASE, `import { os } from '@orpc/server';`).sort(), [NEW_RULE, RESTRICT].sort());
});

test('a procedure never builds its own oRPC implementer', () => {
  assert.deepEqual(ruleIds(PROCEDURES, `import { os } from '@orpc/server';`), [RESTRICT]);
});

test('app-level code outside the core may not import @orpc/server', () => {
  assert.deepEqual(ruleIds('src/other.ts', `import { os } from '@orpc/server';`), [RESTRICT]);
  assert.deepEqual(ruleIds('src/core/orpc.ts', `import { os } from '@orpc/server';`), []);
});

test('the cron contract (cron.ts) is app core: it builds its own implementer', () => {
  assert.deepEqual(ruleIds('src/cron.ts', `import { implement } from '@orpc/server';`), []);
});

test('a usecase or a procedure may not runtime-import its feature.ts: feature.ts imports them, so that is a cycle', () => {
  assert.deepEqual(ruleIds(USECASE, `import { demoLogic } from '../feature';`), [BACK]);
  assert.deepEqual(ruleIds(PROCEDURES, `import { rpcImplementer } from '../feature';`), [BACK]);
  assert.deepEqual(ruleIds(PROCEDURES, `import { rpcImplementer } from '../feature.js';`), [BACK]);
});

test('import type of Deps / rpcImplementer from feature.ts is fine: it vanishes at build time', () => {
  assert.deepEqual(ruleIds(USECASE, `import type { Deps } from '../feature';`), []);
  assert.deepEqual(ruleIds(PROCEDURES, `import type { rpcImplementer } from '../feature';`), []);
  // Another feature's feature.ts is not this rule's business (cross-feature imports go through handles).
  assert.deepEqual(ruleIds(USECASE, `import type { Deps } from '../other-feature';`), []);
});

test('tests may wire infra directly, so they are ignored', () => {
  assert.deepEqual(ruleIds('src/features/demo/usecases/__tests__/a.test.ts', `import { store } from '../../infra/store';`), []);
});

test('a procedure calls a usecase: reading context.repos fails, in every spelling', () => {
  const leaf = (/** @type {string} */ body) => `export const p = { a: (impl) => impl.a.handler(${body}) };`;
  assert.deepEqual(ruleIds(PROCEDURES, leaf(`({ context }) => context.repos.push.find()`)), [CALLS_USECASES]);
  assert.deepEqual(ruleIds(PROCEDURES, leaf(`({ context }) => context['repos'].push.find()`)), [CALLS_USECASES]);
  assert.deepEqual(ruleIds(PROCEDURES, leaf(`({ context }) => { const { repos } = context; return repos.push.find(); }`)), [CALLS_USECASES]);
  assert.deepEqual(ruleIds(PROCEDURES, leaf(`({ context: { repos } }) => repos.push.find()`)), [CALLS_USECASES]);
});

test('a procedure that calls context.usecases is fine', () => {
  const code = `export const p = { a: (impl) => impl.a.handler(({ context }) => context.usecases.find(context.session.user.id)) };`;
  assert.deepEqual(ruleIds(PROCEDURES, code), []);
  // A key named repos in an object LITERAL is not a read.
  assert.deepEqual(ruleIds(PROCEDURES, `const x = { context: { repos: 1 } };`), []);
});

test('a procedure may not runtime-import infra; import type is fine', () => {
  assert.deepEqual(ruleIds(PROCEDURES, `import { store } from '../infra/store';`), [CALLS_USECASES]);
  assert.deepEqual(ruleIds(PROCEDURES, `import type { Row } from '../infra/repository';`), []);
});

test('usecases may read repos: the procedures rule only covers entrypoints/procedures.ts', () => {
  assert.deepEqual(ruleIds(USECASE, `export const f = ({ repos }) => () => repos.push.find();`), []);
});

test('an infra plugin names the handles it needs, but never imports its own feature.ts (a cycle) or inner layers', () => {
  const store = 'src/features/demo/infra/store.ts';
  // The app's adapters and other features' chain files hold the handles a plugin binds in `needs`.
  assert.deepEqual(ruleIds(store, `import { database } from '../../../db';`), []);
  assert.deepEqual(ruleIds(store, `import { cache } from '../../../kv';`), []);
  assert.deepEqual(ruleIds(store, `import type { Database } from '../../../db';`), []);
  // Another feature is the domain: infra never depends on it (D9). Its output comes through .needs().
  assert.deepEqual(ruleIds(store, `import { otherLogic } from '../../other/feature';`), [INFRA]);
  assert.deepEqual(ruleIds(store, `import type { Repos } from '../../other/feature';`), []);
  // Its own feature.ts imports it: a value import back is a module cycle.
  assert.deepEqual(ruleIds(store, `import { demoLogic } from '../feature';`), [INFRA]);
  assert.deepEqual(ruleIds(store, `import type { Deps } from '../feature';`), []);
  assert.deepEqual(ruleIds(store, `import { run } from '../usecases/run';`), [INFRA]);
  assert.deepEqual(ruleIds(store, `import { plugin, service } from '@arki/dot/plugin';`), []);
});

test('a nested child is a feature root of its own: every layer rule applies there first', () => {
  const child = 'src/features/digest/features/compile/usecases/compile-for.ts';
  assert.deepEqual(ruleIds(child, `import { ranker } from '../infra/ranker';`), [NEW_RULE]);
  assert.deepEqual(ruleIds(child, `import { c } from '../entrypoints/rpc';`), [RESTRICT]);
  assert.deepEqual(ruleIds(child, `import { compileLogic } from '../feature';`), [BACK]);
  assert.deepEqual(
    ruleIds('src/features/digest/features/compile/infra/ranker.ts', `import { database } from '../../../../../db';`),
    [],
  );
  // An ancestor's feature.ts imports the child, which imports its infra: the import back is the same cycle.
  assert.deepEqual(
    ruleIds('src/features/digest/features/compile/infra/ranker.ts', `import { digest } from '../../../feature';`),
    [INFRA],
  );
  assert.deepEqual(
    ruleIds('src/features/digest/features/compile/entrypoints/rpc.ts', `import { x } from '../usecases/compile-for';`),
    [RESTRICT],
  );
});

test("a parent's contract mounts its children's contracts; the app contract still mounts the top-level ones", () => {
  const parent = 'src/features/digest/entrypoints/rpc.ts';
  assert.deepEqual(ruleIds(parent, `import { compileRpcContract } from '../features/compile/entrypoints/rpc';`), []);
  assert.deepEqual(ruleIds(parent, `import { compileLogic } from '../features/compile/feature';`), [RESTRICT]);
  assert.deepEqual(ruleIds('src/rpc.ts', `import { digestRpcContract } from './features/digest/entrypoints/rpc';`), []);
});

test('features keep to their own layers: another feature is reached through feature.ts, its contract or its model', () => {
  assert.deepEqual(ruleIds(USECASE, `import { run } from '../../other/usecases/run';`), [BOUNDARY]);
  assert.deepEqual(ruleIds(USECASE, `import type { Run } from '../../other/usecases/run';`), []);
  assert.deepEqual(ruleIds(USECASE, `import { otherLogic } from '../../other/feature';`), []);
  // (From a usecase, any entrypoints/ import is the usecases layer rule's business; a procedure may mount another contract.)
  assert.deepEqual(ruleIds(PROCEDURES, `import { otherRpcContract } from '../../other/entrypoints/rpc';`), []);
  assert.deepEqual(ruleIds(USECASE, `import { ItemId } from '../../other/model/ids';`), []);
  assert.deepEqual(ruleIds(USECASE, `import { procedures } from '../../other/entrypoints/procedures';`).sort(), [BOUNDARY, RESTRICT].sort());
  assert.deepEqual(ruleIds('src/features/demo/feature.ts', `import { store } from '../other/infra/store';`), [BOUNDARY]);
  assert.deepEqual(ruleIds('src/features/demo/feature.ts', `import { otherLogic } from '../other/feature';`), []);
  // A parent never reaches into a child's layers either; it mounts the child's feature.ts.
  assert.deepEqual(ruleIds(USECASE, `import { compileFor } from '../features/compile/usecases/compile-for';`), [BOUNDARY]);
  assert.deepEqual(ruleIds('src/features/demo/feature.ts', `import { compileLogic } from './features/compile/feature';`), []);
});

test("a nested child may use an ancestor's infra, never a cousin's", () => {
  const child = 'src/features/digest/features/compile/infra/ranker.ts';
  assert.deepEqual(ruleIds(child, `import { bindRepos } from '../../../infra/store';`), []);
  assert.deepEqual(ruleIds(child, `import { mailer } from '../../deliver/infra/mailer';`), [BOUNDARY]);
  assert.deepEqual(ruleIds('src/features/digest/features/compile/features/rank/feature.ts', `import { bindRepos } from '../../../../infra/store';`), []);
  // The usecases layer rule still holds at depth: a usecase runtime-imports no infra, an ancestor's included.
  assert.deepEqual(ruleIds('src/features/digest/features/compile/features/rank/usecases/top.ts', `import { bindRepos } from '../../../../../infra/store';`), [NEW_RULE]);
});

test('the boundary rule reads dynamic imports, template literals included; computed ones are skipped', () => {
  assert.deepEqual(ruleIds(USECASE, `export const f = async () => import('../../other/usecases/run');`), [BOUNDARY]);
  assert.deepEqual(ruleIds(USECASE, 'export const f = async () => import(`../../other/usecases/run`);'), [BOUNDARY]);
  assert.deepEqual(ruleIds(USECASE, 'export const f = async (n) => import(`../../other/usecases/${n}`);'), []);
  assert.deepEqual(ruleIds(USECASE, `export type R = typeof import('../../other/usecases/run');`), []);
});

test('legacy shapes wait to convert: an importer outside a layer, or a target outside one, is not checked', () => {
  assert.deepEqual(ruleIds('src/features/demo/services/x.ts', `import { run } from '../../other/usecases/run';`), []);
  assert.deepEqual(ruleIds(USECASE, `import { service } from '../../other/service';`), []);
  assert.deepEqual(ruleIds(USECASE, `import { helper } from '../../../lib/helper';`), []);
});

test("a feature never imports the app's table barrel (src/model/tables), at any depth or layer", () => {
  assert.deepEqual(ruleIds('src/features/demo/infra/store.ts', `import { User } from '../../../model/tables';`), [BARREL]);
  assert.deepEqual(ruleIds('src/features/demo/usecases/run.ts', `import type { User } from '../../../model/tables';`), [BARREL]);
  assert.deepEqual(ruleIds('src/features/demo/features/child/infra/store.ts', `import { User } from '../../../../../model/tables';`), [BARREL]);
});

test("a feature's own model/tables is not the barrel, and the app model/auth/tables is fine", () => {
  assert.deepEqual(ruleIds('src/features/demo/infra/store.ts', `import { Demo } from '../model/tables';`), []);
  assert.deepEqual(ruleIds('src/features/demo/infra/store.ts', `import { User } from '../../../model/auth/tables';`), []);
});

test('the app root src/model/relations.ts and src/model/tables.ts may import their own siblings', () => {
  assert.deepEqual(
    ruleIds('src/model/relations.ts', `import { defineRelationsPart } from '@arki/db/orm'; import * as tables from './tables'; import { r } from '../features/demo/model/relations';`),
    [],
  );
  assert.deepEqual(ruleIds('src/model/tables.ts', `export * from './pg-namespace'; export * from '../features/demo/model/tables';`), []);
});

test('featureLayers needs the app folder, or the barrel check would silently look in the wrong place', () => {
  // @ts-expect-error -- `root` is required; a config without it must fail at load, not pass every file.
  assert.throws(() => featureLayers({}), /root must be the backend's absolute folder/);
  assert.throws(() => featureLayers({ root: 'apps/demo/backend' }), /root must be the backend's absolute folder/);
});

test('a usecase never imports a sibling file at runtime', () => {
  assert.deepEqual(ruleIds(USECASE, `import { x } from './other';`), [SIBLING]);
  assert.deepEqual(ruleIds(USECASE, `export { y } from './other';`), [SIBLING]);
  assert.deepEqual(ruleIds(USECASE, `import type { X } from './other';`), []);
  assert.deepEqual(ruleIds(USECASE, `import { x } from './lib/x';`), []);
  assert.deepEqual(ruleIds('src/features/demo/usecases/email/section.ts', `import { t } from './types';`), []);
});

test('only feature.ts imports a domain service at runtime', () => {
  assert.deepEqual(ruleIds('src/features/demo/features/child/feature.ts', `import { e } from '../../domain-services/extras';`), []);
  assert.deepEqual(ruleIds('src/features/demo/feature.ts', `import { e } from './domain-services/extras';`), []);
  assert.deepEqual(ruleIds(USECASE, `import { e } from '../domain-services/extras';`), [DS]);
  assert.deepEqual(ruleIds(USECASE, `import type { E } from '../domain-services/extras';`), []);
});

test('domain-services/ is a feature layer: cross-feature import, runtime bans, no feature.ts value import', () => {
  const DOMAIN_SERVICE = 'src/features/demo/domain-services/x.ts';
  assert.deepEqual(
    ruleIds('src/features/other/usecases/run.ts', `import { x } from '../../demo/domain-services/x';`).sort(),
    [BOUNDARY, DS].sort(),
  );
  assert.deepEqual(ruleIds(DOMAIN_SERVICE, `import { s } from '../infra/store';`), [NEW_RULE]);
  assert.deepEqual(ruleIds(DOMAIN_SERVICE, `import { eq } from 'drizzle-orm';`), [NEW_RULE]);
  assert.deepEqual(ruleIds(DOMAIN_SERVICE, `import type { S } from '../infra/store';`), []);
  assert.deepEqual(ruleIds(DOMAIN_SERVICE, `import { f } from '../feature';`), [BACK]);
  assert.deepEqual(ruleIds(DOMAIN_SERVICE, `import type { DomainDeps } from '../feature';`), []);
});

test('a nested child feature.ts may import its ancestor domain service; nothing else may', () => {
  const EXTRAS = '../../domain-services/extras';
  assert.deepEqual(ruleIds('src/features/demo/features/child/feature.ts', `import { extras } from '${EXTRAS}';`), []);
  assert.deepEqual(
    ruleIds('src/features/demo/features/child/usecases/run.ts', `import { extras } from '../../../domain-services/extras';`).sort(),
    [BOUNDARY, DS].sort(),
  );
  assert.deepEqual(
    ruleIds('src/features/other/feature.ts', `import { extras } from '../demo/domain-services/extras';`).sort(),
    [BOUNDARY, DS].sort(),
  );
});
