import failure from '@arki/failure/eslint';
import baseConfig, { restrictEnvAccess } from '@arki/eslint-config/base';
import reactConfig from '@arki/eslint-config/react';

/** @type {import('typescript-eslint').Config} */
export default [
  {
    // `src/content/packages` holds docs copied from npm tarballs by `release:arki site`, not app code.
    ignores: ['dist/**', 'src/paraglide/**', 'routeTree.gen.ts', 'src/content/packages/**'],
  },
  ...baseConfig,
  failure.configs.recommended,
  ...reactConfig,
  ...restrictEnvAccess,
  {
    // TanStack Router signals control flow by throwing redirect()/notFound();
    // these are not error objects, so only-throw-error must allow them.
    files: ['src/routes/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [
            { from: 'package', name: 'Redirect', package: '@tanstack/router-core' },
            { from: 'package', name: 'NotFoundError', package: '@tanstack/router-core' },
          ],
        },
      ],
    },
  },
];
