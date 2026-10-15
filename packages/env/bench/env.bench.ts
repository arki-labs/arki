// Speed of defineEnv() against the usual ways to read a typed environment.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Every `compare` group states a contract and is checked before timing: each
// ranked library must return the same parsed values for every input. Each case
// is given the same environment object explicitly, so every library parses the
// same 15 values (see the notes for what that leaves out).

import { createEnv } from '@t3-oss/env-core';
import { bool, cleanEnv, num, port, str, url } from 'envalid';
import { z } from 'zod';

import { compare, defineSuite, scenario } from '@arki/bench';
import { defineEnv } from '@arki/env/core';

type Vars = Record<string, string>;

// A realistic 15-variable server environment: strings, numbers, URLs, enums, booleans.
const base: Vars = {
  APP_NAME: 'billing',
  REGION: 'eu-central',
  HOST: '0.0.0.0',
  PORT: '8080',
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  DEBUG: 'false',
  CACHE_ENABLED: 'true',
  TIMEOUT_MS: '30000',
  MAX_CONNECTIONS: '20',
  RETRIES: '3',
  DATABASE_URL: 'postgres://user:pass@db.internal:5432/app',
  REDIS_URL: 'redis://cache.internal:6379',
  PUBLIC_URL: 'https://example.com',
  FEATURE_MODE: 'beta',
};

// Inputs vary in value and cover the boundaries where zod and envalid coercion could part ways:
// port limits, negative and fractional numbers, exponent notation, both booleans, unicode text.
const inputs: readonly Vars[] = [
  base,
  { ...base, PORT: '1', DEBUG: 'true', CACHE_ENABLED: 'false', NODE_ENV: 'development' },
  { ...base, PORT: '65535', TIMEOUT_MS: '-5', MAX_CONNECTIONS: '0', LOG_LEVEL: 'debug' },
  { ...base, TIMEOUT_MS: '1.5', RETRIES: '1e3', FEATURE_MODE: 'alpha', NODE_ENV: 'test' },
  { ...base, APP_NAME: 'facturi-ăîșțâ', REGION: 'us-east-1', FEATURE_MODE: 'stable', LOG_LEVEL: 'error' },
];

const flag = z.enum(['true', 'false']).transform(v => v === 'true');
const shape = {
  APP_NAME: z.string(),
  REGION: z.string(),
  HOST: z.string(),
  PORT: z.coerce.number().int().min(1).max(65_535),
  NODE_ENV: z.enum(['development', 'production', 'test']),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']),
  DEBUG: flag,
  CACHE_ENABLED: flag,
  TIMEOUT_MS: z.coerce.number(),
  MAX_CONNECTIONS: z.coerce.number(),
  RETRIES: z.coerce.number(),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  PUBLIC_URL: z.url(),
  FEATURE_MODE: z.enum(['alpha', 'beta', 'stable']),
};

const envalidSpec = {
  APP_NAME: str(),
  REGION: str(),
  HOST: str(),
  PORT: port(),
  NODE_ENV: str({ choices: ['development', 'production', 'test'] }),
  LOG_LEVEL: str({ choices: ['debug', 'info', 'warn', 'error'] }),
  DEBUG: bool(),
  CACHE_ENABLED: bool(),
  TIMEOUT_MS: num(),
  MAX_CONNECTIONS: num(),
  RETRIES: num(),
  DATABASE_URL: url(),
  REDIS_URL: url(),
  PUBLIC_URL: url(),
  FEATURE_MODE: str({ choices: ['alpha', 'beta', 'stable'] }),
};

const keys = Object.keys(shape) as (keyof typeof shape)[];

/** The parsed values in declaration order, as stable JSON. Drops anything else a library adds. */
const values = (env: Record<keyof typeof shape, unknown>): string => JSON.stringify(keys.map(key => [key, env[key]]));

// Validation is forced on for both wrappers: defineEnv skips it outside development by default.
const arki = (vars: Vars) => defineEnv({ server: shape, runtimeEnv: vars, options: { skipValidation: false } });
const t3 = (vars: Vars) =>
  createEnv({
    server: shape,
    client: {},
    shared: {},
    clientPrefix: '',
    runtimeEnv: vars,
    skipValidation: false,
    emptyStringAsUndefined: true,
  });
const envalid = (vars: Vars) =>
  cleanEnv(vars, envalidSpec, {
    reporter: () => {
      /* envalid failures surface as thrown errors; the log is noise */
    },
  });
const plainZod = (vars: Vars) => z.object(shape).parse(vars);

export default defineSuite({
  id: '@arki/env',
  intro:
    'Defining and validating a 15-variable server environment with `defineEnv()`, against `@t3-oss/env-core` (which it wraps), envalid, and a plain zod object parse.',
  notes: [
    '`defineEnv()` is lazy: it builds and validates the environment on the first property read, so "define + validate + read" is the fair row for it. The "define only" group shows what declaring an env costs before anything reads it.',
    'Validation is forced on (`skipValidation: false`) for `defineEnv()` and `createEnv`, because `defineEnv()` skips validation by default when `CI` is set.',
    '`defineEnv()` and `createEnv` share the same zod schemas, so the gap between them is the wrapper alone: copying the declared keys, a labelled error handler, and the lazy object. envalid uses its own validators, and the plain zod parse does no env-specific work (no empty-string handling, no frozen result).',
    'Every case gets the same 15-key object (`runtimeEnv`) instead of `process.env`. Without that, `defineEnv()` copies only the keys it declares from `process.env`, while `createEnv`, envalid and a zod parse are shown reading the whole `process.env`, so their cost would also grow with the size of the process environment. That difference is not measured here.',
    'Only valid environments are measured. What happens on invalid input (error text, throw versus exit, collecting every issue) differs between the libraries and is not compared. Inputs avoid values where coercion rules differ (hex numbers, empty strings).',
  ],
  groups: [
    compare<Vars>({
      id: 'define-validate-read',
      title: 'Define + validate 15 variables + read one value',
      note: 'Each call builds a fresh environment from the input, validates every variable and reads `PORT`. The result is every parsed value.',
      contract: {
        id: 'env-parse/v1',
        description: 'all 15 variables parsed to the same typed values (numbers as numbers, flags as booleans)',
      },
      inputs,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/env defineEnv()',
          package: '@arki/env',
          run: vars => {
            const env = arki(vars);
            // The first read triggers the lazy build and validation.
            void env.PORT;
            return env;
          },
          normalize: values,
        }),
        t3: c({
          label: '@t3-oss/env-core createEnv() (used directly)',
          package: '@t3-oss/env-core',
          run: vars => {
            const env = t3(vars);
            void env.PORT;
            return env;
          },
          normalize: values,
        }),
        envalid: c({
          label: 'envalid cleanEnv()',
          package: 'envalid',
          run: vars => {
            const env = envalid(vars);
            void env.PORT;
            return env;
          },
          normalize: values,
        }),
        zod: c({
          label: 'zod z.object().parse()',
          package: 'zod',
          run: vars => {
            const env = plainZod(vars);
            void env.PORT;
            return env;
          },
          normalize: values,
        }),
      }),
    }),
    scenario<Vars>({
      kind: 'scenario',
      id: 'define-only',
      title: 'Define only (no read)',
      note: 'Declare the environment and never read it. `defineEnv()` defers all work to the first read; the others validate immediately, so these rows do different work and are not ranked.',
      inputs,
      cases: c => ({
        arki: c({
          label: '@arki/env defineEnv() (lazy, no validation yet)',
          package: '@arki/env',
          run: vars => arki(vars),
        }),
        t3: c({
          label: '@t3-oss/env-core createEnv() (validates now)',
          package: '@t3-oss/env-core',
          run: vars => t3(vars),
        }),
        envalid: c({
          label: 'envalid cleanEnv() (validates now)',
          package: 'envalid',
          run: vars => envalid(vars),
        }),
        zod: c({
          label: 'zod z.object().parse() (validates now)',
          package: 'zod',
          run: vars => plainZod(vars),
        }),
      }),
    }),
    compare<Vars>({
      id: 'read-one',
      title: 'Read one value from an already-validated environment',
      note: 'The hot path: `env.PORT` after the environment exists.',
      contract: { id: 'env-read-port/v1', description: 'the parsed PORT as a number' },
      inputs,
      expected: vars => String(Number(vars.PORT)),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/env (lazy object over createEnv)',
          package: '@arki/env',
          setup: vars => {
            const env = arki(vars);
            void env.PORT; // build now, outside the timed run
            return env;
          },
          run: env => env.PORT,
          normalize: String,
        }),
        t3: c({
          label: '@t3-oss/env-core createEnv()',
          package: '@t3-oss/env-core',
          setup: t3,
          run: env => env.PORT,
          normalize: String,
        }),
        envalid: c({
          label: 'envalid cleanEnv()',
          package: 'envalid',
          setup: envalid,
          run: env => env.PORT,
          normalize: String,
        }),
        zod: c({
          label: 'zod parsed plain object',
          package: 'zod',
          setup: plainZod,
          run: env => env.PORT,
          normalize: String,
        }),
      }),
    }),
  ],
});
