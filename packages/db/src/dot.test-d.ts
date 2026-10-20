/** Driver overloads retain their service factories and lifecycle outcomes at app mounting. */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { defineRelations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { expectTypeOf } from 'vitest';

import type { PluginCloseFailure, PluginOpenFailure, PluginPhaseFailures, Provided } from '@arki/dot/plugin';
import { defineApp } from '@arki/dot/plugin';

import type { LocalRuntimeCloseFailure, LocalRuntimeFailure } from './runtime-local.js';
import { db } from './dot.js';

type IsAny<Value> = 0 extends 1 & Value ? true : false;

const records = pgTable('records', { id: text('id').primaryKey() });
const relations = defineRelations({ records });
const database = db({ relations });
const explicitPg = db({ driver: 'pg', relations });
const embedded = db({ driver: 'pglite', memory: true, relations });

expectTypeOf(database).toEqualTypeOf<typeof explicitPg>();
expectTypeOf<Provided<typeof database.provides.db>>().toEqualTypeOf<NodePgDatabase<typeof relations>>();
expectTypeOf<Provided<typeof embedded.provides.db>>().toEqualTypeOf<PgliteDatabase<typeof relations>>();
expectTypeOf<typeof database.factories>().toEqualTypeOf<{
  readonly db: (ctx: never) => NodePgDatabase<typeof relations>;
}>();
expectTypeOf<typeof embedded.factories>().toEqualTypeOf<{
  readonly db: (ctx: never) => Promise<PgliteDatabase<typeof relations> | LocalRuntimeFailure>;
}>();
expectTypeOf<IsAny<typeof database.factories.db>>().toEqualTypeOf<false>();
expectTypeOf<IsAny<typeof embedded.factories.db>>().toEqualTypeOf<false>();
// @ts-expect-error -- a pg database factory cannot return an unrelated number
const _invalidPg: typeof database.factories.db = () => 42;
// @ts-expect-error -- an embedded database factory must resolve to its Drizzle handle
const _invalidEmbedded: typeof embedded.factories.db = () => Promise.resolve('wrong');

const _drivers = { database, embedded };
type Driver = (typeof _drivers)[keyof typeof _drivers];
expectTypeOf<Driver['name']>().toEqualTypeOf<string>();
expectTypeOf<Driver['provides']['db']['provider']>().toEqualTypeOf<'db'>();
expectTypeOf<Awaited<ReturnType<NonNullable<Driver['hooks']['boot']>>>>().toEqualTypeOf<undefined>();
expectTypeOf<ReturnType<NonNullable<Driver['hooks']['configure']>>>().toEqualTypeOf<undefined>();
expectTypeOf<IsAny<Driver['hooks']['dispose']>>().toEqualTypeOf<false>();
// @ts-expect-error -- disposal cannot resolve to an unrelated value
const _invalidDispose: Driver['hooks']['dispose'] = () => Promise.resolve(42);
expectTypeOf<PluginOpenFailure<Driver>>().toEqualTypeOf<LocalRuntimeFailure>();
expectTypeOf<PluginCloseFailure<Driver>>().toEqualTypeOf<never>();
expectTypeOf<PluginPhaseFailures<typeof embedded>['dispose']>().toEqualTypeOf<LocalRuntimeCloseFailure>();

// The source guard must see precise hooks, rather than an erased Plugin boot callback.
defineApp('pg-types').use(database);
defineApp('explicit-pg-types').use(explicitPg);
defineApp('pglite-types').use(embedded);
