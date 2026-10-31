/** The libSQL plugin publishes a typed `LibSQLDatabase` and no session pool. */
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { defineRelations } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expectTypeOf } from 'vitest';

import type { Provided } from '@arki/dot/unit';
import { defineApp } from '@arki/dot/unit';

import { db } from './dot.js';

const notes = sqliteTable('notes', { id: text('id').primaryKey() });
const relations = defineRelations({ notes });
const onSqlite = db({ relations });

expectTypeOf<Provided<typeof onSqlite.provides.db>>().toEqualTypeOf<LibSQLDatabase<typeof relations>>();
// SQLite has no LISTEN, so the libsql plugin publishes no session pool.
// @ts-expect-error -- the libsql plugin has no sessionPool
void onSqlite.provides.sessionPool;
// @ts-expect-error -- the URL is read at boot, so it is a thunk, never a string
db({ relations, url: 'file:./app.db' });
defineApp('libsql-types').infra(onSqlite);
