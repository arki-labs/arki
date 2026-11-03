---
'@arki/tsconfig': patch
'@arki/eslint-config': patch
'@arki/prettier-config': patch
'@arki/vitest-config': patch
'@arki/playwright-config': patch
'@arki/library-tooling': patch
---

First npm release of the shared tooling configs.

- `@arki/tsconfig`: strict base, React, Next.js and internal-package tsconfig presets.
- `@arki/eslint-config`: base, library, React and TanStack Start flat configs, plus the feature-layer rules.
- `@arki/prettier-config`: the shared Prettier config with import, class and package.json sorting.
- `@arki/vitest-config`: the shared Vitest base config.
- `@arki/playwright-config`: `createPlaywrightConfig` and `e2ePolicy` for Playwright suites.
- `@arki/library-tooling`: the library check, layer, runtime, doc-example and index bins.
