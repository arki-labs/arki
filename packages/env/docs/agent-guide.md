# @arki/env for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. `defineEnv({ server, client, shared, runtimeEnv })` returns a typed object. It validates on the first read.
2. A schema is any Standard Schema. Each value is typed as the schema's output, so defaults and coercions apply.
3. `presets` holds ready-made shapes: ports, URLs, comma lists and JSON.
4. `secret(schema)` makes a `Redacted` value. It prints as `[redacted]`. `reveal(value)` returns the raw string.
5. `env()` from `@arki/dot/env` turns the same options into a Dot plugin that validates at boot.
6. The package reads no environment at import and does not need `process`.
7. `@arki/env/node` loads committed `.env.<environment>` files (dotenvx format, values encrypted) into `process.env`. The real environment always wins.

## Task map

### Define the environment of an app

1. Create one `env.ts`.
2. Declare each variable with a preset or your own schema.
3. Import `env` where you need a value.

```ts
import { defineEnv } from '@arki/env/core';
import { presets } from '@arki/env/presets';

export const env = defineEnv({
  server: {
    PORT: presets.port(3000),
    DATABASE_URL: presets.databaseUrl(),
  },
});
```

### Keep a secret out of logs

```ts
import { z } from 'zod';

import { defineEnv, reveal, secret } from '@arki/env/core';

const env = defineEnv({ server: { API_KEY: secret(z.string().min(1)) } });

export const apiKey = (): string => reveal(env.API_KEY);
```

### Commit secrets, encrypted

Use `dot env`, never a text editor, for secret values. Never print a value to check it.

```sh
printf %s "$API_KEY" | dot env set API_KEY --stdin   # stored encrypted, never in argv
dot env ls --json                          # keys and kinds, never values
dot env explain API_KEY --json             # which file and which key source, no value
dot env check --json                       # must be ok before committing
dot env run -- bun run test                # run with the files loaded
```

Do not read `.env.keys`. Agents are denied it. A process you start with `dot env run` gets the values but never the private key.

### Load env files outside `dot env run`

Make `import '@arki/env/node/register'` the first import of the process entry. This explicit boot import throws on returned load failures. Direct `loadEnvFiles()` callers check `isFailure` and handle `EnvFilesFailed.data.errors`, cancellation or deadline before starting work.

### Build a Docker image without secrets

Set `SKIP_ENV_VALIDATION=1` in the build stage only. Do not set it in the run stage.

### Validate at boot in a Dot app

```ts skip="needs a Dot app; see the adapter tests in packages/dot/src/env.test.ts"
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { env } from '@arki/dot/env';

const app = await defineApp('pizzeria')
  .infra(env({ schema: { PORT: z.coerce.number().default(3000) } }))
  .build();
```

## Rules that bite

- `SKIP_ENV_VALIDATION=true` does not skip. Only exactly `1` does.
- `CI`, `lint` and `NODE_ENV` never skip validation.
- With validation skipped, schemas do not run. Values are raw strings.
- Do not call `.parse` on a `secret()` result. Use `['~standard'].validate(value)`.
- Pass `runtimeEnv` on engines with no `process`.
- Client keys need the `clientPrefix`.
- Load env files before any module that reads `process.env`: `register` first, or `dot env run`.
- Commit only `.env.<environment>`. Bare `.env`, `.env.local` and `.env.keys*` stay untracked.
- `dot env check` fails when the schema cannot be read and a tracked file has a plain value. Run it under Bun (`bun --bun dot env check`) or encrypt the value.

## Errors

| Code or error             | Meaning                                     | What to do                                                           |
| ------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `Error` from `defineEnv`  | A variable failed its schema on first read. | Read the `path: message` lines. Fix the variables.                   |
| `ARKI_ENV_PLUGIN_E001`    | The Dot plugin found a bad env at boot.     | Set the listed variables before booting. Do not skip validation.     |
| `env.missing_private_key` | Encrypted values and no private key.        | Export the `DOTENV_PRIVATE_KEY_<ENV>` named, or `dot env keys pull`. |
| `env.decryption_failed`   | A value did not decrypt.                    | `dot env explain <KEY>`; set it again with `dot env set --stdin`.    |
| `env.reference_failed`    | A reference did not resolve.                | Sign in to the provider CLI named in the message.                    |

### Handle node operations

Use `isFailure` before reading a generated keypair, loaded report, edit result or private-key source. Parse external strings with `parsePublicKey` / `parsePrivateKey`; never cast key brands. Expected filesystem/crypto/provider rejection is returned. Boot declaration misuse still throws.

Pass a shared `timeoutMs` and optional `signal` to `loadEnvFiles`. Providers receive the remaining synchronous read budget; native subprocesses time out. Cancellation is cooperative between synchronous callbacks. Provider stderr stays in the local private cause.

Keep `.env.keys` after `RotationIncomplete`. Every existing candidate local key store is staged as well as the root. Their existing comma-list format holds old and new generations; use it to retry. Old keys are removed only after every rewritten file reads back exactly as planned. Never print the file or attach keys to diagnostics.

Node/provider OpenTelemetry is enabled through the API without SDK setup. It emits only bounded operation/outcome data, never file paths, references or secret bytes. Local declarations, schemas, text parsing and crypto helpers do not create redundant spans.

## Verify

```sh
bun run test
bun run test:docs
dot explain --json | jq '.data.services'   # in a Dot app: env is listed, nothing is validated
dot doctor --json | jq '.data'             # boots the app: a bad env fails here with ARKI_ENV_PLUGIN_E001
```
