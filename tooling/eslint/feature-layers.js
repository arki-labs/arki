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
 *   `gateway.ts`, `cron.ts`) and `feature.ts` — a procedure never builds its own `os`.
 * - `@orpc/contract` only in contract files — `entrypoints/contract.ts` and
 *   the app's `contract.ts`.
 * - A contract file imports only `@orpc/contract`, zod / `@arki/contracts`,
 *   and its model (`../model/*`, or feature contracts from the app contract)
 *   — it ships to the browser.
 * - `model/` imports no `usecases/`, `infra/` or `entrypoints/`, and no
 *   database runtime — except `model/tables.ts`, which declares tables.
 * - `usecases/` imports no `entrypoints/` (a usecase never knows how it is called).
 * - `usecases/` makes no RUNTIME import of infra, database, drizzle, oRPC-server
 *   or app-specific client modules (`arki-feature-layers/usecase-runtime-imports`).
 *   `import type` is fine. Dependencies reach a usecase through the feature graph.
 * - `usecases/` and `entrypoints/` make no RUNTIME import of their own
 *   `feature.ts` (`arki-feature-layers/feature-runtime-imports`): `feature.ts`
 *   imports them, so a value import back is a module cycle that dies with a
 *   TDZ error at import. `import type { Deps }` / `import type { os }` is fine.
 *
 * The rules only look at layer folders and app-level files, so router-first
 * features (no layer folders yet) are not flagged while they wait to convert.
 *
 * An app opts in with one line in its backend `eslint.config.js`:
 *
 *   export default [...rootConfig, ...featureLayers()];
 */

/** @typedef {{ group?: string[], regex?: string, message: string }} Pattern */

const SERVER = { group: ['@orpc/server', '@orpc/server/*'], message: 'Only feature.ts and the app core (core/orpc.ts, root.ts, gateway.ts, cron.ts) build oRPC implementers. Take `os` as a typed parameter (`import type { os } from "../feature"`).' };
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

/**
 * Banned runtime imports in usecases. Each one is a way to reach infra without
 * the feature graph.
 */
// A feature's private plugins (store, clients) live in infra/.
const USECASE_INFRA = '^\\.{1,2}/(.*/)?infra(/|$)';
// The app's database / kv modules are infra even when they sit outside the feature.
const USECASE_DB_KV = '^\\.{1,2}/(.*/)?(db|kv)(/.*)?$';
// The app core's oRPC module builds implementers; a usecase is not a procedure.
const USECASE_CORE_ORPC = '^\\.{1,2}/(.*/)?core/orpc$';
// Database runtimes: a usecase asks a store, it does not run queries itself.
const USECASE_DB_RUNTIME = '^(drizzle-orm(/.*)?|pg|postgres|@arki/db(/.*)?)$';
// The oRPC server belongs to the entrypoints and the app core.
const USECASE_ORPC_SERVER = '^@orpc/server(/.*)?$';

const USECASE_BANNED = [USECASE_INFRA, USECASE_DB_KV, USECASE_CORE_ORPC, USECASE_DB_RUNTIME, USECASE_ORPC_SERVER];

/**
 * `importKind` / `exportKind` are TypeScript-parser extras that plain ESTree
 * types don't declare, so they are read with `in` checks rather than a cast.
 */
const kindOf = (/** @type {object} */ node, /** @type {'importKind' | 'exportKind'} */ kind) => {
  if (kind === 'importKind') return 'importKind' in node ? node.importKind : undefined;
  return 'exportKind' in node ? node.exportKind : undefined;
};

/** `import type { a }` or `import { type a, type b }` — erased at build time, so allowed. */
const isTypeOnly = (/** @type {object} */ node, /** @type {'importKind' | 'exportKind'} */ kind) => {
  if (kindOf(node, kind) === 'type') return true;
  const specifiers = /** @type {unknown[]} */ ('specifiers' in node && Array.isArray(node.specifiers) ? node.specifiers : []);
  return (
    specifiers.length > 0 &&
    specifiers.every((s) => typeof s === 'object' && s !== null && kindOf(s, kind) === 'type')
  );
};

/**
 * A custom rule, not `no-restricted-imports`: apps add their own
 * `@typescript-eslint/no-restricted-imports` block for features after this
 * preset, and in flat config a later block for the same rule replaces the
 * earlier options. A rule with its own name cannot be switched off that way.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const usecaseRuntimeImports = {
  meta: {
    type: 'problem',
    schema: [{ type: 'object', properties: { patterns: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      runtime:
        'A usecase takes {{source}} through the feature graph (a need or a private infra plugin), never by a runtime import. `import type` is fine.',
    },
  },
  create(context) {
    const options = /** @type {{ patterns?: string[] } | undefined} */ (context.options[0]);
    const banned = (options?.patterns ?? []).map((source) => new RegExp(source));
    const check = (/** @type {import('estree').Node} */ node, /** @type {unknown} */ source) => {
      if (typeof source !== 'string') return;
      if (banned.some((re) => re.test(source))) context.report({ node, messageId: 'runtime', data: { source: `"${source}"` } });
    };
    return {
      ImportDeclaration(node) {
        if (!isTypeOnly(node, 'importKind')) check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source && !isTypeOnly(node, 'exportKind')) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        if (!isTypeOnly(node, 'exportKind')) check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node, node.source.value);
      },
    };
  },
};

/**
 * The same check with its own name and message: a usecase or a procedure takes
 * `Deps` / `os` from its `feature.ts` as a type. One file per usecase and per
 * procedure means many files that could slip in a value import by accident.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const featureRuntimeImports = {
  meta: {
    ...usecaseRuntimeImports.meta,
    messages: {
      runtime:
        'feature.ts imports this file, so a runtime import of {{source}} back is a module cycle (TDZ at import). Use `import type { Deps }` / `import type { os }`.',
    },
  },
  create: usecaseRuntimeImports.create,
};

// The feature's own chain file, from any depth inside usecases/ or entrypoints/.
const OWN_FEATURE = '^(\\.\\./)+feature(\\.[jt]s)?$';

const plugin = {
  rules: { 'usecase-runtime-imports': usecaseRuntimeImports, 'feature-runtime-imports': featureRuntimeImports },
};

const TESTS = ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'];

/**
 * @param {{ src?: string, legacy?: string[], clients?: string[] }} [options]
 *   `src`: the backend's source folder (default `'src'`).
 *   `legacy`: app-level files that still build router-first procedures and
 *   may import `@orpc/server` until they are deleted (e.g. `['src/core/offline.ts']`).
 *   `clients`: regex sources for app-specific external clients a usecase must take
 *   through the graph, never by a runtime import (e.g. `['^stripe$', '^web-push$']`).
 */
export function featureLayers({ src = 'src', legacy = [], clients = [] } = {}) {
  const features = `${src}/features/*`;
  const contracts = [`${src}/contract.ts`, `${features}/entrypoints/contract.ts`];
  const serverAllowed = [`${src}/core/orpc.ts`, `${src}/root.ts`, `${src}/gateway.ts`, `${src}/cron.ts`];

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
      plugins: { 'arki-feature-layers': plugin },
      rules: {
        ...rule([SERVER, CONTRACT, USECASES_INWARD]),
        'arki-feature-layers/usecase-runtime-imports': ['error', { patterns: [...USECASE_BANNED, ...clients] }],
      },
    },
    {
      name: 'arki/feature-layers/no-feature-back-import',
      files: [`${features}/usecases/**/*.ts`, `${features}/entrypoints/**/*.ts`],
      ignores: TESTS,
      plugins: { 'arki-feature-layers': plugin },
      rules: { 'arki-feature-layers/feature-runtime-imports': ['error', { patterns: [OWN_FEATURE] }] },
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
