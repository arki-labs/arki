/**
 * Lint preset for Dot feature layers and contract-first oRPC (RFC
 * `docs/rfcs/2026-10-15-dot-feature-builder.md`, R1.7 and Part C).
 *
 * A converted feature is five folders and a chain file:
 *
 *   features/<name>/model/        schemas, tables, ids, pure rules
 *   features/<name>/domain-services/  logic with dependencies that usecases share; built once per boot; never leaves the feature
 *   features/<name>/usecases/     what the feature does
 *   features/<name>/infra/        its private plugins (store, clients)
 *   features/<name>/entrypoints/  rpc.ts (the browser-safe contract) + procedures.ts
 *   features/<name>/feature.ts    the defineFeature chain and `rpcImplementer`
 *
 * Types cannot see folders, so these rules hold the shape:
 *
 * - `@orpc/server` only in the app's entrypoints (`entrypoints/{middleware,router,gateway,cron}.ts`;
 *   older layout: `core/orpc.ts`, `root.ts`, `gateway.ts`, `cron.ts`) and `feature.ts` — a procedure never builds its own implementer.
 * - `@orpc/contract` only in contract files — `entrypoints/rpc.ts` and
 *   the app's `rpc.ts` (or `entrypoints/rpc.ts`).
 * - The app's own `model/` is a leaf like a feature's: every layer may import
 *   it; it imports no `usecases/`, `infra/` or `entrypoints/` and no database runtime.
 * - A contract file imports only `@orpc/contract`, zod / `@arki/contracts`,
 *   the `offlineSafe` marker (`@arki/offline/orpc`), failure error maps (`@arki/failure/orpc`), and its model (`../model/*`, or feature contracts from the app contract)
 *   — it ships to the browser.
 * - `model/` imports no `usecases/`, `infra/` or `entrypoints/`, and no
 *   database runtime — except `model/tables.ts` (declares tables) and `model/relations.ts`
 *   (declares the feature's relations part with `defineRelationsPart`).
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
 * - `infra/` makes no RUNTIME import of its own (or an ancestor's)
 *   `feature.ts`, nor of `usecases/` / `entrypoints/`
 *   (`arki-feature-layers/infra-runtime-imports`), nor of ANY other
 *   feature's `feature.ts`: infra adapts the outside world and never depends
 *   on the domain (RFC 2026-10-22-dot-usecase-boundary, D9). An infra plugin
 *   names the app's adapter handles it needs (`needs: { db: database.provides.db }`)
 *   or declares a need unbound (`service<T>()`) for the feature to bind at
 *   `.infra()`. Another feature's output reaches this feature through
 *   `.needs()` into a domain service or a usecase. Its own `feature.ts`
 *   imports it, so a value import back is also a module cycle.
 * - Features nest: `features/<name>/features/<child>/` is a feature root of
 *   its own, and every layer rule above applies there first. Across roots,
 *   a file may RUNTIME-import another feature's `feature.ts`,
 *   `entrypoints/rpc.ts` (its contract) and `model/**` only — plus an
 *   ANCESTOR's `infra/**` for a nested child, and an ANCESTOR's `domain-services/**`
 *   for a nested child's `feature.ts` only
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

import nodePath from 'node:path';

/** @typedef {{ group?: string[], regex?: string, message: string }} Pattern */

const SERVER = {
  group: ['@orpc/server', '@orpc/server/*'],
  message:
    'Only feature.ts and the app entrypoints (entrypoints/{middleware,router,gateway,cron}.ts; older layout: core/orpc.ts, root.ts, gateway.ts, cron.ts) build oRPC implementers. Take `rpcImplementer` as a typed parameter (`import type { rpcImplementer } from "../feature"`).',
};
const CONTRACT = {
  group: ['@orpc/contract', '@orpc/contract/*'],
  message: 'Contracts live in entrypoints/rpc.ts (and the app rpc.ts / entrypoints/rpc.ts) only.',
};
const DB_RUNTIME = {
  regex: '^(drizzle-orm(/(?!pg-core$).*)?|pg|postgres|@arki/db(/(?!id$|temporal$).*)?)$',
  message:
    'model/ holds no database runtime (only model/tables.ts and model/relations.ts declare tables and relations). Use drizzle-orm/pg-core or @arki/db/{id,temporal} types.',
};

/** A relative import that walks into one of the given layer folders. */
const layer = (/** @type {string[]} */ names, /** @type {string} */ message) => ({
  regex: `^\\.{1,2}/(.*/)?(${names.join('|')})(/|$)`,
  message,
});

const MODEL_INWARD = layer(
  ['usecases', 'infra', 'entrypoints'],
  'model/ is the inside layer: it imports no usecases/, infra/ or entrypoints/.',
);
const USECASES_INWARD = layer(
  ['entrypoints'],
  'usecases/ never imports entrypoints/: a usecase does not know how it is called.',
);

/**
 * Only the contract's own vocabulary: oRPC contract, zod, the `offlineSafe`
 * marker (policy is declared on the contract), canonical failure definitions,
 * `errorMap` from
 * `@arki/failure/orpc` (browser-safe: it imports only `@orpc/client`), canonical
 * database failures from `@arki/db/errors`, canonical lock failures from
 * `@arki/lock` (its root is browser-safe), any library's `./contract` entry
 * (`arki-library-check` bundles each one for the browser, A-41), its model,
 * and (in the app contract) the feature contracts.
 */
const CONTRACT_ONLY = {
  regex:
    '^(?!(@orpc/contract|zod|zod/.*|@arki/contracts|@arki/offline/orpc|@arki/failure|@arki/failure/orpc|@arki/auth|@arki/db/errors|@arki/lock|@arki/dot/action|@arki/[^/]+/contract)$)(?!\\.\\./model/)(?!\\./schemas$)(?!\\./features/[^/]+/entrypoints/rpc$)(?!\\.\\./features/[^/]+/entrypoints/rpc$)(?!\\.\\./\\.\\./[^/]+/entrypoints/rpc$).*',
  message:
    'A contract ships to the browser: import only @orpc/contract, zod / @arki/contracts, @arki/offline/orpc (the offlineSafe marker), @arki/failure (canonical failures), @arki/failure/orpc (errorMap), @arki/auth (canonical auth failures), @arki/db/errors (canonical database failures), @arki/lock (canonical lock failures), @arki/dot/action, any @arki/<library>/contract entry, ../model/* and its child contracts (../features/<child>/entrypoints/rpc), the contract of a sibling feature whose procedures it mounts (../../<feature>/entrypoints/rpc; the app contract: ./features/<name>/entrypoints/rpc).',
};

/**
 * Banned runtime imports in usecases. Each one is a way to reach infra without
 * the feature graph.
 */
// A feature's private plugins (store, clients) live in infra/.
const USECASE_INFRA = '^\\.{1,2}/(.*/)?infra(/|$)';
// The app's database / kv modules are infra even when they sit outside the feature.
const USECASE_DB_KV = '^\\.{1,2}/(.*/)?(db|kv)(/.*)?$';
// The app's middleware module builds implementers; a usecase is not a procedure.
const USECASE_CORE_ORPC = '^\\.{1,2}/(.*/)?(core/orpc|entrypoints/middleware)$';
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
  const specifiers = /** @type {unknown[]} */ (
    'specifiers' in node && Array.isArray(node.specifiers) ? node.specifiers : []
  );
  return (
    specifiers.length > 0 && specifiers.every(s => typeof s === 'object' && s !== null && kindOf(s, kind) === 'type')
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
    schema: [
      {
        type: 'object',
        properties: {
          patterns: { type: 'array', items: { type: 'string' } },
          allow: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      runtime:
        'A usecase takes {{source}} through the feature graph (a need or a private infra plugin), never by a runtime import. `import type` is fine.',
    },
  },
  create(context) {
    const options = /** @type {{ patterns?: string[], allow?: string[] } | undefined} */ (context.options[0]);
    const banned = (options?.patterns ?? []).map(source => new RegExp(source));
    // `allow` wins over `patterns`: a pure module under an infra path (an email template) is not a plugin.
    const allowed = (options?.allow ?? []).map(source => new RegExp(source));
    const check = (/** @type {import('estree').Node} */ node, /** @type {unknown} */ source) => {
      if (typeof source !== 'string') return;
      if (allowed.some(re => re.test(source))) return;
      if (banned.some(re => re.test(source)))
        context.report({ node, messageId: 'runtime', data: { source: `"${source}"` } });
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
  pattern.properties.some(p => p.type === 'Property' && propertyName(p.key, p.computed) === 'repos');

/** The static name of a property key, or undefined when it is computed from a variable. */
/** A property key's name: `a` and `'a'` are the same key; a computed key is named only when it is a string literal. */
export const propertyName = (/** @type {import('estree').Node} */ key, /** @type {boolean} */ computed) => {
  if (!computed && key.type === 'Identifier') return key.name;
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
};

/** True for the bare identifier `context`, the name oRPC and Start give a handler's context. */
export const isContext = (/** @type {import('estree').Node | null | undefined} */ node) =>
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
      repos:
        'A procedure calls a usecase (`context.usecases.x(…)`), never `context.repos`. Move the data access into a usecase.',
      infra:
        'A procedure reaches infra through a usecase, never by a runtime import of {{source}}. `import type` is fine.',
    },
  },
  create(context) {
    const infra = new RegExp(USECASE_INFRA);
    const reportRepos = (/** @type {import('estree').Node} */ node) => context.report({ node, messageId: 'repos' });
    const checkSource = (/** @type {import('estree').Node} */ node, /** @type {unknown} */ source) => {
      if (typeof source === 'string' && infra.test(source))
        context.report({ node, messageId: 'infra', data: { source: `"${source}"` } });
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
        if (
          inPattern &&
          propertyName(node.key, node.computed) === 'context' &&
          node.value.type === 'ObjectPattern' &&
          destructuresRepos(node.value)
        ) {
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

// The feature's own chain file (or an ancestor's), from any depth inside usecases/, entrypoints/ or infra/.
const OWN_FEATURE = '^(\\.\\./)+feature(\\.[jt]s)?$';
// The layers an infra plugin never reaches into.
const INFRA_INWARD = '^\\.{1,2}/(.*/)?(usecases|entrypoints)(/|$)';

// Any feature's chain file, own, ancestor or another feature's: infra never depends on the domain (D9).
const ANY_FEATURE = '^(\\.\\./)+([a-z0-9-]+/)*feature(\\.[jt]s)?$';

const INFRA_BANNED = [ANY_FEATURE, INFRA_INWARD];

/**
 * The same check again for `infra/`. A plugin may name the app's adapter
 * handles it needs (`needs: { db: database.provides.db }`), and the feature
 * builder checks the feature declares those same handles. It makes no runtime
 * import of any `feature.ts`: its own (or an ancestor's) imports it, so a
 * value import back is a module cycle that dies with a TDZ error, and another
 * feature's is the domain, which infra never depends on (D9). Infra never
 * reaches into `usecases/` or `entrypoints/` either.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const infraRuntimeImports = {
  meta: {
    ...usecaseRuntimeImports.meta,
    messages: {
      runtime:
        "An infra plugin never runtime-imports a feature.ts (its own is a module cycle; another feature is the domain, which infra never depends on), usecases/ or entrypoints/: no runtime import of {{source}}. Take another feature's output through .needs() into a domain service or a usecase. `import type` is fine.",
    },
  },
  create: usecaseRuntimeImports.create,
};

const LAYERS = new Set(['model', 'domain-services', 'usecases', 'infra', 'entrypoints']);

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
  if (source.type === 'TemplateLiteral' && source.expressions.length === 0)
    return source.quasis[0]?.value.cooked ?? undefined;
  return undefined;
};

/**
 * One feature never reaches into another's layers. From a layer file (or
 * `feature.ts`) of feature A, a RUNTIME import that lands inside feature B is
 * allowed only when it is B's `feature.ts`, its contract (`entrypoints/rpc`),
 * or its `model/**` — plus `infra/**` of an ancestor, for a nested child, and
 * `domain-services/**` of an ancestor, for a nested child's `feature.ts` only.
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
        "{{importer}} reaches into {{target}}: a feature takes another feature's services through the graph (.needs()), or imports its contract (entrypoints/rpc), model/ or feature.ts. `import type` is fine.",
    },
  },
  create(context) {
    const filename = context.filename.replace(/\\/g, '/');
    const importer = featureRootOf(filename);
    if (importer === undefined) return {};
    const [importerLayer, ...importerBelow] = importer.rest;
    const importerInLayer =
      (LAYERS.has(importerLayer ?? '') && importerBelow.length > 0) || importer.rest.join('/') === 'feature.ts';
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
      const targetIsAncestor = importer.root.startsWith(`${target.root}/features/`);
      if (targetLayer === 'infra' && targetIsAncestor) return;
      if (targetLayer === 'domain-services' && targetIsAncestor && importer.rest.join('/') === 'feature.ts') return;
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

/**
 * The app's table barrel (`<src>/model/tables.ts`) hides which feature owns a table, so no
 * feature file imports it. A feature's own `model/tables` is the same file name at another
 * path, so the import is resolved against the importing file rather than matched by depth.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const noTableBarrel = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: { barrel: { type: 'string' }, src: { type: 'string' } },
        required: ['barrel', 'src'],
        additionalProperties: false,
      },
    ],
    messages: {
      barrel:
        "Import the table from its owning feature's model (features/<owner>/model/tables), not the app barrel {{src}}/model/tables: the barrel hides feature dependencies.",
    },
  },
  create(context) {
    // `barrel` is absolute (`featureLayers` resolves it from the app's `root`), so the rule
    // finds it from whatever directory ESLint runs in.
    const { barrel, src } = /** @type {{ barrel: string, src: string }} */ (context.options[0]);
    const check = (/** @type {import('estree').Node} */ node, /** @type {unknown} */ source) => {
      if (typeof source !== 'string' || !source.startsWith('.')) return;
      const target = moduleId(nodePath.resolve(nodePath.dirname(context.filename), source));
      if (target === barrel) context.report({ node, messageId: 'barrel', data: { src } });
    };
    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        check(node, literalSource(node.source));
      },
    };
  },
};

/**
 * A file directly in `usecases/` or `domain-services/` imports no sibling file at
 * runtime (`./other`). Shared logic is a domain service the feature declares, and
 * a usecase reaches it through its deps. Subfolders (`./lib/x`) and `import type` are fine.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const siblingImports = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      sibling:
        'a usecase (or domain service) never imports a sibling at runtime: shared logic is a domain service the feature declares, and a usecase reaches it through its deps',
    },
  },
  create(context) {
    const located = featureRootOf(context.filename.replace(/\\/g, '/'));
    const isDirectChild =
      located !== undefined &&
      located.rest.length === 2 &&
      (located.rest[0] === 'usecases' || located.rest[0] === 'domain-services');
    if (!isDirectChild) return {};
    const check = (/** @type {import('estree').Node} */ node, /** @type {unknown} */ source) => {
      if (typeof source === 'string' && /^\.\/[^/]+$/.test(source)) context.report({ node, messageId: 'sibling' });
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
 * A runtime import that lands in `<feature>/domain-services/**` is allowed only
 * from that feature's `feature.ts` or a child's `features/<child>/feature.ts`.
 * Everything else gets the service through its deps. `import type` is fine.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const domainServiceImports = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      runtime:
        "only feature.ts (or a child's feature.ts) imports a domain service at runtime; usecases receive it through their deps",
    },
  },
  create(context) {
    const filename = context.filename.replace(/\\/g, '/');
    const check = (/** @type {import('estree').Node} */ node, /** @type {unknown} */ source) => {
      if (typeof source !== 'string' || !source.startsWith('.')) return;
      const target = featureRootOf(moduleId(resolveRelative(filename, source)));
      if (target === undefined || target.rest[0] !== 'domain-services') return;
      const isOwnFeature = filename === `${target.root}/feature.ts`;
      const childPrefix = `${target.root}/features/`;
      const childRest = filename.startsWith(childPrefix) ? filename.slice(childPrefix.length).split('/') : [];
      const isChildFeature = childRest.length === 2 && childRest[1] === 'feature.ts';
      if (!isOwnFeature && !isChildFeature) context.report({ node, messageId: 'runtime' });
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

const plugin = {
  rules: {
    'usecase-runtime-imports': usecaseRuntimeImports,
    'feature-runtime-imports': featureRuntimeImports,
    'sibling-imports': siblingImports,
    'domain-service-imports': domainServiceImports,
    'procedures-call-usecases': proceduresCallUsecases,
    'infra-runtime-imports': infraRuntimeImports,
    'feature-boundaries': featureBoundaries,
    'no-table-barrel': noTableBarrel,
  },
};

const TESTS = ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'];

/**
 * @param {{ root: string, src?: string, legacy?: string[], clients?: string[], pure?: string[], siblingImports?: 'error' | 'warn' }} options
 *   `root`: the backend's folder, absolute — pass `import.meta.dirname` from its `eslint.config.js`.
 *   The table-barrel check resolves imports to real paths, so it must know where the app is
 *   wherever ESLint runs from (the app folder, the repo root, an editor).
 *   `src`: the backend's source folder, relative to `root` (default `'src'`).
 *   `legacy`: files (app-level, or inside a feature's layers) that still build router-first
 *   procedures and may import `@orpc/server` until they are deleted
 *   (e.g. `['src/features/highlights/entrypoints/idempotency.ts']`).
 *   `clients`: regex sources for app-specific external clients a usecase must take
 *   through the graph, never by a runtime import (e.g. `['^stripe$', '^web-push$']`).
 *   `pure`: regex sources under an `infra/` path that hold no plugin — pure modules
 *   such as email templates (e.g. `['/infra/mail/templates/']`) — which a usecase
 *   may still runtime-import.
 *   `siblingImports`: severity of `sibling-imports` (default `'error'`); `'warn'` while a backend migrates.
 */
export function featureLayers({ root, src = 'src', legacy = [], clients = [], pure = [], siblingImports = 'error' }) {
  if (typeof root !== 'string' || !nodePath.isAbsolute(root)) {
    throw new TypeError(
      `featureLayers({ root }): root must be the backend's absolute folder (import.meta.dirname); got ${String(root)}.`,
    );
  }
  const barrel = nodePath.resolve(root, src, 'model', 'tables');
  // `**`: a feature nested under another (`features/a/features/b`) is a root of its own.
  const features = `${src}/features/**`;
  // The app's shared leaves (`model/`), with the same rules as a feature's `model/`.
  const appModel = `${src}/model`;
  const contracts = [`${src}/rpc.ts`, `${src}/entrypoints/rpc.ts`, `${features}/entrypoints/rpc.ts`];
  const serverAllowed = [
    `${src}/entrypoints/middleware.ts`,
    `${src}/entrypoints/router.ts`,
    `${src}/entrypoints/gateway.ts`,
    `${src}/entrypoints/cron.ts`,
    // Older layout.
    `${src}/core/orpc.ts`,
    `${src}/root.ts`,
    `${src}/gateway.ts`,
    `${src}/cron.ts`,
  ];

  /** One config per file class, so each file gets exactly one `no-restricted-imports` list. */
  const rule = (/** @type {Pattern[]} */ patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

  return [
    {
      // Every feature file (feature.ts, ...): none imports the app's table barrel.
      name: 'arki/feature-layers/no-table-barrel',
      files: [`${features}/*.ts`, `${features}/**/*.ts`],
      ignores: TESTS,
      plugins: { 'arki-feature-layers': plugin },
      rules: { 'arki-feature-layers/no-table-barrel': ['error', { barrel, src }] },
    },
    {
      name: 'arki/feature-layers/contracts',
      files: contracts,
      ignores: TESTS,
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [CONTRACT_ONLY],
            paths: [
              {
                name: '@arki/failure',
                importNames: ['orThrow'],
                message: 'A contract declares failures; the exception bridge belongs in its implementation.',
              },
            ],
          },
        ],
      },
    },
    {
      name: 'arki/feature-layers/model',
      files: [`${features}/model/**/*.ts`],
      ignores: [
        ...TESTS,
        `${features}/model/tables.ts`,
        `${features}/model/tables/**`,
        `${features}/model/relations.ts`,
      ],
      rules: rule([SERVER, CONTRACT, MODEL_INWARD, DB_RUNTIME]),
    },
    {
      name: 'arki/feature-layers/model-tables',
      files: [`${features}/model/tables.ts`, `${features}/model/tables/**/*.ts`, `${features}/model/relations.ts`],
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
        'arki-feature-layers/sibling-imports': siblingImports,
        'arki-feature-layers/usecase-runtime-imports': [
          'error',
          { patterns: [...USECASE_BANNED, ...clients], allow: pure },
        ],
      },
    },
    {
      // Domain-service files: same runtime bans as usecases, no sibling files, no value import of their own feature.ts.
      name: 'arki/feature-layers/domain-services',
      files: [`${features}/domain-services/**/*.ts`],
      ignores: TESTS,
      plugins: { 'arki-feature-layers': plugin },
      rules: {
        'arki-feature-layers/sibling-imports': siblingImports,
        'arki-feature-layers/usecase-runtime-imports': [
          'error',
          { patterns: [...USECASE_BANNED, ...clients], allow: pure },
        ],
        'arki-feature-layers/feature-runtime-imports': ['error', { patterns: [OWN_FEATURE] }],
      },
    },
    {
      name: 'arki/feature-layers/domain-service-imports',
      files: [`${features}/*.ts`, `${features}/**/*.ts`],
      ignores: TESTS,
      plugins: { 'arki-feature-layers': plugin },
      rules: { 'arki-feature-layers/domain-service-imports': 'error' },
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
      ignores: [...TESTS, ...contracts, ...legacy],
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
      name: 'arki/feature-layers/app-model',
      files: [`${appModel}/**/*.ts`],
      ignores: [...TESTS, `${appModel}/**/tables.ts`, `${appModel}/**/tables/**`, `${appModel}/**/relations.ts`],
      rules: rule([SERVER, CONTRACT, MODEL_INWARD, DB_RUNTIME]),
    },
    {
      name: 'arki/feature-layers/app-model-tables',
      files: [`${appModel}/**/tables.ts`, `${appModel}/**/tables/**/*.ts`, `${appModel}/**/relations.ts`],
      ignores: TESTS,
      rules: rule([SERVER, CONTRACT, MODEL_INWARD]),
    },
    {
      // App-level code outside the features and model: the entrypoints build implementers, nothing else does.
      name: 'arki/feature-layers/app',
      files: [`${src}/**/*.ts`],
      ignores: [...TESTS, `${src}/features/**`, `${appModel}/**`, ...contracts, ...serverAllowed, ...legacy],
      rules: rule([SERVER, CONTRACT]),
    },
  ];
}
