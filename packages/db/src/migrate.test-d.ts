import type { MigrationMeta } from 'drizzle-orm/migrator';
import { expectTypeOf } from 'vitest';

import type { FailureOf, SuccessOf } from '@arki/failure';

import type {
  migrateDb,
  MIGRATION_APPLY_FAILURES,
  MIGRATION_READ_FAILURES,
  MIGRATION_STATE_FAILURES,
  pendingMigrations,
  readMigrations,
} from './migrate.js';

expectTypeOf<FailureOf<typeof readMigrations>>().toEqualTypeOf<ReturnType<(typeof MIGRATION_READ_FAILURES)[number]>>();
expectTypeOf<FailureOf<typeof pendingMigrations>>().toEqualTypeOf<
  ReturnType<(typeof MIGRATION_STATE_FAILURES)[number]>
>();
expectTypeOf<FailureOf<typeof migrateDb>>().toEqualTypeOf<ReturnType<(typeof MIGRATION_APPLY_FAILURES)[number]>>();
expectTypeOf<SuccessOf<typeof readMigrations>>().toEqualTypeOf<MigrationMeta[]>();
expectTypeOf<SuccessOf<typeof pendingMigrations>>().toEqualTypeOf<string[]>();
expectTypeOf<SuccessOf<typeof migrateDb>>().toEqualTypeOf<undefined>();
