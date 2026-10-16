/**
 * Lint preset for Dot feature layers and contract-first oRPC (RFC
 * `docs/rfcs/2026-10-15-dot-feature-builder.md`, R1.7 and Part C).
 *
 * A converted feature is four folders and a chain file:
 *
 *   features/<name>/model/        schemas, tables, ids, pure rules
 *   features/<name>/usecases/     what the feature does
 *   features/<name>/infra/        its private plugins (store, clients)
 *   features/<name>/entrypoints/  rpc.ts (the browser-safe contract) + procedures.ts
 *   features/<name>/feature.ts    the defineFeature chain and `rpcImplementer`
 *
 * Types cannot see folders, so these rules hold the shape:
 *
 * - `@orpc/server` only in the app core (`core/orpc.ts`, `root.ts`,
 *   `gateway.ts`, `cron.ts`) and `feature.ts` — a procedure never builds its own implementer.
 * - `@orpc/contract` only in contract files — `entrypoints/rpc.ts` and
 *   the app's `rpc.ts`.
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
 *   TDZ error at import. `import type { Deps }` / `import type { rpcImplementer }` is fine.
 * - `entrypoints/procedures.ts` calls usecases: it never reads `context.repos`
 *   and makes no runtime import of `infra/` (`arki-feature-layers/procedures-call-usecases`).
 *   Data access belongs in a usecase, where a test can reach it without HTTP.
 *
 * - `infra/` makes no RUNTIME import of the app's `db` / `kv` modules, of any
 *   `feature.ts`, or of `usecases/` / `entrypoints/`
 *   (`arki-feature-layers/infra-runtime-imports`): an infra plugin declares
 *   what it needs unbound (`service<T>()`), and the feature binds it at
 *   `.infra()`. `import type` is fine.
 * - Features nest: `features/<name>/features/<child>/` is a feature root of
 *   its own, and every layer rule above applies there first. Across roots,
 *   a file may RUNTIME-import another feature's `feature.ts`,
 *   `entrypoints/rpc.ts` (its contract) and `model/**` only — plus an
 *   ANCESTOR's `infra/**` for a nested child
 *   (`arki-feature-layers/feature-boundaries`). Services cross a boundary
 *   through `.needs()`, never by import. `import type` is fine.
 *
 * The rules only look at layer folders and app-level files, so router-first
 * features (no layer folders yet) are not flagged while they wait to convert.
 *
 * An app opts in with one line in its backend `eslint.config.js`:
 *
 *   export default [...rootConfig, ...featureLayers()];
 */

/** @typedef {{ group?: string[], regex?: string, message: string }} Pattern */

const SERVER = { group: ['@orpc/server', '@orpc/server/*'], message: 'Only feature.ts and the app core (core/orpc.ts, root.ts, gateway.ts, cron.ts) build oRPC implementers. Take `rpcImplementer` as a typed parameter (`import type { rpcImplementer } from "../feature"`).' };
const CONTRACT = { group: ['@orpc/contract', '@orpc/contract/*'], message: 'Contracts live in entrypoints/rpc.ts (and the app rpc.ts) only.' };
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
    '^(?!(@orpc/contract|zod|zod/.*|@arki/contracts)$)(?!\\.\\./model/)(?!\\./schemas$)(?!\\./features/[^/]+/entrypoints/rpc$)(?!\\.\\./features/[^/]+/entrypoints/rpc$).*',
  message:
    'A contract ships to the browser: import only @orpc/contract, zod / @arki/contracts, ../model/* and its child contracts (../features/<child>/entrypoints/rpc; the app contract: ./features/<name>/entrypoints/rpc).',
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
 * The same check with its own name and message: a usecase or the procedures
 * file takes `Deps` / `rpcImplementer` from its `feature.ts` as a type. One file
 * per usecase means many files that could slip in a value import by accident.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const featureRuntimeImports = {
  meta: {
    ...usecaseRuntimeImports.meta,
    messages: {
      runtime:
        'feature.ts imports this file, so a runtime import of {{source}} back is a module cycle (TDZ at import). Use `import type { Deps }` / `import type { rpcImplementer }`.',
    },
  },
  create: usecaseRuntimeImports.create,
};

/** `{ repos }` (or `{ 'repos': … }`) inside an object pattern. */
const destructuresRepos = (/** @type {import('estree').Pattern | null | undefined} */ pattern) =>
  pattern?.type === 'ObjectPattern' &&
  pattern.properties.some((p) => p.type === 'Property' && propertyName(p.key, p.computed) === 'repos');

/** The static name of a property key, or undefined when it is computed from a variable. */
const propertyName = (/** @type {import('estree').Node} */ key, /** @type {boolean} */ computed) => {
  if (!computed && key.type === 'Identifier') return key.name;
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
};

const isContext = (/** @type {import('estree').Node | null | undefined} */ node) =>
  node?.type === 'Identifier' && node.name === 'context';

/**
XX * procedure calls a usecase"). In `entrypoints/procedures.ts`:
 * - no `context.repos` read — as a member (`context.repos.x`), a destructure
 *   (`const { repos } = context`) or a handler parameter (`({ context: { repos } })`);
 * - no runtime import of `infra/`. `import type` is fine.
 * The procedure keeps the HTTP work (auth, error mapping); the usecase does
 * the rest, so the rest is testable without a request.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const proceduresCallUsecases = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      repos: 'A procedure calls a usecase (`context.usecases.x(…)`), never `context.repos`. Move the data access into a usecase.',
      infra: 'A procedure reaches infra through a usecase, never by a runtime import of {{source}}. `import type` is fine.',
    },
  },
  create(context) {
    const infra = new RegExp(USECASE_INFRA);
    const reportRepos = (/** @type {import('estree').Node} */ node) => context.report({ node, messageId: 'repos' });
    const checkSource = (/** @type {import('estree').Node} */ node, /** @type {unknown} */ source) => {
      if (typeof source === 'string' && infra.test(source)) context.report({ node, messageId: 'infra', data: { source: `"${source}"` } });
    };
    return {
      MemberExpression(node) {
        if (isContext(node.object) && propertyName(node.property, node.computed) === 'repos') reportRepos(node);
      },
      VariableDeclarator(node) {
        if (isContext(node.init) && destructuresRepos(node.id)) reportRepos(node);
      },
      Property(node) {
        // `({ context: { repos } }) => …` — only inside a pattern, not an object literal.
        const inPattern = 'parent' in node && node.parent?.type === 'ObjectPattern';
        if (inPattern && propertyName(node.key, node.computed) === 'context' && node.value.type === 'ObjectPattern' && destructuresRepos(node.value)) {
          reportRepos(node);
        }
      },
      ImportDeclaration(node) {
        if (!isTypeOnly(node, 'importKind')) checkSource(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source && !isTypeOnly(node, 'exportKind')) checkSource(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        if (!isTypeOnly(node, 'exportKind')) checkSource(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') checkSource(node, node.source.value);
      },
    };
  },
};

// The feature's own chain file, from any depth inside usecases/ or entrypoints/.
const OWN_FEATURE = '^(\\.\\./)+feature(\\.[jt]s)?$';
// Any feature's chain file: infra never holds a feature's handles, the feature hands its needs to infra.
const ANY_FEATURE = '^\\.{1,2}/(.*/)?feature(\\.[jt]s)?$';
// The layers an infra plugin never reaches into.
const INFRA_INWARD = '^\\.{1,2}/(.*/)?(usecases|entrypoints)(/|$)';

const INFRA_BANNED = [USECASE_DB_KV, ANY_FEATURE, INFRA_INWARD];

/**
 * The same check again for `infra/`: a plugin declares what it needs unbound
 * (`service<T>()`) and the feature binds it at `.infra()`. A runtime import of
 * the app's `db` / `kv` module or of a `feature.ts` pins the plugin to one
 * handle — and a feature's handles are the feature's business.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const infraRuntimeImports = {
  meta: {
    ...usecaseRuntimeImports.meta,
    messages: {
      runtime:
        'An infra plugin declares what it needs unbound (`service<T>()`); the feature binds it at `.infra()`. No runtime import of {{source}}. `import type` is fine.',
    },
  },
  create: usecaseRuntimeImports.create,
};

const LAYERS = new Set(['model', 'usecases', 'infra', 'entrypoints']);

/** A module path without its extension or trailing `/index`. */
const moduleId = (/** @type {string} */ path) => path.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');

/**
 * The deepest `features/<name>` on a path, and the path below it. A nested
 * child (`features/a/features/b/...`) is rooted at `features/a/features/b`.
 */
const featureRootOf = (/** @type {string} */ path) => {
  const segments = path.split('/');
  let rootEnd = -1;
  for (let i = 0; i + 1 < segments.length; i += 1) if (segments[i] === 'features') rootEnd = i + 2;
  if (rootEnd === -1) return undefined;
  return { root: segments.slice(0, rootEnd).join('/'), rest: segments.slice(rootEnd) };
};

/** `a/b` resolved against the folder of `from`, in posix form. */
const resolveRelative = (/** @type {string} */ from, /** @type {string} */ source) => {
  const parts = [...from.replace(/\\/g, '/').split('/').slice(0, -1)];
  for (const segment of source.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
};

/** The one string a dynamic import names, or undefined when it is computed. */
const literalSource = (/** @type {import('estree').Expression} */ source) => {
  if (source.type === 'Literal') return source.value;
  if (source.type === 'TemplateLiteral' && source.expressions.length === 0) return source.quasis[0]?.value.cooked ?? undefined;
  return undefined;
};

/**
 * One feature never reaches into another's layers. From a layer file (or
 * `feature.ts`) of feature A, a RUNTIME import that lands inside feature B is
 * allowed only when it is B's `feature.ts`, its contract (`entrypoints/rpc`),
 * or its `model/**` — plus `infra/**` of an ancestor, for a nested child.
 * Legacy shapes (an importer outside a layer folder, a target outside one)
 * are not checked: they are still waiting to convert.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const featureBoundaries = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      crosses:
        '{{importer}} reaches into {{target}}: a feature takes another feature\'s services through the graph (.needs()), or imports its contract (entrypoints/rpc), model/ or feature.ts. `import type` is fine.',
    },
  },
  create(context) {
    const filename = context.filename.replace(/\\/g, '/');
    const importer = featureRootOf(filename);
    if (importer === undefined) return {};
    const [importerLayer, ...importerBelow] = importer.rest;
    const importerInLayer = (LAYERS.has(importerLayer ?? '') && importerBelow.length > 0) || importer.rest.join('/') === 'feature.ts';
    if (!importerInLayer) return {};

    const check = (/** @type {import('estree').Node} */ node, /** @type {unknown} */ source) => {
      if (typeof source !== 'string' || !source.startsWith('.')) return;
      const target = featureRootOf(moduleId(resolveRelative(filename, source)));
      if (target === undefined || target.root === importer.root) return;
      const [targetLayer, ...targetBelow] = target.rest;
      if (target.rest.join('/') === 'feature') return;
      if (targetLayer === undefined || !LAYERS.has(targetLayer) || targetBelow.length === 0) return;
      if (targetLayer === 'model') return;
      if (targetLayer === 'entrypoints' && targetBelow.join('/') === 'rpc') return;
      if (targetLayer === 'infra' && importer.root.startsWith(`${target.root}/features/`)) return;
      context.report({ node, messageId: 'crosses', data: { importer: `"${importer.root}"`, target: `"${source}"` } });
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
        check(node, literalSource(node.source));
      },
    };
  },
};

const plugin = {
  rules: {
    'usecase-runtime-imports': usecaseRuntimeImports,
    'feature-runtime-imports': featureRuntimeImports,
    'procedures-call-usecases': proceduresCallUsecases,
    'infra-runtime-imports': infraRuntimeImports,
    'feature-boundaries': featureBoundaries,
  },
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
  // `**`: a feature nested under another (`features/a/features/b`) is a root of its own.
  const features = `${src}/features/**`;
  const contracts = [`${src}/rpc.ts`, `${features}/entrypoints/rpc.ts`];
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
      name: 'arki/feature-layers/procedures',
      files: [`${features}/entrypoints/procedures.ts`],
      plugins: { 'arki-feature-layers': plugin },
      rules: { 'arki-feature-layers/procedures-call-usecases': 'error' },
    },
    {
      name: 'arki/feature-layers/infra-entrypoints',
      files: [`${features}/infra/**/*.ts`, `${features}/entrypoints/**/*.ts`],
      ignores: [...TESTS, ...contracts],
      rules: rule([SERVER, CONTRACT]),
    },
    {
      name: 'arki/feature-layers/infra',
      files: [`${features}/infra/**/*.ts`],
      ignores: TESTS,
      plugins: { 'arki-feature-layers': plugin },
      rules: { 'arki-feature-layers/infra-runtime-imports': ['error', { patterns: INFRA_BANNED }] },
    },
    {
      name: 'arki/feature-layers/boundaries',
      files: [`${features}/*.ts`, `${features}/**/*.ts`],
      ignores: TESTS,
      plugins: { 'arki-feature-layers': plugin },
      rules: { 'arki-feature-layers/feature-boundaries': 'error' },
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
