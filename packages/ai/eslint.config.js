import { library } from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

export default [
  // These files read the process environment or use Node builtins on purpose (Node-only server code);
  // the portable-source rules do not apply to them.
  ...library({
    adapters: [
      'src/ai-service/ollama-service.ts',
      'src/ai-service/telemetry.ts',
      'src/capabilities/podhop.ts',
      'src/dot/**',
      'src/utils/secure-config.ts',
    ],
  }),
  // `failure/must-use` and `failure/no-blind-accept`: a returned failure is never thrown away or accepted unchecked.
  failure.configs.recommended,
  {
    // Tests: the ES2022 lib this package compiles against has no `toSorted`, so copy-then-sort stays; and an
    // explicit `undefined` argument is often what the callee's type needs (`mockResolvedValue(undefined)`)
    // or what the test is about (`retryAfterMs(undefined)`).
    files: ['src/**/*.test.ts'],
    rules: {
      'unicorn/no-array-sort': 'off',
      'unicorn/no-useless-undefined': ['error', { checkArguments: false }],
    },
  },
];
