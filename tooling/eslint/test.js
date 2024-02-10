/** @type {import('eslint').Linter.Config} */
const config = {
  extends: ['plugin:vitest/recommended'],
  plugins: ['vitest'],
};

// eslint-disable-next-line unicorn/prefer-module
module.exports = config;
