/** Validated database environment variables (`DB_URL`, pool sizes and timeouts). */
import { z } from '@arki/contracts';
import { defineEnv } from '@arki/env/core';

import { poolEnvSchema, poolRuntimeEnv } from './pool-env.js';

export const env = defineEnv({
  name: '@arki/db',
  /**
   * Environment variables schema for database services (PostgreSQL).
   * Everything but the URL is shared with `poolEnv` (`./pool-env.ts`).
   */
  server: {
    ...poolEnvSchema,
    // Database Connection - Primary method (connection string)
    // DB_URL is the canonical @arki/db name. DATABASE_URL (PG/Coolify/12-factor
    // standard) is also accepted as a fallback via the runtimeEnv alias below,
    // which resolves to this same `env.DB_URL` field so consumers don't change.
    DB_URL: z.url(),
    // The direct (non-pooled) URL for LISTEN, session locks and migrations, when
    // DB_URL goes through a transaction pooler (Neon -pooler, Supabase :6543).
    DB_DIRECT_URL: z.url().optional(),
  },

  client: {},
  clientPrefix: '',

  /**
   * Destructure all variables from `process.env` to make sure they aren't tree-shaken away.
   */
  runtimeEnv: {
    ...poolRuntimeEnv,
    // Resolve from `DB_URL` (canonical) first, falling back to `DATABASE_URL`
    // (PG/Coolify/12-factor standard) so deployments using the standard name
    // still work. Closes the silent divergence between app schemas keyed on
    // DATABASE_URL and this package's DB_URL schema.
    DB_URL: process.env['DB_URL'] ?? process.env['DATABASE_URL'],
    DB_DIRECT_URL: process.env['DB_DIRECT_URL'],
  },
});
