import baseConfig, { restrictEnvAccess } from '@arki/eslint-config/base';
import reactConfig from '@arki/eslint-config/react';

/** @type {import('typescript-eslint').Config} */
export default [
  {
    // `src/content/packages` holds docs copied from npm tarballs by `release:arki site`, not app code.
    ignores: ['dist/**', 'src/paraglide/**', 'routeTree.gen.ts', 'src/content/packages/**'],
  },
  ...baseConfig,
  ...reactConfig,
  ...restrictEnvAccess,
];
