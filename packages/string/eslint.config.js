const baseConfig = require('../../eslint.config.js');
module.exports = [
  ...baseConfig,
  {
    files: [
      'packages/string/**/*.ts',
      'packages/string/**/*.tsx',
      'packages/string/**/*.js',
      'packages/string/**/*.jsx',
    ],
    rules: {},
  },
  {
    files: ['packages/string/**/*.ts', 'packages/string/**/*.tsx'],
    rules: {},
  },
  {
    files: ['packages/string/**/*.js', 'packages/string/**/*.jsx'],
    rules: {},
  },
];
