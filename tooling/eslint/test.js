const config = {
  extends: ['plugin:vitest/recommended'],
  plugins: ['vitest', 'eslint-plugin-playwright', 'eslint-plugin-testing-library'],
};

// eslint-disable-next-line unicorn/prefer-module
module.exports = config;
