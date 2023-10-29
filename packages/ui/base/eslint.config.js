const { FlatCompat } = require('@eslint/eslintrc');
const baseConfig = require('../../../eslint.config.js');
const js = require('@eslint/js');
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});
module.exports = [
  ...baseConfig,
  ...compat.extends('plugin:@nx/react'),
  {
    files: ['packages/ui/**/*.ts', 'packages/ui/**/*.tsx', 'packages/ui/**/*.js', 'packages/ui/**/*.jsx'],
    rules: {},
  },
  {
    files: ['packages/ui/**/*.ts', 'packages/ui/**/*.tsx'],
    rules: {},
  },
  {
    files: ['packages/ui/**/*.js', 'packages/ui/**/*.jsx'],
    rules: {},
  },
];
