# @arki/env

Type-safe environment variable parsing for ARKI. `defineEnv()` is a thin wrapper around [`@t3-oss/env-core`](https://env.t3.gg/) with Zod contracts for common variable shapes — ports, URLs, comma-separated lists, JSON, and more.

## Installation

```sh
npm install @arki/env
# or
bun add @arki/env
# or
pnpm add @arki/env
```

## Usage

### `defineEnv`

```ts
import { defineEnv } from '@arki/env/core';
import { contracts } from '@arki/env/contracts';

export const env = defineEnv({
  server: {
    NODE_ENV: contracts.nodeEnv(),
    PORT: contracts.port(3000),
    DATABASE_URL: contracts.url(),
    LOG_LEVEL: contracts.string('info'),
  },
});

console.log(env.PORT); // number
console.log(env.DATABASE_URL); // string (validated URL)
```

`defineEnv` reads from `process.env`, validates against the Zod schemas in `server`, and returns a fully typed object. It skips validation when `CI` is set or `NODE_ENV !== 'development'` unless you override via `options.skipValidation`.

### Contracts

The `contracts` namespace bundles common variable shapes so you do not have to assemble them by hand. The categories:

- **Common**: `string`, `number`, `boolean`, `port`, `nodeEnv`.
- **URLs**: `url`, `httpsUrl`, `postgresUrl`, `redisUrl`.
- **Parsing**: `csv`, `json`, `keyValue`.

```ts
import { contracts } from '@arki/env/contracts';

const env = defineEnv({
  server: {
    ALLOWED_ORIGINS: contracts.csv(),       // 'a,b,c' → ['a', 'b', 'c']
    FEATURE_FLAGS: contracts.json(),         // JSON-parsed
    SERVICE_TAGS: contracts.keyValue(),      // 'a=1,b=2' → { a: '1', b: '2' }
  },
});
```

## API

- `@arki/env/core`
  - `defineEnv(config)` — validate `process.env` and return a typed object.
- `@arki/env/contracts`
  - `contracts` — flattened namespace of all built-in Zod contracts.
  - `commonContracts`, `urlContracts`, `parseContracts` — per-category namespaces.
- `@arki/env`
  - Re-exports `contracts` from `@arki/env/contracts`.

## Documentation

`@arki/env` ships an optional `@arki/env/dot` adapter for the
[`@arki/dot`](https://www.npmjs.com/package/@arki/dot) framework.

- See `packages/dot/docs/` in the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
  package for plugin authoring, lifecycle, diagnostics, and the
  [adapter authoring guide](https://github.com/arkijs/arki/blob/main/packages/dot/docs/adapter-authoring.md).

## License

MIT — see [LICENSE](./LICENSE).
