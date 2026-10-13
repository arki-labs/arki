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

<!-- bench:start -->
## Benchmarks

Defining and validating a 15-variable server environment with `defineEnv()`, against `@t3-oss/env-core` (which it wraps), envalid, and a plain zod object parse.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Define + validate 15 variables + read one value

Each call builds a fresh environment from scratch, validates every variable, then reads `PORT`.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/env defineEnv() | 25.03 µs | fastest |
| @t3-oss/env-core createEnv() (used directly) | 306.02 µs | 12.22× |
| envalid cleanEnv() | 59.23 µs | 2.37× |
| zod z.object().parse(process.env) | 177.92 µs | 7.11× |

### Define only (no read)

Declare the environment and never read it. `defineEnv()` defers all work to the first read; the others validate immediately.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/env defineEnv() (lazy, no validation yet) | 126.8 ns | fastest |
| @t3-oss/env-core createEnv() (validates now) | 519.07 µs | 4094.95× |
| envalid cleanEnv() (validates now) | 115.66 µs | 912.46× |
| zod z.object().parse(process.env) (validates now) | 431.26 µs | 3402.26× |

### Read one value from an already-validated environment

The hot path: `env.PORT` after the environment exists.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/env (lazy object over createEnv) | 229.1 ns | 28.25× |
| @t3-oss/env-core createEnv() | 50.3 ns | 6.20× |
| envalid cleanEnv() | 83.8 ns | 10.34× |
| zod parsed plain object | 8.1 ns | fastest |

Read the rows with the contracts in mind:

- `defineEnv()` is lazy: it builds and validates the environment on the first property read, so "define + first read" is the fair row for it. The "define only" group shows what declaring an env costs before anything reads it.
- Validation is forced on (`skipValidation: false`) for `defineEnv()` and `createEnv`, because `defineEnv()` skips validation outside development by default.
- `defineEnv()` and `createEnv` share the same zod schemas, so the gap between them is the wrapper alone: building `runtimeEnv` from `process.env`, a labelled error handler, and the lazy object. envalid uses its own validators, and the plain zod parse does no env-specific work (no empty-string handling, no frozen result).
- `createEnv`, envalid and the zod parse are given the whole `process.env`, as their docs show, so their cost grows with how many variables the process has. `defineEnv()` reads only the keys it declares. The gap therefore depends on the size of the environment it runs in.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT — see [LICENSE](./LICENSE).
