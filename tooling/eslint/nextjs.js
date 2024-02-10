/** @type {import('eslint').Linter.Config} */
const config = {
  extends: ['plugin:@next/next/recommended'],
  rules: {
    '@next/next/no-html-link-for-pages': 'off',
  },
};

// eslint-disable-next-line unicorn/prefer-module
module.exports = config;
