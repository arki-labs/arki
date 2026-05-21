import baseConfig, { restrictEnvAccess } from '@arki/eslint-config/base';
import reactConfig from '@arki/eslint-config/react';

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: ['dist/**', 'src/paraglide/**', 'routeTree.gen.ts'],
  },
  ...baseConfig,
  ...reactConfig,
  ...restrictEnvAccess,
];
