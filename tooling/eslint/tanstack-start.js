import queryPlugin from '@tanstack/eslint-plugin-query';
import routerPlugin from '@tanstack/eslint-plugin-router';

import { isContext, propertyName } from './feature-layers.js';

/** @type {Awaited<import('typescript-eslint').Config>} */
export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      '@tanstack/query': queryPlugin,
      '@tanstack/router': routerPlugin,
    },
    rules: {
      ...queryPlugin.configs['flat/recommended'][0]?.rules,
      ...routerPlugin.configs['flat/recommended'][0]?.rules,
    },
  },
];

/**
 * Start code in a Dot app calls the contract, not the services (founder decision D-4,
 * `docs/arki/research/16-tanstack-start/design.md`). `context.services` reaches every usecase
 * and repository directly, which skips the contract's validation, policy and manifest entry.
 * Server routes are the mounts and may read it: every file under `routes/api/`, and in any route
 * file the code inside its `server: { handlers: { … } }` object (a server route on a page path,
 * such as `/unsubscribe`). Everything else uses `context.rpc`. Flags a member read (`context.services.x`), a destructure
 * (`const { services } = context`) and a handler parameter (`({ context: { services } })`).
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const noServices = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      services:
        "Start code calls the contract (`context.rpc.x(…)`), never `context.services`. Only server routes (routes/api/, or a route's server.handlers) read services.",
    },
  },
  create(context) {
    /** True when `node` sits inside a route's `server: { handlers: { … } }` object. */
    const inServerHandlers = (/** @type {import('estree').Node} */ node) => {
      const ancestors = context.sourceCode.getAncestors(node);
      return ancestors.some((handlers, i) => {
        const object = ancestors[i - 1];
        const server = ancestors[i - 2];
        return (
          handlers.type === 'Property' &&
          handlers.value.type === 'ObjectExpression' &&
          propertyName(handlers.key, handlers.computed) === 'handlers' &&
          object?.type === 'ObjectExpression' &&
          server?.type === 'Property' &&
          propertyName(server.key, server.computed) === 'server'
        );
      });
    };
    const report = (/** @type {import('estree').Node} */ node) => {
      if (!inServerHandlers(node)) context.report({ node, messageId: 'services' });
    };
    /** `{ services }` (or `{ 'services': … }`) inside an object pattern. */
    const destructuresServices = (/** @type {import('estree').Pattern | null | undefined} */ pattern) =>
      pattern?.type === 'ObjectPattern' &&
      pattern.properties.some(p => p.type === 'Property' && propertyName(p.key, p.computed) === 'services');
    return {
      MemberExpression(node) {
        if (isContext(node.object) && propertyName(node.property, node.computed) === 'services') report(node);
      },
      VariableDeclarator(node) {
        if (isContext(node.init) && destructuresServices(node.id)) report(node);
      },
      Property(node) {
        // `({ context: { services } }) => …` — only inside a pattern, not an object literal.
        const inPattern = 'parent' in node && node.parent?.type === 'ObjectPattern';
        if (
          inPattern &&
          propertyName(node.key, node.computed) === 'context' &&
          node.value.type === 'ObjectPattern' &&
          destructuresServices(node.value)
        ) {
          report(node);
        }
      },
    };
  },
};

/**
 * Lint for the Start layer of a Dot app (`@arki/tanstack-start/dot`). An app opts in with one line
 * in its start `eslint.config.js`:
 *
 *   export default [...rootConfig, ...tanstackStartDot()];
 *
 * @returns {Awaited<import('typescript-eslint').Config>}
 */
export function tanstackStartDot() {
  return [
    {
      files: ['src/**/*.ts', 'src/**/*.tsx'],
      ignores: ['src/routes/api/**'],
      plugins: { 'arki-tanstack-start': { rules: { 'no-services': noServices } } },
      rules: { 'arki-tanstack-start/no-services': 'error' },
    },
  ];
}
