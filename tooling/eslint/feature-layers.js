/**
 * Lint preset for Dot feature layers and contract-first oRPC (RFC
 * `docs/rfcs/2026-10-15-dot-feature-builder.md`, R1.7 and Part C).
 *
 * A converted feature is four folders and a chain file:
 *
 *   features/<name>/model/        schemas, tables, ids, pure rules
 *   features/<name>/usecases/     what the feature does
 *   features/<name>/infra/        its private plugins (store, clients)
 *   features/<name>/entrypoints/  contract.ts (browser-safe) + procedures
 *   features/<name>/feature.ts    the defineFeature chain and `os`
 *
 * Types cannot see folders, so these rules hold the shape:
 *
 * - `@orpc/server` only in the app core (`core/orpc.ts`, `root.ts`,
 *   `gateway.ts`) and `feature.ts` — a procedure never builds its own `os`.
 * - `@orpc/contract` only in contract files — `entrypoints/contract.ts` and
 *   the app's `contract.ts`.
 * - A contract file imports only `@orpc/contract`, zod / `@arki/contracts`,
 *   and its model (`../model/*`, or feature contracts from the app contract)
 *   — it ships to the browser.
 * - `model/` imports no `usecases/`, `infra/` or `entrypoints/`, and no
 *   database runtime — except `model/tables.ts`, which declares tables.
 * - `usecases/` imports no `entrypoints/` (a usecase never knows how it is called).
 *
 * The rules only look at layer folders and app-level files, so router-first
 * features (no layer folders yet) are not flagged while they wait to convert.
 *
 * An app opts in with one line in its backend `eslint.config.js`:
 *
 *   export default [...rootConfig, ...featureLayers()];
 */

/** @typedef {{ group?: string[], regex?: string, message: string }} Pattern */

const SERVER = { group: ['@orpc/server', '@orpc/server/*'], message: 'Only feature.ts and the app core (core/orpc.ts, root.ts, gateway.ts) build oRPC implementers. Take `os` as a typed parameter (`import type { os } from "../feature"`).' };
const CONTRACT = { group: ['@orpc/contract', '@orpc/contract/*'], message: 'Contracts live in entrypoints/contract.ts (and the app contract.ts) only.' };
const DB_RUNTIME = {
  regex: '^(drizzle-orm(/(?!pg-core$).*)?|pg|postgres|@arki/db(/(?!id$|temporal$).*)?)$',
  message: 'model/ holds no database runtime (only model/tables.ts declares tables). Use drizzle-orm/pg-core or @arki/db/{id,temporal} types.',
};

/** A relative import that walks into one of the given layer folders. */
const layer = (/** @type {string[]} */ names, /** @type {string} */ message) => ({
  regex: `^\\.{1,2}/(.*/)?(${names.join('|')})(/|$)`,
  message,
});

const MODEL_INWARD = layer(['usecases', 'infra', 'entrypoints'], 'model/ is the inside layer: it imports no usecases/, infra/ or entrypoints/.');
const USECASES_INWARD = layer(['entrypoints'], 'usecases/ never imports entrypoints/: a usecase does not know how it is called.');

/**
 * Only the contract's own vocabulary: oRPC contract, zod, its model, and (in
 * the app contract) the feature contracts.
 */
const CONTRACT_ONLY = {
  regex:
    '^(?!(@orpc/contract|zod|zod/.*|@arki/contracts)$)(?!\\.\\./model/)(?!\\./schemas$)(?!\\./features/[^/]+/entrypoints/contract$).*',
  message:
    'A contract ships to the browser: import only @orpc/contract, zod / @arki/contracts and ../model/* (the app contract: ./features/<name>/entrypoints/contract).',
};

const TESTS = ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'];

/**
 * @param {{ src?: string, legacy?: string[] }} [options]
 *   `src`: the backend's source folder (default `'src'`).
 *   `legacy`: app-level files that still build router-first procedures and
 *   may import `@orpc/server` until they are deleted (e.g. `['src/core/offline.ts']`).
 */
export function featureLayers({ src = 'src', legacy = [] } = {}) {
  const features = `${src}/features/*`;
  const contracts = [`${src}/contract.ts`, `${features}/entrypoints/contract.ts`];
  const serverAllowed = [`${src}/core/orpc.ts`, `${src}/root.ts`, `${src}/gateway.ts`];

  /** One config per file class, so each file gets exactly one `no-restricted-imports` list. */
  const rule = (/** @type {Pattern[]} */ patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

  return [
    {
      name: 'arki/feature-layers/contracts',
      files: contracts,
      ignores: TESTS,
      rules: rule([CONTRACT_ONLY]),
    },
    {
      name: 'arki/feature-layers/model',
      files: [`${features}/model/**/*.ts`],
      ignores: [...TESTS, `${features}/model/tables.ts`, `${features}/model/tables/**`],
      rules: rule([SERVER, CONTRACT, MODEL_INWARD, DB_RUNTIME]),
    },
    {
      name: 'arki/feature-layers/model-tables',
      files: [`${features}/model/tables.ts`, `${features}/model/tables/**/*.ts`],
      ignores: TESTS,
      rules: rule([SERVER, CONTRACT, MODEL_INWARD]),
    },
    {
      name: 'arki/feature-layers/usecases',
      files: [`${features}/usecases/**/*.ts`],
      ignores: TESTS,
      rules: rule([SERVER, CONTRACT, USECASES_INWARD]),
    },
    {
      name: 'arki/feature-layers/infra-entrypoints',
      files: [`${features}/infra/**/*.ts`, `${features}/entrypoints/**/*.ts`],
      ignores: [...TESTS, ...contracts],
      rules: rule([SERVER, CONTRACT]),
    },
    {
      // App-level code outside the features: the core builds implementers, nothing else does.
      name: 'arki/feature-layers/app',
      files: [`${src}/**/*.ts`],
      ignores: [...TESTS, `${src}/features/**`, ...contracts, ...serverAllowed, ...legacy],
      rules: rule([SERVER, CONTRACT]),
    },
  ];
}
