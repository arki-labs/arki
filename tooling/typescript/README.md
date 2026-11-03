# @arki/tsconfig

Shared `tsconfig` files for ARKI projects. It ships JSON only. There is no build and no code.

## Install

This config is not published to npm. It is used inside this repo only. A package here adds it as a workspace dependency:

```json
{ "devDependencies": { "@arki/tsconfig": "workspace:*" } }
```

## Use

Extend one file from your `tsconfig.json`.

```json
{
  "extends": "@arki/tsconfig/base.json"
}
```

| File                    | What it adds on top of `base.json`                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `base.json`             | Strict mode, ES2022 target, no incremental builds, `isolatedModules`.                       |
| `react.json`            | DOM libs and `jsx: preserve`. Extends `base.json`.                                          |
| `next.json`             | The Next.js plugin and `module: esnext`. Extends `react.json`.                              |
| `internal-package.json` | Emits only declarations to `dist/`. For packages that ship types and source. Extends `base.json`. |

## Limits

- `react.json` lists `types` for `unplugin-icons` and `@tanstack/start-client-core`. Install them, or override `compilerOptions.types`.
- Pin your own `include`, `outDir` and `rootDir`. The files set none of them, except `internal-package.json`.
- `base.json` turns incremental builds off on purpose. A stale `.tsbuildinfo` hid errors after a dependency upgrade.

## Support

Issues and source: [arki-labs/arki](https://github.com/arki-labs/arki/tree/main/tooling/typescript).
