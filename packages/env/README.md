# @arki/env

Type-safe environment variables for ARKI. `defineEnv()` wraps [`@t3-oss/env-core`](https://env.t3.gg/). It validates on the first read and returns a typed object. Any [Standard Schema](https://standardschema.dev) works: Zod, Valibot, ArkType or a hand-written `~standard` object.

## Install

```sh
bun add @arki/env
```

## Quick start

Declare the variables once. Read them anywhere. A bad value throws on the first read, never at import.

```ts run expect
import { presets } from '@arki/env/presets';
import { defineEnv } from '@arki/env/core';

const env = defineEnv({
  server: {
    PORT: presets.port(3000),
    DATABASE_URL: presets.url(),
  },
  runtimeEnv: { PORT: '8080', DATABASE_URL: 'https://db.example.com' },
});

console.log(env.PORT, typeof env.PORT);
console.log(env.DATABASE_URL);
```

```text
8080 number
https://db.example.com
```

Leave out `runtimeEnv` in a server app. `defineEnv` then reads `globalThis.process?.env` on the first access.

## When not to use this

- You need a config file, layered sources or hot reload. This package reads environment variables only.
- Your validator is asynchronous. Validation is synchronous.
- You need the secret to stay hidden from code in the same process. `secret()` stops accidents in logs. It is not encryption.

## Runtime support

`@arki/env/core` and `@arki/env/presets` run on Node, Bun, Deno, browsers and React Native (Hermes). Nothing reads the environment at import. On an engine with no `process`, pass `runtimeEnv`. A browser cannot read server keys, so declare client keys (`clientPrefix`) for code that ships to it. The Dot adapter lives in `@arki/dot/env`. `bun run test:runtimes` runs a smoke test of the built package on each runtime. The Hermes leg needs `HERMES_BIN`.

`@arki/env/node` (encrypted env files) runs on Node, Bun and Deno only. It reads files and starts provider CLIs.

## Public imports

- `@arki/env/core`: `defineEnv`, `secret`, `reveal`, `Redacted`, `describeEnv`, `isSecretSchema`, `formatIssues`.
- `@arki/env/presets`: `presets` and the per-category namespaces `commonPresets`, `urlPresets`, `parsePresets`.
- `@arki/env`: re-exports `presets`.
- `@arki/env/node`: `loadEnvFiles`, `secretValues`, `formatEnvFilesErrors`, `ENV_FILES_ERROR_CODES`, the codec (`encryptValue`, `decryptValue`, `generateKeypair`, `parseEnv`, …), the file edits behind `dot env`, `findPrivateKey` and `DEFAULT_RESOLVERS`.
- `@arki/env/node/register`: a side-effect import that loads the env files into `process.env`.

## Secrets

Wrap a secret's schema in `secret(...)`. The variable becomes a `Redacted` value. It prints as `[redacted]` in logs, JSON, template strings and `console.log`. The compiler will not pass it where a string is expected. Read it with `reveal(...)` at the one place that needs it. For an optional secret, call `.optional()` on the result. A missing variable then stays `undefined`.

```ts run expect
import { z } from 'zod';

import { defineEnv, reveal, secret } from '@arki/env/core';

const env = defineEnv({
  server: { STRIPE_KEY: secret(z.string().min(1)) },
  runtimeEnv: { STRIPE_KEY: 'sk_live_123' },
});

console.log(String(env.STRIPE_KEY));
console.log(reveal(env.STRIPE_KEY));
```

```text
[redacted]
sk_live_123
```

`reveal` also accepts the raw string, because schemas do not run when validation is skipped.

## Encrypted env files

Commit `.env.<environment>` files with their secrets encrypted. The format is dotenvx 2.x, so the `dotenvx` CLI reads the same files. Each file holds a public key, so anyone can add a value. Only a holder of the private key can read one. The private key lives in `DOTENV_PRIVATE_KEY_<ENV>` (for `.env.production`: `DOTENV_PRIVATE_KEY_PRODUCTION`) or in the gitignored `.env.keys` file.

Edit the files with `dot env` from `@arki/dot`:

```sh
dot env init                     # public key header + private key for .env.development
dot env set STRIPE_KEY --stdin   # stored encrypted; the value never appears in argv
dot env set PORT 3000 --plain    # refused when the schema declares PORT secret()
dot env run -- bun run dev       # load, decrypt, run; secrets redacted when output is piped
dot env check                    # CI gate: no tracked key file, no plaintext secret()
```

Load the files once, at the top of a process. Use `dot env run -- <command>` (the app templates' `with-env` script does), or make `import '@arki/env/node/register'` the first import of an entry. Both write into `process.env`, because package envs such as `@arki/db/env` read it.

- The real environment wins. A file never replaces a value that is already set; a different value is reported as shadowed.
- The environment is `NODE_ENV`, else `development`. Files load from the repository root down to the working directory. A deeper folder wins, and `.env.local` wins over `.env.<environment>`. Under `test`, `.env.local` is skipped.
- A value can be a reference: `op://vault/item/field`, `infisical://…` or `doppler://…`. The provider's CLI resolves it at load. A public key (`VITE_`, `NEXT_PUBLIC_`, `PUBLIC_`, `EXPO_PUBLIC_`) is never filled from a reference.
- Keys that change how a process runs (`PATH`, `NODE_OPTIONS`, `LD_*`, TLS settings and more) are never loaded from a file.
- A private key is needed only when a value needs it. A key already set in the environment needs no decryption.
- `defineEnv` refuses a value that is still `encrypted:`, so ciphertext never passes as a string.

Mask loaded secrets in logs, wherever they appear:

```ts skip="needs encrypted env files on disk"
import { configure, maskSecrets } from '@arki/log';
import { secretValues } from '@arki/env/node';

configure({ processors: [maskSecrets(secretValues)] });
```

| Code                  | Meaning                                                  |
| --------------------- | -------------------------------------------------------- |
| `ARKI_ENV_FILES_E001` | A file has encrypted values and no private key was found. |
| `ARKI_ENV_FILES_E002` | A value did not decrypt with the key that was found.     |
| `ARKI_ENV_FILES_E003` | A reference could not be resolved by its provider CLI.   |

Messages name the file and the key, never a value.

## Presets

The `presets` namespace holds common variable shapes:

- Common: `string`, `number`, `boolean`, `port`, `nodeEnv`, `logLevel`.
- URLs: `url`, `databaseUrl`, `redisUrl`.
- Parsing: `json(schema)`, `csvArray(itemSchema)`, `csvSet(itemSchema)`.

```ts run expect
import { z } from 'zod';

import { presets } from '@arki/env/presets';
import { defineEnv } from '@arki/env/core';

const env = defineEnv({
  server: {
    ALLOWED_ORIGINS: presets.csvArray(z.string()),
    FEATURES: presets.json(z.object({ beta: z.boolean() })),
  },
  runtimeEnv: { ALLOWED_ORIGINS: 'a,b,c', FEATURES: '{"beta":true}' },
});

console.log(env.ALLOWED_ORIGINS);
console.log(env.FEATURES);
```

```text
[ "a", "b", "c" ]
{
  beta: true,
}
```

## Failure behaviour

`defineEnv` throws an `Error` on the first read of a bad environment. The message starts with your `name` and lists one `path: message` line per issue. Set `options.onValidationError` to throw something else.

```ts run expect
import { presets } from '@arki/env/presets';
import { defineEnv } from '@arki/env/core';

const env = defineEnv({
  server: { PORT: presets.port(), DATABASE_URL: presets.url() },
  runtimeEnv: { PORT: 'abc' },
});

try {
  console.log(env.PORT);
} catch (error) {
  console.log(error instanceof Error ? 'invalid environment' : 'unknown');
}
```

```text
invalid environment
```

The Dot adapter (`env()` from `@arki/dot/env`) validates at boot. A bad environment stops `boot()` with `ARKI_ENV_PLUGIN_E001`. Its `remediation` tells you to set the listed variables. `dot explain` never validates.

Handle it by fixing the variables. Do not catch the error and continue with defaults.

## Limits

- Validation runs in every environment, production, CI and tests included. `NODE_ENV`, `CI` and `lint` never skip it.
- The only implicit opt-out is `SKIP_ENV_VALIDATION=1`, exactly `1`. Use it only in build stages that run without secrets. `SKIP_ENV_VALIDATION=true` does not skip.
- `options.skipValidation` overrides the variable in code.
- Validation is synchronous. Validation is lazy, so a bad value shows at the first read, not at import.
- With validation skipped, schemas do not run. Values are raw strings. `reveal` still works on them.

## Documentation

- [Agent guide](docs/agent-guide.md): tasks and rules for agents.
- [Upgrade 0.0.11 to 0.1.0](docs/upgrades/0.0.11-to-0.1.0.md): what broke and how to migrate.
- [Upgrade 0.1.0 to 0.2.0](docs/upgrades/0.1.0-to-0.2.0.md): the Dot adapter moved to `@arki/dot/env`.
- The Dot adapter `@arki/dot/env` publishes `env` through `provides`. Consumers write `needs: { env: envPlugin.provides.env }`. See the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot) package for plugin authoring and lifecycle.

## Support

Report bugs at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).

<!-- bench:start -->

## Benchmarks

Defining and validating a 15-variable server environment with `defineEnv()`, against `@t3-oss/env-core` (which it wraps), envalid, and a plain zod object parse.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Define + validate 15 variables + read one value

Each call builds a fresh environment from scratch, validates every variable, then reads `PORT`.

| Library                                      | Time / op | vs fastest |
| -------------------------------------------- | --------: | ---------: |
| @arki/env defineEnv()                        |  25.03 µs |    fastest |
| @t3-oss/env-core createEnv() (used directly) | 306.02 µs |     12.22× |
| envalid cleanEnv()                           |  59.23 µs |      2.37× |
| zod z.object().parse(process.env)            | 177.92 µs |      7.11× |

### Define only (no read)

Declare the environment and never read it. `defineEnv()` defers all work to the first read; the others validate immediately.

| Library                                           | Time / op | vs fastest |
| ------------------------------------------------- | --------: | ---------: |
| @arki/env defineEnv() (lazy, no validation yet)   |  126.8 ns |    fastest |
| @t3-oss/env-core createEnv() (validates now)      | 519.07 µs |   4094.95× |
| envalid cleanEnv() (validates now)                | 115.66 µs |    912.46× |
| zod z.object().parse(process.env) (validates now) | 431.26 µs |   3402.26× |

### Read one value from an already-validated environment

The hot path: `env.PORT` after the environment exists.

| Library                                | Time / op | vs fastest |
| -------------------------------------- | --------: | ---------: |
| @arki/env (lazy object over createEnv) |  229.1 ns |     28.25× |
| @t3-oss/env-core createEnv()           |   50.3 ns |      6.20× |
| envalid cleanEnv()                     |   83.8 ns |     10.34× |
| zod parsed plain object                |    8.1 ns |    fastest |

Read the rows with the presets in mind:

- `defineEnv()` is lazy: it builds and validates the environment on the first property read, so "define + first read" is the fair row for it. The "define only" group shows what declaring an env costs before anything reads it.
- Validation is forced on (`skipValidation: false`) for `defineEnv()` and `createEnv`, so the numbers do not depend on `SKIP_ENV_VALIDATION`.
- `defineEnv()` and `createEnv` share the same zod schemas, so the gap between them is the wrapper alone: building `runtimeEnv` from `process.env`, a labelled error handler, and the lazy object. envalid uses its own validators, and the plain zod parse does no env-specific work (no empty-string handling, no frozen result).
- `createEnv`, envalid and the zod parse are given the whole `process.env`, as their docs show, so their cost grows with how many variables the process has. `defineEnv()` reads only the keys it declares. The gap therefore depends on the size of the environment it runs in.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT. See [LICENSE](./LICENSE).
