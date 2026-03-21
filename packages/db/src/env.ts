import { createEnv } from '@t3-oss/env-core';

import { z } from '@arki/contracts';

export const env = createEnv({
  onValidationError(issues) {
    console.error(
      '❌ [@arki/db] Invalid environment variables:\n' +
        issues.map(i => `  ${(i.path ?? []).join('.')}: ${i.message}`).join('\n'),
    );
    throw new Error('Invalid environment variables');
  },
  /**
   * Environment variables schema for database services (PostgreSQL)
   */
  server: {
    // General Configuration
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // Database Connection - Primary method (connection string)
    // Either DB_URL must be provided (validated after env creation)
    DB_URL: z.url(),

    // Database Connection - Individual parameters (alternative to DB_URL)
    PGUSER: z.string().optional(),
    PGPASSWORD: z.string().optional(),
    PGHOST: z.string().default('localhost'),
    PGPORT: z.coerce.number().default(5432),
    PGDATABASE: z.string().optional(),
    PGSSLMODE: z.enum(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']).default('prefer'),

    // Connection Pool Configuration
    DB_POOL_MIN: z.coerce.number().default(2),
    DB_POOL_MAX: z.coerce.number().default(20),
    DB_POOL_IDLE_TIMEOUT: z.coerce.number().default(30_000), // 30 seconds
    DB_POOL_CONNECTION_TIMEOUT: z.coerce.number().default(2000), // 2 seconds

    // Database Behavior Configuration
    DB_LOGGING: z.coerce.boolean().default(false),
    DB_MIGRATIONS_FOLDER: z.string().default('./migrations'),
    DB_SCHEMA: z.string().default('public'),

    // Performance and Reliability
    DB_STATEMENT_TIMEOUT: z.coerce.number().default(30_000), // 30 seconds
    DB_QUERY_TIMEOUT: z.coerce.number().default(60_000), // 1 minute
    DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT: z.coerce.number().default(10_000), // 10 seconds

    // Development and Testing
    DB_SEED_ON_START: z
      .string()
      .optional()
      .transform(val => val === 'true'),
    DB_DROP_ON_START: z
      .string()
      .optional()
      .transform(val => val === 'true'),
  },

  client: {},
  clientPrefix: '',

  /**
   * Destructure all variables from `process.env` to make sure they aren't tree-shaken away.
   */
  runtimeEnv: {
    NODE_ENV: process.env['NODE_ENV'],
    DB_URL: process.env['DB_URL'],
    PGUSER: process.env['PGUSER'],
    PGPASSWORD: process.env['PGPASSWORD'],
    PGHOST: process.env['PGHOST'],
    PGPORT: process.env['PGPORT'],
    PGDATABASE: process.env['PGDATABASE'],
    PGSSLMODE: process.env['PGSSLMODE'],
    DB_POOL_MIN: process.env['DB_POOL_MIN'],
    DB_POOL_MAX: process.env['DB_POOL_MAX'],
    DB_POOL_IDLE_TIMEOUT: process.env['DB_POOL_IDLE_TIMEOUT'],
    DB_POOL_CONNECTION_TIMEOUT: process.env['DB_POOL_CONNECTION_TIMEOUT'],
    DB_LOGGING: process.env['DB_LOGGING'],
    DB_MIGRATIONS_FOLDER: process.env['DB_MIGRATIONS_FOLDER'],
    DB_SCHEMA: process.env['DB_SCHEMA'],
    DB_STATEMENT_TIMEOUT: process.env['DB_STATEMENT_TIMEOUT'],
    DB_QUERY_TIMEOUT: process.env['DB_QUERY_TIMEOUT'],
    DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT: process.env['DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT'],
    DB_SEED_ON_START: process.env['DB_SEED_ON_START'],
    DB_DROP_ON_START: process.env['DB_DROP_ON_START'],
  },

  skipValidation: !!process.env['SKIP_ENV_VALIDATION'] || !!process.env['CI'] || process.env['NODE_ENV'] === 'test',
});
