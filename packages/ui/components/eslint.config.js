const baseConfig = require('../../../eslint.config.js');
module.exports = [
  ...baseConfig,
  {
    files: [
      'packages/ui/components/**/*.ts',
      'packages/ui/components/**/*.tsx',
      'packages/ui/components/**/*.js',
      'packages/ui/components/**/*.jsx',
    ],
    rules: {},
  },
  {
    files: ['packages/ui/components/**/*.ts', 'packages/ui/components/**/*.tsx'],
    rules: {},
  },
  {
    files: ['packages/ui/components/**/*.js', 'packages/ui/components/**/*.jsx'],
    rules: {},
  },
  ...compat.extends('plugin:@nx/react'),
];
