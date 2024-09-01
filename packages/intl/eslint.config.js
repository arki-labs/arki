import baseConfig from "@arki/eslint-config/base";
import nextjsConfig from "@arki/eslint-config/nextjs";
import reactConfig from "@arki/eslint-config/react";

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: [".next/**"],
  },
  ...baseConfig,
  ...reactConfig,
  ...nextjsConfig,
];
