/**
 * The database boundary is honest: the handles apps really have (node-postgres in production,
 * PGlite in tests and local dev) are `AuthDb` as they are, with no cast.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { defineRelations } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { describe, expectTypeOf, it } from 'vitest';

import type { AuthDb } from './types.js';

declare const pool: Pool;
declare const client: PGlite;

const notes = pgTable('notes', { id: text('id').primaryKey() });
const relations = defineRelations({ notes });

describe('AuthDb', () => {
  it('accepts node-postgres', () => {
    expectTypeOf(drizzleNodePg({ client: pool })).toExtend<AuthDb>();
    expectTypeOf(drizzleNodePg({ client: pool, relations })).toExtend<AuthDb>();
  });

  it('accepts PGlite', () => {
    expectTypeOf(drizzlePglite({ client })).toExtend<AuthDb>();
    expectTypeOf(drizzlePglite({ client, relations })).toExtend<AuthDb>();
  });

  it('refuses something that is not a database', () => {
    expectTypeOf<{ query: () => Promise<unknown> }>().not.toExtend<AuthDb>();
  });
});
