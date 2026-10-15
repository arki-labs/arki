import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { featureLayers } from './feature-layers.js';

const NEW_RULE = 'arki-feature-layers/usecase-runtime-imports';
const RESTRICT = 'no-restricted-imports';

const linter = new Linter();

/** Lint `code` as if it lived at `filename`; return the rule ids that fired. */
const ruleIds = (/** @type {string} */ filename, /** @type {string} */ code, /** @type {string[]} */ clients = []) =>
  linter
    .verify(code, [...featureLayers({ clients }), { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }], { filename })
    .map((m) => m.ruleId);

const USECASE = 'src/features/demo/usecases/run.ts';

test('contracts ship to the browser, so importing outside their vocabulary fails', () => {
  assert.deepEqual(ruleIds('src/features/demo/entrypoints/contract.ts', `import { x } from '../usecases/run';`), [RESTRICT]);
  assert.deepEqual(ruleIds('src/features/demo/entrypoints/contract.ts', `import { z } from 'zod'; import { m } from '../model/m';`), []);
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

test('a usecase does not know how it is called: no entrypoints import', () => {
  assert.deepEqual(ruleIds(USECASE, `import { c } from '../entrypoints/contract';`), [RESTRICT]);
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
  assert.deepEqual(ruleIds('src/features/demo/entrypoints/procedures.ts', `import { os } from '@orpc/server';`), [RESTRICT]);
});

test('app-level code outside the core may not import @orpc/server', () => {
  assert.deepEqual(ruleIds('src/other.ts', `import { os } from '@orpc/server';`), [RESTRICT]);
  assert.deepEqual(ruleIds('src/core/orpc.ts', `import { os } from '@orpc/server';`), []);
});

test('tests may wire infra directly, so they are ignored', () => {
  assert.deepEqual(ruleIds('src/features/demo/usecases/__tests__/a.test.ts', `import { store } from '../../infra/store';`), []);
});
