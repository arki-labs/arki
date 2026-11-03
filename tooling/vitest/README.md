# @arki/vitest-config

The Vitest base config ARKI projects share. It ships TypeScript source, so Vitest (which uses Vite) or a bundler must load it. There is no build.

## Install

This config is not published to npm. It is used inside this repo only. A package here adds it as a workspace dependency:

```json
{ "devDependencies": { "@arki/vitest-config": "workspace:*" } }
```

## Use

```ts
import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '@arki/vitest-config';

export default mergeConfig(baseConfig, defineConfig({ test: { include: ['src/**/*.test.ts'] } }));
```

The base sets `globals: true` and `environment: 'node'`. Merge your own options on top.

## Limits

- It is the base only. Add `jsdom`, React or coverage settings in your own config. The dependencies (`jsdom`, Testing Library, `@vitejs/plugin-react`, coverage) install with the package.
- Source only: a tool that cannot read `.ts` from `node_modules` will fail.

## Support

Issues and source: [arki-labs/arki](https://github.com/arki-labs/arki/tree/main/tooling/vitest).
