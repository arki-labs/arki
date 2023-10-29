const baseConfig = require('../../eslint.config.js');
module.exports = [
  ...baseConfig,
  {
    files: ['packages/theme/**/*.ts', 'packages/theme/**/*.tsx', 'packages/theme/**/*.js', 'packages/theme/**/*.jsx'],
    rules: {},
  },
  {
    files: ['packages/theme/**/*.ts', 'packages/theme/**/*.tsx'],
    rules: {},
  },
  {
    files: ['packages/theme/**/*.js', 'packages/theme/**/*.jsx'],
    rules: {},
  },
];
