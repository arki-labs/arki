import queryPlugin from '@tanstack/eslint-plugin-query';
import routerPlugin from '@tanstack/eslint-plugin-router';

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
