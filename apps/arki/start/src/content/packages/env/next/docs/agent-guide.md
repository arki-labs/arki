# @arki/env for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. `defineEnv({ server, client, shared, runtimeEnv })` returns a typed object. It validates on the first read.
2. A schema is any Standard Schema. Each value is typed as the schema's output, so defaults and coercions apply.
3. `contracts` holds ready-made shapes: ports, URLs, comma lists and JSON.
4. `secret(schema)` makes a `Redacted` value. It prints as `[redacted]`. `reveal(value)` returns the raw string.
5. `@arki/env/dot` turns the same options into a Dot plugin that validates at boot.
6. The package reads no environment at import and does not need `process`.

## Task map

### Define the environment of an app

1. Create one `env.ts`.
2. Declare each variable with a contract or your own schema.
3. Import `env` where you need a value.

```ts
import { contracts } from '@arki/env/contracts';
import { defineEnv } from '@arki/env/core';

export const env = defineEnv({
  server: {
    PORT: contracts.port(3000),
    DATABASE_URL: contracts.databaseUrl(),
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

### Build a Docker image without secrets

Set `SKIP_ENV_VALIDATION=1` in the build stage only. Do not set it in the run stage.

### Validate at boot in a Dot app

```ts skip="needs a Dot app; see the plugin tests in src/dot.test.ts"
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { env } from '@arki/env/dot';

const app = await defineApp('my-app')
  .use(env({ schema: { PORT: z.coerce.number().default(3000) } }))
  .build();
```

## Rules that bite

- `SKIP_ENV_VALIDATION=true` does not skip. Only exactly `1` does.
- `CI`, `lint` and `NODE_ENV` never skip validation.
- With validation skipped, schemas do not run. Values are raw strings.
- Do not call `.parse` on a `secret()` result. Use `['~standard'].validate(value)`.
- Pass `runtimeEnv` on engines with no `process`.
- Client keys need the `clientPrefix`.

## Errors

| Code or error            | Meaning                                     | What to do                                                       |
| ------------------------ | ------------------------------------------- | ---------------------------------------------------------------- |
| `Error` from `defineEnv` | A variable failed its schema on first read. | Read the `path: message` lines. Fix the variables.               |
| `ARKI_ENV_PLUGIN_E001`   | The Dot plugin found a bad env at boot.     | Set the listed variables before booting. Do not skip validation. |

## Verify

```sh
bun run test
bun run test:docs
dot explain --json | jq '.data.services'   # in a Dot app: env is listed, nothing is validated
dot doctor --json | jq '.data'             # boots the app: a bad env fails here with ARKI_ENV_PLUGIN_E001
```
