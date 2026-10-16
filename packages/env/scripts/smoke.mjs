// Cross-runtime smoke test for the BUILT package (dist/). Runs under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser and Hermes targets.
// Keys are client keys (prefix `APP_`) because a browser may not read server keys.

import { z } from 'zod';

import { contracts, defineEnv, reveal, secret } from '../dist/core/index.js';
import { contracts as rootContracts } from '../dist/index.js';

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(`smoke check failed: ${message}`);
  checks += 1;
}

// Explicit runtimeEnv works on every engine, with or without `process`.
const env = defineEnv({
  name: 'smoke',
  server: {},
  clientPrefix: 'APP_',
  client: { APP_PORT: contracts.port(), APP_NAME: z.string().default('app') },
  runtimeEnv: { APP_PORT: '8080' },
});
check(env.APP_PORT === 8080, 'a port string is coerced to a number');
check(env.APP_NAME === 'app', 'a default applies when the key is absent');
check(rootContracts === contracts, 'the root entry re-exports the same contracts');

// Lazy by design: declaring an env reads nothing.
let reads = 0;
const source = { APP_A: 'x' };
const lazy = defineEnv({
  server: {},
  clientPrefix: 'APP_',
  client: { APP_A: z.string() },
  runtimeEnv: new Proxy(source, {
    get: (target, key) => {
      reads += 1;
      return Reflect.get(target, key);
    },
  }),
});
check(reads === 0, 'declaring an env does not read the source');
check(lazy.APP_A === 'x' && reads > 0, 'the first access reads the source');

// Without a runtimeEnv, engines with no `process` global see no values instead of a ReferenceError.
const auto = defineEnv({ server: {}, clientPrefix: 'APP_', client: { APP_SMOKE_UNSET: z.string().optional() } });
check(auto.APP_SMOKE_UNSET === undefined, 'an unset key reads as undefined');

// A bad value fails loud, through onValidationError.
let message = '';
try {
  const bad = defineEnv({
    name: 'smoke-bad',
    server: {},
    clientPrefix: 'APP_',
    client: { APP_PORT: z.coerce.number() },
    runtimeEnv: { APP_PORT: 'nope' },
    options: {
      onValidationError: () => {
        throw new Error('rejected');
      },
    },
  });
  void bad.APP_PORT;
} catch (error) {
  message = error.message;
}
check(message === 'rejected', 'validation errors go through onValidationError');

// Secrets hide their value until revealed.
const token = secret(z.string()).parse('hunter2');
check(!String(token).includes('hunter2'), 'a secret does not print its value');
check(reveal(token) === 'hunter2', 'reveal returns the value');

console.log(`${checks} smoke checks passed`);
